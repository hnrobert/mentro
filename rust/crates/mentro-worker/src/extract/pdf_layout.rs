//! Layout-aware text reconstruction, ported 1:1 from pdf2md's
//! `layout_analyzer.py` (pdfplumber heuristics). Input fragments come from
//! `pdftohtml -xml` (per-run text with top/left/width/height + font size);
//! everything downstream is pure geometry.
//!
//! Coordinates are top-origin (y grows downward), unlike pdf2md's
//! bottom-origin PDF space — all comparisons are flipped accordingly.
//! Thresholds mirror the Python constants exactly.

/// Minimum gap (fraction of page width) for a column boundary.
const COLUMN_GAP_MIN_FRACTION: f64 = 0.15;
/// Column-detection strip count.
const COLUMN_STRIPS: usize = 40;
/// Max vertical gap (in line heights) to group lines into one block.
const BLOCK_MAX_GAP_LINES: f64 = 1.5;
/// Min horizontal overlap ratio for lines to share a block.
const BLOCK_MIN_OVERLAP: f64 = 0.5;
/// A block wider than this fraction of the page spans all columns.
const SPANNING_WIDTH_FRACTION: f64 = 0.8;
/// Header band (top of page) and footer band fractions.
const HEADER_BAND: f64 = 0.08;
const FOOTER_BAND: f64 = 0.92;
/// Heading font-size threshold over body size.
const HEADING_SIZE_FACTOR: f64 = 1.1;

#[derive(Debug, Clone)]
pub struct Fragment {
    pub text: String,
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
    pub size: f64,
    pub bold: bool,
}

#[derive(Debug, Clone)]
pub struct PageGeom {
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone)]
pub struct Block {
    pub text: String,
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub size: f64,
    pub bold: bool,
    pub is_header: bool,
    pub is_footer: bool,
}

impl Block {
    fn width(&self) -> f64 {
        self.right - self.left
    }
    fn center_x(&self) -> f64 {
        (self.left + self.right) / 2.0
    }
}

#[derive(Clone)]
struct Line {
    text: String,
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
    size: f64,
    bold: bool,
    weight: usize,
}

impl Line {
    fn width(&self) -> f64 {
        self.right - self.left
    }
    fn height(&self) -> f64 {
        self.bottom - self.top
    }
}

/// One page's ordered blocks plus the geometry.
pub struct AnalyzedPage {
    #[allow(dead_code)] // kept for renderers that need page dimensions
    pub geom: PageGeom,
    pub blocks: Vec<Block>,
}

/// Phase 1: per-page analysis (lines -> blocks -> columns -> reading
/// order -> positional headers/footers -> hyphenation merge).
pub fn analyze_page(geom: &PageGeom, fragments: Vec<Fragment>) -> AnalyzedPage {
    let lines = group_fragments_to_lines(fragments);
    let blocks = group_lines_to_blocks(lines);
    let columns = detect_columns(&blocks, geom.width);
    let mut ordered = apply_reading_order(blocks, &columns, geom.width);
    let modal_size = modal_block_size(&ordered);
    mark_headers_footers_positional(&mut ordered, geom.height, modal_size);
    merge_hyphenation(&mut ordered);
    AnalyzedPage {
        geom: PageGeom {
            width: geom.width,
            height: geom.height,
        },
        blocks: ordered,
    }
}

/// Length-weighted modal font size of the page's blocks (body size).
fn modal_block_size(blocks: &[Block]) -> f64 {
    use std::collections::HashMap;
    let mut weight: HashMap<u64, usize> = HashMap::new();
    for b in blocks {
        let key = (b.size * 10.0).round() as u64;
        *weight.entry(key).or_insert(0) += b.text.len().max(1);
    }
    weight
        .into_iter()
        .max_by_key(|(_, n)| *n)
        .map(|(k, _)| k as f64 / 10.0)
        .unwrap_or(12.0)
}

