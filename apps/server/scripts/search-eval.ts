/**
 * §9.2 upgrade-trigger measurement (M6 evaluation): builds the full index
 * bundle against a DB snapshot and reports the three trigger metrics —
 * unit count, gzip bundle size, cold build time. Run against a COPY of
 * the live DB (the running server owns the real one):
 *
 *   cp apps/server/data/mentro.db /tmp/mentro-eval.db
 *   MENTRO_DB=/tmp/mentro-eval.db npx tsx scripts/search-eval.ts
 */
import { gzipSync } from "node:zlib";
import { initDataSource, closeDataSource } from "../src/db/data-source";
import { buildFullBundle } from "../src/indexbundle";

async function main(): Promise<void> {
  await initDataSource();

  // Cold build x3: first run pays JIT/SQLite page-cache warmup.
  const runs: Array<{ ms: number; bytes: number; gz: number }> = [];
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    const bundle = await buildFullBundle();
    const ms = Math.round(performance.now() - t0);
    const json = JSON.stringify(bundle);
    runs.push({
      ms,
      bytes: Buffer.byteLength(json),
      gz: gzipSync(Buffer.from(json)).length,
    });
  }

  const units = (
    (await import("../src/db/data-source")).AppDataSource.query(
      "SELECT COUNT(*) AS n FROM content_units",
    ) as Promise<Array<{ n: number }>>
  )[0];
  const unitsM6 = (
    (await import("../src/db/data-source")).AppDataSource.query(
      "SELECT COUNT(*) AS n FROM unit_embeddings",
    ) as Promise<Array<{ n: number }>>
  )[0];

  console.log(
    JSON.stringify(
      { units: units.n, embeddings: unitsM6?.n ?? 0, runs },
      null,
      2,
    ),
  );
  await closeDataSource();
}

void main();
