//! OOXML text extraction: PPTX (slides in presentation order + notes),
//! DOCX (paragraphs), XLSX (sheet names + shared strings). Pure
//! zip + XML walking — no external tools, no rendering here.

use std::io::{Read, Write};
use std::path::Path;

use crate::{
    error::{WorkerError, WorkerResult},
    proto::mentro::worker::v1::{CMsgContentUnit, EUnitType},
};

fn open_zip(path: &Path) -> WorkerResult<zip::ZipArchive<std::fs::File>> {
    let file = std::fs::File::open(path)
        .map_err(|e| WorkerError::invalid(format!("open {}: {e}", path.display())))?;
    zip::ZipArchive::new(file).map_err(|e| WorkerError::invalid(format!("bad ooxml zip: {e}")))
}

fn read_entry(archive: &mut zip::ZipArchive<std::fs::File>, name: &str) -> Option<String> {
    let mut entry = archive.by_name(name).ok()?;
    let mut text = String::new();
    entry.read_to_string(&mut text).ok()?;
    Some(text)
}

/// Collect text inside `<a:t>...</a:t>` (PowerPoint runs).
/// CJK boundary: no space between two CJK-ish runs (pdftohtml and
/// OOXML both split CJK text into many runs; blanket spaces turn
/// 在线优化 into 在 线 优化). Mirrors pdf_layout::cjk_ish/join_runs.
fn cjk_ish(c: char) -> bool {
    matches!(c as u32,
        0x2E80..=0x9FFF
        | 0xAC00..=0xD7AF
        | 0xF900..=0xFAFF
        | 0xFF00..=0xFFEF
    ) || matches!(
        c,
        '\u{2014}' | '\u{2018}' | '\u{2019}' | '\u{201C}' | '\u{201D}' | '\u{2026}'
    )
}

/// Append `next` to `out` with a space only at real word boundaries.
fn push_run(out: &mut String, next: &str) {
    let n = next.trim();
    if n.is_empty() {
        return;
    }
    if !out.is_empty() {
        let prev_cjk = out.chars().last().map(cjk_ish).unwrap_or(false);
        let next_cjk = n.chars().next().map(cjk_ish).unwrap_or(false);
        if !(out.ends_with(' ') || prev_cjk && next_cjk) {
            out.push(' ');
        }
    }
    out.push_str(n);
}

fn slide_text(xml: &str) -> String {
    let mut out = String::new();
    let mut reader = quick_xml::Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut in_at = false;
    loop {
        match reader.read_event() {
            Ok(quick_xml::events::Event::Start(e)) if e.name().as_ref() == b"a:t" => {
                in_at = true;
            }
            Ok(quick_xml::events::Event::Text(t)) if in_at => {
                if let Ok(txt) = t.decode() {
                    push_run(&mut out, &txt);
                }
            }
            Ok(quick_xml::events::Event::End(e)) if e.name().as_ref() == b"a:t" => {
                in_at = false;
            }
            Ok(quick_xml::events::Event::Eof) => break,
            Ok(_) => {}
            Err(_) => break,
        }
    }
    out
}

/// Collect paragraph text inside `<w:t>...</w:t>` (Word runs).
fn docx_text(xml: &str) -> String {
    let mut out = String::new();
    let mut reader = quick_xml::Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut in_wt = false;
    let mut in_para = false;
    loop {
        match reader.read_event() {
            Ok(quick_xml::events::Event::Start(e)) => match e.name().as_ref() {
                b"w:p" => in_para = true,
                b"w:t" => in_wt = true,
                _ => {}
            },
            Ok(quick_xml::events::Event::Text(t)) if in_wt => {
                if let Ok(txt) = t.decode() {
                    // Runs within one paragraph join at word boundaries
                    // only (CJK runs flush).
                    if in_para && !out.is_empty() && !out.ends_with('\n') {
                        let prev_cjk = out.chars().last().map(cjk_ish).unwrap_or(false);
                        let next_cjk = txt.chars().next().map(cjk_ish).unwrap_or(false);
                        if !(out.ends_with(' ') || prev_cjk && next_cjk) {
                            out.push(' ');
                        }
                    }
                    out.push_str(&txt);
                }
            }
            Ok(quick_xml::events::Event::End(e)) => match e.name().as_ref() {
                b"w:p" => {
                    in_para = false;
                    out.push('\n');
                }
                b"w:t" => in_wt = false,
                _ => {}
            },
            Ok(quick_xml::events::Event::Eof) => break,
            Ok(_) => {}
            Err(_) => break,
        }
    }
    out
}

