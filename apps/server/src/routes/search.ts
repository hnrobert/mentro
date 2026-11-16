/** Search routes: thin adapters over the search service (hybrid
 *  pipeline + as-you-type suggestions). */

import type { FastifyInstance } from "fastify";
import { ftsSearch } from "../search/fts";
import type { WorkerClient } from "../worker/client";
import {
  extractCompletions,
  hybridSearch,
  prefixExpr,
  readableSetOf,
  type Scope,
  type SuggestResponse,
} from "../services/search.service";

export async function registerSearchRoutes(
  app: FastifyInstance,
  worker: WorkerClient,
) {
  app.get<{
    Querystring: {
      q?: string;
      limit?: string;
      mode?: string;
      scope?: string;
      groups?: string;
    };
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
    const scope: Scope =
      request.query.scope === "content" || request.query.scope === "filename"
        ? request.query.scope
        : "everywhere";
    const groups = request.query.groups
      ? new Set(request.query.groups.split(",").filter(Boolean))
      : undefined;
    const hits = await hybridSearch(worker, q, limit, mode, {
      scope,
      groups,
      readable: await readableSetOf(request.user),
    });
    return { hits };
  });

  // As-you-type suggestions: completion phrases + quick-jump page hits.
  app.get<{ Querystring: { q?: string } }>(
    "/api/search/suggest",
    async (request) => {
      const q = (request.query.q ?? "").trim();
      if (q.length < 1)
        return { terms: [], hits: [] } satisfies SuggestResponse;
      const expr = prefixExpr(q);
      const hits = expr
        ? await ftsSearch(
            expr,
            20,
            undefined,
            await readableSetOf(request.user),
          )
        : [];
      const terms = extractCompletions(
        q,
        hits.flatMap((h) => [
          (h.snippet ?? "").replaceAll("[", "").replaceAll("]", ""),
          h.title ?? "",
        ]),
        8,
      );
      return {
        terms,
        hits: hits.slice(0, 3).map((h) => ({
          unitId: h.unitId,
          assetId: h.assetId,
          ordinal: h.ordinal,
          unitType: h.unitType,
          title: h.title,
          fileName: h.fileName,
          kind: h.kind,
        })),
      } satisfies SuggestResponse;
    },
  );
}
