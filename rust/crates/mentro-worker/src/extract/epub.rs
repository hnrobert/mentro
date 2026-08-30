//! EPUB extraction: zip-based e-book. Extracts spine order from OPF,
//! chapter text from XHTML files, and cover image.

use std::{io::Read, path::Path};

use crate::{
    error::{WorkerError, WorkerResult},
    proto::mentro::worker::v1::{CMsgContentUnit, EUnitType},
};

fn open_zip(path: &Path) -> WorkerResult<zip::ZipArchive<std::fs::File>> {
    let file = std::fs::File::open(path)
        .map_err(|e| WorkerError::invalid(format!("open {}: {e}", path.display())))?;
    zip::ZipArchive::new(file).map_err(|e| WorkerError::invalid(format!("bad epub: {e}")))
}

fn read_entry(archive: &mut zip::ZipArchive<std::fs::File>, name: &str) -> Option<String> {
    let mut entry = archive.by_name(name).ok()?;
    let mut text = String::new();
    entry.read_to_string(&mut text).ok()?;
    Some(text)
}

/// Strip HTML tags to plain text (rough but effective for chapters).
fn html_to_text(html: &str) -> String {
    let mut reader = quick_xml::Reader::from_str(html);
    reader.config_mut().trim_text(true);
    let mut out = String::new();
    let mut in_body = false;
    let mut skip_tag = false;
    loop {
        use quick_xml::events::Event;
        match reader.read_event() {
            Ok(Event::Start(ref e)) => {
                let name = e.name();
                let name = name.as_ref().to_vec();
                if name == b"body" {
                    in_body = true;
                } else if in_body && (name == b"script".to_vec() || name == b"style".to_vec()) {
                    skip_tag = true;
                } else if in_body
                    && (name == b"p"
                        || name == b"br"
                        || name == b"div"
                        || name == b"h1"
                        || name == b"h2"
                        || name == b"h3")
                    && !out.is_empty()
                    && !out.ends_with('\n')
                {
                    out.push('\n');
                }
            }
            Ok(Event::End(ref e)) => {
                let name = e.name();
                let name = name.as_ref().to_vec();
                if name == b"body" {
                    break;
                }
                if name == b"script" || name == b"style" {
                    skip_tag = false;
                }
            }
            Ok(Event::Text(t)) if in_body && !skip_tag => {
                if let Ok(txt) = t.decode() {
                    let trimmed = txt.trim();
                    if !trimmed.is_empty() {
                        if !out.is_empty() && !out.ends_with('\n') {
                            out.push(' ');
                        }
                        out.push_str(trimmed);
                    }
                }
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(_) => break,
        }
    }
    out
}

fn title_of(text: &str) -> String {
    for line in text.lines() {
        let t = line.trim();
        if !t.is_empty() {
            return t.chars().take(120).collect();
        }
    }
    String::new()
}

pub fn extract_epub(path: &Path) -> WorkerResult<Vec<CMsgContentUnit>> {
    let mut zip = open_zip(path)?;

    // 1. Find the OPF file from META-INF/container.xml
    let container = read_entry(&mut zip, "META-INF/container.xml")
        .ok_or_else(|| WorkerError::invalid("epub missing container.xml"))?;

    let mut opf_path = String::new();
    {
        let mut reader = quick_xml::Reader::from_str(&container);
        reader.config_mut().trim_text(true);
        use quick_xml::events::Event;
        loop {
            match reader.read_event() {
                Ok(Event::Start(e)) if e.name().as_ref() == b"rootfile" => {
                    for attr in e.attributes().flatten() {
                        if attr.key.as_ref() == b"full-path" {
                            opf_path = String::from_utf8_lossy(&attr.value).to_string();
                        }
                    }
                }
                Ok(Event::Eof) => break,
                Ok(_) => {}
                Err(_) => break,
            }
        }
    }
    if opf_path.is_empty() {
        return Err(WorkerError::invalid(
            "epub container.xml missing rootfile path",
        ));
    }

    // 2. Parse the OPF to get spine (reading order) and manifest.
    let opf =
        read_entry(&mut zip, &opf_path).ok_or_else(|| WorkerError::invalid("epub missing OPF"))?;

    let mut manifest = std::collections::HashMap::new(); // id -> href
    let mut spine = Vec::<String>::new(); // idrefs in order
    let opf_dir = std::path::Path::new(&opf_path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    {
        let mut reader = quick_xml::Reader::from_str(&opf);
        reader.config_mut().trim_text(true);
        use quick_xml::events::Event;
        loop {
            match reader.read_event() {
                Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
                    let name = e.name();
                    let name = name.as_ref().to_vec();
                    match name.as_slice() {
                        b"item" => {
                            let mut id = String::new();
                            let mut href = String::new();
                            for attr in e.attributes().flatten() {
                                match attr.key.as_ref() {
                                    b"id" => id = String::from_utf8_lossy(&attr.value).to_string(),
                                    b"href" => {
                                        href = String::from_utf8_lossy(&attr.value).to_string()
                                    }
                                    _ => {}
                                }
                            }
                            if !id.is_empty() && !href.is_empty() {
                                manifest.insert(id, href);
                            }
                        }
                        b"itemref" => {
                            for attr in e.attributes().flatten() {
                                if attr.key.as_ref() == b"idref" {
                                    spine.push(String::from_utf8_lossy(&attr.value).to_string());
                                }
                            }
                        }
                        _ => {}
                    }
                }
                Ok(Event::Eof) => break,
                Ok(_) => {}
                Err(_) => break,
            }
        }
    }

    // 3. Walk spine, extract chapter text.
    let mut units = Vec::new();
    for (i, idref) in spine.iter().enumerate() {
        let Some(href) = manifest.get(idref) else {
            continue;
        };
        let full_path = if opf_dir.is_empty() {
            href.clone()
        } else {
            format!("{opf_dir}/{href}")
        };
        // URL-decode the path (epub hrefs can be percent-encoded)
        let decoded = full_path
            .replace("%20", " ")
            .replace("%28", "(")
            .replace("%29", ")");
        let Some(html) = read_entry(&mut zip, &decoded) else {
            continue;
        };
        let text = html_to_text(&html);
        if text.trim().is_empty() {
            continue;
        }
        let title = title_of(&text);
        units.push(CMsgContentUnit {
            ordinal: (i + 1) as i32,
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
