import { AppDataSource } from "../db/data-source";
import { UnitEmbedding } from "../db/entities";
import { onIndexChanged } from "../bus";
import type { WorkerClient } from "../worker/client";

/** In-memory vector table for brute-force cosine. The sidecar emits
 *  normalized vectors, so cosine == dot. Invalidated on index changes
 *  (extract/transcribe/embed all publish); corpus-scale sizes make a
 *  full reload cheap — see docs/search-evaluation.md for the ceiling. */

interface Cache {
  byUnit: Map<string, Float32Array>;
  loaded: Promise<void> | null;
}

const cache: Cache = { byUnit: new Map(), loaded: null };

onIndexChanged(() => {
  cache.byUnit.clear();
  cache.loaded = null;
});

function load(): Promise<void> {
  cache.loaded ??= (async () => {
    const rows = await AppDataSource.getRepository(UnitEmbedding).find();
    const byUnit = new Map<string, Float32Array>();
    for (const row of rows) {
      byUnit.set(row.unitId, decodeVector(row.vector));
    }
    cache.byUnit = byUnit;
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
  invalidateEmbeddingCache();
}

export async function countEmbeddings(): Promise<number> {
  await load();
  return cache.byUnit.size;
}

/** Top-`limit` unit ids by cosine similarity. */
export async function nearestUnits(
  query: Float32Array,
  limit: number,
): Promise<Array<{ unitId: string; score: number }>> {
  await load();
  const scored: Array<{ unitId: string; score: number }> = [];
  for (const [unitId, vec] of cache.byUnit) {
    let dot = 0;
    const n = Math.min(vec.length, query.length);
    for (let i = 0; i < n; i++) dot += vec[i] * query[i];
    scored.push({ unitId, score: dot });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
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
