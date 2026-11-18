/** Sources domain: mounted-directory CRUD + scan orchestration. */

import fs from "node:fs";
import path from "node:path";
import { ulid } from "ulid";
import { Source } from "../db/entities";
import {
  countAssetsBySource,
  countDoneAssetsBySource,
  findAssetsBySource,
} from "../repositories/asset.repository";
import {
  deleteSource,
  findSourceById,
  findSourceByRootPath,
  saveSource,
  findSources,
} from "../repositories/misc.repository";
import { deleteAssetCascade, runSourceScan } from "../pipeline/scan";
import { publish } from "../lib/bus";
import type { WorkerClient } from "../worker/client";
import { ServiceError } from "../lib/errors";

export async function listSources(): Promise<
  Array<Source & { assetCount: number; doneCount: number }>
> {
  const sources = await findSources();
  return Promise.all(
    sources.map(async (s) => ({
      ...s,
      assetCount: await countAssetsBySource(s.id),
      doneCount: await countDoneAssetsBySource(s.id),
    })),
  );
}

export async function mountSource(
  rootPath: string,
  worker: WorkerClient,
): Promise<Source> {
  if (!rootPath || typeof rootPath !== "string") {
    throw new ServiceError(400, "rootPath required");
  }
  const abs = path.resolve(rootPath.trim());
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new ServiceError(400, `not a directory: ${abs}`);
  }
  if (await findSourceByRootPath(abs)) {
    throw new ServiceError(409, "source already exists");
  }
  const source = await saveSource({ id: ulid(), rootPath: abs } as Source);
  // First scan runs in the background; WS snapshots report progress.
  void runSourceScan(source, worker)
    .then((outcome) => {
      console.log(`[scan] ${abs}: ${JSON.stringify(outcome)}`);
      publish({ event: "scan.finished", sourceId: source.id, ...outcome });
    })
    .catch((err) => console.error(`[scan] ${abs} failed:`, err));
  return source;
}

export async function removeSource(id: string): Promise<number> {
  const source = await findSourceById(id);
  if (!source) throw new ServiceError(404, "not found");
  const assets = await findAssetsBySource(source.id);
  for (const asset of assets) await deleteAssetCascade(asset.id);
  await deleteSource(source.id);
  return assets.length;
}

export async function rescanSource(
  id: string,
  worker: WorkerClient,
): Promise<void> {
  const source = await findSourceById(id);
  if (!source) throw new ServiceError(404, "not found");
  void runSourceScan(source, worker)
    .then((outcome) =>
      publish({ event: "scan.finished", sourceId: source.id, ...outcome }),
    )
    .catch((err) => console.error(`[scan] ${source.rootPath} failed:`, err));
}
