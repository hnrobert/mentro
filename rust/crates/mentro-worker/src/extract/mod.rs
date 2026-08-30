pub mod media;
pub mod ooxml;
pub mod pdf;
pub mod pdf_layout;
pub mod pdf_xml;
pub mod render;
pub mod text;

use std::path::Path;

use crate::{
    error::{WorkerError, WorkerResult},
    proto::mentro::worker::v1::{ExtractRequest, ExtractResult},
};

pub fn extract(req: &ExtractRequest) -> WorkerResult<ExtractResult> {
    let path = Path::new(&req.path);
    if !path.is_file() {
        return Err(WorkerError::invalid(format!(
            "not a file: {}",
            path.display()
        )));
    }

    let kind = crate::proto::mentro::worker::v1::EAssetKind::try_from(req.kind)
        .unwrap_or(crate::proto::mentro::worker::v1::EAssetKind::Other);

    let units = match kind {
        crate::proto::mentro::worker::v1::EAssetKind::Text => text::extract(path)?,
        crate::proto::mentro::worker::v1::EAssetKind::Pdf => pdf::extract(path)?,
        crate::proto::mentro::worker::v1::EAssetKind::Presentation => ooxml::extract_pptx(path)?,
        crate::proto::mentro::worker::v1::EAssetKind::Document => ooxml::extract_docx(path)?,
        crate::proto::mentro::worker::v1::EAssetKind::Spreadsheet => ooxml::extract_xlsx(path)?,
        crate::proto::mentro::worker::v1::EAssetKind::Image => media::extract_image(path)?,
        crate::proto::mentro::worker::v1::EAssetKind::Video
        | crate::proto::mentro::worker::v1::EAssetKind::Audio => media::extract_av(path)?,
        other => {
            return Err(WorkerError::unsupported(format!(
                "{other:?} extraction lands in a later milestone"
            )));
        }
    };

    // Cover thumbnail for renderable kinds (presentation/document): the
    // Office->PDF->page-1 path; failure degrades to text-only (§7.5).
    let wants_thumb = req
        .want
        .contains(&(crate::proto::mentro::worker::v1::EExtractWant::CoverThumb as i32));
    let mut thumbs = Vec::new();
    if wants_thumb
        && matches!(
            kind,
            crate::proto::mentro::worker::v1::EAssetKind::Presentation
                | crate::proto::mentro::worker::v1::EAssetKind::Document
        )
        && let Some(thumb) = render::cover_thumb(path, &req.asset_id)
    {
        thumbs.push(thumb);
    }

    Ok(ExtractResult {
        asset_id: req.asset_id.clone(),
        content_hash: req.content_hash.clone(),
        kind: req.kind,
        units,
        thumbs,
    })
}
