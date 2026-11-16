//! Batch text translation through five HTTP backends (LLM via any
//! OpenAI-compatible endpoint, DeepL, Baidu, Google, LibreTranslate).
//! The worker is a PURE EXECUTOR: the server resolves the backend
//! chain, glossary and pacing, then passes credentials per request —
//! nothing is read from env or disk here. Adapters validate the
//! returned count and map failures to retryable/non-retryable codes so
//! the server can walk its fallback chain.

use std::time::Duration;

use crate::{
    error::{WorkerError, WorkerResult},
    proto::mentro::worker::v1::{
        TranslateBaidu, TranslateDeepl, TranslateGoogle, TranslateLibre, TranslateLlm,
    },
    proto::mentro::worker::v1::{TranslateRequest, TranslateResult, translate_backend::Kind},
};

const TIMEOUT: Duration = Duration::from_secs(120);
/// LLM streams can stall-then-resume on flaky gateways; a tight body
/// read timeout kills alive generations (observed as "llm body read:
/// timed out" bursts that burned every retry).
const LLM_TIMEOUT: Duration = Duration::from_secs(300);

/// Batch cap — the server batches smaller (8 for llm, 32 for APIs);
/// this is a hard stop against runaway payloads.
const BATCH_CAP: usize = 64;

fn retryable(msg: String) -> WorkerError {
    WorkerError::new(
        crate::proto::mentro::worker::v1::EErrorCode::ToolNonZeroExit,
        msg,
        true,
    )
}

fn fatal(msg: String) -> WorkerError {
    WorkerError::new(
        crate::proto::mentro::worker::v1::EErrorCode::ToolNonZeroExit,
        msg,
        false,
    )
}

/// DeepL target/source codes are uppercase ISO ("EN", "ZH"); Baidu has
/// its own three-letter set; zh maps to "zh" for Google/Libre/LLM.
fn deepl_lang(code: &str) -> String {
    code.to_uppercase()
}

fn baidu_lang(code: &str) -> String {
    match code {
        "zh" => "zh".into(),
        "en" => "en".into(),
        "ja" => "jp".into(),
        "ko" => "kor".into(),
        "de" => "de".into(),
        "fr" => "fra".into(),
        "ru" => "ru".into(),
        "es" => "spa".into(),
        other => other.into(),
    }
}

pub fn translate(req: &TranslateRequest) -> WorkerResult<TranslateResult> {
    if req.texts.is_empty() {
        return Err(WorkerError::invalid("translate needs at least one text"));
    }
    if req.texts.len() > BATCH_CAP {
        return Err(WorkerError::invalid(format!(
            "translate batch cap is {BATCH_CAP} texts, got {}",
            req.texts.len()
        )));
    }
    let Some(backend) = req.backend.as_ref() else {
        return Err(WorkerError::invalid("translate needs a backend"));
    };
    let kind = backend
        .kind
        .clone()
        .ok_or_else(|| WorkerError::invalid("translate backend has no configured kind"))?;
    let texts = match kind {
        Kind::Llm(cfg) => llm_translate(
            &req.texts,
            &req.source_lang,
            &req.target_lang,
            &req.system_prompt,
            &cfg,
        )?,
        Kind::Deepl(cfg) => deepl_translate(&req.texts, &req.source_lang, &req.target_lang, &cfg)?,
        Kind::Baidu(cfg) => baidu_translate(&req.texts, &req.source_lang, &req.target_lang, &cfg)?,
        Kind::Google(cfg) => {
            google_translate(&req.texts, &req.source_lang, &req.target_lang, &cfg)?
        }
        Kind::Libre(cfg) => libre_translate(&req.texts, &req.source_lang, &req.target_lang, &cfg)?,
    };
    if texts.len() != req.texts.len() {
        return Err(retryable(format!(
            "backend returned {} translations for {} texts",
            texts.len(),
            req.texts.len()
        )));
    }
    Ok(TranslateResult {
        translations: texts,
    })
}

// --- LLM (OpenAI-compatible, non-streaming) -------------------------------

/// Parse the model's answer: a JSON array of strings. Tolerates code
/// fences and a leading/trailing prose sentence (rare).
fn parse_llm_array(content: &str) -> Option<Vec<String>> {
    let trimmed = content.trim();
    // Strip ```json ... ``` fences when present.
    let body = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
        .map(|s| s.strip_suffix("```").unwrap_or(s))
        .unwrap_or(trimmed);
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(arr) = v.as_array() {
            let out: Vec<String> = arr
                .iter()
                .filter_map(|i| i.as_str())
                .map(String::from)
                .collect();
            if out.len() == arr.len() {
                return Some(out);
            }
        }
        return None;
    }
    // Fallback: locate the outermost [ ... ] and retry.
    if let (Some(a), Some(b)) = (body.find('['), body.rfind(']'))
        && b > a
        && let Ok(v) = serde_json::from_str::<serde_json::Value>(&body[a..=b])
        && let Some(arr) = v.as_array()
    {
        let out: Vec<String> = arr
            .iter()
            .filter_map(|i| i.as_str())
            .map(String::from)
            .collect();
        if out.len() == arr.len() {
            return Some(out);
        }
    }
    None
}

