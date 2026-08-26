//! Parse `pdftohtml -xml` output into per-page geometry + positioned text
//! fragments (font size resolved through per-page `<fontspec>` ids).

use std::collections::HashMap;

use quick_xml::Reader;
use quick_xml::events::Event;

use super::pdf_layout::{Fragment, PageGeom};

pub struct XmlPage {
    pub geom: PageGeom,
    pub fragments: Vec<Fragment>,
}

pub fn parse(xml: &str) -> Vec<XmlPage> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);

    let mut pages: Vec<XmlPage> = Vec::new();
    let mut fonts: HashMap<u32, f64> = HashMap::new();
    let mut in_text = false;
    let mut bold = false;
    let mut buf = String::new();
    let mut cur: Option<Fragment> = None;

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => match e.name().as_ref() {
                b"page" => {
                    fonts.clear();
                    let mut width = 0.0;
                    let mut height = 0.0;
                    for attr in e.attributes().flatten() {
                        match attr.key.as_ref() {
                            b"width" => {
                                width = attr_value(&attr).unwrap_or(0.0);
                            }
                            b"height" => {
                                height = attr_value(&attr).unwrap_or(0.0);
                            }
                            _ => {}
                        }
                    }
                    pages.push(XmlPage {
                        geom: PageGeom { width, height },
                        fragments: Vec::new(),
                    });
                }
                b"fontspec" => {
                    let mut id = 0u32;
                    let mut size = 0.0f64;
                    for attr in e.attributes().flatten() {
                        match attr.key.as_ref() {
                            b"id" => id = attr_value(&attr).unwrap_or(0.0) as u32,
                            b"size" => size = attr_value(&attr).unwrap_or(0.0),
                            _ => {}
                        }
                    }
                    fonts.insert(id, size);
                }
                b"text" => {
                    in_text = true;
                    bold = false;
                    buf.clear();
                    let mut left = 0.0;
                    let mut top = 0.0;
                    let mut width = 0.0;
                    let mut height = 0.0;
                    let mut font = 0u32;
                    for attr in e.attributes().flatten() {
                        match attr.key.as_ref() {
                            b"left" => left = attr_value(&attr).unwrap_or(0.0),
                            b"top" => top = attr_value(&attr).unwrap_or(0.0),
                            b"width" => width = attr_value(&attr).unwrap_or(0.0),
                            b"height" => height = attr_value(&attr).unwrap_or(0.0),
                            b"font" => font = attr_value(&attr).unwrap_or(0.0) as u32,
                            _ => {}
                        }
                    }
                    cur = Some(Fragment {
                        text: String::new(),
                        left,
                        top,
                        width,
                        height,
                        size: fonts.get(&font).copied().unwrap_or(height.max(3.0)),
                        bold: false,
                    });
                }
                b"b" | b"i" if in_text => bold = true,
                _ => {}
            },
            Ok(Event::Text(t)) if in_text => {
                if let Ok(raw) = t.decode() {
                    buf.push_str(&decode_entities(&raw));
                }
            }
            Ok(Event::End(e)) => match e.name().as_ref() {
                b"text" => {
                    in_text = false;
                    if let Some(mut frag) = cur.take() {
                        let text: String = buf.split_whitespace().collect::<Vec<_>>().join(" ");
                        if !text.is_empty() {
                            frag.text = text;
                            frag.bold = bold;
                            if let Some(page) = pages.last_mut() {
                                page.fragments.push(frag);
                            }
                        }
                    }
                }
                b"page" => {}
                _ => {}
            },
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(_) => break,
        }
    }
    pages
}

fn attr_value(attr: &quick_xml::events::attributes::Attribute) -> Option<f64> {
    std::str::from_utf8(&attr.value)
        .ok()?
        .trim()
        .parse::<f64>()
        .ok()
}

/// Minimal XML entity decode (pdftohtml emits the standard five).
fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}
