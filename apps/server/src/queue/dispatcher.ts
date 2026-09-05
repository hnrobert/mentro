import fs from "node:fs";
import path from "node:path";
import { ulid } from "ulid";
import { AppDataSource } from "../db/data-source";
import { serializedTx } from "../db/tx";
import { Asset, ContentUnit, Job, UnitEmbedding } from "../db/entities";
import { ftsDeleteAsset, ftsReplaceUnits } from "../search/fts";
import {
  storeAssetEmbeddings,
  unitEmbeddingInput,
  embedTexts,
  invalidateEmbeddingCache,
} from "../search/embeddings";
import { logRemoved, logUpserted, unitIdsOfAsset } from "../indexbundle";
import { publish } from "../bus";
import type { WorkerClient } from "../worker/client";
import { WorkerPool } from "../worker/pool";

const UNIT_TYPE_BY_NUMBER = [
  "unspecified",
  "page",
  "slide",
  "sheet",
  "frame",
  "whole",
] as const;

/** EExtractWant.CoverThumb */
const COVER_THUMB = 2;
const MAX_ATTEMPTS = 3;
const TICK_MS = 500;
/** Sidecar embed batch size (worker caps at 64). */
const EMBED_BATCH = 32;
/** Transcript units group at most this many milliseconds of speech. */
const TRANSCRIPT_WINDOW_MS = 30_000;

export interface DispatcherEvents {
  onJobUpdate?: (job: Job) => void;
}

export interface ExportJobPayload {
  units: Array<{ assetId: string; ordinal: number }>;
  format: "pdf" | "pptx" | "native" | "original";
  nameHint: string;
  artifactPath?: string;
  /** Per-source artifact names (zip entries when bundled). */
  artifacts?: string[];
  createdBy?: string | null;
}

