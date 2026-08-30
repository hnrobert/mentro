//! Speech-to-text through the faster-whisper sidecar container
//! (docker/whisper, self-built thin image). Video sources get their
//! audio track extracted with ffmpeg (16 kHz mono wav) first — whisper
//! wants PCM, not containers. Backend unavailability degrades to
//! Ok(None); the server marks the job failed-retryable-free.

use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use once_cell::sync::Lazy;

use crate::{
    error::{WorkerError, WorkerResult},
    ext::{container, run_tool},
    proto::mentro::worker::v1::{CMsgTranscriptSegment, TranscribeRequest, TranscribeResult},
};

static SPEC: Lazy<container::ContainerSpec> = Lazy::new(|| container::ContainerSpec {
    log_tag: "whisper",
    name: "mentro-whisper",
    image: "mentro-whisper:latest",
    host_port: 9500,
    container_port: 8000,
    url_env: "MENTRO_WHISPER_URL",
    off_env: "MENTRO_WHISPER",
    extra_env: &[],
    health_path: "/health",
    health_timeout_sec: 300,
});
static GUARD: Lazy<container::Guard> = Lazy::new(container::Guard::new);

/// Hard ceiling on transcribed duration — bounds CPU cost per asset.
const MAX_DURATION_SEC: f64 = 4.0 * 3600.0;

pub fn transcribe(req: &TranscribeRequest) -> WorkerResult<TranscribeResult> {
    let path = Path::new(&req.path);
    if !path.is_file() {
        return Err(WorkerError::invalid(format!(
            "not a file: {}",
            path.display()
        )));
    }
    let Some(base) = container::ensure(&SPEC, &GUARD) else {
        // Backend off: surfaced as a normal "unavailable" outcome, not an
        // error — transcription is an enhancement, not a gate.
        return Ok(TranscribeResult {
            asset_id: req.asset_id.clone(),
            content_hash: req.content_hash.clone(),
            segments: Vec::new(),
        });
    };

    let wav = extract_audio(path)?;
    let wav_bytes = std::fs::read(&wav)
        .map_err(|e| WorkerError::invalid(format!("read {}: {e}", wav.display())))?;
    let _ = std::fs::remove_file(&wav);

    let Some(json) = container::post_file_multipart(
        &format!("{base}/transcribe"),
        "file",
        "audio.wav",
        &wav_bytes,
        Duration::from_secs(1800),
    )?
    else {
        return Ok(TranscribeResult {
            asset_id: req.asset_id.clone(),
            content_hash: req.content_hash.clone(),
            segments: Vec::new(),
        });
    };

    let mut segments = Vec::new();
    if let Some(arr) = json.get("segments").and_then(|s| s.as_array()) {
        for seg in arr {
            let start = seg.get("start").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let end = seg.get("end").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let text = seg
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .trim();
            if text.is_empty() {
                continue;
            }
            segments.push(CMsgTranscriptSegment {
                start_ms: (start * 1000.0) as i64,
                end_ms: (end * 1000.0) as i64,
                text: text.to_string(),
            });
        }
    }

    Ok(TranscribeResult {
        asset_id: req.asset_id.clone(),
        content_hash: req.content_hash.clone(),
        segments,
    })
}

/// ffmpeg -> 16 kHz mono wav under the data dir; video containers are
/// accepted, the video stream is dropped.
fn extract_audio(path: &Path) -> WorkerResult<PathBuf> {
    let data_dir = PathBuf::from(std::env::var("MENTRO_DATA").unwrap_or_else(|_| "./data".into()));
    std::fs::create_dir_all(data_dir.join("tmp"))
        .map_err(|e| WorkerError::internal(format!("mkdir tmp: {e}")))?;
    let out = data_dir.join("tmp").join(format!(
        "{}.wav",
        blake3::hash(path.to_string_lossy().as_bytes()).to_hex()
    ));
    run_tool(
        "ffmpeg",
        &[
            "-y",
            "-i",
            &path.to_string_lossy(),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-t",
            &MAX_DURATION_SEC.to_string(),
            &out.to_string_lossy(),
        ],
        Duration::from_secs(600),
    )?;
    if !out.exists() {
        return Err(WorkerError::new(
            crate::proto::mentro::worker::v1::EErrorCode::ToolNonZeroExit,
            "ffmpeg produced no audio",
            false,
        ));
    }
    Ok(out)
}
