//! PPTX selected-slide export: OOXML surgery on the package zip. Kept
//! parts are copied **byte-verbatim** (`raw_copy_file` — compression and
//! content untouched), so slide XML, media, and masters keep full fidelity.
//! Only three structural parts are rewritten:
//!
//! - `ppt/presentation.xml` — `p:sldIdLst` reduced (and renumbered) to the
//!   selected slides, in the requested order;
//! - `ppt/_rels/presentation.xml.rels` — relationships of dropped slides
//!   removed, everything else kept verbatim;
//! - `[Content_Types].xml` — Override entries of dropped slide parts
//!   removed (an Override naming a missing part is what actually trips
//!   PowerPoint's repair).
//!
//! Orphaned media / notes slides of dropped slides are left in place:
//! OPC allows unreferenced parts, and deleting them would require parsing
//! every dropped slide's relationship graph for marginal size savings.
//! `docProps/app.xml` (slide-count metadata) is likewise left stale —
//! PowerPoint regenerates it on save.

use std::{
    collections::{HashMap, HashSet},
    io::{Read, Write},
    path::Path,
};

use quick_xml::{
    Reader, Writer,
    events::{BytesStart, Event},
};
use zip::ZipWriter;

use crate::{
    error::{WorkerError, WorkerResult},
    proto::mentro::worker::v1::CMsgUnitRef,
};

const PRESENTATION_PART: &str = "ppt/presentation.xml";
const PRESENTATION_RELS: &str = "ppt/_rels/presentation.xml.rels";
const CONTENT_TYPES: &str = "[Content_Types].xml";

/// One `p:sldId` entry: `id` attribute + relationship id.
type SldId = (String, String);

pub fn export_pptx(units: &[CMsgUnitRef], out: &Path) -> WorkerResult<()> {
    let paths: HashSet<&str> = units.iter().map(|u| u.path.as_str()).collect();
    if paths.len() > 1 {
        return Err(WorkerError::invalid(
            "pptx export needs units from a single source presentation",
        ));
    }
    let src = Path::new(units[0].path.as_str());
    if !src.is_file() {
        return Err(WorkerError::invalid(format!(
            "not a file: {}",
            src.display()
        )));
    }

    let fin = std::fs::File::open(src)
        .map_err(|e| WorkerError::invalid(format!("open {}: {e}", src.display())))?;
    let mut zip = zip::ZipArchive::new(fin)
        .map_err(|e| WorkerError::invalid(format!("unzip {}: {e}", src.display())))?;

    let presentation = read_part(&mut zip, PRESENTATION_PART)?;
    let rels = read_part(&mut zip, PRESENTATION_RELS)?;

    let slide_ids = slide_id_list(&presentation)?;
    let rid_targets = relationship_targets(&rels);

    // ordinal -> (sldId id, rid), then to slide part names.
    let mut kept: Vec<(String, String)> = Vec::new(); // (id, rid) in output order
    let mut kept_parts: HashSet<String> = HashSet::new();
    for unit in units {
        let entry = slide_ids.get(unit.ordinal as usize - 1).ok_or_else(|| {
            WorkerError::invalid(format!(
                "slide {} out of range (deck has {})",
                unit.ordinal,
                slide_ids.len()
            ))
        })?;
        kept.push(entry.clone());
        let target = rid_targets
            .get(&entry.1)
            .ok_or_else(|| WorkerError::invalid(format!("rel {} missing", entry.1)))?;
        kept_parts.insert(normalize_part(target));
    }

    let dropped_parts: HashSet<String> = slide_ids
        .iter()
        .filter_map(|(_, rid)| rid_targets.get(rid))
        .map(|t| normalize_part(t))
        .filter(|p| !kept_parts.contains(p))
        .collect();
    let dropped_rids: HashSet<String> = slide_ids
        .iter()
        .filter(|(_, rid)| {
            rid_targets
                .get(rid)
                .map(|t| dropped_parts.contains(&normalize_part(t)))
                .unwrap_or(false)
        })
        .map(|(_, rid)| rid.clone())
        .collect();

    let new_presentation = rewrite_presentation(&presentation, &kept)?;
    let new_rels = filter_relationships(&rels, &dropped_rids)?;

    let fout = std::fs::File::create(out)
        .map_err(|e| WorkerError::internal(format!("create {}: {e}", out.display())))?;
    let mut writer = ZipWriter::new(fout);

    for i in 0..zip.len() {
        let name = {
            let f = zip
                .by_index_raw(i)
                .map_err(|e| WorkerError::invalid(format!("zip entry {i}: {e}")))?;
            f.name().to_string()
        };
        if name == PRESENTATION_PART {
            rewrite_entry(&mut writer, &name, new_presentation.as_bytes())?;
        } else if name == PRESENTATION_RELS {
            rewrite_entry(&mut writer, &name, new_rels.as_bytes())?;
        } else if name == CONTENT_TYPES {
            let mut buf = String::new();
            zip.by_index(i)
                .and_then(|mut f| f.read_to_string(&mut buf).map_err(Into::into))
                .map_err(|e| WorkerError::invalid(format!("read {name}: {e}")))?;
            let filtered = filter_content_types(&buf, &dropped_parts)?;
            rewrite_entry(&mut writer, &name, filtered.as_bytes())?;
        } else if dropped_parts.contains(&name)
            || dropped_slide_rels(&dropped_parts).contains(&name)
        {
            // slide (and its rels) removed
        } else {
            let f = zip
                .by_index_raw(i)
                .map_err(|e| WorkerError::invalid(format!("zip entry {i}: {e}")))?;
            writer
                .raw_copy_file(f)
                .map_err(|e| WorkerError::invalid(format!("copy {name}: {e}")))?;
        }
    }

    writer
        .finish()
        .map_err(|e| WorkerError::internal(format!("finish zip: {e}")))?;
    Ok(())
}

