//! Media extraction: images (EXIF + dimensions), video/audio (ffprobe).
//! Thumbnails: image via `image` crate downscale, video via ffmpeg poster
//! frame. All failures degrade to metadata-only units.

use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use crate::{
    error::WorkerResult,
    ext::run_tool,
    proto::mentro::worker::v1::{CMsgContentUnit, EUnitType},
};

fn data_dir() -> PathBuf {
    PathBuf::from(std::env::var("MENTRO_DATA").unwrap_or_else(|_| "./data".into()))
}

fn title_of(text: &str) -> String {
    for line in text.lines() {
        let t = line.trim();
        if !t.is_empty() {
            return t.chars().take(120).collect();
        }
    }
    String::new()
}

// --- Image ---

pub fn extract_image(path: &Path) -> WorkerResult<Vec<CMsgContentUnit>> {
    let mut text = String::new();

    // EXIF metadata.
    if let Ok(f) = std::fs::File::open(path) {
        let mut buf = std::io::BufReader::new(f);
        if let Ok(exif) = exif::Reader::new().read_from_container(&mut buf) {
            for field in exif.fields() {
                use exif::Tag;
                let name = match field.tag {
                    Tag::Model => "Model",
                    Tag::DateTimeOriginal => "Taken",
                    Tag::Orientation => "Orientation",
                    Tag::Software => "Software",
                    _ => continue,
                };
                text.push_str(&format!("\n{name}: {}", field.display_value()));
            }
        }
    }

    // Dimensions via image crate (fast header probe).
    if let Ok((w, h)) = image::image_dimensions(path) {
        text.push_str(&format!("\nDimensions: {w}x{h}"));

        // Generate thumbnail (480px max dimension).
        let thumb = generate_image_thumb(path, w, h);
        let title = if text.lines().count() > 1 {
            title_of(&text)
        } else {
            format!("{w}x{h}")
        };

        return Ok(vec![CMsgContentUnit {
            ordinal: 1,
            unit_type: EUnitType::Whole as i32,
            title,
            text: text.trim().to_string(),
            start_ms: 0,
            end_ms: 0,
            thumb_path: thumb.unwrap_or_default(),
            hidden: false,
        }]);
    }

    Ok(vec![CMsgContentUnit {
        ordinal: 1,
        unit_type: EUnitType::Whole as i32,
        title: String::new(),
        text,
        start_ms: 0,
        end_ms: 0,
        thumb_path: String::new(),
        hidden: false,
    }])
}

fn generate_image_thumb(path: &Path, _w: u32, _h: u32) -> Option<String> {
    let asset_id = path
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.split("__").next().unwrap_or(s).to_string())?;
    let thumbs_dir = data_dir().join("thumbs").join(&asset_id);
    std::fs::create_dir_all(&thumbs_dir).ok()?;
    let out = thumbs_dir.join("1.webp");

    // Use ffmpeg for reliable webp output.
    let ok = run_tool(
        "ffmpeg",
        &[
            "-y",
            "-i",
            &path.to_string_lossy(),
            "-vf",
            "scale=480:-1",
            "-q:v",
            "75",
            &out.to_string_lossy(),
        ],
        Duration::from_secs(30),
    );
    if ok.is_err() {
        // Fallback: PNG via image crate.
        let img = image::open(path).ok()?;
        let scaled = img.thumbnail(480, 480);
        let png_out = thumbs_dir.join("1.png");
        scaled.save(&png_out).ok()?;
        return Some(format!("thumbs/{asset_id}/1.png"));
    }

    Some(format!("thumbs/{asset_id}/1.webp"))
}

// --- Audio/Video ---

pub fn extract_av(path: &Path) -> WorkerResult<Vec<CMsgContentUnit>> {
    let mut text = String::new();
    let start_ms: i64 = 0;
    let mut end_ms: i64 = 0;
    let is_video = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            matches!(
                e.to_ascii_lowercase().as_str(),
                "mp4" | "mov" | "mkv" | "avi" | "webm"
            )
        })
        .unwrap_or(false);

    // ffprobe JSON metadata.
    let json = run_tool(
        "ffprobe",
        &[
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            &path.to_string_lossy(),
        ],
        Duration::from_secs(60),
    );

    if let Ok(json) = json
        && let Ok(v) = serde_json::from_str::<serde_json::Value>(&json)
    {
        if let Some(format) = v.pointer("/format") {
            if let Some(dur) = format
                .get("duration")
                .and_then(|d| d.as_str())
                .and_then(|d| d.parse::<f64>().ok())
            {
                end_ms = (dur * 1000.0) as i64;
                text.push_str(&format!("Duration: {:.1}s\n", dur));
            }
            if let Some(tags) = format.get("tags") {
                for key in ["title", "artist", "album", "comment", "description"] {
                    if let Some(val) = tags.get(key).and_then(|v| v.as_str()) {
                        text.push_str(&format!("{}: {}\n", key, val));
                    }
                }
            }
        }
        // Video stream info.
        if let Some(streams) = v.get("streams").and_then(|s| s.as_array()) {
            for s in streams {
                if s.get("codec_type").and_then(|t| t.as_str()) == Some("video") {
                    let w = s.get("width").and_then(|w| w.as_u64()).unwrap_or(0);
                    let h = s.get("height").and_then(|h| h.as_u64()).unwrap_or(0);
                    text.push_str(&format!("Resolution: {w}x{h}\n"));
                }
            }
        }
    }

    // Generate poster frame thumbnail for video.
    let thumb = if is_video {
        generate_video_poster(path)
    } else {
        None
    };

    let title = title_of(&text);
    Ok(vec![CMsgContentUnit {
        ordinal: 1,
        unit_type: EUnitType::Frame as i32,
        title,
        text: text.trim().to_string(),
        start_ms,
        end_ms,
        thumb_path: thumb.unwrap_or_default(),
        hidden: false,
    }])
}

fn generate_video_poster(path: &Path) -> Option<String> {
    let asset_id = path
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.split("__").next().unwrap_or(s).to_string())?;
    let thumbs_dir = data_dir().join("thumbs").join(&asset_id);
    std::fs::create_dir_all(&thumbs_dir).ok()?;
    let out = thumbs_dir.join("1.webp");

    let ok = run_tool(
        "ffmpeg",
        &[
            "-y",
            "-ss",
            "3", // skip 3s to avoid black intro
            "-i",
            &path.to_string_lossy(),
            "-frames:v",
            "1",
            "-vf",
            "scale=480:-1",
            "-q:v",
            "75",
            &out.to_string_lossy(),
        ],
        Duration::from_secs(60),
    );
    if ok.is_err() {
        return None;
    }

    Some(format!("thumbs/{asset_id}/1.webp"))
}
