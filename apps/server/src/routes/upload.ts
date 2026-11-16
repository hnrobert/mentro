/** Upload routes: multipart parsing over the upload service. */

import type { FastifyInstance } from "fastify";
import type { Source } from "../db/entities";
import type { WorkerClient } from "../worker/client";
import type { Config } from "../config";
import { ingestUpload, type UploadOutcome } from "../services/upload.service";
import { ServiceError } from "../services/errors";

export type { UploadOutcome };

export function registerUploadRoutes(
  app: FastifyInstance,
  deps: {
    config: Config;
    worker: WorkerClient;
    poolSource: () => Promise<Source>;
  },
) {
  app.post<{ Body?: { groupId?: string | null } }>(
    "/api/upload",
    async (request, reply) => {
      const parts = request.files({
        limits: { fileSize: deps.config.maxUploadBytes },
      });
      // Uploaded files land in the selected group (or ungrouped).
      const groupId =
        (request.body as { groupId?: string } | undefined)?.groupId ?? null;
      const uploader = request.user?.id ?? null;
      const overwrite =
        (request.body as { overwrite?: boolean } | undefined)?.overwrite ===
        true;
      try {
        const uploaded = await ingestUpload(deps, parts, {
          groupId,
          uploader,
          overwrite,
        });
        return reply.code(201).send({ uploaded });
      } catch (err) {
        if (err instanceof ServiceError && err.message === "duplicate") {
          const dup = err as ServiceError & {
            fileName?: string;
            existingId?: string;
          };
          return reply.code(409).send({
            error: "duplicate",
            fileName: dup.fileName,
            existingId: dup.existingId,
          });
        }
        throw err;
      }
    },
  );
}
