import { AppDataSource } from "../db/data-source";
import { UnitEmbedding, UnitTranslationEmbedding } from "../db/entities";
import { onIndexChanged } from "../bus";
import type { WorkerClient } from "../worker/client";

/** In-memory vector table for brute-force cosine. The sidecar emits
 *  normalized vectors, so cosine == dot. Invalidated on index changes
 *  (extract/transcribe/embed all publish); corpus-scale sizes make a
 *  full reload cheap — see docs/search-evaluation.md for the ceiling.
 *
 * Two caches: original-language vectors (byUnit) and translation
 *  vectors (byUnitLang, key `${unitId} ${lang}`). nearestUnits scores
 *  BOTH and merges per unit — a doc matches in any language. */

interface Cache {
  byUnit: Map<string, Float32Array>;
  assetByUnit: Map<string, string>;
  byUnitLang: Map<string, Float32Array>;
  assetByUnitLang: Map<string, string>;
  loaded: Promise<void> | null;
}

const cache: Cache = {
  byUnit: new Map(),
  assetByUnit: new Map(),
  byUnitLang: new Map(),
  assetByUnitLang: new Map(),
  loaded: null,
};

onIndexChanged(() => {
  cache.byUnit.clear();
  cache.byUnitLang.clear();
  cache.loaded = null;
});

function load(): Promise<void> {
  cache.loaded ??= (async () => {
    const [rows, tRows] = await Promise.all([
      AppDataSource.getRepository(UnitEmbedding).find(),
      AppDataSource.getRepository(UnitTranslationEmbedding).find(),
    ]);
    const byUnit = new Map<string, Float32Array>();
    const assets = new Map<string, string>();
    for (const row of rows) {
      byUnit.set(row.unitId, decodeVector(row.vector));
      assets.set(row.unitId, row.assetId);
    }
    const byUnitLang = new Map<string, Float32Array>();
    const tAssets = new Map<string, string>();
    for (const row of tRows) {
      byUnitLang.set(`${row.unitId} ${row.lang}`, decodeVector(row.vector));
      tAssets.set(`${row.unitId} ${row.lang}`, row.assetId);
    }
    cache.byUnit = byUnit;
    cache.assetByUnit = assets;
    cache.byUnitLang = byUnitLang;
    cache.assetByUnitLang = tAssets;
  })();
  return cache.loaded;
}

/** little-endian float32 blob -> Float32Array (fresh, aligned copy). */
function decodeVector(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(bytes.byteLength / 4);
  for (let i = 0; i < out.length; i++) {
    out[i] = view.getFloat32(i * 4, true);
  }
  return out;
}

export function encodeVector(values: Float32Array): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < values.length; i++) {
    view.setFloat32(i * 4, values[i], true);
  }
  return out;
}

export function invalidateEmbeddingCache(): void {
  cache.byUnit.clear();
  cache.byUnitLang.clear();
  cache.loaded = null;
}

/** Persist one asset's vectors (replacing any previous ones). */
export async function storeAssetEmbeddings(
  entries: Array<{ unitId: string; assetId: string; vector: Float32Array }>,
): Promise<void> {
  if (entries.length === 0) return;
  const repo = AppDataSource.getRepository(UnitEmbedding);
  const ids = entries.map((e) => e.unitId);
  await repo.delete(ids as never[]);
  await repo.insert(
    entries.map((e) => ({
      unitId: e.unitId,
      assetId: e.assetId,
      dim: e.vector.length,
      vector: encodeVector(e.vector),
    })),
  );
  invalidateEmbeddingCache();
}

export async function dropAssetEmbeddings(assetId: string): Promise<void> {
  await AppDataSource.getRepository(UnitEmbedding).delete({ assetId });
  await AppDataSource.getRepository(UnitTranslationEmbedding).delete({
    assetId,
  });
  invalidateEmbeddingCache();
}

/** Persist translation vectors (replacing previous ones per key). */
export async function storeTranslationEmbeddings(
  entries: Array<{
    unitId: string;
    lang: string;
    assetId: string;
    vector: Float32Array;
  }>,
): Promise<void> {
  if (entries.length === 0) return;
  const repo = AppDataSource.getRepository(UnitTranslationEmbedding);
  await repo.delete(
    entries.map((e) => ({ unitId: e.unitId, lang: e.lang })) as never[],
  );
  await repo.insert(
    entries.map((e) => ({
      unitId: e.unitId,
      lang: e.lang,
      assetId: e.assetId,
      dim: e.vector.length,
      vector: encodeVector(e.vector),
    })),
  );
  invalidateEmbeddingCache();
}

export async function countEmbeddings(): Promise<number> {
  await load();
  return cache.byUnit.size;
}

/** Top-`limit` unit ids by cosine similarity. `groups` restricts to
 *  units whose asset belongs to one of the given group ids
 *  (`__ungrouped__` = null group). */
export async function nearestUnits(
  query: Float32Array,
  limit: number,
  groups?: Set<string>,
): Promise<Array<{ unitId: string; score: number }>> {
  await load();
  let allowed: Set<string> | null = null;
  if (groups && groups.size > 0) {
    // Directory paths now; LIKE prefix includes subdirectories,
    // "__ungrouped__" = files directly in the pool root.
    const dirs = [...groups].filter((g) => g !== "__ungrouped__");
    const wantsRoot = groups.has("__ungrouped__");
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (dirs.length > 0) {
      clauses.push(`(${dirs.map(() => "path LIKE ?").join(" OR ")})`);
      params.push(...dirs.map((d) => `${d}/%`));
    }
    if (wantsRoot) clauses.push("path NOT LIKE '%/%'");
    const rows = (await AppDataSource.query(
      `SELECT id FROM assets WHERE ${clauses.join(" OR ")}`,
      params,
    )) as Array<{ id: string }>;
    allowed = new Set(rows.map((r) => r.id));
  }
  const scored = new Map<string, { unitId: string; score: number }>();
  const bump = (unitId: string, score: number): void => {
    const cur = scored.get(unitId);
    if (!cur || score > cur.score) scored.set(unitId, { unitId, score });
  };
  for (const [unitId, vec] of cache.byUnit) {
    if (allowed && !allowed.has(cache.assetByUnit.get(unitId) ?? "")) continue;
    let dot = 0;
    const n = Math.min(vec.length, query.length);
    for (let i = 0; i < n; i++) dot += vec[i] * query[i];
    bump(unitId, dot);
  }
  for (const [key, vec] of cache.byUnitLang) {
    const unitId = key.slice(0, key.lastIndexOf(" "));
    if (allowed && !allowed.has(cache.assetByUnitLang.get(key) ?? "")) continue;
    let dot = 0;
    const n = Math.min(vec.length, query.length);
    for (let i = 0; i < n; i++) dot += vec[i] * query[i];
    bump(unitId, dot);
  }
  return [...scored.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Embed texts through the worker (sidecar container). Empty result
 *  means the backend is unavailable — callers degrade to FTS-only. */
export async function embedTexts(
  worker: WorkerClient,
  texts: string[],
): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const resp = await worker.embed(texts, 300_000);
  if (!resp.ok || resp.result?.case !== "embedResult") return [];
  return resp.result.value.embeddings.map((e) => Float32Array.from(e.vector));
}

/** Embedding input for a unit: title anchors the topic, text carries
 *  the body; capped to keep sidecar latency sane. */
export function unitEmbeddingInput(
  title: string | null,
  text: string | null,
): string {
  const head = (title ?? "").trim();
  const body = (text ?? "").trim().slice(0, 4000);
  return head ? `${head}\n${body}` : body;
}
