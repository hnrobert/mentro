import fs from "node:fs";
import path from "node:path";
import { ulid } from "ulid";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { AppDataSource } from "../db/data-source";
import { Asset, Job } from "../db/entities";
import { parseExportPayload } from "../queue/dispatcher";

/**
 * Export formats:
 * - "pdf"      — all selected pages merged into ONE pdf (agent flow)
 * - "pptx"     — slides cropped from each source deck (verbatim parts);
 *                multiple decks are zipped
 * - "native"   — cart flow: per-file crop in the file's own format
 *                (deck → cropped pptx, document/pdf → cropped pdf);
 *                multiple files are zipped
 * - "original" — unmodified original files, zipped when more than one
 */

type ExportFormat = "pdf" | "pptx" | "native" | "original";

interface ExportBody {
  units: Array<{ assetId: string; ordinal: number }>;
  format: ExportFormat;
  nameHint?: string;
}

/** Shared by /api/export and the agent API: validate refs, enqueue an
 *  export job, return its id for polling. */
export async function createExportJob(
  request: FastifyRequest,
  body: ExportBody,
): Promise<{ jobId: string } | { error: string; code: number }> {
  const formats: ExportFormat[] = ["pdf", "pptx", "native", "original"];
  if (
    !Array.isArray(body.units) ||
    body.units.length === 0 ||
    body.units.length > 500 ||
    !formats.includes(body.format)
  ) {
    return {
      error: "body: units[] (1..500) + format pdf|pptx|native|original",
      code: 400,
    };
  }
  if (body.format === "pptx" || body.format === "native") {
    // pdf/office sources only — pages/slides are croppable, media is not
    const assetRepo = AppDataSource.getRepository(Asset);
    for (const ref of body.units) {
      if (!ref.assetId || !Number.isInteger(ref.ordinal) || ref.ordinal < 1) {
        return { error: "units need assetId + 1-based ordinal", code: 400 };
      }
    }
    const distinct = new Set(body.units.map((u) => u.assetId));
    for (const assetId of distinct) {
      const asset = await assetRepo.findOneBy({ id: assetId });
      if (!asset) return { error: `asset ${assetId} not found`, code: 404 };
      if (
        asset.kind !== "presentation" &&
        asset.kind !== "pdf" &&
        asset.kind !== "document"
      ) {
        return {
          error: `page cropping needs pdf/presentation/document sources, ${asset.path.split("/").pop()} is ${asset.kind}`,
          code: 400,
        };
      }
    }
  } else {
    const assetRepo = AppDataSource.getRepository(Asset);
    for (const ref of body.units) {
      if (!ref.assetId || !Number.isInteger(ref.ordinal) || ref.ordinal < 1) {
        return { error: "units need assetId + 1-based ordinal", code: 400 };
      }
      const asset = await assetRepo.findOneBy({ id: ref.assetId });
      if (!asset) return { error: `asset ${ref.assetId} not found`, code: 404 };
    }
  }
  const user = (request as unknown as { user?: { id: string } }).user;
  const job = await AppDataSource.getRepository(Job).save({
    id: ulid(),
    assetId: null,
    kind: "export",
    status: "pending",
    payload: JSON.stringify({
      units: body.units,
      format: body.format,
      nameHint: body.nameHint ?? "",
      createdBy: user?.id ?? null,
    }),
  });
  return { jobId: job.id };
}

export function registerExportRoutes(app: FastifyInstance) {
  app.post<{ Body: ExportBody }>("/api/export", async (request, reply) => {
    const outcome = await createExportJob(request, request.body);
    if ("error" in outcome) {
      return reply.code(outcome.code).send({ error: outcome.error });
    }
    return reply.code(202).send(outcome);
  });

  app.get<{ Params: { id: string } }>(
    "/api/export/:id",
    async (request, reply) => {
      const job = await AppDataSource.getRepository(Job).findOneBy({
        id: request.params.id,
      });
      if (!job || job.kind !== "export") {
        return reply.code(404).send({ error: "not found" });
      }
      const payload = parseExportPayload(job.payload);
      return {
        id: job.id,
        status: job.status,
        format: payload?.format,
        units: payload?.units,
        artifactPath: payload?.artifactPath ?? null,
        artifacts: payload?.artifacts ?? [],
        error: job.error,
        createdAt: job.createdAt,
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/export/:id/file",
    async (request, reply) => {
      const job = await AppDataSource.getRepository(Job).findOneBy({
        id: request.params.id,
      });
      const payload =
        job?.kind === "export" ? parseExportPayload(job.payload) : null;
      if (!payload?.artifactPath) {
        return reply.code(404).send({ error: "no artifact yet" });
      }
      const dataDir = process.env.MENTRO_DATA ?? "./data";
      const file = path.join(dataDir, payload.artifactPath);
      if (
        !file.startsWith(path.join(dataDir, "exports")) ||
        !fs.existsSync(file)
      ) {
        return reply.code(404).send({ error: "artifact missing" });
      }
      const name = payload.artifactPath.split("/").pop() ?? "export";
      reply.header(
        "content-disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      );
      reply.type(
        payload.artifactPath.endsWith(".zip")
          ? "application/zip"
          : payload.format === "pptx"
            ? "application/vnd.openxmlformats-officedocument.presentationml.presentation"
            : "application/pdf",
      );
      return reply.send(fs.createReadStream(file));
    },
  );
}
