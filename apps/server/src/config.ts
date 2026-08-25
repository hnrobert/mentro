import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root, derived from this module's location (src/ or dist/ both sit
 * two levels below apps/server). */
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
  "..",
);

export interface Config {
  dataDir: string;
  port: number;
  bind: string;
  workerBin: string;
  /** Access token TTL in seconds (default 1h). */
  accessTtlSec: number;
  /** Refresh token TTL in seconds (default 30d). */
  refreshTtlSec: number;
}

export function loadConfig(): Config {
  const dataDir = path.resolve(process.env.MENTRO_DATA ?? "./data");
  const config: Config = {
    dataDir,
    port: Number(process.env.MENTRO_PORT ?? 37797),
    bind: process.env.MENTRO_BIND ?? "127.0.0.1",
    workerBin: path.resolve(
      process.env.MENTRO_WORKER_BIN ?? path.join(REPO_ROOT, "bin/mentro-worker"),
    ),
    accessTtlSec: 60 * 60,
    refreshTtlSec: 30 * 24 * 60 * 60,
  };

  for (const dir of [
    dataDir,
    path.join(dataDir, "thumbs"),
    path.join(dataDir, "render"),
    path.join(dataDir, "office-fonts"),
    path.join(dataDir, "containers"),
    path.join(dataDir, "logs"),
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return config;
}

/** Single-instance advisory lock on the data dir; refuses to start when
 * another live owner holds it. Returns a release function. */
export function lockDataDir(dataDir: string): () => void {
  const lockPath = path.join(dataDir, ".lock");
  try {
    fs.writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      const holder = fs.readFileSync(lockPath, "utf8").trim();
      let alive = false;
      try {
        process.kill(Number(holder), 0);
        alive = true;
      } catch {
        alive = false;
      }
      if (alive) {
        console.error(
          `[mentro] data dir already in use by pid ${holder} — refusing to start`,
        );
        process.exit(73);
      }
      fs.writeFileSync(lockPath, `${process.pid}\n`);
    } else {
      throw err;
    }
  }
  return () => {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* best effort */
    }
  };
}

/** JWT secret, generated on first boot under the data dir. */
export function loadJwtSecret(dataDir: string): Uint8Array {
  const keyPath = path.join(dataDir, "jwt.key");
  if (!fs.existsSync(keyPath)) {
    const secret = crypto.randomBytes(32).toString("base64");
    fs.writeFileSync(keyPath, secret, { mode: 0o600 });
  }
  return new TextEncoder().encode(fs.readFileSync(keyPath, "utf8").trim());
}
