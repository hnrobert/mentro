//! OOXML text extraction: PPTX (slides in presentation order + notes),
//! DOCX (paragraphs), XLSX (sheet names + shared strings). Pure
//! zip + XML walking — no external tools, no rendering here.

use std::io::Read;
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
                    if !out.is_empty() {
                        out.push(' ');
                    }
                    out.push_str(&txt);
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
                    if in_para && !out.is_empty() && !out.ends_with('\n') {
                        // runs within one paragraph join with space
                        if !out.ends_with(' ') && !out.is_empty() {
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

    // 3. Walk slides in order; pull slide + notes text.
    let mut units = Vec::new();
    for (i, rid) in r_ids.iter().enumerate() {
        let target = target_by_id
            .get(rid)
            .cloned()
            .unwrap_or_else(|| format!("slides/slide{}.xml", i + 1));
        let entry = format!("ppt/{target}");
        let slide_xml = read_entry(&mut zip, &entry).unwrap_or_default();
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
                text.push_str("\n\n[备注] ");
                text.push_str(&notes);
            }
        }

        let title = title_of(&text);
        units.push(CMsgContentUnit {
            ordinal: (i + 1) as i32,
            unit_type: EUnitType::Slide as i32,
            title,
            text,
            start_ms: 0,
            end_ms: 0,
            thumb_path: String::new(),
        });
    }
    Ok(units)
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
