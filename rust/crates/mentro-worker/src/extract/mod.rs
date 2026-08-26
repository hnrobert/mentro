pub mod pdf;
pub mod pdf_layout;
pub mod pdf_xml;
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
        other => {
            return Err(WorkerError::unsupported(format!(
                "{other:?} extraction lands in a later milestone"
            )));
        }
    };

    Ok(ExtractResult {
        asset_id: req.asset_id.clone(),
        content_hash: req.content_hash.clone(),
        kind: req.kind,
        units,
        thumbs: Vec::new(),
    })
}
