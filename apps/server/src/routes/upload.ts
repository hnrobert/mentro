import fs from "node:fs";
import path from "node:path";
import { ulid } from "ulid";
import type { FastifyInstance } from "fastify";
import { create } from "@bufbuild/protobuf";
import { UnpackRequestSchema } from "@mentro/protocol";
import { Source } from "../db/entities";
import { runSourceScan } from "../pipeline/scan";
import { publish } from "../bus";
import type { WorkerClient } from "../worker/client";
import type { Config } from "../config";

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

export function registerUploadRoutes(
  app: FastifyInstance,
  deps: {
    config: Config;
    worker: WorkerClient;
    poolSource: () => Promise<Source>;
  },
) {
  app.post("/api/upload", async (request, reply) => {
    const parts = request.files({
      limits: { fileSize: deps.config.maxUploadBytes },
    });
    const outcomes: UploadOutcome[] = [];
    const uploadRoot = path.join(
      deps.config.dataDir,
      "pool",
      "_uploads",
      monthDir(),
    );
    fs.mkdirSync(uploadRoot, { recursive: true });

    for await (const part of parts) {
      const name = safeName(part.filename);
      const stored = path.join(uploadRoot, `${ulid()}__${name}`);
      outcomes.push(await storePart(part.file, stored, name, deps));
    }

    // Rescan the pool source so unpacked/stored files get indexed.
    const pool = await deps.poolSource();
    void runSourceScan(pool, deps.worker)
      .then((o) => publish({ event: "scan.finished", sourceId: pool.id, ...o }))
      .catch((err) => console.error("[upload] pool rescan failed:", err));

    return reply.code(201).send({ uploaded: outcomes });
  });
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
