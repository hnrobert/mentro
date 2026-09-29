//! Plain-text extraction (txt/md/csv/json/...): one whole-file unit.

use std::{io::Read, path::Path};

use crate::{
    error::WorkerResult,
    proto::mentro::worker::v1::{CMsgContentUnit, EUnitType},
};

const TEXT_CAP: u64 = 2 * 1024 * 1024;

pub fn first_line_title(text: &str) -> String {
    for line in text.lines() {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            return trimmed.chars().take(120).collect();
        }
    }
    String::new()
}

pub fn extract(path: &Path) -> WorkerResult<Vec<CMsgContentUnit>> {
    let file = std::fs::File::open(path)
        .map_err(|e| crate::error::WorkerError::invalid(format!("open {}: {e}", path.display())))?;
    let mut text = String::new();
    (&file)
        .take(TEXT_CAP)
        .read_to_string(&mut text)
        .map_err(|e| crate::error::WorkerError::invalid(format!("read {}: {e}", path.display())))?;

    let title = first_line_title(&text);
    Ok(vec![CMsgContentUnit {
        ordinal: 1,
        unit_type: EUnitType::Whole as i32,
        title,
        text,
        start_ms: 0,
        end_ms: 0,
        thumb_path: String::new(),
        hidden: false,
    }])
}
