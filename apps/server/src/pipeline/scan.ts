import { ulid } from "ulid";
import { AppDataSource } from "../db/data-source";
import { Asset, ContentUnit, Job, Source } from "../db/entities";
import { ftsDeleteAsset } from "../search/fts";
import type { WorkerClient } from "../worker/client";

/** Numeric EAssetKind -> our kind string (keep in sync with the proto). */
const KIND_BY_NUMBER = [
  "unspecified",
  "text",
  "pdf",
  "presentation",
  "document",
  "spreadsheet",
  "image",
  "video",
  "audio",
  "archive",
  "other",
] as const;

/** Kinds with extractors in the current milestone. */
const EXTRACTABLE = new Set(["text", "pdf"]);

export async function deleteAssetCascade(assetId: string): Promise<void> {
  await ftsDeleteAsset(assetId);
  await AppDataSource.getRepository(ContentUnit).delete({ assetId });
  await AppDataSource.getRepository(Job).delete({ assetId });
  await AppDataSource.getRepository(Asset).delete({ id: assetId });
}

export interface ScanOutcome {
  discovered: number;
  updated: number;
  removed: number;
  enqueued: number;
}

export async function runSourceScan(
  source: Source,
  worker: WorkerClient,
): Promise<ScanOutcome> {
  const resp = await worker.scan(source.rootPath);
  if (!resp.ok || resp.result?.case !== "scanResult") {
    throw new Error(
      `scan failed: ${resp.error?.message ?? "unexpected response"}`,
    );
  }
  const records = resp.result.value.records;

  const assetRepo = AppDataSource.getRepository(Asset);
  const jobRepo = AppDataSource.getRepository(Job);
  const existing = await assetRepo.findBy({ sourceId: source.id });
  const byPath = new Map(existing.map((a) => [a.path, a]));

  const seen = new Set<string>();
  let updated = 0;
  let enqueued = 0;

  for (const record of records) {
    seen.add(record.path);
    const kind = KIND_BY_NUMBER[record.kind] ?? "other";
    const prior = byPath.get(record.path);

    if (!prior) {
      const asset = await assetRepo.save({
        id: ulid(),
        sourceId: source.id,
        path: record.path,
        sizeBytes: Number(record.sizeBytes),
        mtimeMs: Number(record.mtimeMs),
        contentHash: record.contentHash || null,
        mime: record.mime || null,
        kind,
        oversized: record.oversized,
        extractionStatus: "pending",
      });
      if (EXTRACTABLE.has(kind) && !record.oversized) {
        await jobRepo.save({ id: ulid(), assetId: asset.id, kind: "extract", status: "pending" });
        enqueued++;
      } else {
        await assetRepo.update({ id: asset.id }, { extractionStatus: "skipped" });
      }
      updated++;
      continue;
    }

    const hashChanged =
      (record.contentHash || "") !== (prior.contentHash ?? "") &&
      !record.oversized;
    const statChanged =
      Number(record.sizeBytes) !== prior.sizeBytes ||
      Number(record.mtimeMs) !== prior.mtimeMs;
    if (!hashChanged && !statChanged && prior.kind === kind) continue;

    // Content changed: drop stale units + FTS rows, reset status.
    if (hashChanged) {
      await ftsDeleteAsset(prior.id);
      await AppDataSource.getRepository(ContentUnit).delete({ assetId: prior.id });
    }
    const nextStatus = !EXTRACTABLE.has(kind) || record.oversized
      ? "skipped"
      : hashChanged
        ? "pending"
        : prior.extractionStatus === "done" || prior.extractionStatus === "failed"
          ? prior.extractionStatus
          : "pending";
    await assetRepo.update(
      { id: prior.id },
      {
        sizeBytes: Number(record.sizeBytes),
        mtimeMs: Number(record.mtimeMs),
        contentHash: record.contentHash || null,
        mime: record.mime || null,
        kind,
        oversized: record.oversized,
        extractionStatus: nextStatus,
      },
    );
    if (
      EXTRACTABLE.has(kind) &&
      !record.oversized &&
      hashChanged &&
      !(await jobRepo.findOneBy({ assetId: prior.id, status: "pending" }))
    ) {
      await jobRepo.save({ id: ulid(), assetId: prior.id, kind: "extract", status: "pending" });
      enqueued++;
    }
    updated++;
  }

  // Remove assets whose path vanished from disk.
  let removed = 0;
  for (const prior of existing) {
    if (!seen.has(prior.path)) {
      await deleteAssetCascade(prior.id);
      removed++;
    }
  }

  await AppDataSource.getRepository(Source).update(
    { id: source.id },
    { lastScanAt: new Date() },
  );

  return { discovered: records.length, updated, removed, enqueued };
}