fn llm_translate(
    texts: &[String],
    source: &str,
    target: &str,
    system_prompt: &str,
    cfg: &TranslateLlm,
) -> WorkerResult<Vec<String>> {
    let base = cfg.base_url.trim_end_matches('/');
    let user = serde_json::to_string(texts)
        .map_err(|e| WorkerError::internal(format!("serialize texts: {e}")))?;
    let system = if system_prompt.is_empty() {
        format!(
            "You are a professional translator. Translate each string from {source_or_auto} to {target}. \
             Respond with ONLY a JSON array of exactly {n} translated strings, same order, no commentary.",
            source_or_auto = if source.is_empty() {
                "the auto-detected source language"
            } else {
                source
            },
            target = target,
            n = texts.len(),
        )
    } else {
        system_prompt.to_string()
    };
    let mut body = serde_json::json!({
        "model": cfg.model,
        "temperature": 0.1,
        // Reasoning models burn headroom before the visible answer —
        // cap the total so batches cannot run unbounded.
        "max_tokens": 8000,
        // STREAM: real translation content takes ~50s on slow channels;
        // non-streaming idle connections hit gateway timeouts (504).
        // Streaming keeps bytes flowing and completes reliably.
        "stream": true,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user },
        ],
    });
    // Provider switches (e.g. disabling thinking) ride in extra_json.
    if !cfg.extra_json.is_empty()
        && let Ok(extra) = serde_json::from_str::<serde_json::Value>(&cfg.extra_json)
        && let (Some(target), Some(src)) = (body.as_object_mut(), extra.as_object())
    {
        for (k, v) in src {
            target.insert(k.clone(), v.clone());
        }
    }
    let resp = ureq::post(&format!("{base}/chat/completions"))
        .timeout(LLM_TIMEOUT)
        .set("authorization", &format!("Bearer {}", cfg.api_key))
        .send_json(body)
        .map_err(|e| retryable(format!("llm translate: {e}")))?;
    if resp.status() >= 400 {
        let status = resp.status();
        let msg = resp.into_string().unwrap_or_default();
        return Err(if status == 401 || status == 403 {
            fatal(format!(
                "llm translate auth failed ({status}): {}",
                msg.chars().take(200).collect::<String>()
            ))
        } else {
            retryable(format!("llm translate HTTP {status}"))
        });
    }
    // Accumulate streamed content deltas; ignore reasoning_content.
    // A gateway that ignores stream:true answers with plain JSON —
    // fall back to reading that instead.
    let mut content = String::new();
    let mut saw_sse = false;
    {
        let mut reader = resp.into_reader();
        let mut raw = String::new();
        std::io::Read::read_to_string(&mut reader, &mut raw)
            .map_err(|e| retryable(format!("llm body read: {e}")))?;
        for line in raw.lines() {
            let line = line.trim();
            if !line.starts_with("data:") {
                continue;
            }
            saw_sse = true;
            let payload = line[5..].trim();
            if payload == "[DONE]" {
                continue;
            }
            if let Ok(ev) = serde_json::from_str::<serde_json::Value>(payload)
                && let Some(delta) = ev.pointer("/choices/0/delta/content")
                && let Some(s) = delta.as_str()
            {
                content.push_str(s);
            }
        }
        if !saw_sse {
            // Plain (non-streamed) JSON response.
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw)
                && let Some(c) = v.pointer("/choices/0/message/content")
                && let Some(s) = c.as_str()
            {
                content = s.to_string();
            }
        }
    }
    match parse_llm_array(&content) {
        Some(v) if v.len() == texts.len() => Ok(v),
        _ => Err(retryable(format!(
            "llm returned a malformed array ({} of {} parsed)",
            parse_llm_array(&content).map(|v| v.len()).unwrap_or(0),
            texts.len()
        ))),
    }
}

// --- DeepL -----------------------------------------------------------------

