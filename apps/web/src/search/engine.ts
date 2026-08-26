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
}

export interface SearchHit {
  unit: SearchUnit;
  score: number;
  /** Terms that matched, for snippet highlighting. */
  terms: string[];
}

export interface SearchEngine {
  readonly size: number;
  replaceAll(units: SearchUnit[]): void;
  applyDelta(upserted: SearchUnit[], removed: string[]): void;
  search(query: string, limit?: number): SearchHit[];
}