export class Dispatcher {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly pool: WorkerPool,
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
    // Concurrency is worker-bound: each job claims an idle worker for
    // its whole duration (the serve loop inside one worker process is
    // sequential; the pool IS the parallelism).
    for (;;) {
      const worker = this.pool.tryClaim();
      if (!worker) return;
      const jobRepo = AppDataSource.getRepository(Job);
      const job = await jobRepo.findOne({
        where: { status: "pending" },
        order: { createdAt: "ASC" },
      });
      if (!job) {
        this.pool.release(worker);
        return;
      }
      await jobRepo.update(
        { id: job.id },
        { status: "running", updatedAt: new Date() },
      );
      void this.run(job.id, worker)
        .catch((err) => console.error("[queue] job crashed:", err))
        .finally(() => {
          this.pool.release(worker);
        });
    }
  }

  private async run(jobId: string, worker: WorkerClient): Promise<void> {
    const job = await AppDataSource.getRepository(Job).findOneBy({ id: jobId });
    if (!job) return;
    switch (job.kind) {
      case "extract":
        return this.runExtract(job, worker);
      case "transcribe":
        return this.runTranscribe(job, worker);
      case "embed":
        return this.runEmbed(job, worker);
      case "export":
        return this.runExport(job, worker);
      default:
        await this.finish(
          job.id,
          "failed",
          "E_ERROR_CODE_INTERNAL",
          `unknown job kind ${job.kind}`,
        );
    }
  }

  // --- extract -----------------------------------------------------------

  private async runExtract(job: Job, worker: WorkerClient): Promise<void> {
    const jobRepo = AppDataSource.getRepository(Job);
    const assetRepo = AppDataSource.getRepository(Asset);
    if (!job.assetId) return;
    const asset = await assetRepo.findOneBy({ id: job.assetId });
    if (!asset) {
      await this.finish(job.id, "cancelled", null, null);
      return;
    }
    await assetRepo.update({ id: asset.id }, { extractionStatus: "running" });

    try {
      const kind = kindNumber(asset.kind);
      const want = kind === 3 || kind === 4 ? [COVER_THUMB] : []; // presentation/document
      const resp = await worker.extract({
        assetId: asset.id,
        path: asset.path,
        contentHash: asset.contentHash ?? "",
        kind,
        want,
      });

      if (resp.ok && resp.result?.case === "extractResult") {
        const result = resp.result.value;
        // Fencing: discard stale results if the file changed meanwhile.
        const current = await assetRepo.findOneBy({ id: asset.id });
        if (!current || (current.contentHash ?? "") !== result.contentHash) {
          await this.finish(job.id, "pending", null, "stale result discarded");
          return;
        }
        await this.persistUnits(asset.id, asset.path, result);
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
        // Intelligence follow-ups (M6): transcript for av, embeddings for
        // anything with units.
        if (asset.kind === "audio" || asset.kind === "video") {
          await this.enqueueOnce("transcribe", asset.id);
        }
        if (result.units.length > 0) {
          await this.enqueueOnce("embed", asset.id);
        }
        return;
      }

      const error = resp.error;
      const attempts = job.attempts + 1;
      const retryable = error?.retryable === true && attempts < MAX_ATTEMPTS;
      await assetRepo.update(
        { id: asset.id },
        {
          extractionStatus: retryable ? "pending" : "failed",
          error: error?.message ?? null,
        },
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
        {
          extractionStatus: retryable ? "pending" : "failed",
          error: String(err),
        },
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
    assetPath: string,
    result: {
      units: Array<{
        ordinal: number;
        unitType: number;
        title: string;
        text: string;
        startMs: bigint | number;
        endMs: bigint | number;
        thumbPath: string;
      }>;
      thumbs?: string[];
    },
  ): Promise<void> {
    // Cover thumb (worker's thumbs[0]) attaches to the first unit.
    const coverThumb = result.thumbs?.[0] ?? null;
    // Units + FTS rows land in one transaction — the per-unit FTS
    // roundtrips were the dominant cost of extraction commits. Serialized:
    // one SQLite connection cannot host concurrent transactions.
    await serializedTx(async (m) => {
      const unitRepo = m.getRepository(ContentUnit);
      await ftsDeleteAsset(assetId, m);
      await logRemoved(await unitIdsOfAsset(assetId, m), m);
      await unitRepo.delete({ assetId });
      // Re-extraction replaces units: stale embeddings must go too.
      await m.getRepository(UnitEmbedding).delete({ assetId });
      const units = result.units.map((u, i) => ({
        id: ulid(),
        assetId,
        ordinal: u.ordinal,
        unitType: UNIT_TYPE_BY_NUMBER[u.unitType] ?? "whole",
        title: u.title || null,
        text: u.text || null,
        startMs: Number(u.startMs) || null,
        endMs: Number(u.endMs) || null,
        thumbPath: i === 0 ? u.thumbPath || coverThumb : u.thumbPath || null,
        metaJson: null,
      }));
      if (units.length > 0) await unitRepo.insert(units);
      const fileName = assetPath.split("/").pop() ?? "";
      await ftsReplaceUnits(units, fileName, m);
      await logUpserted(
        units.map((u) => u.id),
        m,
      );
    });
    invalidateEmbeddingCache();
    publish({ event: "index.changed" });
  }

  // --- transcribe --------------------------------------------------------

  private async runTranscribe(job: Job, worker: WorkerClient): Promise<void> {
    const assetRepo = AppDataSource.getRepository(Asset);
    if (!job.assetId) return;
    const asset = await assetRepo.findOneBy({ id: job.assetId });
    if (!asset) {
      await this.finish(job.id, "cancelled", null, null);
      return;
    }
    try {
      const resp = await worker.transcribe(
        {
          assetId: asset.id,
          path: asset.path,
          contentHash: asset.contentHash ?? "",
        },
        60 * 60 * 1000,
      );
      if (!resp.ok || resp.result?.case !== "transcribeResult") {
        const error = resp.error;
        const attempts = job.attempts + 1;
        const retryable = error?.retryable === true && attempts < MAX_ATTEMPTS;
        await this.failJob(
          job,
          retryable,
          attempts,
          error?.message ?? "transcribe failed",
        );
        return;
      }
      const result = resp.result.value;
      // Fencing: file changed while we were transcribing.
      const current = await assetRepo.findOneBy({ id: asset.id });
      if (!current || (current.contentHash ?? "") !== result.contentHash) {
        await this.finish(job.id, "pending", null, "stale result discarded");
        return;
      }
      if (result.segments.length === 0) {
        // Backend unavailable or silent media: nothing to add. Not an
        // error — the metadata unit from M4 stays searchable.
        await this.finish(job.id, "done", null, null);
        return;
      }
      await this.persistTranscript(asset.id, result.segments);
      await this.finish(job.id, "done", null, null);
      await this.enqueueOnce("embed", asset.id);
    } catch (err) {
      const attempts = job.attempts + 1;
      await this.failJob(job, attempts < MAX_ATTEMPTS, attempts, String(err));
    }
  }

  private async persistTranscript(
    assetId: string,
    segments: Array<{
      startMs: bigint | number;
      endMs: bigint | number;
      text: string;
    }>,
  ): Promise<void> {
    // Group segments into ~30s windows; each window becomes a
    // time-positioned "frame" unit (click-through in the video player).
    const windows: Array<{ start: number; end: number; text: string }> = [];
    for (const seg of segments) {
      const start = Number(seg.startMs);
      const end = Number(seg.endMs);
      const current = windows[windows.length - 1];
      if (current && start - current.start < TRANSCRIPT_WINDOW_MS) {
        current.end = Math.max(current.end, end);
        current.text += ` ${seg.text.trim()}`;
      } else {
        windows.push({ start, end, text: seg.text.trim() });
      }
    }

    await serializedTx(async (m) => {
      const unitRepo = m.getRepository(ContentUnit);
      // Replace prior transcript units only (metaJson marker); the
      // M4 metadata unit (ordinal 1) survives.
      await unitRepo
        .createQueryBuilder()
        .delete()
        .where("asset_id = :assetId AND meta_json = 'transcript'", { assetId })
        .execute();
      const base = await unitRepo.countBy({ assetId });
      const units = windows.map((w, i) => ({
        id: ulid(),
        assetId,
        ordinal: base + 1 + i,
        unitType: "frame",
        title: fmtTimecode(w.start),
        text: w.text,
        startMs: w.start,
        endMs: w.end,
        thumbPath: null,
        metaJson: "transcript",
      }));
      if (units.length > 0) await unitRepo.insert(units);
      const asset = await m.getRepository(Asset).findOneBy({ id: assetId });
      await ftsReplaceUnits(units, asset?.path.split("/").pop() ?? "", m);
      await logUpserted(
        units.map((u) => u.id),
        m,
      );
    });
    invalidateEmbeddingCache();
    publish({ event: "index.changed" });
  }

  // --- embed -------------------------------------------------------------

  private async runEmbed(job: Job, worker: WorkerClient): Promise<void> {
    if (!job.assetId) return;
    const assetRepo = AppDataSource.getRepository(Asset);
    const asset = await assetRepo.findOneBy({ id: job.assetId });
    if (!asset) {
      await this.finish(job.id, "cancelled", null, null);
      return;
    }
    try {
      // Units of this asset that lack a stored vector.
      const rows = (await AppDataSource.query(
        `SELECT cu.id, cu.title, cu.text FROM content_units cu
         LEFT JOIN unit_embeddings ue ON ue.unit_id = cu.id
         WHERE cu.asset_id = ? AND ue.unit_id IS NULL
           AND COALESCE(cu.text, '') != ''`,
        [asset.id],
      )) as Array<{ id: string; title: string | null; text: string | null }>;
      if (rows.length === 0) {
        await this.finish(job.id, "done", null, null);
        return;
      }
      const entries: Array<{
        unitId: string;
        assetId: string;
        vector: Float32Array;
      }> = [];
      for (let i = 0; i < rows.length; i += EMBED_BATCH) {
        const batch = rows.slice(i, i + EMBED_BATCH);
        const vectors = await embedTexts(
          worker,
          batch.map((r) => unitEmbeddingInput(r.title, r.text)),
        );
        if (vectors.length === 0) {
          // Sidecar unavailable: semantic search degrades to FTS-only.
          await this.finish(
            job.id,
            "done",
            null,
            "embedding backend unavailable",
          );
          return;
        }
        batch.forEach((r, j) => {
          const vector = vectors[j];
          if (vector) entries.push({ unitId: r.id, assetId: asset.id, vector });
        });
      }
      await storeAssetEmbeddings(entries);
      await this.finish(job.id, "done", null, null);
    } catch (err) {
      const attempts = job.attempts + 1;
      await this.failJob(job, attempts < MAX_ATTEMPTS, attempts, String(err));
    }
  }

  // --- export ------------------------------------------------------------

  private async runExport(job: Job, worker: WorkerClient): Promise<void> {
    const payload = parseExportPayload(job.payload);
    if (!payload) {
      await this.finish(
        job.id,
        "failed",
        "E_ERROR_CODE_INVALID_INPUT",
        "invalid export payload",
      );
      return;
    }
    try {
      const assetRepo = AppDataSource.getRepository(Asset);
      const byId = new Map<string, Asset>();
      const resolve = async (assetId: string): Promise<Asset | null> => {
        if (!byId.has(assetId)) {
          const found: Asset | null = await assetRepo.findOneBy({
            id: assetId,
          });
          byId.set(assetId, found as Asset);
        }
        return byId.get(assetId) ?? null;
      };

      const artifacts: Array<{ path: string; name: string }> = [];

      if (payload.format === "original") {
        // Unmodified original files, one entry per distinct asset.
        const seen = new Set<string>();
        for (const ref of payload.units) {
          if (seen.has(ref.assetId)) continue;
          seen.add(ref.assetId);
          const asset = await resolve(ref.assetId);
          if (!asset || !fs.existsSync(asset.path)) {
            await this.failExport(job, `original missing: ${ref.assetId}`);
            return;
          }
          artifacts.push({
            path: asset.path,
            name: asset.path.split("/").pop() ?? `${asset.id}`,
          });
        }
      } else if (payload.format === "pdf") {
        // One merged pdf across files (agent flow).
        const units: Array<{ assetId: string; ordinal: number; path: string }> =
          [];
        for (const ref of payload.units) {
          const asset = await resolve(ref.assetId);
          if (!asset) {
            await this.failExport(job, `asset ${ref.assetId} not found`);
            return;
          }
          units.push({
            assetId: asset.id,
            ordinal: ref.ordinal,
            path: asset.path,
          });
        }
        const got = await this.workerExport(
          worker,
          job.id,
          units,
          1,
          payload.nameHint || job.id,
        );
        if (!got) return; // failure recorded
        artifacts.push(got);
      } else {
        // "pptx" / "native": crop PER SOURCE FILE (keeps each deck's
        // theme and masters — only unselected pages are dropped), then
        // zip when the selection spans several files.
        const groups = new Map<string, number[]>(); // assetId -> ordinals
        for (const ref of payload.units) {
          const list = groups.get(ref.assetId) ?? [];
          list.push(ref.ordinal);
          groups.set(ref.assetId, list);
        }
        for (const [assetId, ordinals] of groups) {
          const asset = await resolve(assetId);
          if (!asset) {
            await this.failExport(job, `asset ${assetId} not found`);
            return;
          }
          const fmt =
            payload.format === "pptx" || asset.kind === "presentation"
              ? "pptx"
              : "pdf";
          const units = ordinals.map((ordinal) => ({
            assetId: asset.id,
            ordinal,
            path: asset.path,
          }));
          const base = (asset.path.split("/").pop() ?? asset.id).replace(
            /\.(pptx|pdf|docx|ppt|doc)$/i,
            "",
          );
          const got = await this.workerExport(
            worker,
            job.id,
            units,
            fmt === "pptx" ? 2 : 1,
            `${base}-${fmt}`,
          );
          if (!got) return; // failure recorded
          artifacts.push(got);
        }
      }

      // Single artifact downloads directly; several land in one zip
      // (worker-side STORED pack — streaming, no deflate burn).
      let artifactPath = artifacts[0].path;
      if (artifacts.length > 1) {
        const packed = await worker.packFiles(
          artifacts,
          job.id,
          10 * 60 * 1000,
        );
        if (packed.ok && packed.result?.case === "packResult") {
          artifactPath = packed.result.value.path;
        } else {
          await this.failExportById(
            job.id,
            packed.error?.message ?? "pack failed",
          );
          return;
        }
      }
      await AppDataSource.getRepository(Job).update(
        { id: job.id },
        {
          status: "done",
          payload: JSON.stringify({
            ...payload,
            artifactPath,
            artifacts: artifacts.map((a) => a.name),
          }),
          error: null,
          updatedAt: new Date(),
        },
      );
      await this.emitJob(job.id);
    } catch (err) {
      const attempts = job.attempts + 1;
      await this.failJob(job, attempts < MAX_ATTEMPTS, attempts, String(err));
    }
  }

  /** One worker export call; records failure on the job and returns null. */
  private async workerExport(
    worker: WorkerClient,
    jobId: string,
    units: Array<{ assetId: string; ordinal: number; path: string }>,
    format: number,
    nameHint: string,
  ): Promise<{ path: string; name: string } | null> {
    const resp = await worker.exportUnits(
      { units, format, nameHint },
      10 * 60 * 1000,
    );
    if (resp.ok && resp.result?.case === "exportResult") {
      const rel = resp.result.value.path; // exports/<name>.<ext>
      const dataDir = process.env.MENTRO_DATA ?? "./data";
      return {
        path: path.join(dataDir, rel),
        name: rel.split("/").pop() ?? nameHint,
      };
    }
    await this.failExportById(jobId, resp.error?.message ?? "export failed");
    return null;
  }

  private async failExportById(jobId: string, message: string): Promise<void> {
    await AppDataSource.getRepository(Job).update(
      { id: jobId },
      { status: "failed", error: message, updatedAt: new Date() },
    );
    const job = await AppDataSource.getRepository(Job).findOneBy({ id: jobId });
    if (job) this.events.onJobUpdate?.(job);
  }

  private async failExport(job: Job, message: string): Promise<void> {
    await AppDataSource.getRepository(Job).update(
      { id: job.id },
      { status: "failed", error: message, updatedAt: new Date() },
    );
    await this.emitJob(job.id);
  }

  // --- helpers -----------------------------------------------------------

  /** Insert a job of `kind` for `assetId` unless a live one exists. */
  private async enqueueOnce(kind: string, assetId: string): Promise<void> {
    const jobRepo = AppDataSource.getRepository(Job);
    const existing = await jobRepo.findOne({
      where: { kind, assetId, status: "pending" },
    });
    if (existing) return;
    await jobRepo.insert({
      id: ulid(),
      assetId,
      kind,
      status: "pending",
    });
  }

  private async failJob(
    job: Job,
    retryable: boolean,
    attempts: number,
    message: string,
  ): Promise<void> {
    await AppDataSource.getRepository(Job).update(
      { id: job.id },
      {
        status: retryable ? "pending" : "failed",
        attempts,
        error: message,
        updatedAt: new Date(),
      },
    );
    await this.emitJob(job.id);
  }

  private async finish(
    jobId: string,
    status: string,
    errorCode: string | null,
    error: string | null,
  ): Promise<void> {
    const jobRepo = AppDataSource.getRepository(Job);
    await jobRepo.update(
      { id: jobId },
      { status, errorCode, error, updatedAt: new Date() },
    );
    await this.emitJob(jobId);
  }

  private async emitJob(jobId: string): Promise<void> {
    const job = await AppDataSource.getRepository(Job).findOneBy({ id: jobId });
    if (job) this.events.onJobUpdate?.(job);
  }
}

export function parseExportPayload(
  raw: string | null,
): ExportJobPayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ExportJobPayload;
    if (!Array.isArray(parsed.units) || parsed.units.length === 0) return null;
    if (
      parsed.format !== "pdf" &&
      parsed.format !== "pptx" &&
      parsed.format !== "native" &&
      parsed.format !== "original"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function fmtTimecode(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
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
