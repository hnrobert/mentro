/** Search routes: thin adapters over the search service (hybrid
 *  pipeline + as-you-type suggestions). */

import type { FastifyInstance } from "fastify";
import {
  ftsSearch,
  ftsSearchTranslations,
  type SearchHit,
} from "../search/fts";
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
      const readable = await readableSetOf(request.user);
      // Two legs: originals AND translations — an English prefix like
      // "port" must surface Chinese decks (matched via their en
      // translations) while typing, not only after Enter.
      const origPromise: Promise<SearchHit[]> = expr
        ? ftsSearch(expr, 20, undefined, readable)
        : Promise.resolve([]);
      const transPromise: Promise<SearchHit[]> = expr
        ? ftsSearchTranslations(expr, 10, undefined, readable)
        : Promise.resolve([]);
      const [origHits, transHits] = await Promise.all([
        origPromise,
        transPromise,
      ]);
      // Round-robin interleave (o0, t0, o1, o2, t1, ...) so
      // translation hits are not buried under 20 original matches —
      // a Chinese deck must reach the quick-jump slots, not just the
      // completion pool.
      const hits: SearchHit[] = [];
      const seen = new Set<string>();
      const assets = new Set<string>();
      const push = (h: SearchHit) => {
        if (seen.has(h.unitId)) return;
        // The quick-jump slots (first 3) show DISTINCT files — one
        // English deck with 20 matching units must not crowd the
        // Chinese decks out of the dropdown.
        if (hits.length < 3 && assets.has(h.assetId)) return;
        seen.add(h.unitId);
        assets.add(h.assetId);
        hits.push(h);
      };
      for (
        let i = 0;
        hits.length < 20 && (i < origHits.length || i < transHits.length);
        i++
      ) {
        if (i < origHits.length) push(origHits[i]!);
        if (i === 0 || i === 2) {
          // translation slots: rank 0 and rank 1 of the translation leg
          const t = (i === 0 ? transHits[0] : transHits[1]) as
            SearchHit | undefined;
          if (t) push(t);
        }
      }
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
