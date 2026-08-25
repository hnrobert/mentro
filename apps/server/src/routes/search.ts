import type { FastifyInstance } from "fastify";
import { ftsMatchExpr } from "../search/segment";
import { ftsSearch } from "../search/fts";

export function registerSearchRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { q?: string; limit?: string } }>(
    "/api/search",
    async (request) => {
      const q = (request.query.q ?? "").trim();
      if (!q) return { hits: [] };
      const limit = Math.min(100, Math.max(1, Number(request.query.limit ?? 50) || 50));
      const hits = await ftsSearch(ftsMatchExpr(q), limit);
      return { hits };
    },
  );
}
