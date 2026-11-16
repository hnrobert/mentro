/** Source routes: thin adapters over the sources service. */

import type { FastifyInstance } from "fastify";
import type { WorkerClient } from "../worker/client";
import {
  listSources,
  mountSource,
  removeSource,
  rescanSource,
} from "../services/sources.service";

export function registerSourceRoutes(
  app: FastifyInstance,
  deps: { worker: WorkerClient },
) {
  app.get("/api/sources", async () => ({
    sources: await listSources(),
  }));

  app.post<{ Body: { rootPath?: string } }>(
    "/api/sources",
    async (request, reply) => {
      const source = await mountSource(
        request.body?.rootPath ?? "",
        deps.worker,
      );
      return reply.code(201).send({ source });
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/sources/:id",
    async (request) => ({
      ok: true,
      removedAssets: await removeSource(request.params.id),
    }),
  );

  app.post<{ Params: { id: string } }>(
    "/api/sources/:id/rescan",
    async (request) => {
      await rescanSource(request.params.id, deps.worker);
      return { ok: true };
    },
  );
}
