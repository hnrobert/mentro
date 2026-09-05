//! PPTX selected-slide export: OOXML surgery on the package zip. The
//! keep-set is computed as a REACHABILITY CLOSURE over the package's
//! relationship graph, rooted at the package manifest and presentation
//! part — every part not reachable from the new slide list (dropped
//! slides, their layouts' orphaned media, unused videos/images) is
//! removed. Kept parts are copied **byte-verbatim** (`raw_copy_file` —
//! compression and content untouched), so slide XML, media, and masters
//! keep full fidelity; a one-slide crop of a 500 MB deck exports only
//! that slide's dependencies.
//!
//! Three structural parts are rewritten:
//!
//! - `ppt/presentation.xml` — `p:sldIdLst` reduced (and renumbered) to the
//!   selected slides, in the requested order;
//! - `ppt/_rels/presentation.xml.rels` — relationships of dropped slides
//!   removed, everything else kept verbatim;
//! - `[Content_Types].xml` — Override entries naming pruned parts removed
//!   (an Override naming a missing part is what trips PowerPoint's
//!   repair).
//!
//! `docProps/app.xml` (slide-count metadata) stays stale — PowerPoint
//! regenerates it on save.

use std::{
    collections::{HashMap, HashSet},
    io::Read,
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
const PACKAGE_RELS: &str = "_rels/.rels";

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
    for unit in units {
        let entry = slide_ids.get(unit.ordinal as usize - 1).ok_or_else(|| {
            WorkerError::invalid(format!(
                "slide {} out of range (deck has {})",
                unit.ordinal,
                slide_ids.len()
            ))
        })?;
        rid_targets
            .get(&entry.1)
            .ok_or_else(|| WorkerError::invalid(format!("rel {} missing", entry.1)))?;
        kept.push(entry.clone());
    }
    let dropped_rids: HashSet<String> = slide_ids
        .iter()
        .filter(|(_, rid)| !kept.iter().any(|(_, k)| k == rid))
        .map(|(_, rid)| rid.clone())
        .collect();

    // Keep-set: BFS the relationship graph from the package manifest.
    // Everything reachable (minus dropped slides) ships; the rest —
    // orphaned media, layouts, notes — is pruned. Selected slides are
    // reached through the presentation's relationships, so their media
    // and layouts are walked transitively.
    let mut keep: HashSet<String> = HashSet::from([CONTENT_TYPES.to_string()]);
    let mut owners: Vec<String> = vec![String::new()]; // "" = package root
    while let Some(owner) = owners.pop() {
        let rels_name = rels_of(&owner);
        let Some(xml) = try_read_part(&mut zip, &rels_name) else {
            continue;
        };
        keep.insert(rels_name);
        for rel in relationships(&xml) {
            if rel.external {
                continue;
            }
            // The presentation's rels point at every slide, including
            // dropped ones — the rewrite drops those relationships.
            if owner == PRESENTATION_PART && dropped_rids.contains(&rel.id) {
                continue;
            }
            let part = resolve_against(&owner, &rel.target);
            if keep.insert(part.clone()) {
                owners.push(part);
            }
        }
    }

    let new_presentation = rewrite_presentation(&presentation, &kept)?;
    let new_rels = filter_relationships(&rels, &dropped_rids)?;
    let new_content_types = filter_content_types(
        &try_read_part(&mut zip, CONTENT_TYPES).unwrap_or_default(),
        &keep,
    )?;

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
        if !keep.contains(&name) {
            continue; // unreachable from the new slide list
        }
        if name == PRESENTATION_PART {
            rewrite_entry(&mut writer, &name, new_presentation.as_bytes())?;
        } else if name == PRESENTATION_RELS {
            rewrite_entry(&mut writer, &name, new_rels.as_bytes())?;
        } else if name == CONTENT_TYPES {
            rewrite_entry(&mut writer, &name, new_content_types.as_bytes())?;
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

fn read_part(zip: &mut zip::ZipArchive<std::fs::File>, name: &str) -> WorkerResult<String> {
    let mut buf = String::new();
    zip.by_name(name)
        .and_then(|mut f| f.read_to_string(&mut buf).map_err(Into::into))
        .map_err(|e| WorkerError::invalid(format!("read {name}: {e}")))?;
    Ok(buf)
}

fn try_read_part(zip: &mut zip::ZipArchive<std::fs::File>, name: &str) -> Option<String> {
    let mut buf = String::new();
    zip.by_name(name)
        .and_then(|mut f| f.read_to_string(&mut buf).map_err(Into::into))
        .ok()?;
    Some(buf)
}

fn rewrite_entry(
    writer: &mut ZipWriter<std::fs::File>,
    name: &str,
    bytes: &[u8],
) -> WorkerResult<()> {
    use std::io::Write;
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

/// One `<Relationship>` in a .rels document.
struct Rel {
    id: String,
    target: String,
    external: bool,
}

/// rId -> Target (internal relationships only is NOT assumed; the map
/// holds all, external targets are filtered at BFS time).
fn relationship_targets(xml: &str) -> HashMap<String, String> {
    relationships(xml)
        .into_iter()
        .map(|r| (r.id, r.target))
        .collect()
}

fn relationships(xml: &str) -> Vec<Rel> {
    let mut reader = Reader::from_str(xml);
    let mut out = Vec::new();
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                if e.name().as_ref() == b"Relationship" {
                    let mut id = String::new();
                    let mut target = String::new();
                    let mut external = false;
                    for attr in e.attributes().flatten() {
                        match attr.key.as_ref() {
                            b"Id" => id = String::from_utf8_lossy(&attr.value).to_string(),
                            b"Target" => target = String::from_utf8_lossy(&attr.value).to_string(),
                            b"TargetMode" => {
                                external = String::from_utf8_lossy(&attr.value)
                                    .eq_ignore_ascii_case("External");
                            }
                            _ => {}
                        }
                    }
                    if !id.is_empty() {
                        out.push(Rel {
                            id,
                            target,
                            external,
                        });
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

/// OPC rels rule: part `a/b/c.xml` has rels at `a/b/_rels/c.xml.rels`;
/// the package root uses `_rels/.rels`.
fn rels_of(part: &str) -> String {
    if part.is_empty() {
        return PACKAGE_RELS.to_string();
    }
    rels_path_of(part)
}

fn rels_path_of(part: &str) -> String {
    match part.rsplit_once('/') {
        Some((dir, base)) => format!("{dir}/_rels/{base}.rels"),
        None => format!("_rels/{part}.rels"),
    }
}

/// Resolve a relationship Target against its owner part's directory.
fn resolve_against(owner: &str, target: &str) -> String {
    if let Some(rest) = target.strip_prefix('/') {
        // Absolute part names resolve from the package root.
        return normalize_segments(rest.split('/'));
    }
    let owner_dir = match owner.rsplit_once('/') {
        Some((dir, _)) => format!("{dir}/"),
        None => String::new(),
    };
    normalize_segments(format!("{owner_dir}{target}").split('/'))
}

fn normalize_segments<'a>(parts: impl Iterator<Item = &'a str>) -> String {
    let mut stack: Vec<&str> = Vec::new();
    for seg in parts {
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
    let mut reader = Reader::from_str(xml);
    let mut writer = Writer::new(Vec::new());
    let mut buf = Vec::new();
    loop {
        let event = reader
            .read_event_into(&mut buf)
            .map_err(|e| WorkerError::invalid(format!("rels: {e}")))?;
        let skip = match &event {
            Event::Start(e) | Event::Empty(e) if e.name().as_ref() == b"Relationship" => e
                .attributes()
                .flatten()
                .find(|a| a.key.as_ref() == b"Id")
                .map(|a| drop.contains(String::from_utf8_lossy(&a.value).as_ref()))
                .unwrap_or(false),
            Event::Eof => break,
            _ => false,
        };
        if !skip {
            writer
                .write_event(event.into_owned())
                .map_err(|e| WorkerError::internal(format!("xml write: {e}")))?;
        }
        buf.clear();
    }
    Ok(String::from_utf8_lossy(&writer.into_inner()).to_string())
}

/// Drop `<Override PartName="...">` elements naming parts outside `keep`.
fn filter_content_types(xml: &str, keep: &HashSet<String>) -> WorkerResult<String> {
    let mut reader = Reader::from_str(xml);
    let mut writer = Writer::new(Vec::new());
    let mut buf = Vec::new();
    loop {
        let event = reader
            .read_event_into(&mut buf)
            .map_err(|e| WorkerError::invalid(format!("content types: {e}")))?;
        let skip = match &event {
            Event::Start(e) | Event::Empty(e) if e.name().as_ref() == b"Override" => e
                .attributes()
                .flatten()
                .find(|a| a.key.as_ref() == b"PartName")
                .map(|a| {
                    let part = String::from_utf8_lossy(&a.value);
                    !keep.contains(part.trim_start_matches('/'))
                })
                .unwrap_or(false),
            Event::Eof => break,
            _ => false,
        };
        if !skip {
            writer
                .write_event(event.into_owned())
                .map_err(|e| WorkerError::internal(format!("xml write: {e}")))?;
        }
        buf.clear();
    }
    Ok(String::from_utf8_lossy(&writer.into_inner()).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rels_follow_opc_directory_rule() {
        assert_eq!(
            rels_path_of("ppt/slides/slide2.xml"),
            "ppt/slides/_rels/slide2.xml.rels"
        );
        assert_eq!(rels_path_of("ppt/presentation.xml"), PRESENTATION_RELS);
        assert_eq!(rels_of(""), PACKAGE_RELS);
    }

    #[test]
    fn resolves_targets_against_owner() {
        // presentation.xml (in ppt/) -> slides/slide1.xml
        assert_eq!(
            resolve_against("ppt/presentation.xml", "slides/slide1.xml"),
            "ppt/slides/slide1.xml"
        );
        // slide (in ppt/slides/) -> ../media/pic.png
        assert_eq!(
            resolve_against("ppt/slides/slide1.xml", "../media/pic.png"),
            "ppt/media/pic.png"
        );
        // package root rels -> absolute-ish targets
        assert_eq!(
            resolve_against("", "ppt/presentation.xml"),
            "ppt/presentation.xml"
        );
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
    fn filters_content_type_overrides_to_keep_set() {
        let xml = r#"<Types><Override PartName="/ppt/slides/slide1.xml" ContentType="a"/><Override PartName="/ppt/media/unused.png" ContentType="a"/></Types>"#;
        let keep: HashSet<String> = ["ppt/slides/slide1.xml".to_string()].into();
        let out = filter_content_types(xml, &keep).unwrap();
        assert!(out.contains("slide1.xml"));
        assert!(!out.contains("unused.png"));
    }

    #[test]
    fn reads_slide_ids_in_order() {
        let xml = r#"<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst></p:presentation>"#;
        let ids = slide_id_list(xml).unwrap();
        assert_eq!(ids.len(), 2);
        assert_eq!(ids[0], ("256".to_string(), "rId2".to_string()));
        assert_eq!(ids[1], ("257".to_string(), "rId3".to_string()));
    }

    #[test]
    fn skips_external_relationships() {
        let xml = r#"<Relationships><Relationship Id="rId1" Type="t" Target="https://example.com" TargetMode="External"/><Relationship Id="rId2" Type="t" Target="slides/slide1.xml"/></Relationships>"#;
        let rels = relationships(xml);
        assert_eq!(rels.len(), 2);
        assert!(rels[0].external);
        assert!(!rels[1].external);
    }
}