/// OPC rels rule: part `a/b/c.xml` has rels at `a/b/_rels/c.xml.rels`.
fn rels_path_of(part: &str) -> String {
    match part.rsplit_once('/') {
        Some((dir, base)) => format!("{dir}/_rels/{base}.rels"),
        None => format!("_rels/{part}.rels"),
    }
}

fn dropped_slide_rels(dropped_parts: &HashSet<String>) -> HashSet<String> {
    dropped_parts.iter().map(|p| rels_path_of(p)).collect()
}

fn read_part(zip: &mut zip::ZipArchive<std::fs::File>, name: &str) -> WorkerResult<String> {
    let mut buf = String::new();
    zip.by_name(name)
        .and_then(|mut f| f.read_to_string(&mut buf).map_err(Into::into))
        .map_err(|e| WorkerError::invalid(format!("read {name}: {e}")))?;
    Ok(buf)
}

fn rewrite_entry(
    writer: &mut ZipWriter<std::fs::File>,
    name: &str,
    bytes: &[u8],
) -> WorkerResult<()> {
    writer
        .start_file(name, zip::write::SimpleFileOptions::default())
        .map_err(|e| WorkerError::internal(format!("start {name}: {e}")))?;
    writer
        .write_all(bytes)
        .map_err(|e| WorkerError::internal(format!("write {name}: {e}")))?;
    Ok(())
}

/// `p:sldId` entries of `p:sldIdLst`, in document order.
fn slide_id_list(xml: &str) -> WorkerResult<Vec<SldId>> {
    let mut reader = Reader::from_str(xml);
    let mut out = Vec::new();
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                if e.name().as_ref() == b"p:sldId" {
                    let mut id = String::new();
                    let mut rid = String::new();
                    for attr in e.attributes() {
                        let attr = attr.map_err(|e| WorkerError::invalid(format!("attr: {e}")))?;
                        match attr.key.as_ref() {
                            b"id" => id = String::from_utf8_lossy(&attr.value).to_string(),
                            b"r:id" => rid = String::from_utf8_lossy(&attr.value).to_string(),
                            _ => {}
                        }
                    }
                    if !rid.is_empty() {
                        out.push((id, rid));
                    }
                }
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(e) => return Err(WorkerError::invalid(format!("presentation.xml: {e}"))),
        }
        buf.clear();
    }
    Ok(out)
}

/// rId -> relationship Target from a .rels document.
fn relationship_targets(xml: &str) -> HashMap<String, String> {
    let mut reader = Reader::from_str(xml);
    let mut out = HashMap::new();
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                if e.name().as_ref() == b"Relationship" {
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
                        out.insert(id, target);
                    }
                }
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(_) => break,
        }
        buf.clear();
    }
    out
}

