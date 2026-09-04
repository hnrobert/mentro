import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { AppDataSource } from "../db/data-source";
import { Asset, ContentUnit } from "../db/entities";
import type { WorkerClient } from "../worker/client";

/** Kinds whose pages can be lazily rendered to preview images. */
const RENDERABLE = new Set(["pdf", "presentation", "document"]);

export function registerAssetRoutes(
  app: FastifyInstance,
  worker?: WorkerClient,
) {
  app.get<{
    Querystring: {
      kind?: string;
      page?: string;
      pageSize?: string;
      status?: string;
    };
  }>("/api/assets", async (request) => {
    const { kind, status } = request.query;
    const page = Math.max(1, Number(request.query.page ?? 1) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, Number(request.query.pageSize ?? 30) || 30),
    );
    const repo = AppDataSource.getRepository(Asset);
    const where: Record<string, string> = {};
    if (kind) where.kind = kind;
    if (status) where.extractionStatus = status;
    const [items, total] = await repo.findAndCount({
      where,
      order: { path: "ASC" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return { total, page, pageSize, assets: items };
  });

  app.get<{ Params: { id: string } }>(
    "/api/assets/:id",
    async (request, reply) => {
      const asset = await AppDataSource.getRepository(Asset).findOneBy({
        id: request.params.id,
      });
      if (!asset) return reply.code(404).send({ error: "not found" });
      const units = await AppDataSource.getRepository(ContentUnit).find({
        where: { assetId: asset.id },
        order: { ordinal: "ASC" },
      });
      return { asset, units };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/assets/:id/file",
    async (request, reply) => {
      const asset = await AppDataSource.getRepository(Asset).findOneBy({
        id: request.params.id,
      });
      if (!asset || !fs.existsSync(asset.path)) {
        return reply.code(404).send({ error: "not found" });
      }
      reply.header(
        "content-disposition",
        `inline; filename*=UTF-8''${encodeURIComponent(asset.path.split("/").pop() ?? "file")}`,
      );
      if (asset.mime) reply.type(asset.mime);
      return reply.send(fs.createReadStream(asset.path));
    },
  );

  // Thumbnail for a content unit; lazily renders the page on first
  // request (render-on-miss) for pdf/office kinds.
  app.get<{ Params: { unitId: string } }>(
    "/api/thumbs/:unitId",
    async (request, reply) => {
      const unit = await AppDataSource.getRepository(ContentUnit).findOneBy({
        id: request.params.unitId,
      });
      if (!unit) {
        return reply.code(404).send({ error: "unit not found" });
      }
      const dataDir = process.env.MENTRO_DATA ?? "./data";

      let thumbPath = unit.thumbPath;
      if (!thumbPath && worker) {
        // Render-on-miss: ask the worker to render this page once.
        const asset = await AppDataSource.getRepository(Asset).findOneBy({
          id: unit.assetId,
        });
        if (asset && RENDERABLE.has(asset.kind) && fs.existsSync(asset.path)) {
          const resp = await worker.renderPage(
            {
              assetId: asset.id,
              path: asset.path,
              ordinal: unit.ordinal,
              contentHash: asset.contentHash ?? "",
            },
            5 * 60 * 1000,
          );
          if (resp.ok && resp.result?.case === "renderResult") {
            thumbPath = resp.result.value.thumbPath;
            await AppDataSource.getRepository(ContentUnit).update(
              { id: unit.id },
              { thumbPath },
            );
          }
        }
      }

      if (!thumbPath) {
        return reply.code(404).send({ error: "no thumbnail" });
      }
      const file = path.join(dataDir, thumbPath);
      if (!fs.existsSync(file)) {
        return reply.code(404).send({ error: "not rendered" });
      }
      reply.type("image/png");
      return reply.send(fs.createReadStream(file));
    },
  );

  // Rendered PDF (office -> pdf cache) for in-browser preview.
  app.get<{ Params: { id: string } }>(
    "/api/assets/:id/rendered",
    async (request, reply) => {
      const asset = await AppDataSource.getRepository(Asset).findOneBy({
        id: request.params.id,
      });
      if (!asset) return reply.code(404).send({ error: "not found" });
      const dataDir = process.env.MENTRO_DATA ?? "./data";
      const pdf = path.join(dataDir, "render", `${asset.id}.pdf`);
      if (!fs.existsSync(pdf)) {
        return reply.code(404).send({ error: "not rendered" });
      }
      reply.type("application/pdf");
      return reply.send(fs.createReadStream(pdf));
    },
  );
}