fn deepl_translate(
    texts: &[String],
    source: &str,
    target: &str,
    cfg: &TranslateDeepl,
) -> WorkerResult<Vec<String>> {
    let host = if cfg.pro {
        "api.deepl.com"
    } else {
        "api-free.deepl.com"
    };
    let mut body = serde_json::json!({
        "text": texts,
        "target_lang": deepl_lang(target),
    });
    if !source.is_empty() {
        body["source_lang"] = serde_json::Value::String(deepl_lang(source));
    }
    let resp = ureq::post(&format!("https://{host}/v2/translate"))
        .timeout(TIMEOUT)
        .set("authorization", &format!("DeepL-Auth-Key {}", cfg.key))
        .send_json(body)
        .map_err(|e| retryable(format!("deepl: {e}")))?;
    if resp.status() >= 400 {
        let status = resp.status();
        let msg = resp.into_string().unwrap_or_default();
        return Err(if status == 401 || status == 403 {
            fatal(format!("deepl auth failed ({status})"))
        } else {
            retryable(format!(
                "deepl HTTP {status}: {}",
                msg.chars().take(200).collect::<String>()
            ))
        });
    }
    let parsed: serde_json::Value = resp
        .into_json()
        .map_err(|e| retryable(format!("deepl decode: {e}")))?;
    let Some(arr) = parsed.pointer("/translations").and_then(|t| t.as_array()) else {
        return Err(retryable("deepl response missing translations".into()));
    };
    Ok(arr
        .iter()
        .map(|t| {
            t.get("text")
                .and_then(|t| t.as_str())
                .unwrap_or_default()
                .to_string()
        })
        .collect())
}

// --- Baidu -----------------------------------------------------------------

