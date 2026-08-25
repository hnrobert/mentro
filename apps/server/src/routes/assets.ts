import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { AppDataSource } from "../db/data-source";
import { Asset, ContentUnit } from "../db/entities";

export function registerAssetRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: { kind?: string; page?: string; pageSize?: string; status?: string };
  }>("/api/assets", async (request) => {
    const { kind, status } = request.query;
    const page = Math.max(1, Number(request.query.page ?? 1) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(request.query.pageSize ?? 30) || 30));
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
}
