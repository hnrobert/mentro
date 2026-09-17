import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { AppDataSource } from "../db/data-source";
import { Asset, ContentUnit } from "../db/entities";
import type { WorkerPool } from "../worker/pool";
import { canRead, readableAssetIds } from "../auth/perm";

/** Kinds whose pages can be lazily rendered to preview images. */
const RENDERABLE = new Set(["pdf", "presentation", "document"]);

export function registerAssetRoutes(app: FastifyInstance, pool?: WorkerPool) {
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
    const readable = await readableAssetIds(request.user!);
    const where: Record<string, string> = {};
    if (kind) where.kind = kind;
    if (status) where.extractionStatus = status;
    const [items] = await repo.findAndCount({
      where,
      order: { path: "ASC" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    const visible =
      readable === "all" ? items : items.filter((a) => readable.has(a.id));
    return { total: visible.length, page, pageSize, assets: visible };
  });

  app.get<{ Params: { id: string } }>(
    "/api/assets/:id",
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
      if (!(await canRead(request.user!, asset.id))) {
        return reply.code(403).send({ error: "forbidden" });
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
  // request (render-on-miss) for pdf/office kinds. `?full=1` renders
  // preview-grade (1200px) instead of thumbnail-grade (480px). Renders
  // run through the worker POOL (an idle worker), never a pinned one —
  // a busy primary must not stall UI previews behind extraction jobs.
  app.get<{ Params: { unitId: string }; Querystring: { full?: string } }>(
    "/api/thumbs/:unitId",
    async (request, reply) => {
      const unit = await AppDataSource.getRepository(ContentUnit).findOneBy({
        id: request.params.unitId,
      });
      if (!unit) {
        return reply.code(404).send({ error: "unit not found" });
      }
      if (!(await canRead(request.user!, unit.assetId))) {
        return reply.code(403).send({ error: "forbidden" });
      }
      const dataDir = process.env.MENTRO_DATA ?? "./data";
      const full = request.query.full === "1";

      let thumbPath = unit.thumbPath;
      if (!thumbPath && pool) {
        // Render-on-miss: ask the worker to render this page once.
        const asset = await AppDataSource.getRepository(Asset).findOneBy({
          id: unit.assetId,
        });
        if (asset && RENDERABLE.has(asset.kind) && fs.existsSync(asset.path)) {
          const resp = await pool.run((worker) =>
            worker.renderPage(
              {
                assetId: asset.id,
                path: asset.path,
                ordinal: unit.ordinal,
                contentHash: asset.contentHash ?? "",
                full,
              },
              5 * 60 * 1000,
            ),
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
      if (!(await canRead(request.user!, asset.id))) {
        return reply.code(403).send({ error: "forbidden" });
      }
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
