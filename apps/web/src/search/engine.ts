/** Search engine interface — MiniSearch today, WASM engine at §9.2 scale. */

export interface SearchUnit {
  id: string;
  assetId: string;
  kind: string;
  unitType: string;
  ordinal: number;
  title: string | null;
  text: string | null;
  fileName: string;
  sourcePath: string;
  mtimeMs: number;
  hasThumb: boolean;
  /** Owning asset's group (null = ungrouped); powers group filters. */
  groupId: string | null;
}

export interface SearchHit {
  unit: SearchUnit;
  score: number;
  /** Terms that matched, for snippet highlighting. */
  terms: string[];
}

/** Fields a search may target — the UI's "filename only" scope. */
export type SearchField = "title" | "fileName" | "text";

export interface SearchOptions {
  /** Restrict matching to these fields (default: all). */
  fields?: SearchField[];
}

export interface SearchEngine {
  readonly size: number;
  replaceAll(units: SearchUnit[]): void;
  applyDelta(upserted: SearchUnit[], removed: string[]): void;
  search(query: string, limit?: number, opts?: SearchOptions): SearchHit[];
}
