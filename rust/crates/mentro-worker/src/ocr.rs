//! Per-image OCR through the PaddleOCR serving container (§7.6 model:
//! lazy start, health probe, one warning when unavailable). The container
//! is owned by this worker; external tool rules apply.

use std::{
    path::Path,
    sync::atomic::{AtomicU8, Ordering},
    time::Duration,
};

use base64::Engine;

use crate::{
    error::{WorkerError, WorkerResult},
    ext::run_tool,
    proto::mentro::worker::v1::EErrorCode,
};

const CONTAINER_NAME: &str = "mentro-paddle-ocr";
// Thin local image (docker/ocr/Dockerfile): official PaddleX CPU image +
// the serving plugin, which the base image lacks.
const DEFAULT_IMAGE: &str = "mentro-ocr:serving";
const HOST_PORT: u16 = 9300;

/// 0 = idle, 1 = ready, 2 = unavailable.
static STATE: AtomicU8 = AtomicU8::new(0);
static WARNED: AtomicU8 = AtomicU8::new(0);

fn image() -> String {
    std::env::var("MENTRO_OCR_IMAGE").unwrap_or_else(|_| DEFAULT_IMAGE.to_string())
}

fn base_url() -> String {
    format!("http://127.0.0.1:{}", port())
}

fn port() -> u16 {
    std::env::var("MENTRO_OCR_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(HOST_PORT)
}

fn warn_once(msg: &str) {
    if WARNED.swap(1, Ordering::Relaxed) == 0 {
        eprintln!("[ocr] {msg} — embedded-image OCR disabled for this session");
    }
}

/// Ensure the container is up; returns the base URL or None.
pub fn ensure() -> Option<String> {
    if std::env::var("MENTRO_OCR")
        .map(|v| v == "off")
        .unwrap_or(false)
    {
        warn_once("OCR disabled via MENTRO_OCR=off");
        STATE.store(2, Ordering::Relaxed);
        return None;
    }
    match STATE.load(Ordering::Relaxed) {
        1 => return Some(base_url()),
        2 => return None,
        _ => {}
    }

    // Already running?
    let ps = run_tool(
        "docker",
        &[
            "ps",
            "--filter",
            &format!("name={CONTAINER_NAME}"),
            "--format",
            "{{.Names}}",
        ],
        Duration::from_secs(10),
    );
    let running = matches!(&ps, Ok(out) if out.contains(CONTAINER_NAME));
    if !running {
        if let Err(e) = &ps
            && e.code == EErrorCode::ToolMissing
        {
            warn_once("no container runtime found");
            STATE.store(2, Ordering::Relaxed);
            return None;
        }
        // Try starting an existing (stopped) container, else create one.
        let _ = run_tool(
            "docker",
            &["start", CONTAINER_NAME],
            Duration::from_secs(30),
        );
        let ps2 = run_tool(
            "docker",
            &[
                "ps",
                "--filter",
                &format!("name={CONTAINER_NAME}"),
                "--format",
                "{{.Names}}",
            ],
            Duration::from_secs(10),
        );
        if !matches!(&ps2, Ok(out) if out.contains(CONTAINER_NAME)) {
            let port_map = format!("127.0.0.1:{}:8080", port());
            eprintln!("[ocr] creating container (image {})", image());
            let created = run_tool(
                "docker",
                &[
                    "run",
                    "-d",
                    "--name",
                    CONTAINER_NAME,
                    "-p",
                    &port_map,
                    "-e",
                    "DISABLE_MODEL_SOURCE_CHECK=True",
                    image().as_str(),
                ],
                Duration::from_secs(900),
            );
            if let Err(e) = created {
                warn_once(&format!("failed to start OCR container: {e}"));
                STATE.store(2, Ordering::Relaxed);
                return None;
            }
        }
    }

    // Health poll (up to 180s; model load is slow on first boot).
    let base = base_url();
    for _ in 0..90 {
        if let Ok(resp) = ureq::get(&format!("{base}/health"))
            .timeout(Duration::from_secs(2))
            .call()
            && resp.status() >= 200
            && resp.status() < 300
        {
            STATE.store(1, Ordering::Relaxed);
            return Some(base);
        }
        std::thread::sleep(Duration::from_secs(2));
    }
    warn_once("OCR container did not become healthy in 180s");
    STATE.store(2, Ordering::Relaxed);
    None
}

/// OCR one image file; None when the OCR backend is unavailable.
pub fn ocr_image(path: &Path) -> WorkerResult<Option<String>> {
    let Some(base) = ensure() else {
        return Ok(None);
    };
    let bytes = std::fs::read(path)
        .map_err(|e| WorkerError::invalid(format!("read {}: {e}", path.display())))?;
    if bytes.len() > 12 * 1024 * 1024 {
        return Ok(None);
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let resp = match ureq::post(&format!("{base}/ocr"))
        .timeout(Duration::from_secs(120))
        .send_json(ureq::json!({ "file": b64, "fileType": 1 }))
    {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[ocr] request failed: {e}");
            return Ok(None);
        }
    };
    let body: serde_json::Value = match resp.into_json() {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[ocr] response decode failed: {e}");
            return Ok(None);
        }
    };
    Ok(Some(collect_texts(&body)))
}

/// Text extraction from a PaddleX OCR response: the precise path is
/// `result.ocrResults[*].prunedResult.rec_texts`; the recursive walker is
/// only a fallback for schema drift across PaddleX versions.
fn collect_texts(v: &serde_json::Value) -> String {
    if let Some(results) = v.pointer("/result/ocrResults").and_then(|r| r.as_array()) {
        let mut texts: Vec<String> = Vec::new();
        for item in results {
            if let Some(rec) = item
                .pointer("/prunedResult/rec_texts")
                .and_then(|t| t.as_array())
            {
                for t in rec {
                    if let Some(s) = t.as_str()
                        && !s.trim().is_empty()
                    {
                        texts.push(s.trim().to_string());
                    }
                }
            }
        }
        if !texts.is_empty() {
            return texts.join(" ");
        }
    }
    let mut out = String::new();
    walk(v, &mut out);
    out.trim().to_string()
}

fn walk(v: &serde_json::Value, out: &mut String) {
    match v {
        serde_json::Value::String(s) => {
            // Bare strings deeper than the log level are recognition text.
            if !s.is_empty() && !s.starts_with("http") && s.len() < 500 {
                if !out.is_empty() {
                    out.push(' ');
                }
                out.push_str(s);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                walk(item, out);
            }
        }
        serde_json::Value::Object(map) => {
            for (k, val) in map {
                // Skip non-text metadata fields.
                if matches!(
                    k.as_str(),
                    "score"
                        | "confidence"
                        | "box"
                        | "boxes"
                        | "poly"
                        | "dt"
                        | "logId"
                        | "errorCode"
                        | "errorMsg"
                        | "elapsedTime"
                        | "min"
                        | "general"
                        | "label"
                        | "inputImage"
                        | "modelName"
                ) {
                    continue;
                }
                walk(val, out);
            }
        }
        _ => {}
    }
}
