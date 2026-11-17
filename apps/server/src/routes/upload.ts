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
      // attachFieldsToBody is off — non-file fields ride on the first
      // file part (part.fields); request.body stays undefined.
      let groupId: string | null = null;
      const uploader = request.user?.id ?? null;
      let overwrite = false;
      let mtimes: Array<{ name: string; lastModified: number }> = [];
      const it = parts[Symbol.asyncIterator]();
      const first = await it.next();
      if (first.done) return reply.code(201).send({ uploaded: [] });
      const firstPart = first.value;
      const field = (k: string): string | undefined => {
        const v = (firstPart as { fields?: Record<string, unknown> }).fields?.[
          k
        ];
        return typeof v === "string" ? v : undefined;
      };
      groupId = field("groupId") || null;
      overwrite = field("overwrite") === "true";
      try {
        mtimes = JSON.parse(field("meta") ?? "[]");
      } catch {
        mtimes = [];
      }
      // Re-wrap the peeked part back into a file iterable.
      const firstFields = (firstPart as { fields?: Record<string, unknown> })
        .fields;
      const files = (async function* () {
        yield { ...firstPart, fields: firstFields } as typeof firstPart;
        let nxt = await it.next();
        while (!nxt.done) {
          yield nxt.value;
          nxt = await it.next();
        }
      })();
      try {
        const uploaded = await ingestUpload(deps, files, {
          groupId,
          uploader,
          overwrite,
          mtimes,
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
