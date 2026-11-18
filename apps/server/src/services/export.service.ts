/** Export domain: validating unit refs, enqueueing export jobs, and
 *  resolving job status/artifacts. The heavy lifting (pdf/pptx/native
 *  composition) lives in the worker; this service owns job semantics. */

import fs from "node:fs";
import path from "node:path";
import { ulid } from "ulid";
import { Job } from "../db/entities";
import { findAssetById } from "../repositories/asset.repository";
import { findJobById, saveJob } from "../repositories/job.repository";
import type { ExportJobPayload } from "../queue/dispatcher";
import { canRead } from "./acl.service";
import type { AuthUser } from "../auth/tokens";
import { ServiceError } from "../lib/errors";

export type ExportFormat = "pdf" | "pptx" | "native" | "original";

export interface ExportBody {
  units: Array<{ assetId: string; ordinal: number }>;
  format: ExportFormat;
  nameHint?: string;
}

const FORMATS: ExportFormat[] = ["pdf", "pptx", "native", "original"];

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

/** Validate refs, enqueue an export job, return its id for polling.
 *  Shared by /api/export and the agent API. */
export async function createExportJob(
  user: AuthUser | undefined,
  body: ExportBody,
): Promise<{ jobId: string }> {
  if (
    !Array.isArray(body.units) ||
    body.units.length === 0 ||
    body.units.length > 500 ||
    !FORMATS.includes(body.format)
  ) {
    throw new ServiceError(
      400,
      "body: units[] (1..500) + format pdf|pptx|native|original",
    );
  }
  if (body.format === "pptx" || body.format === "native") {
    // pdf/office sources only — pages/slides are croppable, media is not
    for (const ref of body.units) {
      if (!ref.assetId || !Number.isInteger(ref.ordinal) || ref.ordinal < 1) {
        throw new ServiceError(400, "units need assetId + 1-based ordinal");
      }
    }
    const distinct = new Set(body.units.map((u) => u.assetId));
    for (const assetId of distinct) {
      const asset = await mustReadAsset(user, assetId);
      if (
        asset.kind !== "presentation" &&
        asset.kind !== "pdf" &&
        asset.kind !== "document"
      ) {
        throw new ServiceError(
          400,
          `page cropping needs pdf/presentation/document sources, ${asset.path.split("/").pop()} is ${asset.kind}`,
        );
      }
    }
  } else {
    for (const ref of body.units) {
      if (!ref.assetId || !Number.isInteger(ref.ordinal) || ref.ordinal < 1) {
        throw new ServiceError(400, "units need assetId + 1-based ordinal");
      }
      await mustReadAsset(user, ref.assetId);
    }
  }
  const job = await saveJob({
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
  } as Job);
  return { jobId: job.id };
}

async function mustReadAsset(user: AuthUser | undefined, assetId: string) {
  const asset = await findAssetById(assetId);
  if (!asset) throw new ServiceError(404, `asset ${assetId} not found`);
  if (!user || !(await canRead(user, assetId))) {
    throw new ServiceError(403, `no permission on asset ${assetId}`);
  }
  return asset;
}

export function parseExportPayload(
  payload: string | null,
): ExportJobPayload | null {
  try {
    return JSON.parse(payload ?? "null") as ExportJobPayload | null;
  } catch {
    return null;
  }
}

export async function exportJobStatus(
  id: string,
): Promise<Record<string, unknown>> {
  const job = await findJobById(id);
  if (!job || job.kind !== "export") {
    throw new ServiceError(404, "not found");
  }
  const payload = parseExportPayload(job.payload);
  return {
    id: job.id,
    status: job.status,
    format: payload?.format,
    units: payload?.units,
    artifactPath: payload?.artifactPath ?? null,
    artifacts: payload?.artifacts ?? [],
    progress: payload?.progress ?? null,
    error: job.error,
    createdAt: job.createdAt,
  };
}

export interface ArtifactFile {
  file: string;
  name: string;
  mime: string;
  size: number;
}

export async function exportArtifact(id: string): Promise<ArtifactFile> {
  const job = await findJobById(id);
  const payload =
    job?.kind === "export" ? parseExportPayload(job.payload) : null;
  if (!payload?.artifactPath) {
    throw new ServiceError(404, "no artifact yet");
  }
  const dataDir = process.env.MENTRO_DATA ?? "./data";
  const file = path.join(dataDir, payload.artifactPath);
  if (!file.startsWith(path.join(dataDir, "exports")) || !fs.existsSync(file)) {
    throw new ServiceError(404, "artifact missing");
  }
  return {
    file,
    name: payload.artifactPath.split("/").pop() ?? "export",
    mime: payload.artifactPath.endsWith(".zip")
      ? "application/zip"
      : payload.format === "pptx"
        ? "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        : "application/pdf",
    size: fs.statSync(file).size,
  };
}
