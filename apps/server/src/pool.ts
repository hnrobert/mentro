import fs from "node:fs";
import path from "node:path";
import { ulid } from "ulid";
import { AppDataSource } from "./db/data-source";
import { Source } from "./db/entities";
import { runSourceScan } from "./pipeline/scan";
import type { WorkerClient } from "./worker/client";

const sourceRepo = () => AppDataSource.getRepository(Source);

async function ensureSource(rootPath: string): Promise<Source> {
  const existing = await sourceRepo().findOneBy({ rootPath });
  if (existing) return existing;
  return sourceRepo().save({ id: ulid(), rootPath });
}

/** The asset pool lives under <dataDir>/pool and is a self-owned source. */
export async function ensurePoolSource(dataDir: string): Promise<Source> {
  const poolDir = path.join(dataDir, "pool", "_uploads");
  fs.mkdirSync(poolDir, { recursive: true });
  return ensureSource(path.join(dataDir, "pool"));
}

/** MENTRO_SOURCES (comma-separated) mounts, idempotent, scanned in the
 * background at boot. */
export async function mountEnvSources(worker: WorkerClient): Promise<void> {
  const raw = process.env.MENTRO_SOURCES ?? "";
  for (const entry of raw.split(/[,，]/)) {
    const dir = entry.trim();
    if (!dir) continue;
    const abs = path.resolve(dir);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      console.warn(`[pool] MENTRO_SOURCES entry is not a directory: ${abs}`);
      continue;
    }
    const source = await ensureSource(abs);
    void runSourceScan(source, worker)
      .then((o) => console.log(`[pool] mounted ${abs}: ${JSON.stringify(o)}`))
      .catch((err) => console.error(`[pool] mount scan ${abs} failed:`, err));
  }
}