/// First text line as title, capped.
fn title_of(text: &str) -> String {
    for line in text.lines() {
        let t = line.trim();
        if !t.is_empty() {
            return t.chars().take(120).collect();
        }
    }
    String::new()
}

/// PPTX: one unit per slide, slides ordered by presentation.xml's
/// sldIdLst -> r:id -> slideN.xml mapping.
pub fn extract_pptx(path: &Path) -> WorkerResult<Vec<CMsgContentUnit>> {
    let mut zip = open_zip(path)?;

    // 1. presentation.xml: ordered slide relationship ids.
    let presentation = read_entry(&mut zip, "ppt/presentation.xml")
        .ok_or_else(|| WorkerError::invalid("not a pptx: missing ppt/presentation.xml"))?;
    let mut r_ids: Vec<String> = Vec::new();
    {
        let mut reader = quick_xml::Reader::from_str(&presentation);
        reader.config_mut().trim_text(true);
        loop {
            match reader.read_event() {
                Ok(quick_xml::events::Event::Start(e)) | Ok(quick_xml::events::Event::Empty(e))
                    if e.name().as_ref() == b"p:sldId" =>
                {
                    for attr in e.attributes().flatten() {
                        if attr.key.as_ref().starts_with(b"r:id") {
                            r_ids.push(String::from_utf8_lossy(&attr.value).to_string());
                        }
                    }
                }
                Ok(quick_xml::events::Event::Eof) => break,
                Ok(_) => {}
                Err(_) => break,
            }
        }
    }
    if r_ids.is_empty() {
        return Err(WorkerError::invalid("pptx has no slides in sldIdLst"));
    }

    // 2. presentation rels: rIdN -> slides/slideM.xml.
    let rels = read_entry(&mut zip, "ppt/_rels/presentation.xml.rels")
        .ok_or_else(|| WorkerError::invalid("pptx missing presentation rels"))?;
    let mut target_by_id = std::collections::HashMap::new();
    {
        let mut reader = quick_xml::Reader::from_str(&rels);
        reader.config_mut().trim_text(true);
        loop {
            match reader.read_event() {
                Ok(quick_xml::events::Event::Start(e)) | Ok(quick_xml::events::Event::Empty(e))
                    if e.name().as_ref() == b"Relationship" =>
                {
                    let mut id = String::new();
                    let mut target = String::new();
                    for attr in e.attributes().flatten() {
                        match attr.key.as_ref() {
                            b"Id" => id = String::from_utf8_lossy(&attr.value).to_string(),
                            b"Target" => target = String::from_utf8_lossy(&attr.value).to_string(),
                            _ => {}
                        }
                    }
                    if !id.is_empty() {
                        target_by_id.insert(id, target);
                    }
                }
                Ok(quick_xml::events::Event::Eof) => break,
                Ok(_) => {}
                Err(_) => break,
            }
        }
    }

    // 3. Walk slides in order; pull slide + notes text. Hidden slides
    //    (p:sld show="0") stay in the index — the render pipeline
    //    un-hides them before LibreOffice conversion
    //    (unhidden_pptx_copy), so ordinals follow the true sldIdLst
    //    position and stay aligned with the rendered PDF's pages.
    let mut units = Vec::new();
    for (i, rid) in r_ids.iter().enumerate() {
        let target = target_by_id
            .get(rid)
            .cloned()
            .unwrap_or_else(|| format!("slides/slide{}.xml", i + 1));
        let entry = format!("ppt/{target}");
        let slide_xml = read_entry(&mut zip, &entry).unwrap_or_default();
        let hidden = is_hidden_slide(&slide_xml);
        let mut text = slide_text(&slide_xml);

        // Notes: slideN.xml rels point to ../notesSlides/notesSlideN.xml.
        let rel_entry = format!(
            "ppt/slides/_rels/{}",
            target.trim_start_matches("slides/").to_string() + ".rels"
        );
        if let Some(slide_rels) = read_entry(&mut zip, &rel_entry)
            && let Some(notes_target) = find_notes_target(&slide_rels)
            && let Some(notes_xml) = read_entry(&mut zip, &format!("ppt/{notes_target}"))
        {
            let notes = slide_text(&notes_xml);
            if !notes.trim().is_empty() {
                text.push_str("\n\n[notes] ");
                text.push_str(&notes);
            }
        }

        let title = title_of(&text);
        units.push(CMsgContentUnit {
            // True sldIdLst position (see step 3 comment above).
            ordinal: (i + 1) as i32,
            unit_type: EUnitType::Slide as i32,
            title,
            text,
            start_ms: 0,
            end_ms: 0,
            thumb_path: String::new(),
            hidden,
        });
    }
    Ok(units)
}

