//! MIME + extension -> EAssetKind classification. Content sniffing wins
//! where magic bytes exist; the zip family (OOXML/epub/plain zip) and the
//! text family are disambiguated by extension.

use std::path::Path;

use crate::proto::mentro::worker::v1::EAssetKind;

pub fn classify(mime: Option<&str>, path: &Path) -> EAssetKind {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();

    if let Some(m) = mime {
        match m {
            "application/pdf" => return EAssetKind::Pdf,
            m if m.starts_with("image/") => return EAssetKind::Image,
            m if m.starts_with("video/") => return EAssetKind::Video,
            m if m.starts_with("audio/") => return EAssetKind::Audio,
            // zip family and text/* fall through to extension refinement
            _ => {}
        }
    }

    match ext.as_str() {
        "pptx" | "ppt" | "key" => EAssetKind::Presentation,
        "docx" | "doc" => EAssetKind::Document,
        "xlsx" | "xls" | "numbers" => EAssetKind::Spreadsheet,
        "pdf" => EAssetKind::Pdf,
        "txt" | "md" | "markdown" | "csv" | "json" | "tex" | "bib" | "log" | "epub" => {
            EAssetKind::Text
        }
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" | "heic" | "tiff" | "svg" => {
            EAssetKind::Image
        }
        "mp4" | "mov" | "mkv" | "avi" | "webm" => EAssetKind::Video,
        "mp3" | "wav" | "flac" | "aac" | "m4a" => EAssetKind::Audio,
        "zip" | "7z" | "rar" | "tar" | "gz" => EAssetKind::Archive,
        _ => EAssetKind::Other,
    }
}
