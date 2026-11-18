/** Upload routes: multipart parsing over the upload service. */

import type { FastifyInstance } from "fastify";
import type { Source } from "../db/entities";
import type { WorkerClient } from "../worker/client";
import type { Config } from "../lib/config";
import { ingestUpload, type UploadOutcome } from "../services/upload.service";
import { ServiceError } from "../lib/errors";
import {
  findAssetByFileNameInGroup,
  findAssetByMd5,
} from "../repositories/asset.repository";

export type { UploadOutcome };

export function registerUploadRoutes(
  app: FastifyInstance,
  deps: {
    config: Config;
    worker: WorkerClient;
    poolSource: () => Promise<Source>;
  },
) {
  // Upload preflight: name+md5+dir per file -> conflict report so the
  // UI can ask (overwrite / keep both / skip) BEFORE transferring bytes.
  app.post<{
    Body: { dir?: string; items?: Array<{ name?: string; md5?: string }> };
  }>("/api/upload/check", async (request) => {
    const dir = (request.body?.dir ?? "").replace(/^[./]+/, "");
    const items = request.body?.items ?? [];
    const results = await Promise.all(
      items.map(async (it) => {
        const name = (it.name ?? "").trim();
        if (!name) return { status: "error" as const, reason: "missing name" };
        const sameName = await findAssetByFileNameInGroup(name, dir || null);
        const sameHash = it.md5 ? await findAssetByMd5(it.md5) : null;
        if (sameHash) {
          return {
            status: "same-hash" as const,
            existingPath: sameHash.path,
          };
        }
        if (sameName) {
          return {
            status: "same-name" as const,
            existingPath: sameName.path,
          };
        }
        return { status: "ok" as const };
      }),
    );
    return { results };
  });

  app.post<{ Body?: { dir?: string | null } }>(
    "/api/upload",
    async (request, reply) => {
      const parts = request.files({
        limits: { fileSize: deps.config.maxUploadBytes },
      });
      // attachFieldsToBody is off — non-file fields ride on the first
      // file part (part.fields); request.body stays undefined.
      let dir = "";
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
      dir = (field("dir") ?? "").replace(/^[./]+/, "");
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
          dir,
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
