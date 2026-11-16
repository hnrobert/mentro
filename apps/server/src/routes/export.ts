/** Export routes: thin adapters over the export service. */

import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import {
  createExportJob,
  exportArtifact,
  exportJobStatus,
  type ExportBody,
} from "../services/export.service";

export function registerExportRoutes(app: FastifyInstance) {
  app.post<{ Body: ExportBody }>("/api/export", async (request, reply) => {
    const { jobId } = await createExportJob(request.user, request.body);
    return reply.code(202).send({ jobId });
  });

  app.get<{ Params: { id: string } }>("/api/export/:id", async (request) =>
    exportJobStatus(request.params.id),
  );

  app.get<{ Params: { id: string } }>(
    "/api/export/:id/file",
    async (request, reply) => {
      const { file, name, mime, size } = await exportArtifact(
        request.params.id,
      );
      reply.header(
        "content-disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      );
      // Known length lets the browser show real download progress.
      reply.header("content-length", size);
      reply.type(mime);
      return reply.send(fs.createReadStream(file));
    },
  );
}
