//! PDF extraction: layout-aware pipeline ported from pdf2md.
//!
//! Text path: `pdftohtml -xml` (positioned runs + font sizes) -> layout
//! analyzer (lines/blocks/columns/reading order/headers/footers/hyphenation)
//! -> document-wide heading map -> per-page markdown-ish text. Fallback:
//! plain `pdftotext` when pdftohtml is unavailable.
//!
//! Image path: every embedded image extracted via `pdfimages -all`, each
//! OCR'd separately through the PaddleOCR container; OCR text is appended
//! to the owning page's unit text. Pages with no text layer are rendered
//! (`pdftoppm`) and OCR'd whole (scanned-document rule from pdf2md).

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::error::WorkerResult;
use crate::ext::run_tool;
use crate::ocr;
use crate::proto::mentro::worker::v1::{CMsgContentUnit, EUnitType};

use super::pdf_layout as layout;
use super::pdf_xml;

pub fn extract(path: &Path) -> WorkerResult<Vec<CMsgContentUnit>> {
    match extract_layout(path) {
        Ok(units) => Ok(units),
        Err(e) if e.code == crate::proto::mentro::worker::v1::EErrorCode::ToolMissing => {
            extract_plain(path)
        }
        Err(e) => Err(e),
    }
}

/// Original simple path: pdftotext with form-feed page splits.
fn extract_plain(path: &Path) -> WorkerResult<Vec<CMsgContentUnit>> {
    let text = run_tool(
        "pdftotext",
        &["-enc", "UTF-8", &path.to_string_lossy(), "-"],
        Duration::from_secs(120),
    )?;
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

fn extract_layout(path: &Path) -> WorkerResult<Vec<CMsgContentUnit>> {
    let xml = run_tool(
        "pdftohtml",
        &["-xml", "-stdout", "-i", &path.to_string_lossy()],
        Duration::from_secs(120),
    )?;
    let pages = pdf_xml::parse(&xml);
    if pages.is_empty() {
        return extract_plain(path);
    }

    // Phase 1: per-page analysis.
    let mut analyzed: Vec<layout::AnalyzedPage> = pages
        .into_iter()
        .map(|p| layout::analyze_page(&p.geom, p.fragments))
        .collect();
    layout::mark_repeated_elements(&mut analyzed);

    // Phase 2: document-wide heading map.
    let heading_map = layout::compute_heading_size_map(&analyzed);

    // Embedded images (page attribution from the -NNN-NNN filename).
    let images = extract_images(path);

    // Phase 3: render pages.
    let mut h1_emitted = false;
    let mut units = Vec::with_capacity(analyzed.len());
    for (idx, page) in analyzed.iter().enumerate() {
        let page_no = idx + 1;
        let mut text = layout::render_page(page, &heading_map, &mut h1_emitted);

        // Whole-page OCR for textless pages AND for pages whose "text"
        // layer is font-encoding garbage (broken ToUnicode maps, e.g.
        // OmniGraffle/Quartz exports): the glyphs decode confidently to
        // random rare codepoints, so no extractor can recover them —
        // OCR is the only honest source.
        let garbage = looks_like_mojibake(&text);
        if page.blocks.is_empty() || garbage {
            if garbage {
                text.clear();
            }
            // No text layer: scanned page -> render + whole-page OCR.
            if let Some(ocr_text) = ocr_rendered_page(path, page_no) {
                text = if text.is_empty() {
                    ocr_text
                } else {
                    format!("{text}\n\n[page OCR] {ocr_text}")
                };
            }
        }

        // Every embedded image on this page: OCR separately, append.
        let mut img_idx = 0;
        for img in images.iter().filter(|i| i.page == page_no) {
            img_idx += 1;
            if img.min_dim < 32 {
                continue; // decorative specks
            }
            if let Ok(Some(ocr_text)) = ocr::ocr_image(&img.path)
                && !ocr_text.is_empty()
            {
                let label = if text.is_empty() {
                    String::new()
                } else {
                    "\n\n".to_string()
                };
                text.push_str(&format!("{label}[img {img_idx} OCR] {ocr_text}"));
            }
        }

        let title = first_heading(&text)
            .map(|h| h.chars().take(120).collect())
            .unwrap_or_default();

        units.push(CMsgContentUnit {
            ordinal: page_no as i32,
            unit_type: EUnitType::Page as i32,
            title,
            text,
            start_ms: 0,
            end_ms: 0,
            thumb_path: String::new(),
        });
    }
    Ok(units)
}

fn first_heading(markdown: &str) -> Option<&str> {
    markdown
        .lines()
        .find(|l| l.starts_with('#'))
        .map(|l| l.trim_start_matches('#').trim())
        .filter(|l| !l.is_empty())
}

/// Garbage-text detector for broken ToUnicode font maps. Real documents
/// (zh/en/mixed) live overwhelmingly in ASCII + common CJK + kana +
/// fullwidth punctuation; encoding garbage lands in combining marks,
/// bidi controls, exotic scripts, and CJK extension planes. When ≥30%
/// of a ≥20-char page is implausible, the "text" is glyph noise.
fn looks_like_mojibake(text: &str) -> bool {
    let mut total = 0usize;
    let mut plausible = 0usize;
    for c in text.chars().filter(|c| !c.is_whitespace()) {
        total += 1;
        if plausible_char(c) {
            plausible += 1;
        }
    }
    if total < 20 {
        return false;
    }
    (total - plausible) * 10 > total * 3
}

fn plausible_char(c: char) -> bool {
    matches!(c as u32,
        0x20..=0x7E            // ASCII
        | 0xA0..=0x24F          // Latin-1 letters + extended Latin
        | 0x2000..=0x200D       // punctuation + zero-width space
        | 0x2010..=0x2027       // dashes/quotes (excl. bidi controls)
        | 0x3000..=0x303F       // CJK punctuation
        | 0x3040..=0x30FF       // kana
        | 0x4E00..=0x9FFF       // CJK unified (common)
        | 0xAC00..=0xD7AF       // hangul syllables
        | 0xFF00..=0xFFEF       // fullwidth forms
    )
}

// --- embedded images ---

struct PdfImage {
    page: usize,
    path: PathBuf,
    min_dim: u32,
}

fn extract_images(pdf: &Path) -> Vec<PdfImage> {
    let dir = std::env::temp_dir().join(format!(
        "mentro-img-{}",
        blake3::hash(pdf.to_string_lossy().as_bytes()).to_hex()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    if std::fs::create_dir_all(&dir).is_err() {
        return Vec::new();
    }
    let prefix = dir.join("img");

    let list = run_tool(
        "pdfimages",
        &["-list", &pdf.to_string_lossy()],
        Duration::from_secs(60),
    );
    let Ok(list) = list else {
        return Vec::new();
    };

    // Parse -list rows: page num type width height ...
    // Keep only real images (`image`); smask/stencil/mask rows are alpha
    // channels, not pictures.
    let mut rows: Vec<(usize, usize, u32, u32)> = Vec::new(); // (page, num, w, h)
    for line in list.lines().skip(2) {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 6 || cols[2] != "image" {
            continue;
        }
        let (Ok(page), Ok(num), Ok(w), Ok(h)) = (
            cols[0].parse::<usize>(),
            cols[1].parse::<usize>(),
            cols[3].parse::<u32>(),
            cols[4].parse::<u32>(),
        ) else {
            continue;
        };
        rows.push((page, num, w, h));
    }
    if rows.is_empty() {
        return Vec::new();
    }

    // `pdfimages -all` writes prefix-NNN.ext where NNN == the `num` column.
    let extracted = run_tool(
        "pdfimages",
        &["-all", &pdf.to_string_lossy(), &prefix.to_string_lossy()],
        Duration::from_secs(300),
    );
    if extracted.is_err() {
        return Vec::new();
    }

    rows.into_iter()
        .filter_map(|(page, num, w, h)| {
            let path = ["jpg", "png", "jp2", "jpx", "tiff", "ccitt", "bmp"]
                .iter()
                .map(|ext| dir.join(format!("img-{num:03}.{ext}")))
                .find(|p| p.exists())?;
            Some(PdfImage {
                page,
                path,
                min_dim: w.min(h),
            })
        })
        .collect()
}

fn ocr_rendered_page(pdf: &Path, page: usize) -> Option<String> {
    let dir = std::env::temp_dir().join(format!(
        "mentro-page-{}-p{page}",
        blake3::hash(pdf.to_string_lossy().as_bytes()).to_hex()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).ok()?;
    let prefix = dir.join("page");
    let page_str = page.to_string();
    let ok = run_tool(
        "pdftoppm",
        &[
            "-f",
            &page_str,
            "-l",
            &page_str,
            "-r",
            "150",
            "-png",
            &pdf.to_string_lossy(),
            &prefix.to_string_lossy(),
        ],
        Duration::from_secs(120),
    );
    if ok.is_err() {
        return None;
    }
    let png = std::fs::read_dir(&dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .find(|p| p.extension().and_then(|e| e.to_str()) == Some("png"))?;
    let result = ocr::ocr_image(&png).ok().flatten();
    let _ = std::fs::remove_dir_all(&dir);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real output of an OmniGraffle/Quartz export with a broken
    /// ToUnicode map (user-reported roadmap.pdf).
    #[test]
    fn detects_broken_tounicode_garbage() {
        let garbage = "ݗጱقऒఽᎣොໜ चԭහਁਏኞጱ၅Ꮯ௔҅ᬰ ᘒ൉ṛ";
        assert!(looks_like_mojibake(garbage));
    }

    #[test]
    fn keeps_real_chinese_and_english() {
        let real = "港口物流系统：货物仓储、运输管理与海关清关 including English words, 2026.";
        assert!(!looks_like_mojibake(real));
        assert!(!looks_like_mojibake("短文本"));
        assert!(!looks_like_mojibake(""));
    }
}