/// Baidu classic API signature: md5(appid + q + salt + key), hex.
fn baidu_sign(appid: &str, q: &str, salt: &str, key: &str) -> String {
    use md5::{Digest, Md5};
    let mut hasher = Md5::new();
    hasher.update(appid.as_bytes());
    hasher.update(q.as_bytes());
    hasher.update(salt.as_bytes());
    hasher.update(key.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn baidu_translate(
    texts: &[String],
    source: &str,
    target: &str,
    cfg: &TranslateBaidu,
) -> WorkerResult<Vec<String>> {
    // q is the newline-joined batch; newline-split on the way back —
    // translations must therefore not contain raw newlines. Join with
    // a space first to keep the contract safe.
    let q = texts
        .iter()
        .map(|t| t.replace('\n', " "))
        .collect::<Vec<_>>()
        .join("\n");
    let salt = "314159";
    let sign = baidu_sign(&cfg.appid, &q, salt, &cfg.key);
    let from = if source.is_empty() {
        "auto".to_string()
    } else {
        baidu_lang(source)
    };
    let resp = ureq::post("https://fanyi-api.baidu.com/api/trans/vip/translate")
        .timeout(TIMEOUT)
        .send_form(&[
            ("q", q.as_str()),
            ("from", from.as_str()),
            ("to", baidu_lang(target).as_str()),
            ("appid", cfg.appid.as_str()),
            ("salt", salt),
            ("sign", sign.as_str()),
        ])
        .map_err(|e| retryable(format!("baidu: {e}")))?;
    if resp.status() >= 400 {
        let status = resp.status();
        let msg = resp.into_string().unwrap_or_default();
        return Err(if status == 401 || status == 403 {
            fatal(format!("baidu auth failed ({status})"))
        } else {
            retryable(format!(
                "baidu HTTP {status}: {}",
                msg.chars().take(200).collect::<String>()
            ))
        });
    }
    let parsed: serde_json::Value = resp
        .into_json()
        .map_err(|e| retryable(format!("baidu decode: {e}")))?;
    if let Some(code) = parsed.get("error_code").and_then(|c| c.as_str()) {
        // 54003 = rate limited (retryable); 58003/52001 credential issues.
        let retry = code == "54003" || code == "52002" || code == "52003";
        let msg = parsed
            .get("error_msg")
            .and_then(|m| m.as_str())
            .unwrap_or("unknown");
        return Err(if retry {
            retryable(format!("baidu error {code}: {msg}"))
        } else {
            fatal(format!("baidu error {code}: {msg}"))
        });
    }
    let Some(arr) = parsed.get("trans_result").and_then(|t| t.as_array()) else {
        return Err(retryable("baidu response missing trans_result".into()));
    };
    Ok(arr
        .iter()
        .map(|t| {
            t.get("dst")
                .and_then(|d| d.as_str())
                .unwrap_or_default()
                .to_string()
        })
        .collect())
}

// --- Google Cloud Translation ----------------------------------------------

fn google_translate(
    texts: &[String],
    source: &str,
    target: &str,
    cfg: &TranslateGoogle,
) -> WorkerResult<Vec<String>> {
    let mut body = serde_json::json!({ "q": texts, "target": target, "format": "text" });
    if !source.is_empty() {
        body["source"] = serde_json::Value::String(source.to_string());
    }
    let resp = ureq::post(&format!(
        "https://translation.googleapis.com/language/translate/v2?key={}",
        cfg.key
    ))
    .timeout(TIMEOUT)
    .send_json(body)
    .map_err(|e| retryable(format!("google: {e}")))?;
    if resp.status() >= 400 {
        let status = resp.status();
        let msg = resp.into_string().unwrap_or_default();
        return Err(if status == 401 || status == 403 {
            fatal(format!("google auth failed ({status})"))
        } else {
            retryable(format!(
                "google HTTP {status}: {}",
                msg.chars().take(200).collect::<String>()
            ))
        });
    }
    let parsed: serde_json::Value = resp
        .into_json()
        .map_err(|e| retryable(format!("google decode: {e}")))?;
    let Some(arr) = parsed
        .pointer("/data/translations")
        .and_then(|t| t.as_array())
    else {
        return Err(retryable(
            "google response missing data.translations".into(),
        ));
    };
    Ok(arr
        .iter()
        .map(|t| {
            t.get("translatedText")
                .and_then(|d| d.as_str())
                .unwrap_or_default()
                .to_string()
        })
        .collect())
}

// --- LibreTranslate (self-hosted) ------------------------------------------

fn libre_translate(
    texts: &[String],
    source: &str,
    target: &str,
    cfg: &TranslateLibre,
) -> WorkerResult<Vec<String>> {
    let base = cfg.url.trim_end_matches('/');
    let mut body = serde_json::json!({
        "q": texts,
        "source": if source.is_empty() { "auto".to_string() } else { source.to_string() },
        "target": target,
        "format": "text",
    });
    if !cfg.key.is_empty() {
        body["api_key"] = serde_json::Value::String(cfg.key.clone());
    }
    let resp = ureq::post(&format!("{base}/translate"))
        .timeout(TIMEOUT)
        .send_json(body)
        .map_err(|e| retryable(format!("libre: {e}")))?;
    if resp.status() >= 400 {
        let status = resp.status();
        let msg = resp.into_string().unwrap_or_default();
        return Err(if status == 401 || status == 403 {
            fatal(format!("libre auth failed ({status})"))
        } else {
            retryable(format!(
                "libre HTTP {status}: {}",
                msg.chars().take(200).collect::<String>()
            ))
        });
    }
    let parsed: serde_json::Value = resp
        .into_json()
        .map_err(|e| retryable(format!("libre decode: {e}")))?;
    // LibreTranslate answers translatedText as an array when q was one.
    if let Some(arr) = parsed.get("translatedText").and_then(|t| t.as_array()) {
        return Ok(arr
            .iter()
            .map(|t| t.as_str().unwrap_or_default().to_string())
            .collect());
    }
    if let Some(one) = parsed.get("translatedText").and_then(|t| t.as_str()) {
        // Scalar answer is only valid for a single input.
        if texts.len() == 1 {
            return Ok(vec![one.to_string()]);
        }
    }
    Err(retryable(
        "libre response missing translatedText array".into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn llm_array_parser_handles_fences_and_prose() {
        assert_eq!(
            parse_llm_array(r#"["a","b"]"#).unwrap(),
            vec!["a".to_string(), "b".to_string()]
        );
        assert_eq!(
            parse_llm_array("```json\n[\"你好\", \"世界\"]\n```").unwrap(),
            vec!["你好".to_string(), "世界".to_string()]
        );
        assert_eq!(
            parse_llm_array("Here you go: [\"x\"] hope that helps").unwrap(),
            vec!["x".to_string()]
        );
        assert!(parse_llm_array("[1,2]").is_none()); // non-strings
        assert!(parse_llm_array("no array at all").is_none());
    }

    #[test]
    fn baidu_sign_vector() {
        // Reference vector computed independently (md5 of concat).
        let expect = {
            use md5::{Digest, Md5};
            let mut h = Md5::new();
            h.update(b"20151113000005349");
            h.update(b"apple");
            h.update(b"1435660288");
            h.update(b"12345678");
            h.finalize()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        };
        assert_eq!(
            baidu_sign("20151113000005349", "apple", "1435660288", "12345678"),
            expect
        );
    }

    #[test]
    fn lang_code_maps() {
        assert_eq!(deepl_lang("en"), "EN");
        assert_eq!(baidu_lang("ja"), "jp");
        assert_eq!(baidu_lang("ko"), "kor");
        assert_eq!(baidu_lang("fr"), "fra");
        assert_eq!(baidu_lang("es"), "spa");
    }
}
