//! Office rendering: Gotenberg container (Office -> PDF) cached at
//! `render/<assetId>.pdf`, page thumbnails via pdftoppm (480px webp).
//! All failures degrade to None — text extraction never depends on this.

use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use crate::ext::{gotenberg, run_tool};

/// Resolve the render cache root: MENTRO_DATA or ./data.
fn data_dir() -> PathBuf {
    PathBuf::from(std::env::var("MENTRO_DATA").unwrap_or_else(|_| "./data".into()))
}

/// Cached Office->PDF path, rendering on first request. Also feeds PDF
/// export of office pages (export/pdf.rs).
pub(crate) fn ensure_pdf(path: &Path, asset_id: &str) -> Option<PathBuf> {
    let render_dir = data_dir().join("render");
    std::fs::create_dir_all(&render_dir).ok()?;
    let pdf_path = render_dir.join(format!("{asset_id}.pdf"));
    if pdf_path.exists() {
        return Some(pdf_path);
    }
    let bytes = gotenberg::convert_to_pdf(path).ok()?;
    std::fs::write(&pdf_path, bytes).ok()?;
    Some(pdf_path)
}

/// Render page `ordinal` (1-based) of the source document to a webp
/// thumbnail; returns the path relative to the data dir.
pub fn page_thumb(path: &Path, asset_id: &str, ordinal: u32) -> Option<String> {
    let pdf = ensure_pdf(path, asset_id)?;
    let thumbs_dir = data_dir().join("thumbs").join(asset_id);
    std::fs::create_dir_all(&thumbs_dir).ok()?;
    let out = thumbs_dir.join(format!("{ordinal}"));
    let page = ordinal.to_string();
    let ok = run_tool(
        "pdftoppm",
        &[
            "-f",
            &page,
            "-l",
            &page,
            "-scale-to",
            "480",
            "-png",
            "-singlefile",
            &pdf.to_string_lossy(),
            &out.to_string_lossy(),
        ],
        Duration::from_secs(60),
    );
    ok.ok()?;
    let png = out.with_extension("png");
    if !png.exists() {
        return None;
    }
    // Keep PNG for M3 (webp re-encode is a nicety); path relative to data.
    Some(format!("thumbs/{asset_id}/{ordinal}.png"))
}

/// Cover (page 1) thumbnail.
pub fn cover_thumb(path: &Path, asset_id: &str) -> Option<String> {
    page_thumb(path, asset_id, 1)
}
