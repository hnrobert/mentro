/** Agent Tool API routes: thin adapters over the agent + search +
 *  export services. Same JWT guard as everything else under /api; the
 *  MCP endpoint (mcp.ts) wraps these same operations as MCP tools. */

import type { FastifyInstance } from "fastify";
import type { WorkerClient } from "../worker/client";
import { hybridSearch } from "../services/search.service";
import { createExportJob, type ExportBody } from "../services/export.service";
import {
  agentAssetOverview,
  agentContext,
  agentTranscribe,
  agentUnit,
} from "../services/agent.service";
import { ServiceError } from "../lib/errors";

export function registerAgentRoutes(
  app: FastifyInstance,
  worker: WorkerClient,
) {
  app.get<{
    Querystring: { q?: string; limit?: string; kind?: string; mode?: string };
  }>("/api/agent/search", async (request) => {
    const q = (request.query.q ?? "").trim();
    if (!q) return { hits: [] };
    const limit = Math.min(
      50,
      Math.max(1, Number(request.query.limit ?? 20) || 20),
    );
    let hits = await hybridSearch(
      worker,
      q,
      limit,
      request.query.mode === "fts" || request.query.mode === "semantic"
        ? request.query.mode
        : "hybrid",
    );
    if (request.query.kind) {
      hits = hits.filter((h) => h.kind === request.query.kind);
    }
    return { hits };
  });

  app.get<{ Params: { id: string } }>(
    "/api/agent/assets/:id",
    async (request) => agentAssetOverview(request.user!, request.params.id),
  );

  app.get<{ Params: { id: string } }>("/api/agent/units/:id", async (request) =>
    agentUnit(request.user!, request.params.id),
  );

  app.get<{
    Querystring: { unitId?: string; before?: string; after?: string };
  }>("/api/agent/context", async (request) => {
    const unitId = request.query.unitId;
    if (!unitId) throw new ServiceError(400, "unitId required");
    return {
      units: await agentContext(
        request.user!,
        unitId,
        Number(request.query.before ?? 1) || 0,
        Number(request.query.after ?? 1) || 0,
      ),
    };
  });

  app.post<{ Body: ExportBody }>(
    "/api/agent/export",
    async (request, reply) => {
      const outcome = await createExportJob(request.user, request.body);
      return reply.code(202).send(outcome);
    },
  );

  app.post<{ Params: { assetId: string } }>(
    "/api/agent/transcribe/:assetId",
    async (request, reply) => {
      const { jobId } = await agentTranscribe(
        request.user!,
        request.params.assetId,
      );
      return reply.code(202).send({
        jobId,
        statusUrl: `/api/jobs`,
        note: "poll jobs or the asset units; transcript units carry meta_json='transcript'",
      });
    },
  );
}
