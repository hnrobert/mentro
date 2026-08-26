/**
 * MiniSearch engine with CJK bigram tokenization.
 *
 * Chinese/Japanese/Korean runs are indexed as overlapping 2-gram tokens
 * (query "比赛规则" -> 比赛/赛规/规则, all present in a matching text);
 * a single CJK character query is matched via prefix search over the
 * bigrams starting with it. ASCII text is lowercased words. This keeps
 * segmentation entirely client-side (no jieba wasm) and self-consistent
 * between indexing and querying.
 */

import MiniSearch, { type SearchResult } from "minisearch";
import type { SearchEngine, SearchHit, SearchUnit } from "./engine";

interface IndexedUnit {
  id: string;
  title: string;
  fileName: string;
  text: string;
  /** stored fields (MiniSearch storeFields) */
  unit: SearchUnit;
}

function isCjk(code: number): boolean {
  return (
    (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified
    (code >= 0x3040 && code <= 0x30ff) || // Kana
    (code >= 0xac00 && code <= 0xd7af) // Hangul
  );
}

/** ASCII words + CJK bigrams (single-char runs kept for prefix search). */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let ascii = "";
  let cjkRun = "";
  const flushAscii = () => {
    if (ascii) {
      tokens.push(ascii.toLowerCase());
      ascii = "";
    }
  };
  const flushCjk = () => {
    if (cjkRun.length >= 2) {
      for (let i = 0; i + 1 < cjkRun.length; i++) {
        tokens.push(cjkRun.slice(i, i + 2));
      }
    } else if (cjkRun.length === 1) {
      tokens.push(cjkRun);
    }
    cjkRun = "";
  };
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (isCjk(code)) {
      flushAscii();
      cjkRun += ch;
    } else if (/\p{Letter}|\d/u.test(ch)) {
      flushCjk();
      ascii += ch;
    } else {
      flushAscii();
      flushCjk();
    }
  }
  flushAscii();
  flushCjk();
  return tokens;
}

export class MiniSearchEngine implements SearchEngine {
  private index: MiniSearch<IndexedUnit>;
  private unitsById = new Map<string, SearchUnit>();

  constructor() {
    this.index = new MiniSearch<IndexedUnit>({
      fields: ["title", "fileName", "text"],
      storeFields: ["unit"],
      tokenize,
      searchOptions: {
        tokenize,
        prefix: true,
        combineWith: "AND",
        fuzzy: 0.1,
      },
    });
  }

  get size(): number {
    return this.unitsById.size;
  }

  replaceAll(units: SearchUnit[]): void {
    this.index.removeAll();
    this.unitsById.clear();
    this.add(units);
  }

  applyDelta(upserted: SearchUnit[], removed: string[]): void {
    for (const id of removed) {
      this.index.discard(id);
      this.unitsById.delete(id);
    }
    this.add(upserted);
  }

  private add(units: SearchUnit[]): void {
    if (units.length === 0) return;
    const docs: IndexedUnit[] = units.map((unit) => ({
      id: unit.id,
      title: unit.title ?? "",
      fileName: unit.fileName,
      text: unit.text ?? "",
      unit,
    }));
    // Duplicated ids (delta re-upserts) are replaced, not added.
    for (const doc of docs) {
      if (this.unitsById.has(doc.id)) {
        this.index.discard(doc.id);
      }
      this.unitsById.set(doc.id, doc.unit);
    }
    this.index.addAll(docs);
  }

  search(query: string, limit = 50): SearchHit[] {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const results: SearchResult[] = this.index.search(trimmed);
    return results.slice(0, limit).map((r) => {
      const doc = r as SearchResult & { unit?: SearchUnit };
      const fallback: SearchUnit = {
        id: r.id,
        assetId: "",
        kind: "",
        unitType: "",
        ordinal: 0,
        title: null,
        text: null,
        fileName: "",
        sourcePath: "",
        mtimeMs: 0,
        hasThumb: false,
      };
      const unit: SearchUnit = doc.unit ?? this.unitsById.get(r.id) ?? fallback;
      return {
        unit,
        score: r.score,
        terms: Object.keys(r.terms ?? {}),
      };
    });
  }
}