/// A hidden slide carries show="0" on its root p:sld element.
fn is_hidden_slide(slide_xml: &str) -> bool {
    // The root element and its attributes live at the very start; the
    // declaration comes first, so scan events until p:sld opens. Cap
    // the scan head, floor-ed to a char boundary (CJK slides can split
    // a codepoint at any fixed byte offset).
    let mut end = slide_xml.len().min(600);
    while end > 0 && !slide_xml.is_char_boundary(end) {
        end -= 1;
    }
    let head = &slide_xml[..end];
    let mut reader = quick_xml::Reader::from_str(head);
    loop {
        match reader.read_event() {
            Ok(quick_xml::events::Event::Decl(_)) | Ok(quick_xml::events::Event::Text(_)) => {}
            Ok(quick_xml::events::Event::Start(ref e))
            | Ok(quick_xml::events::Event::Empty(ref e)) => {
                return e.name().as_ref() == b"p:sld"
                    && e.attributes().flatten().any(|a| {
                        a.key.as_ref() == b"show" && String::from_utf8_lossy(&a.value) == "0"
                    });
            }
            _ => return false,
        }
    }
}

/// Strip `show="0"` from a slide's root element; None when absent.
/// Only the root `<p:sld ...>` start tag is touched — the rest of the
/// document is preserved verbatim.
fn strip_root_show(slide_xml: &str) -> Option<String> {
    let root = slide_xml.find("<p:sld")?;
    let tag_end = root + slide_xml[root..].find('>')?;
    let tag = &slide_xml[root..tag_end];
    let patched = tag.replace(" show=\"0\"", "").replace(" show='0'", "");
    if patched.len() == tag.len() {
        return None;
    }
    Some(format!(
        "{}{}{}",
        &slide_xml[..root],
        patched,
        &slide_xml[tag_end..]
    ))
}

static UNHIDE_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Write a temp copy of a PPTX with hidden slides un-hidden (root
/// `show="0"` stripped). LibreOffice drops hidden slides when exporting
/// to PDF, so the office→PDF render must convert this normalized copy —
/// otherwise rendered pages drift out of alignment with unit ordinals.
/// Returns None when the deck has no hidden slides (render the
/// original), or when it is not a readable pptx (non-zip, encrypted).
pub fn unhidden_pptx_copy(path: &Path) -> Option<std::path::PathBuf> {
    let mut zip = open_zip(path).ok()?;
    let names: Vec<String> = zip.file_names().map(str::to_string).collect();
    let is_slide =
        |n: &str| n.starts_with("ppt/slides/") && n.ends_with(".xml") && !n.contains("_rels/");

    // Cheap pre-pass: nothing to rewrite unless some slide is hidden.
    if !names.iter().any(|n| is_slide(n)) {
        return None;
    }
    let mut any_hidden = false;
    for name in names.iter().filter(|n| is_slide(n)) {
        if let Some(xml) = read_entry(&mut zip, name)
            && is_hidden_slide(&xml)
        {
            any_hidden = true;
            break;
        }
    }
    if !any_hidden {
        return None;
    }

    let seq = UNHIDE_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("mentro-unhide-{}-{seq}", std::process::id()));
    std::fs::create_dir_all(&dir).ok()?;
    let tmp = dir.join("deck.pptx");
    let fout = std::fs::File::create(&tmp).ok()?;
    let mut writer = zip::ZipWriter::new(fout);
    // Default compression is Deflated — LibreOffice accepts it fine.
    let opts = zip::write::SimpleFileOptions::default();
    for name in &names {
        let Ok(mut entry) = zip.by_name(name) else {
            continue;
        };
        if entry.is_dir() {
            writer.add_directory(name, opts).ok()?;
            continue;
        }
        if writer.start_file(name, opts).is_err() {
            return None;
        }
        if is_slide(name) {
            let mut xml = String::new();
            entry.read_to_string(&mut xml).ok()?;
            let patched = strip_root_show(&xml).unwrap_or(xml);
            writer.write_all(patched.as_bytes()).ok()?;
        } else {
            std::io::copy(&mut entry, &mut writer).ok()?;
        }
    }
    writer.finish().ok()?;
    Some(tmp)
}

