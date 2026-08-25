import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { ulid } from "ulid";
import { AppDataSource } from "../db/data-source";
import { Asset, Source } from "../db/entities";
import { deleteAssetCascade, runSourceScan } from "../pipeline/scan";
import { publish } from "../bus";
import type { WorkerClient } from "../worker/client";

export function registerSourceRoutes(
  app: FastifyInstance,
  deps: { worker: WorkerClient },
) {
  app.get("/api/sources", async () => {
    const sources = await AppDataSource.getRepository(Source).find({
      order: { addedAt: "ASC" },
    });
    const assetRepo = AppDataSource.getRepository(Asset);
    return {
      sources: await Promise.all(
        sources.map(async (s) => {
          const total = await assetRepo.countBy({ sourceId: s.id });
          const done = await assetRepo.countBy({
            sourceId: s.id,
            extractionStatus: "done",
          });
          return { ...s, assetCount: total, doneCount: done };
        }),
      ),
    };
  });

  app.post<{ Body: { rootPath?: string } }>(
    "/api/sources",
    async (request, reply) => {
      const { rootPath } = request.body ?? {};
      if (!rootPath || typeof rootPath !== "string") {
        return reply.code(400).send({ error: "rootPath required" });
      }
      const abs = path.resolve(rootPath.trim());
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
        return reply.code(400).send({ error: `not a directory: ${abs}` });
      }
      const repo = AppDataSource.getRepository(Source);
      if (await repo.findOneBy({ rootPath: abs })) {
        return reply.code(409).send({ error: "source already exists" });
      }
      const source = await repo.save({
        id: ulid(),
        rootPath: abs,
      });
      // First scan runs in the background; WS snapshots report progress.
      void runSourceScan(source, deps.worker)
        .then((outcome) => {
          console.log(`[scan] ${abs}: ${JSON.stringify(outcome)}`);
          publish({ event: "scan.finished", sourceId: source.id, ...outcome });
        })
        .catch((err) => console.error(`[scan] ${abs} failed:`, err));
      return reply.code(201).send({ source });
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/sources/:id",
    async (request, reply) => {
      const repo = AppDataSource.getRepository(Source);
      const source = await repo.findOneBy({ id: request.params.id });
      if (!source) return reply.code(404).send({ error: "not found" });
      const assets = await AppDataSource.getRepository(Asset).findBy({
        sourceId: source.id,
      });
      for (const asset of assets) await deleteAssetCascade(asset.id);
      await repo.delete({ id: source.id });
      return { ok: true, removedAssets: assets.length };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/sources/:id/rescan",
    async (request, reply) => {
      const source = await AppDataSource.getRepository(Source).findOneBy({
        id: request.params.id,
      });
      if (!source) return reply.code(404).send({ error: "not found" });
      void runSourceScan(source, deps.worker)
        .then((outcome) =>
          publish({ event: "scan.finished", sourceId: source.id, ...outcome }),
        )
        .catch((err) =>
          console.error(`[scan] ${source.rootPath} failed:`, err),
        );
      return { ok: true };
    },
  );
}
