//! PDF extraction: `pdftotext` per file, form-feed (`\f`) page splits.
//! Ordinals map 1:1 to physical pages (blank pages kept, empty text).

use std::{path::Path, time::Duration};

use crate::{
    error::WorkerResult,
    ext::run_tool,
    proto::mentro::worker::v1::{CMsgContentUnit, EUnitType},
};

pub fn extract(path: &Path) -> WorkerResult<Vec<CMsgContentUnit>> {
    let text = run_tool(
        "pdftotext",
        &["-enc", "UTF-8", &path.to_string_lossy(), "-"],
        Duration::from_secs(120),
    )?;

    // pdftotext ends output with a trailing form feed; drop it so the
    // split doesn't manufacture a phantom last page.
    let text = text.trim_end_matches('\u{c}');

    Ok(text
        .split('\u{c}')
        .enumerate()
        .map(|(i, page)| CMsgContentUnit {
            ordinal: (i + 1) as i32,
            unit_type: EUnitType::Page as i32,
            title: super::text::first_line_title(page),
            text: page.trim_end().to_string(),
            start_ms: 0,
            end_ms: 0,
            thumb_path: String::new(),
        })
        .collect())
}
