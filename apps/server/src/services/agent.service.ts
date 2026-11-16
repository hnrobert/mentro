/** Agent Tool API surface: the read/search/export/transcribe
 *  operations an autonomous agent operates through — shared by the
 *  HTTP routes (/api/agent/*) and the MCP endpoint. Never the file
 *  system; every read enforces ACL. */

import { ulid } from "ulid";
import { ContentUnit, Job } from "../db/entities";
import { findAssetById } from "../repositories/asset.repository";
import {
  findUnitById,
  findUnitWithNeighbours,
  findUnitsOfAsset,
} from "../repositories/content-unit.repository";
import {
  findJobByKindAndAsset,
  insertJob,
} from "../repositories/job.repository";
import { canRead } from "./acl.service";
import { ServiceError } from "./errors";

export async function agentAssetOverview(
  user: Parameters<typeof canRead>[0],
  assetId: string,
) {
  const asset = await findAssetById(assetId);
  if (!asset) throw new ServiceError(404, "not found");
  if (!(await canRead(user, asset.id))) {
    throw new ServiceError(403, "forbidden");
  }
  const units = await findUnitsOfAsset(asset.id);
  return {
    asset,
    units: units.map((u) => ({
      unitId: u.id,
      ordinal: u.ordinal,
      unitType: u.unitType,
      title: u.title,
      startMs: u.startMs,
      endMs: u.endMs,
      textPreview: (u.text ?? "").slice(0, 300),
    })),
  };
}

export async function agentUnit(
  user: Parameters<typeof canRead>[0],
  unitId: string,
) {
  const unit = await findUnitById(unitId);
  if (!unit) throw new ServiceError(404, "unit not found");
  if (!(await canRead(user, unit.assetId))) {
    throw new ServiceError(403, "forbidden");
  }
  const asset = await findAssetById(unit.assetId);
  return { unit, asset };
}

export async function agentContext(
  user: Parameters<typeof canRead>[0],
  unitId: string,
  before: number,
  after: number,
): Promise<ContentUnit[]> {
  const unit = await findUnitById(unitId);
  if (!unit) throw new ServiceError(404, "unit not found");
  if (!(await canRead(user, unit.assetId))) {
    throw new ServiceError(403, "forbidden");
  }
  return findUnitWithNeighbours(
    unit,
    Math.min(10, Math.max(0, before)),
    Math.min(10, Math.max(0, after)),
  );
}

/** Idempotent transcribe enqueue (dedupes pending jobs). */
export async function agentTranscribe(
  user: Parameters<typeof canRead>[0],
  assetId: string,
): Promise<{ jobId: string }> {
  const asset = await findAssetById(assetId);
  if (!asset) throw new ServiceError(404, "asset not found");
  if (!(await canRead(user, asset.id))) {
    throw new ServiceError(403, "forbidden");
  }
  if (asset.kind !== "audio" && asset.kind !== "video") {
    throw new ServiceError(400, `kind ${asset.kind} has no audio track`);
  }
  const existing = await findJobByKindAndAsset(
    "transcribe",
    asset.id,
    "pending",
  );
  const jobId = existing?.id ?? ulid();
  if (!existing) {
    await insertJob({
      id: jobId,
      assetId: asset.id,
      kind: "transcribe",
      status: "pending",
    } as Job);
  }
  return { jobId };
}
