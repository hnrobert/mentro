/** Asset routes: thin HTTP adapters over the asset service (detail,
 *  raw file, render-on-miss thumbnails, unit translations, rendered
 *  PDF). */

import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import type { WorkerPool } from "../worker/pool";
import {
  assetDetail,
  assetFileStream,
  renderedPdf,
  resolveThumb,
  unitTranslations,
} from "../services/asset.service";
import { listAssetsPaged } from "../repositories/asset.repository";
import { readableAssetIds } from "../services/acl.service";

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
    const readable = await readableAssetIds(request.user!);
    const where: Record<string, string> = {};
    if (kind) where.kind = kind;
    if (status) where.extractionStatus = status;
    const { items } = await listAssetsPaged(where, page, pageSize);
    const visible =
      readable === "all" ? items : items.filter((a) => readable.has(a.id));
    return { total: visible.length, page, pageSize, assets: visible };
  });

  app.get<{ Params: { id: string } }>("/api/assets/:id", async (request) =>
    assetDetail(request.user!, request.params.id),
  );

  app.get<{ Params: { id: string } }>(
    "/api/assets/:id/file",
    async (request, reply) => {
      const { stream, mime, fileName } = await assetFileStream(
        request.user!,
        request.params.id,
      );
      reply.header(
        "content-disposition",
        `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      );
      if (mime) reply.type(mime);
      return reply.send(stream);
    },
  );

  // Thumbnail for a content unit; lazily rendered on first request.
  app.get<{ Params: { unitId: string }; Querystring: { full?: string } }>(
    "/api/thumbs/:unitId",
    async (request, reply) => {
      const { file } = await resolveThumb(
        request.user!,
        request.params.unitId,
        request.query.full === "1",
        pool,
      );
      reply.type("image/png");
      return reply.send(fs.createReadStream(file));
    },
  );

  // Translations of one unit, lazy-loaded by the detail view toggle.
  app.get<{ Params: { unitId: string } }>(
    "/api/units/:unitId/translations",
    async (request) => ({
      translations: await unitTranslations(
        request.user!,
        request.params.unitId,
      ),
    }),
  );

  // Rendered PDF (office -> pdf cache) for in-browser preview.
  app.get<{ Params: { id: string } }>(
    "/api/assets/:id/rendered",
    async (request, reply) => {
      const { file } = await renderedPdf(request.user!, request.params.id);
      reply.type("application/pdf");
      return reply.send(fs.createReadStream(file));
    },
  );
}
