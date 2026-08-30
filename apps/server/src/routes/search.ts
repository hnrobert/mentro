import type { FastifyInstance } from "fastify";
import { AppDataSource } from "../db/data-source";
import { ftsMatchExpr } from "../search/segment";
import { ftsSearch, type SearchHit } from "../search/fts";
import { embedTexts, nearestUnits } from "../search/embeddings";
import type { WorkerClient } from "../worker/client";

export interface HybridHit extends SearchHit {
  score: number;
  source: "fts" | "semantic" | "hybrid";
}

/** Reciprocal Rank Fusion: robust to incomparable score scales (BM25
 *  rank vs cosine), standard k=60. */
const RRF_K = 60;

async function semanticRanking(
  worker: WorkerClient,
  q: string,
  limit: number,
): Promise<Array<{ unitId: string; score: number }>> {
  const [vector] = await embedTexts(worker, [q]);
  if (!vector) return []; // sidecar unavailable -> FTS-only
  return nearestUnits(vector, limit);
}

/** Minimal hit shapes for unit ids the FTS leg never saw. */
async function hydrateSemantic(unitIds: string[]): Promise<SearchHit[]> {
  if (unitIds.length === 0) return [];
  const rows = (await AppDataSource.query(
    `SELECT cu.id AS unit_id, cu.asset_id, cu.ordinal, cu.unit_type, cu.title,
            substr(COALESCE(cu.text, ''), 1, 200) AS snip,
            a.path AS asset_path, a.kind
     FROM content_units cu JOIN assets a ON a.id = cu.asset_id
     WHERE cu.id IN (${unitIds.map(() => "?").join(",")})`,
    unitIds,
  )) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    unitId: r.unit_id as string,
    assetId: r.asset_id as string,
    ordinal: r.ordinal as number,
    unitType: r.unit_type as string,
    title: (r.title as string) ?? null,
    snippet: (r.snip as string) ?? null,
    fileName:
      String(r.asset_path ?? "")
        .split("/")
        .pop() ?? "",
    assetPath: r.asset_path as string,
    kind: r.kind as string,
  }));
}

export async function hybridSearch(
  worker: WorkerClient,
  q: string,
  limit: number,
  mode: "fts" | "semantic" | "hybrid" = "hybrid",
): Promise<HybridHit[]> {
  const [ftsHits, semantic] = await Promise.all([
    mode === "semantic"
      ? Promise.resolve([])
      : ftsSearch(ftsMatchExpr(q), limit),
    mode === "fts" ? Promise.resolve([]) : semanticRanking(worker, q, limit),
  ]);

  const merged = new Map<
    string,
    { hit: SearchHit; score: number; viaFts: boolean; viaSem: boolean }
  >();
  ftsHits.forEach((hit, rank) => {
    merged.set(hit.unitId, {
      hit,
      score: 1 / (RRF_K + 1 + rank),
      viaFts: true,
      viaSem: false,
    });
  });

  // Semantic-only units need hydrated hit shapes.
  const semOnly = semantic.filter((s) => !merged.has(s.unitId));
  const hydrated = await hydrateSemantic(semOnly.map((s) => s.unitId));
  const hydratedById = new Map(hydrated.map((h) => [h.unitId, h]));

  semantic.forEach(({ unitId }, rank) => {
    const contribution = 1 / (RRF_K + 1 + rank);
    const existing = merged.get(unitId);
    if (existing) {
      existing.score += contribution;
      existing.viaSem = true;
    } else {
      const hit = hydratedById.get(unitId);
      if (hit) {
        merged.set(unitId, {
          hit,
          score: contribution,
          viaFts: false,
          viaSem: true,
        });
      }
    }
  });

  return [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ hit, score, viaFts, viaSem }) => ({
      ...hit,
      score,
      source: viaFts && viaSem ? "hybrid" : viaFts ? "fts" : "semantic",
    }));
}

export function registerSearchRoutes(
  app: FastifyInstance,
  worker: WorkerClient,
) {
  app.get<{
    Querystring: { q?: string; limit?: string; mode?: string };
  }>("/api/search", async (request) => {
    const q = (request.query.q ?? "").trim();
    if (!q) return { hits: [] };
    const limit = Math.min(
      100,
      Math.max(1, Number(request.query.limit ?? 50) || 50),
    );
    const mode =
      request.query.mode === "fts" || request.query.mode === "semantic"
        ? request.query.mode
        : "hybrid";
    const hits = await hybridSearch(worker, q, limit, mode);
    return { hits };
  });
}
