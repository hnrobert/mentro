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

/// Render cache layout version. Bump when office→PDF conversion
/// semantics change so stale caches are ignored:
/// v2 — hidden slides are un-hidden before conversion (old caches lack
/// those pages). Keep the name in sync with the server's
/// /api/assets/:id/rendered route.
const RENDER_V: u8 = 2;

/// Cached Office->PDF path, rendering on first request. Also feeds PDF
/// export of office pages (export/pdf.rs).
pub(crate) fn ensure_pdf(path: &Path, asset_id: &str) -> Option<PathBuf> {
    let render_dir = data_dir().join("render");
    std::fs::create_dir_all(&render_dir).ok()?;
    let pdf_path = render_dir.join(format!("{asset_id}.r{RENDER_V}.pdf"));
    if pdf_path.exists() {
        return Some(pdf_path);
    }
    // LibreOffice drops hidden slides when exporting to PDF; converting
    // the original would drift page ordinals out of alignment with the
    // extracted units. Convert a normalized (un-hidden) copy instead.
    let sanitized = super::ooxml::unhidden_pptx_copy(path);
    let converted = gotenberg::convert_to_pdf(sanitized.as_deref().unwrap_or(path)).ok();
    if let Some(copy) = &sanitized {
        // Best-effort temp cleanup (also removes on failure paths).
        let _ = std::fs::remove_file(copy);
        let _ = std::fs::remove_dir(copy.parent().unwrap_or(Path::new("/tmp")));
    }
    let bytes = converted?;
    std::fs::write(&pdf_path, bytes).ok()?;
    Some(pdf_path)
}

/// Render page `ordinal` (1-based) of the source document to a webp
/// thumbnail; returns the path relative to the data dir.
pub fn page_thumb(path: &Path, asset_id: &str, ordinal: u32) -> Option<String> {
    page_thumb_wide(path, asset_id, ordinal, false)
}

/// Cover (page 1) thumbnail.
pub fn cover_thumb(path: &Path, asset_id: &str) -> Option<String> {
    page_thumb(path, asset_id, 1)
}

/// Preview-grade page render: wider than a thumbnail (lazy page
/// previews in the asset detail view). Shares the render/<assetId>.pdf
/// cache with the thumbnail path.
pub fn page_thumb_wide(path: &Path, asset_id: &str, ordinal: u32, wide: bool) -> Option<String> {
    let pdf = ensure_pdf(path, asset_id)?;
    let thumbs_dir = data_dir().join("thumbs").join(asset_id);
    std::fs::create_dir_all(&thumbs_dir).ok()?;
    let scale = if wide { 1200 } else { 480 };
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
            &scale.to_string(),
            "-png",
            "-singlefile",
            &pdf.to_string_lossy(),
            &out.to_string_lossy(),
        ],
        Duration::from_secs(120),
    );
    ok.ok()?;
    let png = out.with_extension("png");
    if !png.exists() {
        return None;
    }
    Some(format!("thumbs/{asset_id}/{ordinal}.png"))
}
