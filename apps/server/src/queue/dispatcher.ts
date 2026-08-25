import { ulid } from "ulid";
import { AppDataSource } from "../db/data-source";
import { Asset, ContentUnit, Job } from "../db/entities";
import { ftsDeleteAsset, ftsReplaceUnits } from "../search/fts";
import type { WorkerClient } from "../worker/client";

const UNIT_TYPE_BY_NUMBER = [
  "unspecified",
  "page",
  "slide",
  "sheet",
  "frame",
  "whole",
] as const;

const MAX_IN_FLIGHT = 2;
const MAX_ATTEMPTS = 3;
const TICK_MS = 500;

export interface DispatcherEvents {
  onJobUpdate?: (job: Job) => void;
}

export class Dispatcher {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = 0;

  constructor(
    private readonly worker: WorkerClient,
    private readonly events: DispatcherEvents = {},
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    while (this.inFlight < MAX_IN_FLIGHT) {
      const jobRepo = AppDataSource.getRepository(Job);
      const job = await jobRepo.findOne({
        where: { status: "pending", kind: "extract" },
        order: { createdAt: "ASC" },
      });
      if (!job) return;
      await jobRepo.update({ id: job.id }, { status: "running", updatedAt: new Date() });
      this.inFlight++;
      void this.run(job.id)
        .catch((err) => console.error("[queue] job crashed:", err))
        .finally(() => {
          this.inFlight--;
        });
    }
  }

  private async run(jobId: string): Promise<void> {
    const jobRepo = AppDataSource.getRepository(Job);
    const assetRepo = AppDataSource.getRepository(Asset);
    const job = await jobRepo.findOneBy({ id: jobId });
    if (!job?.assetId) return;
    const asset = await assetRepo.findOneBy({ id: job.assetId });
    if (!asset) {
      await this.finish(job.id, "cancelled", null, null);
      return;
    }
    await assetRepo.update({ id: asset.id }, { extractionStatus: "running" });

    try {
      const resp = await this.worker.extract({
        assetId: asset.id,
        path: asset.path,
        contentHash: asset.contentHash ?? "",
        kind: kindNumber(asset.kind),
      });

      if (resp.ok && resp.result?.case === "extractResult") {
        const result = resp.result.value;
        // Fencing: discard stale results if the file changed meanwhile.
        const current = await assetRepo.findOneBy({ id: asset.id });
        if (!current || (current.contentHash ?? "") !== result.contentHash) {
          await this.finish(job.id, "pending", null, "stale result discarded");
          return;
        }
        await this.persistUnits(asset.id, result);
        await assetRepo.update(
          { id: asset.id },
          {
            extractionStatus: "done",
            extractionVersion: 1,
            extractedAt: new Date(),
            error: null,
          },
        );
        await this.finish(job.id, "done", null, null);
        return;
      }

      const error = resp.error;
      const attempts = job.attempts + 1;
      const retryable = error?.retryable === true && attempts < MAX_ATTEMPTS;
      await assetRepo.update(
        { id: asset.id },
        { extractionStatus: retryable ? "pending" : "failed", error: error?.message ?? null },
      );
      await jobRepo.update(
        { id: job.id },
        {
          status: retryable ? "pending" : "failed",
          attempts,
          errorCode: errorCodeName(error?.code),
          error: error?.message ?? "unknown error",
          updatedAt: new Date(),
        },
      );
    } catch (err) {
      // Worker died / timed out: retryable unless attempts exhausted.
      const attempts = job.attempts + 1;
      const retryable = attempts < MAX_ATTEMPTS;
      await assetRepo.update(
        { id: asset.id },
        { extractionStatus: retryable ? "pending" : "failed", error: String(err) },
      );
      await jobRepo.update(
        { id: job.id },
        {
          status: retryable ? "pending" : "failed",
          attempts,
          errorCode: "E_ERROR_CODE_INTERNAL",
          error: String(err),
          updatedAt: new Date(),
        },
      );
    }
  }

  private async persistUnits(
    assetId: string,
    result: { units: Array<{ ordinal: number; unitType: number; title: string; text: string; startMs: bigint | number; endMs: bigint | number; thumbPath: string }> },
  ): Promise<void> {
    const unitRepo = AppDataSource.getRepository(ContentUnit);
    await ftsDeleteAsset(assetId);
    await unitRepo.delete({ assetId });
    const units = result.units.map((u) => ({
      id: ulid(),
      assetId,
      ordinal: u.ordinal,
      unitType: UNIT_TYPE_BY_NUMBER[u.unitType] ?? "whole",
      title: u.title || null,
      text: u.text || null,
      startMs: Number(u.startMs) || null,
      endMs: Number(u.endMs) || null,
      thumbPath: u.thumbPath || null,
      metaJson: null,
    }));
    await unitRepo.insert(units);
    await ftsReplaceUnits(units);
  }

  private async finish(
    jobId: string,
    status: string,
    errorCode: string | null,
    error: string | null,
  ): Promise<void> {
    const jobRepo = AppDataSource.getRepository(Job);
    await jobRepo.update({ id: jobId }, { status, errorCode, error, updatedAt: new Date() });
    const job = await jobRepo.findOneBy({ id: jobId });
    if (job) this.events.onJobUpdate?.(job);
  }
}

function kindNumber(kind: string): number {
  const order = [
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
  ];
  const idx = order.indexOf(kind);
  return idx >= 0 ? idx : 0;
}

function errorCodeName(code: number | undefined): string | null {
  if (code === undefined) return null;
  const names: Record<number, string> = {
    0: "E_ERROR_CODE_UNSPECIFIED",
    1: "E_ERROR_CODE_TOOL_MISSING",
    2: "E_ERROR_CODE_TOOL_TIMEOUT",
    3: "E_ERROR_CODE_TOOL_NON_ZERO_EXIT",
    4: "E_ERROR_CODE_OUTPUT_TOO_LARGE",
    5: "E_ERROR_CODE_CANCELLED",
    6: "E_ERROR_CODE_UNSUPPORTED",
    7: "E_ERROR_CODE_INVALID_INPUT",
    8: "E_ERROR_CODE_INTERNAL",
  };
  return names[code] ?? `E_ERROR_CODE_${code}`;
}