fn find_notes_target(rels_xml: &str) -> Option<String> {
    let mut reader = quick_xml::Reader::from_str(rels_xml);
    reader.config_mut().trim_text(true);
    loop {
        match reader.read_event() {
            Ok(quick_xml::events::Event::Start(e)) if e.name().as_ref() == b"Relationship" => {
                let mut target = String::new();
                let mut kind = String::new();
                for attr in e.attributes().flatten() {
                    match attr.key.as_ref() {
                        b"Target" => target = String::from_utf8_lossy(&attr.value).to_string(),
                        b"Type" => kind = String::from_utf8_lossy(&attr.value).to_string(),
                        _ => {}
                    }
                }
                if kind.ends_with("notesSlide") {
                    // Targets are relative to ppt/slides/: ../notesSlides/...
                    return Some(target.trim_start_matches("../").to_string());
                }
            }
            Ok(quick_xml::events::Event::Eof) => return None,
            Ok(_) => {}
            Err(_) => return None,
        }
    }
}

/// DOCX: one unit per whole document (page-level split needs rendering).
pub fn extract_docx(path: &Path) -> WorkerResult<Vec<CMsgContentUnit>> {
    let mut zip = open_zip(path)?;
    let document = read_entry(&mut zip, "word/document.xml")
        .ok_or_else(|| WorkerError::invalid("not a docx: missing word/document.xml"))?;
    let text = docx_text(&document);
    let title = title_of(&text);
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

/// XLSX: one unit per sheet (name + shared strings of that sheet).
pub fn extract_xlsx(path: &Path) -> WorkerResult<Vec<CMsgContentUnit>> {
    let mut zip = open_zip(path)?;
    let workbook = read_entry(&mut zip, "xl/workbook.xml")
        .ok_or_else(|| WorkerError::invalid("not a xlsx: missing xl/workbook.xml"))?;

    // Sheet names in order.
    let mut sheet_names: Vec<String> = Vec::new();
    {
        let mut reader = quick_xml::Reader::from_str(&workbook);
        reader.config_mut().trim_text(true);
        loop {
            match reader.read_event() {
                Ok(quick_xml::events::Event::Start(e)) if e.name().as_ref() == b"sheet" => {
                    for attr in e.attributes().flatten() {
                        if attr.key.as_ref() == b"name" {
                            sheet_names.push(String::from_utf8_lossy(&attr.value).to_string());
                        }
                    }
                }
                Ok(quick_xml::events::Event::Empty(e)) if e.name().as_ref() == b"sheet" => {
                    for attr in e.attributes().flatten() {
                        if attr.key.as_ref() == b"name" {
                            sheet_names.push(String::from_utf8_lossy(&attr.value).to_string());
                        }
                    }
                }
                Ok(quick_xml::events::Event::Eof) => break,
                Ok(_) => {}
                Err(_) => break,
            }
        }
    }

    // Shared strings (all sheets share one pool).
    let shared = read_entry(&mut zip, "xl/sharedStrings.xml").unwrap_or_default();
    let strings = collect_shared_strings(&shared);

    let mut units = Vec::new();
    for (i, name) in sheet_names.iter().enumerate() {
        let n = i + 1;
        let sheet_xml =
            read_entry(&mut zip, &format!("xl/worksheets/sheet{n}.xml")).unwrap_or_default();
        // Inline cell text on this sheet.
        let inline = collect_inline_strings(&sheet_xml);
        let mut text = format!("[sheet] {name}\n");
        if !inline.is_empty() {
            text.push_str(&inline.join(" "));
        }
        // Shared-string references on this sheet (certain cells only).
        let refs = collect_shared_refs(&sheet_xml, &strings);
        if !refs.is_empty() {
            if !inline.is_empty() {
                text.push(' ');
            }
            text.push_str(&refs.join(" "));
        }
        units.push(CMsgContentUnit {
            ordinal: n as i32,
            unit_type: EUnitType::Sheet as i32,
            title: name.clone(),
            text,
            start_ms: 0,
            end_ms: 0,
            thumb_path: String::new(),
            hidden: false,
        });
    }
    Ok(units)
}

fn collect_shared_strings(xml: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut reader = quick_xml::Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut in_t = false;
    let mut buf = String::new();
    loop {
        match reader.read_event() {
            Ok(quick_xml::events::Event::Start(e)) if e.name().as_ref() == b"t" => {
                in_t = true;
                if !buf.is_empty() {
                    out.push(std::mem::take(&mut buf));
                }
            }
            Ok(quick_xml::events::Event::Text(t)) if in_t => {
                if let Ok(txt) = t.decode() {
                    buf.push_str(&txt);
                }
            }
            Ok(quick_xml::events::Event::End(e)) if e.name().as_ref() == b"t" => {
                in_t = false;
            }
            Ok(quick_xml::events::Event::Eof) => break,
            Ok(_) => {}
            Err(_) => break,
        }
    }
    if !buf.is_empty() {
        out.push(buf);
    }
    out
}

fn collect_inline_strings(xml: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut reader = quick_xml::Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut in_is_t = false;
    loop {
        match reader.read_event() {
            Ok(quick_xml::events::Event::Start(e)) if e.name().as_ref() == b"t" => {
                in_is_t = true;
            }
            Ok(quick_xml::events::Event::Text(t)) if in_is_t => {
                if let Ok(txt) = t.decode()
                    && !txt.trim().is_empty()
                {
                    out.push(txt.to_string());
                }
            }
            Ok(quick_xml::events::Event::End(e)) if e.name().as_ref() == b"t" => {
                in_is_t = false;
            }
            Ok(quick_xml::events::Event::Eof) => break,
            Ok(_) => {}
            Err(_) => break,
        }
    }
    out
}

fn collect_shared_refs(xml: &str, strings: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut reader = quick_xml::Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut in_value = false;
    loop {
        match reader.read_event() {
            Ok(quick_xml::events::Event::Start(e)) if e.name().as_ref() == b"v" => {
                in_value = true;
            }
            Ok(quick_xml::events::Event::Text(t)) if in_value => {
                if let Ok(txt) = t.decode()
                    && let Ok(idx) = txt.trim().parse::<usize>()
                    && let Some(s) = strings.get(idx)
                    && !s.trim().is_empty()
                {
                    out.push(s.clone());
                }
            }
            Ok(quick_xml::events::Event::End(e)) if e.name().as_ref() == b"v" => {
                in_value = false;
            }
            Ok(quick_xml::events::Event::Eof) => break,
            Ok(_) => {}
            Err(_) => break,
        }
    }
    out
}

#[cfg(test)]
mod hidden_slide_tests {
    use super::*;

    /// Minimal pptx: `hidden` marks which slides carry show="0".
    fn min_pptx(hidden: &[bool]) -> std::path::PathBuf {
        let tag: String = hidden.iter().map(|h| if *h { 'h' } else { 'v' }).collect();
        let dir = std::env::temp_dir().join(format!("mentro-ooxml-test-{tag}"));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("deck.pptx");
        let fout = std::fs::File::create(&path).unwrap();
        let mut w = zip::ZipWriter::new(fout);
        let opts = zip::write::SimpleFileOptions::default();

        let n = hidden.len();
        let ids: Vec<String> = (1..=n)
            .map(|i| format!("<p:sldId id=\"{i}\" r:id=\"rId{i}\"/>"))
            .collect();
        w.start_file("ppt/presentation.xml", opts).unwrap();
        write!(
            w,
            "<?xml?><p:presentation xmlns:r=\"x\">{}</p:presentation>",
            ids.join("")
        )
        .unwrap();

        let rels: Vec<String> = (1..=n)
            .map(|i| {
                format!(
                    "<Relationship Id=\"rId{i}\" Type=\"slide\" Target=\"slides/slide{i}.xml\"/>"
                )
            })
            .collect();
        w.start_file("ppt/_rels/presentation.xml.rels", opts)
            .unwrap();
        write!(w, "<?xml?><Relationships>{}</Relationships>", rels.join("")).unwrap();

        for (i, hid) in hidden.iter().enumerate() {
            let sn = i + 1;
            w.start_file(format!("ppt/slides/slide{sn}.xml"), opts)
                .unwrap();
            let show = if *hid { " show=\"0\"" } else { "" };
            write!(
                w,
                "<?xml version=\"1.0\"?><p:sld{show}><p:txBody><a:t>slide {sn}</a:t></p:txBody></p:sld>"
            )
            .unwrap();
        }
        w.finish().unwrap();
        path
    }

    #[test]
    fn hidden_slides_stay_in_units() {
        let units = extract_pptx(&min_pptx(&[false, true, false])).unwrap();
        assert_eq!(units.len(), 3);
        // Ordinals follow the true sldIdLst position, hidden included.
        assert_eq!(
            units.iter().map(|u| u.ordinal).collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        assert!(!units[0].hidden);
        assert!(units[1].hidden);
        assert!(!units[2].hidden);
        assert!(units[1].text.contains("slide 2"));
    }

    #[test]
    fn unhidden_copy_strips_show_from_slides_only() {
        let path = min_pptx(&[true]);
        let copy = unhidden_pptx_copy(&path).unwrap();
        let mut z = open_zip(&copy).unwrap();
        let xml = read_entry(&mut z, "ppt/slides/slide1.xml").unwrap();
        assert!(
            xml.starts_with("<?xml version=\"1.0\"?><p:sld>"),
            "root show gone: {xml}"
        );
        // Untouched sibling entry survives byte-for-byte semantics.
        assert!(
            read_entry(&mut z, "ppt/presentation.xml")
                .unwrap()
                .contains("rId1")
        );
        // The original deck is not modified.
        let mut z0 = open_zip(&path).unwrap();
        assert!(
            read_entry(&mut z0, "ppt/slides/slide1.xml")
                .unwrap()
                .contains("show=\"0\"")
        );
    }

    #[test]
    fn multi_byte_char_at_scan_boundary_does_not_panic() {
        // A CJK codepoint straddling byte 600 of the scan head must not
        // panic the byte slice (regression: deck extraction crashed).
        let mut xml = String::from("<?xml version=\"1.0\"?><p:sld show=\"0\"><a:t>");
        while xml.len() < 598 {
            xml.push('x');
        }
        xml.push('港'); // 3-byte codepoint spanning 598..=600
        xml.push_str("</a:t></p:sld>");
        assert!(is_hidden_slide(&xml));
    }

    #[test]
    fn no_hidden_slides_means_no_copy() {
        assert!(unhidden_pptx_copy(&min_pptx(&[false, false])).is_none());
    }

    #[test]
    fn non_pptx_returns_none() {
        // A docx-shaped zip has no slides: no rewrite.
        let dir = std::env::temp_dir().join("mentro-ooxml-test-doc");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.docx");
        let fout = std::fs::File::create(&path).unwrap();
        let mut w = zip::ZipWriter::new(fout);
        w.start_file(
            "word/document.xml",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        write!(w, "<w:document/>").unwrap();
        w.finish().unwrap();
        assert!(unhidden_pptx_copy(&path).is_none());
    }
}
