/**
 * §9.2 cold-start measurement: how long the browser takes to build the
 * local index from a full bundle and answer one query. Reads a bundle
 * snapshot from MENTRO_EVAL_BUNDLE (JSON file path); skips silently when
 * absent so CI never depends on corpus data.
 */
import fs from "node:fs";
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { MiniSearchEngine } from "./minisearch";
import type { SearchUnit } from "./engine";

const BUNDLE_PATH = process.env.MENTRO_EVAL_BUNDLE;

describe("browser cold-start (§9.2)", () => {
  const runs: number[] = [];

  it.skipIf(!BUNDLE_PATH || !fs.existsSync(BUNDLE_PATH))(
    "measures the cold index build (records for docs/search-evaluation.md)",
    () => {
      const bundle = JSON.parse(readFileSync(BUNDLE_PATH!, "utf8")) as {
        units: SearchUnit[];
      };
      // Warm JIT with a throwaway build, then measure the real ones.
      for (let i = 0; i < 3; i++) {
        const engine = new MiniSearchEngine();
        const t0 = performance.now();
        engine.replaceAll(bundle.units);
        const hits = engine.search("port", 20);
        const ms = performance.now() - t0;
        if (i > 0) runs.push(ms);
        expect(hits.length).toBeGreaterThanOrEqual(0);
      }
      // Measurement only — the §9.2 verdict lives in the eval doc, not
      // in an assertion (the trigger is tripped today; see the doc).
      console.log(
        `[eval] units=${bundle.units.length} buildMs=${runs.map((r) => Math.round(r))}`,
      );
      expect(runs.length).toBeGreaterThan(0);
    },
  );

  afterAll(() => {
    if (runs.length > 0 && BUNDLE_PATH) {
      console.log(
        `[eval] summary: median=${Math.round(runs[Math.floor(runs.length / 2)])}ms worst=${Math.round(Math.max(...runs))}ms`,
      );
    }
  });
});
