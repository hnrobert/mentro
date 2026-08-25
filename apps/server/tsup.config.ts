import { defineConfig } from "tsup";

// Dev/bundle config. Native modules and packages with dynamic requires
// (typeorm driver loading, jieba's wasm asset) must stay external.
export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  target: "node24",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  external: ["better-sqlite3", "argon2", "jieba-wasm", "typeorm"],
  // Workspace source packages must be bundled (their extensionless TS
  // imports are unresolvable as externals at runtime).
  noExternal: [/@mentro\//],
  onSuccess: process.env.TSUP_WATCH ? "node dist/index.js" : undefined,
});