/// Resolve a presentation-relative Target to a zip part name
/// (`slides/slide3.xml` -> `ppt/slides/slide3.xml`, with `..` collapsed).
fn normalize_part(target: &str) -> String {
    let base = if let Some(rest) = target.strip_prefix('/') {
        rest.to_string()
    } else {
        format!("ppt/{target}")
    };
    let mut stack: Vec<&str> = Vec::new();
    for seg in base.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                stack.pop();
            }
            other => stack.push(other),
        }
    }
    stack.join("/")
}

/// Rewrite presentation.xml with `p:sldIdLst` reduced to `kept`
/// (renumbered 256..). Everything else roundtrips event-verbatim.
fn rewrite_presentation(xml: &str, kept: &[SldId]) -> WorkerResult<String> {
    let mut reader = Reader::from_str(xml);
    let mut writer = Writer::new(Vec::new());
    let mut buf = Vec::new();
    let mut in_list = false;
    let mut seen_list = false;
    loop {
        let event = reader
            .read_event_into(&mut buf)
            .map_err(|e| WorkerError::invalid(format!("presentation.xml: {e}")))?;
        match event {
            Event::Start(e) if e.name().as_ref() == b"p:sldIdLst" => {
                writer
                    .write_event(Event::Start(e.into_owned()))
                    .map_err(|e| WorkerError::internal(format!("xml write: {e}")))?;
                in_list = true;
                seen_list = true;
                for (n, (_, rid)) in kept.iter().enumerate() {
                    let mut el = BytesStart::new("p:sldId");
                    // sldId ids: >= 256, unique — renumber deterministically.
                    el.push_attribute(("id", (256 + n).to_string().as_str()));
                    el.push_attribute(("r:id", rid.as_str()));
                    writer
                        .write_event(Event::Empty(el))
                        .map_err(|e| WorkerError::internal(format!("xml write: {e}")))?;
                }
            }
            Event::End(e) if e.name().as_ref() == b"p:sldIdLst" => {
                writer
                    .write_event(Event::End(e.into_owned()))
                    .map_err(|e| WorkerError::internal(format!("xml write: {e}")))?;
                in_list = false;
            }
            _ if in_list => { /* original sldId children replaced above */ }
            Event::Eof => break,
            other => {
                writer
                    .write_event(other.into_owned())
                    .map_err(|e| WorkerError::internal(format!("xml write: {e}")))?;
            }
        }
        buf.clear();
    }
    if !seen_list {
        return Err(WorkerError::invalid("presentation.xml has no p:sldIdLst"));
    }
    Ok(String::from_utf8_lossy(&writer.into_inner()).to_string())
}

/// Drop `<Relationship>` elements whose Id is in `drop` (roundtrip
/// everything else).
fn filter_relationships(xml: &str, drop: &HashSet<String>) -> WorkerResult<String> {
    filter_elements(xml, |e| {
        if e.name().as_ref() != b"Relationship" {
            return false;
        }
        e.attributes()
            .flatten()
            .find(|a| a.key.as_ref() == b"Id")
            .map(|a| drop.contains(String::from_utf8_lossy(&a.value).as_ref()))
            .unwrap_or(false)
    })
    .map_err(|e| WorkerError::invalid(format!("rels: {e}")))
}

/// Drop `<Override PartName="...">` elements naming dropped parts.
fn filter_content_types(xml: &str, drop_parts: &HashSet<String>) -> WorkerResult<String> {
    filter_elements(xml, |e| {
        if e.name().as_ref() != b"Override" {
            return false;
        }
        e.attributes()
            .flatten()
            .find(|a| a.key.as_ref() == b"PartName")
            .map(|a| {
                let part = String::from_utf8_lossy(&a.value);
                drop_parts.contains(part.trim_start_matches('/'))
            })
            .unwrap_or(false)
    })
    .map_err(|e| WorkerError::invalid(format!("content types: {e}")))
}

