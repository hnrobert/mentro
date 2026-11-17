/** Upload domain: multipart intake into the pool, duplicate-name
 *  policy, archive unpacking via the worker, and the group/uploader
 *  metadata handoff consumed by the follow-up pool scan. */

import fs from "node:fs";
import path from "node:path";
import { ulid } from "ulid";
import { create } from "@bufbuild/protobuf";
import { UnpackRequestSchema } from "@mentro/protocol";
import type { Source } from "../db/entities";
import { findAssetByFileNameInGroup } from "../repositories/asset.repository";
import { runSourceScan } from "../pipeline/scan";
import { publish } from "../bus";
import type { WorkerClient } from "../worker/client";
import type { Config } from "../config";
import { ServiceError } from "./errors";

/** Extensions the worker can unpack (keep in sync with worker unpack.rs). */
const ARCHIVE_EXTS = new Set([
  "zip",
  "tar",
  "gz",
  "bz2",
  "xz",
  "tgz",
  "tbz2",
  "txz",
  "7z",
  "rar",
]);

function safeName(name: string): string {
  const base = path.basename(name).replaceAll(/[/\\]/g, "_");
  return base.replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(-120) || "file";
}

function monthDir(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export interface UploadOutcome {
  name: string;
  storedPath: string;
  unpackedFiles: number;
  unpackedBytes: number;
  unpackError?: string;
}

// --- upload metadata handoff (path -> group/uploader), consumed by the
// pool scan right after the same request writes the files. ---

interface PendingMeta {
  pathPrefix: string;
  groupId: string | null;
  uploader: string | null;
}

let pendingMetas: PendingMeta[] = [];

function setPendingGroup(
  storedPath: string,
  groupId: string | null,
  uploader: string | null,
): void {
  pendingMetas.push({ pathPrefix: storedPath, groupId, uploader });
}

function takePendingMeta(): PendingMeta[] {
  const taken = pendingMetas;
  pendingMetas = [];
  return taken;
}

export interface IncomingFile {
  filename: string;
  file: NodeJS.ReadableStream;
  /** Multipart fields accumulated before this part (meta may ride on
   *  any part when clients append files first). */
  fields?: Record<string, unknown>;
}

/** Store the files, unpack archives, kick the pool rescan. Throws
 *  ServiceError(409, "duplicate") — with the existing id attached —
 *  when a same-name file exists in the target group and the client did
 *  not confirm overwrite. */
export async function ingestUpload(
  deps: {
    config: Config;
    worker: WorkerClient;
    poolSource: () => Promise<Source>;
  },
  files: AsyncIterable<IncomingFile>,
  opts: {
    groupId: string | null;
    uploader: string | null;
    overwrite: boolean;
    /** Browser-side lastModified per uploaded file, paired by order —
     *  restored onto the stored file so the scan records the ORIGINAL
     *  time instead of upload time. */
    mtimes?: Array<{ name: string; lastModified: number }>;
  },
): Promise<UploadOutcome[]> {
  const outcomes: UploadOutcome[] = [];
  let fileIndex = 0;
  let metaList = opts.mtimes ?? [];
  const uploadRoot = path.join(
    deps.config.dataDir,
    "pool",
    "_uploads",
    monthDir(),
  );
  fs.mkdirSync(uploadRoot, { recursive: true });

  for await (const part of files) {
    // Late meta (files-first clients): first part carrying it wins.
    const late = part.fields?.meta;
    const lateStr =
      typeof late === "string"
        ? late
        : late && typeof late === "object" && "value" in (late as object)
          ? String((late as { value: unknown }).value)
          : undefined;
    if (metaList.length === 0 && lateStr) {
      try {
        metaList = JSON.parse(lateStr);
      } catch {
        metaList = [];
      }
    }
    const name = safeName(part.filename);

    // Duplicate-name check within the target group: refuse unless the
    // client explicitly confirmed overwrite (frontend asks the user).
    if (!opts.overwrite) {
      const existing = await findAssetByFileNameInGroup(name, opts.groupId);
      if (existing) {
        const err = new ServiceError(409, "duplicate") as ServiceError & {
          fileName?: string;
          existingId?: string;
        };
        err.fileName = name;
        err.existingId = existing.id;
        throw err;
      }
    }

    const stored = path.join(uploadRoot, `${ulid()}__${name}`);
    outcomes.push(await storePart(part.file, stored, name, deps));
    // Restore the original modification time (best-effort; ctime is not
    // exposed by browsers over multipart).
    const meta = metaList[fileIndex];
    if (meta && Number.isFinite(meta.lastModified) && meta.lastModified > 0) {
      try {
        const when = new Date(meta.lastModified);
        fs.utimesSync(stored, when, when);
      } catch {
        /* metadata is best-effort */
      }
    }
    fileIndex++;
    // Stamp group/uploader on the ingested asset once the pool scan
    // registers it (setPendingGroup is consumed by the scanner).
    setPendingGroup(stored, opts.groupId, opts.uploader);
  }

  // Rescan the pool source so unpacked/stored files get indexed.
  const pool = await deps.poolSource();
  void runSourceScan(pool, deps.worker, { pendingMeta: takePendingMeta() })
    .then((o) => publish({ event: "scan.finished", sourceId: pool.id, ...o }))
    .catch((err) => console.error("[upload] pool rescan failed:", err));

  return outcomes;
}

async function storePart(
  stream: NodeJS.ReadableStream,
  stored: string,
  name: string,
  deps: { config: Config; worker: WorkerClient },
): Promise<UploadOutcome> {
  const out = fs.createWriteStream(stored);
  stream.pipe(out);
  await new Promise<void>((resolve, reject) => {
    out.on("finish", () => resolve());
    out.on("error", reject);
    stream.on("error", reject);
  });

  const outcome: UploadOutcome = {
    name,
    storedPath: stored,
    unpackedFiles: 0,
    unpackedBytes: 0,
  };

  const ext = path.extname(name).slice(1).toLowerCase();
  if (!ARCHIVE_EXTS.has(ext)) return outcome;

  // Unpack next to the upload: pool/<ulid>-<stem>/
  const stem = name.slice(0, name.length - ext.length - 1) || "archive";
  const destDir = path.join(
    deps.config.dataDir,
    "pool",
    `${ulid()}-${safeName(stem)}`,
  );
  const resp = await deps.worker.request({
    case: "unpack",
    value: create(UnpackRequestSchema, { path: stored, destDir }),
  });
  if (resp.ok && resp.result?.case === "unpackResult") {
    outcome.unpackedFiles = resp.result.value.filePaths.length;
    outcome.unpackedBytes = Number(resp.result.value.totalBytes);
  } else {
    outcome.unpackError = resp.error?.message ?? "unpack failed";
  }
  return outcome;
}
