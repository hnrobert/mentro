import { defineConfig } from "tsup";

/**
 * Builds the Node CLI tooling (migration scripts) into plain ESM bundles via
 * tsup (esbuild) — the app itself stays on the main tsup.config.ts pipeline.
 *
 * Prebuilt bundles start instantly and need no TS loader (the typeorm CLI's
 * own loader chokes on legacy decorators under Node 24).
 *
 * `experimentalDecorators` comes from tsconfig.json;
 * `emitDecoratorMetadata` is not needed — every entity column declares an
 * explicit `type`.
 */
export default defineConfig({
  entry: [
    "scripts/migration-run.ts",
    "scripts/migration-revert.ts",
    "scripts/migration-generate.ts",
  ],
  outDir: "scripts/dist",
  format: ["esm"],
  target: "node24",
  splitting: true,
  clean: true,
});
