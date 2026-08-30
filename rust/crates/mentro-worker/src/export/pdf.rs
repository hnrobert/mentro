//! PDF composition export: split selected pages out of their sources and
//! merge them into one document via `qpdf --empty --pages`. qpdf copies
//! page objects and their streams verbatim — no re-serialization, so the
//! output keeps fidelity (fonts, color spaces, annotations) of the source
//! pages. Non-PDF sources go through the Office->PDF render cache first.

use std::{collections::HashMap, path::Path, time::Duration};

use crate::{
    error::{WorkerError, WorkerResult},
    ext::run_tool,
    extract::render,
    proto::mentro::worker::v1::CMsgUnitRef,
};

/// Resolve a unit's source file to the PDF its ordinal indexes into.
/// Office kinds render through the cached Gotenberg conversion.
fn pdf_source(unit: &CMsgUnitRef) -> WorkerResult<std::path::PathBuf> {
    let path = Path::new(&unit.path);
    if !path.is_file() {
        return Err(WorkerError::invalid(format!(
            "not a file: {}",
            path.display()
        )));
    }
    let is_pdf = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("pdf"))
        .unwrap_or(false);
    if is_pdf {
        return Ok(path.to_path_buf());
    }
    let office = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            matches!(
                e.to_ascii_lowercase().as_str(),
                "pptx" | "docx" | "xlsx" | "ppt" | "doc" | "xls" | "odt" | "ods" | "odp"
            )
        })
        .unwrap_or(false);
    if !office {
        return Err(WorkerError::unsupported(format!(
            "PDF composition needs pdf or office sources, got {}",
            path.display()
        )));
    }
    render::ensure_pdf(path, &unit.asset_id).ok_or_else(|| {
        WorkerError::new(
            crate::proto::mentro::worker::v1::EErrorCode::ToolMissing,
            format!(
                "no rendered PDF for {} (office container unavailable?)",
                path.display()
            ),
            false,
        )
    })
}

pub fn export_pdf(units: &[CMsgUnitRef], out: &Path) -> WorkerResult<()> {
    // Render-cache lookups deduped per source file.
    let mut sources: HashMap<String, std::path::PathBuf> = HashMap::new();
    let mut args: Vec<String> = vec![
        // Corpus PDFs (LaTeX posters etc.) often carry benign xref quirks;
        // qpdf exit 3 means "warnings only, output written".
        "--warning-exit-0".into(),
        "--empty".into(),
        "--pages".into(),
    ];
    for unit in units {
        if unit.ordinal < 1 {
            return Err(WorkerError::invalid("page ordinals are 1-based"));
        }
        let src = match sources.get(&unit.path) {
            Some(p) => p.clone(),
            None => {
                let p = pdf_source(unit)?;
                sources.insert(unit.path.clone(), p.clone());
                p
            }
        };
        // Repeating (file, page) pairs preserves the user's order and
        // allows duplicates.
        args.push(src.to_string_lossy().to_string());
        args.push(unit.ordinal.to_string());
    }
    args.push("--".into());
    args.push(out.to_string_lossy().to_string());

    run_tool(
        "qpdf",
        &args.iter().map(String::as_str).collect::<Vec<_>>(),
        Duration::from_secs(300),
    )
    .map_err(|e| {
        // qpdf exits 3 for page-range problems (invalid input), else 2.
        if e.message.contains("page") || e.message.contains("range") {
            WorkerError::invalid(format!("qpdf: {}", e.message))
        } else {
            WorkerError::new(
                crate::proto::mentro::worker::v1::EErrorCode::ToolNonZeroExit,
                format!("qpdf: {}", e.message),
                true,
            )
        }
    })?;
    if !out.exists() {
        return Err(WorkerError::internal("qpdf produced no output"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_positive_ordinal() {
        let unit = CMsgUnitRef {
            asset_id: "a".into(),
            ordinal: 0,
            path: "/nonexistent.pdf".into(),
        };
        let err = export_pdf(&[unit], Path::new("/tmp/never.pdf")).unwrap_err();
        assert_eq!(
            err.code,
            crate::proto::mentro::worker::v1::EErrorCode::InvalidInput
        );
    }
}
