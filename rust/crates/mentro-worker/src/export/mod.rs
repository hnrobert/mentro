//! Selected-unit export (M6): compose a new document from a set of
//! assetId+ordinal units. PDF goes through qpdf page surgery (byte-level
//! fidelity — objects are copied verbatim, never re-serialized); PPTX goes
//! through OOXML surgery (parts copied verbatim, only the slide list and
//! its relationships are rewritten).

pub mod pdf;
pub mod pptx;

use std::path::PathBuf;

use crate::{
    error::{WorkerError, WorkerResult},
    proto::mentro::worker::v1::{EExportFormat, ExportRequest, ExportResult},
};

fn data_dir() -> PathBuf {
    PathBuf::from(std::env::var("MENTRO_DATA").unwrap_or_else(|_| "./data".into()))
}

/// Artifact name: strip anything path-like from the hint, keep it readable.
fn sanitize_name(hint: &str, ext: &str) -> String {
    let cleaned: String = hint
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_') {
                c
            } else {
                '-'
            }
        })
        .collect();
    let cleaned = cleaned.trim_matches('-');
    let base = if cleaned.is_empty() {
        "export"
    } else {
        cleaned
    };
    let mut name = format!("{base}.{ext}");
    // Never overwrite: suffix on collision.
    let dir = data_dir().join("exports");
    if dir.join(&name).exists() {
        name = format!("{base}-{}.{}", ulid_suffix(), ext);
    }
    name
}

/// Cheap uniqueness suffix (timestamp-based; uniqueness is all we need).
fn ulid_suffix() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{ms:x}")
}

pub fn export(req: &ExportRequest) -> WorkerResult<ExportResult> {
    if req.units.is_empty() {
        return Err(WorkerError::invalid("export needs at least one unit"));
    }
    let format = EExportFormat::try_from(req.format)
        .map_err(|_| WorkerError::invalid("unknown export format"))?;
    let ext = match format {
        EExportFormat::Pdf => "pdf",
        EExportFormat::Pptx => "pptx",
        EExportFormat::Unspecified => {
            return Err(WorkerError::invalid("export format unspecified"));
        }
    };
    let name = sanitize_name(&req.name_hint, ext);
    let out_dir = data_dir().join("exports");
    std::fs::create_dir_all(&out_dir)
        .map_err(|e| WorkerError::internal(format!("mkdir {}: {e}", out_dir.display())))?;
    let out = out_dir.join(&name);

    match format {
        EExportFormat::Pdf => pdf::export_pdf(&req.units, &out)?,
        EExportFormat::Pptx => pptx::export_pptx(&req.units, &out)?,
        EExportFormat::Unspecified => unreachable!("handled above"),
    }

    Ok(ExportResult {
        // Relative to the data dir — the server resolves and serves it.
        path: format!("exports/{name}"),
    })
}