/// Cross-page header/footer vote: text appearing as the topmost/bottommost
/// block on >= 3 pages is marked on every page (pdf2md's
/// `_mark_repeated_elements`).
pub fn mark_repeated_elements(pages: &mut [AnalyzedPage]) {
    use std::collections::HashMap;
    let mut counts: HashMap<String, usize> = HashMap::new();
    for page in pages.iter() {
        let mut by_top: Vec<&Block> = page.blocks.iter().collect();
        by_top.sort_by(|a, b| a.top.total_cmp(&b.top));
        if let Some(first) = by_top.first() {
            *counts.entry(first.text.trim().to_string()).or_insert(0) += 1;
        }
        if let Some(last) = by_top.last() {
            *counts.entry(last.text.trim().to_string()).or_insert(0) += 1;
        }
    }
    for page in pages.iter_mut() {
        for block in page.blocks.iter_mut() {
            if counts.get(block.text.trim()).is_some_and(|n| *n >= 3) {
                block.is_header = true;
            }
        }
    }
}

/// Phase 2: document-wide `{font_size -> heading_level}` map (body size =
/// length-weighted mode; sizes > body*1.1 ranked descending -> 1..=6).
pub fn compute_heading_size_map(pages: &[AnalyzedPage]) -> Vec<(f64, u8)> {
    use std::collections::HashMap;
    let mut weight: HashMap<u64, usize> = HashMap::new();
    for page in pages {
        for b in &page.blocks {
            if b.is_header || b.is_footer || b.text.trim().is_empty() {
                continue;
            }
            // Round to 1 decimal, as pdfplumber reports float-noisy sizes.
            let key = (b.size * 10.0).round() as u64;
            *weight.entry(key).or_insert(0) += b.text.len();
        }
    }
    let Some((&body_key, _)) = weight.iter().max_by_key(|(_, n)| **n) else {
        return Vec::new();
    };
    let body = body_key as f64 / 10.0;
    let mut larger: Vec<u64> = weight
        .keys()
        .copied()
        .filter(|k| *k as f64 / 10.0 > body * HEADING_SIZE_FACTOR)
        .collect();
    larger.sort_unstable_by(|a, b| b.cmp(a));
    larger
        .into_iter()
        .take(6)
        .enumerate()
        .map(|(i, k)| (k as f64 / 10.0, (i + 1) as u8))
        .collect()
}

/// Phase 3: render a page to markdown-ish text (headings, bold blocks,
/// paragraphs), skipping header/footer blocks.
pub fn render_page(
    page: &AnalyzedPage,
    heading_map: &[(f64, u8)],
    h1_emitted: &mut bool,
) -> String {
    let mut out: Vec<String> = Vec::new();
    for block in &page.blocks {
        if block.is_header || block.is_footer {
            continue;
        }
        let text = block.text.trim();
        if text.is_empty() {
            continue;
        }
        let level = heading_map
            .iter()
            .find(|(s, _)| (*s * 10.0).round() as i64 == (block.size * 10.0).round() as i64)
            .map(|(_, l)| *l);
        if let Some(mut lvl) = level {
            if lvl == 1 && *h1_emitted {
                lvl = 2; // exactly one H1 per document
            }
            if lvl == 1 {
                *h1_emitted = true;
            }
            out.push(format!("{} {}", "#".repeat(lvl as usize), text));
        } else if block.bold {
            out.push(format!("**{text}**"));
        } else {
            out.push(text.to_string());
        }
    }
    out.join("\n\n")
}

// --- Step 1: fragments -> lines (y clustering, x sort) ---

