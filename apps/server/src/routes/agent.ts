import { ulid } from "ulid";
import type { FastifyInstance } from "fastify";
import { AppDataSource } from "../db/data-source";
import { Asset, ContentUnit, Job } from "../db/entities";
import { hybridSearch } from "./search";
import { createExportJob } from "./export";
import type { WorkerClient } from "../worker/client";
import { canRead } from "../auth/perm";

/**
 * Agent Tool API (M6): the read/search/export surface an autonomous
 * agent operates through — never the file system. Same JWT guard as
 * everything else under /api. The MCP endpoint (mcp.ts) wraps these
 * same operations as MCP tools.
 */
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
    async (request, reply) => {
      const asset = await AppDataSource.getRepository(Asset).findOneBy({
        id: request.params.id,
      });
      if (!asset) return reply.code(404).send({ error: "not found" });
      if (!(await canRead(request.user!, asset.id))) {
        return reply.code(403).send({ error: "forbidden" });
      }
      const units = await AppDataSource.getRepository(ContentUnit).find({
        where: { assetId: asset.id },
        order: { ordinal: "ASC" },
      });
      return {
        asset,
        units: units.map((u) => ({
          unitId: u.id,
          ordinal: u.ordinal,
          unitType: u.unitType,
          title: u.title,
          startMs: u.startMs,
          endMs: u.endMs,
          textPreview: (u.text ?? "").slice(0, 300),
        })),
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/agent/units/:id",
    async (request, reply) => {
      const unit = await AppDataSource.getRepository(ContentUnit).findOneBy({
        id: request.params.id,
      });
      if (!unit) return reply.code(404).send({ error: "not found" });
      if (!(await canRead(request.user!, unit.assetId))) {
        return reply.code(403).send({ error: "forbidden" });
      }
      const asset = await AppDataSource.getRepository(Asset).findOneBy({
        id: unit.assetId,
      });
      return { unit, asset };
    },
  );

  app.get<{
    Querystring: { unitId?: string; before?: string; after?: string };
  }>("/api/agent/context", async (request, reply) => {
    const unitId = request.query.unitId;
    if (!unitId) return reply.code(400).send({ error: "unitId required" });
    const unit = await AppDataSource.getRepository(ContentUnit).findOneBy({
      id: unitId,
    });
    if (!unit) return reply.code(404).send({ error: "unit not found" });
    if (!(await canRead(request.user!, unit.assetId))) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const before = Math.min(
      10,
      Math.max(0, Number(request.query.before ?? 1) || 0),
    );
    const after = Math.min(
      10,
      Math.max(0, Number(request.query.after ?? 1) || 0),
    );
    const units = await AppDataSource.getRepository(ContentUnit)
      .createQueryBuilder("cu")
      .where("cu.asset_id = :assetId", { assetId: unit.assetId })
      .andWhere("cu.ordinal BETWEEN :lo AND :hi", {
        lo: Math.max(1, unit.ordinal - before),
        hi: unit.ordinal + after,
      })
      .orderBy("cu.ordinal", "ASC")
      .getMany();
    return { units };
  });

  app.post<{
    Body: {
      units: Array<{ assetId: string; ordinal: number }>;
      format: "pdf" | "pptx";
      nameHint?: string;
    };
  }>("/api/agent/export", async (request, reply) => {
    const outcome = await createExportJob(request, request.body);
    if ("error" in outcome) {
      return reply.code(outcome.code).send({ error: outcome.error });
    }
    return reply.code(202).send(outcome);
  });

  app.post<{ Params: { assetId: string } }>(
    "/api/agent/transcribe/:assetId",
    async (request, reply) => {
      const asset = await AppDataSource.getRepository(Asset).findOneBy({
        id: request.params.assetId,
      });
      if (!asset) return reply.code(404).send({ error: "asset not found" });
      if (!(await canRead(request.user!, asset.id))) {
        return reply.code(403).send({ error: "forbidden" });
      }
      if (asset.kind !== "audio" && asset.kind !== "video") {
        return reply
          .code(400)
          .send({ error: `kind ${asset.kind} has no audio track` });
      }
      const jobRepo = AppDataSource.getRepository(Job);
      const existing = await jobRepo.findOne({
        where: { kind: "transcribe", assetId: asset.id, status: "pending" },
      });
      const jobId = existing?.id ?? ulid();
      if (!existing) {
        await jobRepo.insert({
          id: jobId,
          assetId: asset.id,
          kind: "transcribe",
          status: "pending",
        });
      }
      return reply.code(202).send({
        jobId,
        statusUrl: `/api/jobs`,
        note: "poll jobs or the asset units; transcript units carry meta_json='transcript'",
      });
    },
  );
}
