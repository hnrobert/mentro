//! HEIC/HEIF image extraction. Uses ffprobe/ffmpeg for metadata (they
//! support HEIF containers) and falls back to metadata-only if the
//! container can't be decoded.

use std::{path::Path, time::Duration};

use crate::{
    error::WorkerResult,
    ext::run_tool,
    proto::mentro::worker::v1::{CMsgContentUnit, EUnitType},
};

pub fn extract_heic(path: &Path) -> WorkerResult<Vec<CMsgContentUnit>> {
    let mut text = String::new();

    // ffprobe gives dimensions and codec info for HEIF.
    if let Ok(json) = run_tool(
        "ffprobe",
        &[
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_streams",
            &path.to_string_lossy(),
        ],
        Duration::from_secs(30),
    ) && let Ok(v) = serde_json::from_str::<serde_json::Value>(&json)
        && let Some(streams) = v.get("streams").and_then(|s| s.as_array())
    {
        for s in streams {
            if s.get("codec_type").and_then(|t| t.as_str()) == Some("video") {
                let w = s.get("width").and_then(|w| w.as_u64()).unwrap_or(0);
                let h = s.get("height").and_then(|h| h.as_u64()).unwrap_or(0);
                text.push_str(&format!("Dimensions: {w}x{h}\n"));
                if let Some(codec) = s.get("codec_name").and_then(|c| c.as_str()) {
                    text.push_str(&format!("Codec: {codec}\n"));
                }
            }
        }
    }

    // EXIF from HEIF via ffmpeg raw output (if available).
    // kamadak-exif doesn't support HEIF containers natively.
    // For now we just report dimensions + codec.

    let title = if text.is_empty() {
        String::new()
    } else {
        text.lines()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("")
            .to_string()
    };

    Ok(vec![CMsgContentUnit {
        ordinal: 1,
        unit_type: EUnitType::Whole as i32,
        title,
        text: text.trim().to_string(),
        start_ms: 0,
        end_ms: 0,
        thumb_path: String::new(),
    }])
}
