import type { FastifyInstance } from "fastify";
import { buildDelta, buildFullBundle } from "../indexbundle";

export function registerIndexRoutes(app: FastifyInstance) {
  // Full bundle by default; `?since=<version>` returns a delta. ETag on the
  // full form lets clients revalidate cheaply on reload.
  app.get<{ Querystring: { since?: string } }>(
    "/api/index",
    async (request, reply) => {
      const since = Number(request.query.since);
      if (
        Number.isInteger(since) &&
        since >= 0 &&
        request.query.since !== undefined
      ) {
        const delta = await buildDelta(since);
        return reply.send(delta);
      }
      const bundle = await buildFullBundle();
      const etag = `W/"v${bundle.version}"`;
      reply.header("etag", etag);
      if (request.headers["if-none-match"] === etag) {
        return reply.code(304).send();
      }
      return reply.send(bundle);
    },
  );
}