/// Reader->Writer roundtrip that skips Start/Empty elements matching
/// `drop_if` (and their End events).
fn filter_elements(
    xml: &str,
    drop_if: impl Fn(&BytesStart<'_>) -> bool,
) -> Result<String, quick_xml::Error> {
    let mut reader = Reader::from_str(xml);
    let mut writer = Writer::new(Vec::new());
    let mut buf = Vec::new();
    let mut skip_depth = 0usize;
    loop {
        let event = reader.read_event_into(&mut buf)?;
        let drop_current = match &event {
            Event::Start(e) if drop_if(e) => {
                skip_depth += 1;
                None
            }
            Event::Empty(e) if skip_depth == 0 && drop_if(e) => None,
            Event::End(_) if skip_depth > 0 => {
                skip_depth -= 1;
                None
            }
            Event::Eof => break,
            _ => Some(event),
        };
        if let Some(ev) = drop_current {
            writer.write_event(ev.into_owned())?;
        }
        buf.clear();
    }
    Ok(String::from_utf8_lossy(&writer.into_inner()).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_slide_targets() {
        assert_eq!(normalize_part("slides/slide3.xml"), "ppt/slides/slide3.xml");
        // Presentation-level rels resolve against ppt/: `..` lands at the
        // package root.
        assert_eq!(normalize_part("../media/pic.png"), "media/pic.png");
        assert_eq!(
            normalize_part("/ppt/slides/slide1.xml"),
            "ppt/slides/slide1.xml"
        );
    }

    #[test]
    fn rels_follow_opc_directory_rule() {
        assert_eq!(
            rels_path_of("ppt/slides/slide2.xml"),
            "ppt/slides/_rels/slide2.xml.rels"
        );
        assert_eq!(rels_path_of("ppt/presentation.xml"), PRESENTATION_RELS);
    }

    #[test]
    fn rewrites_sld_id_list() {
        let xml = r#"<?xml version="1.0"?><p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/><p:sldId id="258" r:id="rId4"/></p:sldIdLst><p:sldSz cx="1"/></p:presentation>"#;
        let out = rewrite_presentation(xml, &[("257".into(), "rId3".into())]).unwrap();
        assert!(out.contains(r#"<p:sldId id="256" r:id="rId3"/>"#));
        assert!(!out.contains("rId2"));
        assert!(!out.contains("rId4"));
        assert!(out.contains("p:sldSz"));
    }

    #[test]
    fn renumbers_and_reorders_slides() {
        let xml = r#"<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst></p:presentation>"#;
        let out = rewrite_presentation(
            xml,
            &[("257".into(), "rId3".into()), ("256".into(), "rId2".into())],
        )
        .unwrap();
        // Output order = requested order, ids renumbered sequentially.
        let a = out.find(r#"<p:sldId id="256""#).unwrap();
        let b = out.find(r#"<p:sldId id="257""#).unwrap();
        assert!(a < b);
        assert!(out[a..].starts_with(r#"<p:sldId id="256" r:id="rId3"/>"#));
    }

    #[test]
    fn filters_dropped_relationships() {
        let xml = r#"<Relationships><Relationship Id="rId1" Type="t" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId2" Type="t" Target="slides/slide1.xml"/></Relationships>"#;
        let drop: HashSet<String> = ["rId2".to_string()].into();
        let out = filter_relationships(xml, &drop).unwrap();
        assert!(out.contains("rId1"));
        assert!(!out.contains("rId2"));
    }

    #[test]
    fn filters_content_type_overrides() {
        let xml = r#"<Types><Override PartName="/ppt/slides/slide1.xml" ContentType="a"/><Override PartName="/ppt/slides/slide2.xml" ContentType="a"/></Types>"#;
        let drop: HashSet<String> = ["ppt/slides/slide2.xml".to_string()].into();
        let out = filter_content_types(xml, &drop).unwrap();
        assert!(out.contains("slide1.xml"));
        assert!(!out.contains("slide2.xml"));
    }

    #[test]
    fn reads_slide_ids_in_order() {
        let xml = r#"<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst></p:presentation>"#;
        let ids = slide_id_list(xml).unwrap();
        assert_eq!(ids.len(), 2);
        assert_eq!(ids[0], ("256".to_string(), "rId2".to_string()));
        assert_eq!(ids[1], ("257".to_string(), "rId3".to_string()));
    }
}
