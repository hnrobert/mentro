import { ulid } from "ulid";
import type { EntityManager, QueryDeepPartialEntity } from "typeorm";
import { AppDataSource } from "../db/data-source";
import { serializedTx } from "../db/tx";
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

export async function deleteAssetCascade(
  assetId: string,
  m?: EntityManager,
): Promise<void> {
  const em = m ?? AppDataSource.manager;
  await ftsDeleteAsset(assetId, em);
  await em.getRepository(ContentUnit).delete({ assetId });
  await em.getRepository(Job).delete({ assetId });
  await em.getRepository(Asset).delete({ id: assetId });
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
  // Long walk+hash outside any transaction.
  const resp = await worker.scan(source.rootPath);
  if (!resp.ok || resp.result?.case !== "scanResult") {
    throw new Error(
      `scan failed: ${resp.error?.message ?? "unexpected response"}`,
    );
  }
  const records = resp.result.value.records;

  // Diff + writes in ONE transaction: N records used to cost N implicit
  // transactions (a WAL fsync each) — the dominant indexing cost.
  // Serialized: single SQLite connection, no concurrent transactions.
  return serializedTx(async (m) => {
    const assetRepo = m.getRepository(Asset);
    const jobRepo = m.getRepository(Job);
    // Path ownership is global (uq_assets_path): the first source that saw
    // a path owns it; nested/overlapping sources only refresh its stats.
    const existing = await assetRepo.find();
    const byPath = new Map(existing.map((a) => [a.path, a]));

    const seen = new Set<string>();
    const newAssets: QueryDeepPartialEntity<Asset>[] = [];
    const newJobs: QueryDeepPartialEntity<Job>[] = [];
    let updated = 0;
    let enqueued = 0;

    for (const record of records) {
      seen.add(record.path);
      const kind = KIND_BY_NUMBER[record.kind] ?? "other";
      const extractable = EXTRACTABLE.has(kind) && !record.oversized;
      const prior = byPath.get(record.path);

      if (!prior) {
        const assetId = ulid();
        newAssets.push({
          id: assetId,
          sourceId: source.id,
          path: record.path,
          sizeBytes: Number(record.sizeBytes),
          mtimeMs: Number(record.mtimeMs),
          contentHash: record.contentHash || null,
          mime: record.mime || null,
          kind,
          oversized: record.oversized,
          extractionStatus: extractable ? "pending" : "skipped",
        });
        if (extractable) {
          newJobs.push({
            id: ulid(),
            assetId,
            kind: "extract",
            status: "pending",
          });
          enqueued++;
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
        await ftsDeleteAsset(prior.id, m);
        await m.getRepository(ContentUnit).delete({ assetId: prior.id });
      }
      const nextStatus = !extractable
        ? "skipped"
        : hashChanged
          ? "pending"
          : prior.extractionStatus === "done" ||
              prior.extractionStatus === "failed"
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
      if (extractable && hashChanged) {
        newJobs.push({
          id: ulid(),
          assetId: prior.id,
          kind: "extract",
          status: "pending",
        });
        enqueued++;
      }
      updated++;
    }

    if (newAssets.length > 0) await assetRepo.insert(newAssets);
    if (newJobs.length > 0) await jobRepo.insert(newJobs);

    // Remove assets owned by THIS source whose path vanished from disk.
    let removed = 0;
    for (const prior of existing) {
      if (prior.sourceId === source.id && !seen.has(prior.path)) {
        await deleteAssetCascade(prior.id, m);
        removed++;
      }
    }

    await m
      .getRepository(Source)
      .update({ id: source.id }, { lastScanAt: new Date() });

    return {
      discovered: records.length,
      updated,
      removed,
      enqueued,
    };
  });
}