fn group_fragments_to_lines(frags: Vec<Fragment>) -> Vec<Line> {
    // Dedup exact-duplicate glyphs (faux-bold exporters emit each run twice).
    let mut seen = std::collections::HashSet::new();
    let mut frags: Vec<Fragment> = frags
        .into_iter()
        .filter(|f| {
            seen.insert((
                f.text.clone(),
                (f.left * 100.0).round() as i64,
                (f.top * 100.0).round() as i64,
            ))
        })
        .collect();
    frags.sort_by(|a, b| {
        let ca = a.top + a.height / 2.0;
        let cb = b.top + b.height / 2.0;
        ca.partial_cmp(&cb)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(
                a.left
                    .partial_cmp(&b.left)
                    .unwrap_or(std::cmp::Ordering::Equal),
            )
    });

    let mut lines: Vec<Line> = Vec::new();
    let mut current: Vec<Fragment> = Vec::new();

    let finalize = |frags: &mut Vec<Fragment>| -> Option<Line> {
        if frags.is_empty() {
            return None;
        }
        // Join in x order (pdf2md's _TextLine.finalize sorts by x0).
        frags.sort_by(|a, b| {
            a.left
                .partial_cmp(&b.left)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let text = normalize_glyph_spacing(&join_runs(
            &frags.iter().map(|f| f.text.as_str()).collect::<Vec<_>>(),
        ));
        if text.is_empty() {
            return None;
        }
        let left = frags.iter().map(|f| f.left).fold(f64::MAX, f64::min);
        let right = frags
            .iter()
            .map(|f| f.left + f.width)
            .fold(f64::MIN, f64::max);
        let top = frags.iter().map(|f| f.top).fold(f64::MAX, f64::min);
        let bottom = frags
            .iter()
            .map(|f| f.top + f.height)
            .fold(f64::MIN, f64::max);
        // Length-weighted modal size + any-bold.
        let mut size = frags[0].size;
        let mut best = 0usize;
        let mut run = (0usize, frags[0].size);
        for f in frags.iter() {
            if (f.size - run.1).abs() < 0.05 {
                run.0 += f.text.len();
            } else {
                run = (f.text.len(), f.size);
            }
            if run.0 > best {
                best = run.0;
                size = run.1;
            }
        }
        let bold = frags.iter().any(|f| f.bold);
        let weight: usize = frags.iter().map(|f| f.text.len()).sum();
        Some(Line {
            text,
            left,
            top,
            right,
            bottom,
            size,
            bold,
            weight,
        })
    };

    for f in frags {
        let cy = f.top + f.height / 2.0;
        // Adaptive tolerance from fragment height (pdf2md: max(3.0, size*0.4)).
        let tolerance = (f.height * 0.4).max(3.0);
        let matches = current
            .last()
            .map(|_| {
                let l_top = current.iter().map(|f| f.top).fold(f64::MAX, f64::min);
                let l_bottom = current
                    .iter()
                    .map(|f| f.top + f.height)
                    .fold(f64::MIN, f64::max);
                (cy - (l_top + l_bottom) / 2.0).abs() <= tolerance
            })
            .unwrap_or(false);
        if matches {
            current.push(f);
        } else {
            if let Some(l) = finalize(&mut current) {
                lines.push(l);
            }
            current.clear();
            current.push(f);
        }
    }
    if let Some(l) = finalize(&mut current) {
        lines.push(l);
    }
    lines
}

// --- Step 2: lines -> paragraph blocks ---

fn group_lines_to_blocks(lines: Vec<Line>) -> Vec<Block> {
    if lines.is_empty() {
        return Vec::new();
    }
    let mut blocks: Vec<Block> = Vec::new();
    let mut current: Vec<Line> = vec![lines[0].clone()];

    for line in lines.into_iter().skip(1) {
        let prev = current.last().expect("non-empty");
        let overlap = horizontal_overlap(prev, &line);
        let avg_height = ((prev.height() + line.height()) / 2.0).max(0.0);
        let avg_height = if avg_height <= 0.0 { 12.0 } else { avg_height };
        // Top-origin: gap of `line` below `prev` = line.top - prev.bottom.
        let gap = (line.top - prev.bottom).max(0.0);
        if overlap >= BLOCK_MIN_OVERLAP && gap < BLOCK_MAX_GAP_LINES * avg_height {
            current.push(line);
        } else {
            blocks.push(lines_to_block(&current));
            current = vec![line];
        }
    }
    blocks.push(lines_to_block(&current));
    blocks
}

fn horizontal_overlap(a: &Line, b: &Line) -> f64 {
    let overlap = (a.right.min(b.right) - a.left.max(b.left)).max(0.0);
    let min_w = a.width().min(b.width()).max(f64::EPSILON);
    overlap / min_w
}

/// Characters that never take a space on either side when two runs
/// meet (CJK ideographs, kana, hangul, CJK punctuation, fullwidth
/// forms). pdftohtml splits CJK lines into many tiny <text> runs; a
/// blanket " " join turns 在线优化 into 在 线 优化.
fn cjk_ish(c: char) -> bool {
    matches!(c as u32,
        0x2E80..=0x9FFF   // CJK radicals, punctuation, kana, ideographs
        | 0xAC00..=0xD7AF  // hangul
        | 0xF900..=0xFAFF  // compat ideographs
        | 0xFF00..=0xFFEF  // fullwidth forms
    ) || matches!(
        c,
        '\u{2014}' | '\u{2018}' | '\u{2019}' | '\u{201C}' | '\u{201D}' | '\u{2026}'
    )
}

/// Join text runs: a space only where a real word boundary exists.
/// CJK-CJK boundaries join flush; everything else keeps the space.
fn join_runs(parts: &[&str]) -> String {
    let mut out = String::new();
    let mut prev_ends_cjk = false;
    for part in parts {
        let p = part.trim();
        if p.is_empty() {
            continue;
        }
        if out.is_empty() {
            out.push_str(p);
        } else {
            let next_starts_cjk = p.chars().next().map(cjk_ish).unwrap_or(false);
            if !(prev_ends_cjk && next_starts_cjk) {
                out.push(' ');
            }
            out.push_str(p);
        }
        prev_ends_cjk = out.chars().last().map(cjk_ish).unwrap_or(false);
    }
    out
}

/// LibreOffice-rendered PPTX->PDFs sometimes emit a space between EVERY
/// CJK glyph inside a single pdftohtml run (义 典 型 问 题). Word-level
/// spaces in keyword lists are legit and must survive (演化计算 运筹优化).
/// Rule: a chain of >= 3 CJK chars separated only by whitespace is
/// glyph spacing — join it flush; shorter chains are word boundaries.
fn normalize_glyph_spacing(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0usize;
    while i < chars.len() {
        if !cjk_ish(chars[i]) {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        // Collect the maximal chain: CJK (ws CJK)*
        let mut chain: Vec<char> = vec![chars[i]];
        let mut gaps: Vec<String> = Vec::new(); // whitespace between members
        let mut j = i + 1;
        loop {
            let mut k = j;
            let mut ws = String::new();
            while k < chars.len() && chars[k].is_whitespace() {
                ws.push(chars[k]);
                k += 1;
            }
            if ws.is_empty() || k >= chars.len() || !cjk_ish(chars[k]) {
                break;
            }
            chain.push(chars[k]);
            gaps.push(ws);
            j = k + 1;
        }
        if chain.len() >= 3 {
            // Glyph spacing: flush join.
            for c in &chain {
                out.push(*c);
            }
        } else {
            // Word boundary: keep original spacing.
            out.push(chain[0]);
            for (idx, ws) in gaps.iter().enumerate() {
                out.push_str(ws);
                out.push(chain[idx + 1]);
            }
        }
        i = j;
    }
    out
}

fn lines_to_block(lines: &[Line]) -> Block {
    let first = &lines[0];
    let mut block = Block {
        text: join_runs(&lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>()),
        left: f64::MAX,
        top: f64::MAX,
        right: f64::MIN,
        bottom: f64::MIN,
        size: first.size,
        bold: lines.iter().any(|l| l.bold),
        is_header: false,
        is_footer: false,
    };
    for l in lines {
        block.left = block.left.min(l.left);
        block.top = block.top.min(l.top);
        block.right = block.right.max(l.right);
        block.bottom = block.bottom.max(l.bottom);
    }
    // Modal size weighted by text length.
    let mut best = (0usize, first.size);
    let mut cur = (0usize, first.size);
    for l in lines {
        if (l.size - cur.1).abs() < 0.05 {
            cur.0 += l.weight;
        } else {
            cur = (l.weight, l.size);
        }
        if cur.0 > best.0 {
            best = cur;
        }
    }
    block.size = best.1;
    block
}

// --- Step 3: column detection (strip density histogram) ---

fn detect_columns(blocks: &[Block], page_width: f64) -> Vec<(f64, f64)> {
    if page_width <= 0.0 {
        return vec![(0.0, page_width)];
    }
    let strip_w = page_width / COLUMN_STRIPS as f64;
    let mut counts = vec![0usize; COLUMN_STRIPS];
    for b in blocks {
        let strip = ((b.center_x() / strip_w) as usize).min(COLUMN_STRIPS - 1);
        counts[strip] = counts[strip].saturating_add(b.text.len());
    }
    let min_gap = (COLUMN_GAP_MIN_FRACTION * COLUMN_STRIPS as f64).ceil() as usize;
    let mut gaps: Vec<(usize, usize)> = Vec::new();
    let mut start: Option<usize> = None;
    for (s, count) in counts.iter().enumerate() {
        if *count == 0 {
            if start.is_none() {
                start = Some(s);
            }
        } else if let Some(gs) = start.take() {
            gaps.push((gs, s - 1));
        }
    }
    if let Some(gs) = start.take() {
        gaps.push((gs, COLUMN_STRIPS - 1));
    }
    let significant: Vec<(f64, f64)> = gaps
        .into_iter()
        .filter(|(s, e)| e - s + 1 >= min_gap)
        .map(|(s, e)| (s as f64 * strip_w, (e + 1) as f64 * strip_w))
        .collect();

    let mut columns: Vec<(f64, f64)> = Vec::new();
    let mut prev_end = 0.0;
    for (gs, ge) in significant {
        if gs > prev_end {
            columns.push((prev_end, gs));
        }
        prev_end = ge;
    }
    if prev_end < page_width {
        columns.push((prev_end, page_width));
    }
    if columns.is_empty() {
        columns.push((0.0, page_width));
    }
    columns
}

// --- Step 4: reading order (column-major with spanning interleave) ---

fn apply_reading_order(blocks: Vec<Block>, columns: &[(f64, f64)], page_width: f64) -> Vec<Block> {
    if columns.len() <= 1 {
        let mut blocks = blocks;
        blocks.sort_by(|a, b| {
            a.top
                .partial_cmp(&b.top)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        return blocks;
    }

    let mut column_blocks: Vec<Vec<Block>> = vec![Vec::new(); columns.len()];
    let mut spanning: Vec<Block> = Vec::new();
    for block in blocks {
        if block.width() > page_width * SPANNING_WIDTH_FRACTION {
            spanning.push(block);
        } else {
            let mut best = 0usize;
            let mut best_dist = f64::MAX;
            for (i, (c0, c1)) in columns.iter().enumerate() {
                let cc = (c0 + c1) / 2.0;
                let d = (block.center_x() - cc).abs();
                if d < best_dist {
                    best_dist = d;
                    best = i;
                }
            }
            column_blocks[best].push(block);
        }
    }
    for col in column_blocks.iter_mut() {
        col.sort_by(|a, b| {
            a.top
                .partial_cmp(&b.top)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    }
    spanning.sort_by(|a, b| {
        a.top
            .partial_cmp(&b.top)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut result: Vec<Block> = Vec::new();
    let mut idx = vec![0usize; column_blocks.len()];

    for span in &spanning {
        // Flush column blocks above this spanning block (top-origin:
        // "above" = smaller top).
        for (ci, col) in column_blocks.iter().enumerate() {
            while idx[ci] < col.len() && col[idx[ci]].top < span.top {
                result.push(col[idx[ci]].clone());
                idx[ci] += 1;
            }
        }
        result.push(span.clone());
    }
    // Flush remaining: repeatedly emit the globally topmost block.
    loop {
        let mut top: Option<usize> = None;
        for (ci, col) in column_blocks.iter().enumerate() {
            if idx[ci] < col.len() {
                let t = col[idx[ci]].top;
                let better = match top {
                    None => true,
                    Some(tci) => t < column_blocks[tci][idx[tci]].top,
                };
                if better {
                    top = Some(ci);
                }
            }
        }
        let Some(ci) = top else { break };
        result.push(column_blocks[ci][idx[ci]].clone());
        idx[ci] += 1;
    }
    result
}

// --- Step 5: positional headers/footers ---

/// Positional header/footer bands with two guards: (1) running heads are
/// body-sized, so display-size text (poster/paper titles) survives;
/// (2) the block must sit ENTIRELY inside the band — a page whose text
/// merges into one block starting at the top would otherwise be dropped
/// whole.
fn mark_headers_footers_positional(blocks: &mut [Block], page_height: f64, body_size: f64) {
    for block in blocks.iter_mut() {
        let body_sized = block.size <= body_size * 1.2;
        // A running head is a SHORT block: 1-2 lines, a few % of page height.
        let short = block.bottom - block.top < page_height * 0.05;
        let fully_in_top =
            block.top < page_height * HEADER_BAND && block.bottom < page_height * HEADER_BAND * 2.0;
        if fully_in_top && body_sized && short {
            block.is_header = true;
        }
        let fully_in_bottom = block.top > page_height * (1.0 - HEADER_BAND * 2.0)
            && block.bottom > page_height * FOOTER_BAND;
        if fully_in_bottom && short {
            let t = block.text.trim();
            if is_page_number(t) || (body_sized && t.len() <= 120) {
                block.is_footer = true;
            }
        }
    }
}

fn is_page_number(t: &str) -> bool {
    let re_dashes = {
        // ^[-—\s]*\d+[-—\s]*$
        let core = t.trim_matches(|c: char| c == '-' || c == '—' || c.is_whitespace());
        !core.is_empty() && core.chars().all(|c| c.is_ascii_digit())
    };
    let re_slash = {
        // ^\d+\s*/\s*\d+$
        let mut parts = t.split('/');
        match (parts.next(), parts.next(), parts.next()) {
            (Some(a), Some(b), None) => {
                let a = a.trim();
                let b = b.trim();
                !a.is_empty()
                    && !b.is_empty()
                    && a.chars().all(|c| c.is_ascii_digit())
                    && b.chars().all(|c| c.is_ascii_digit())
            }
            _ => false,
        }
    };
    re_dashes || re_slash
}

// --- Step 6: hyphenation merge ---

fn merge_hyphenation(blocks: &mut Vec<Block>) {
    let mut i = 0;
    while i + 1 < blocks.len() {
        let ends_hyphen = blocks[i].text.trim_end().ends_with('-');
        let next_starts_lower = blocks[i + 1]
            .text
            .trim_start()
            .chars()
            .next()
            .map(|c| c.is_lowercase())
            .unwrap_or(false);
        let clean = !(blocks[i].is_header
            || blocks[i].is_footer
            || blocks[i + 1].is_header
            || blocks[i + 1].is_footer);
        if ends_hyphen && next_starts_lower && clean {
            let next = blocks.remove(i + 1);
            let joined = format!(
                "{}{}",
                blocks[i].text.trim_end().trim_end_matches('-'),
                next.text.trim_start()
            );
            blocks[i].text = joined;
            blocks[i].bottom = blocks[i].bottom.max(next.bottom);
            blocks[i].right = blocks[i].right.max(next.right);
        } else {
            i += 1;
        }
    }
}

#[cfg(test)]
mod cjk_join_tests {
    use super::{cjk_ish, join_runs};

    #[test]
    fn joins_cjk_runs_without_spaces() {
        assert_eq!(join_runs(&["在", "线", "优", "化"]), "在线优化");
    }

    #[test]
    fn keeps_ascii_word_boundaries() {
        assert_eq!(
            join_runs(&["stochastic", "scenario", "tree"]),
            "stochastic scenario tree"
        );
    }

    #[test]
    fn mixed_boundaries_keep_space() {
        // ASCII-ASCII boundaries keep the legacy space.
        assert_eq!(
            join_runs(&["在线优化", "(", "online", ")", "调度"]),
            "在线优化 ( online ) 调度"
        );
    }

    #[test]
    fn cjk_punctuation_binds() {
        assert_eq!(join_runs(&["参数", "）", "数据"]), "参数）数据");
    }

    #[test]
    fn recognizes_cjk_and_fullwidth() {
        assert!(cjk_ish('港'));
        assert!(cjk_ish('（'));
        assert!(cjk_ish('，'));
        assert!(!cjk_ish('a'));
        assert!(!cjk_ish('('));
    }

    #[test]
    fn strips_glyph_level_cjk_spacing() {
        let out = super::normalize_glyph_spacing("在 线 优 化 问题");
        assert_eq!(out, "在线优化问题");
    }

    #[test]
    fn keeps_word_level_cjk_spacing() {
        let out = super::normalize_glyph_spacing("演化计算 运筹优化 强化学习");
        assert_eq!(out, "演化计算 运筹优化 强化学习");
    }

    #[test]
    fn two_char_chain_is_word_boundary() {
        let out = super::normalize_glyph_spacing("计算 优化");
        assert_eq!(out, "计算 优化");
    }

    #[test]
    fn mixed_line_keeps_ascii_words() {
        let out = super::normalize_glyph_spacing("在 线 优化 (online) 调度");
        assert_eq!(out, "在线优化 (online) 调度");
    }
}
