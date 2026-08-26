/**
 * Apply pending migrations to a database.
 *
 *   node scripts/dist/migration-run.js [--db=<path>]
 *
 * Target resolution: --db flag > MENTRO_DB env > MENTRO_DATA/mentro.db.
 * Runs the exact same code path as server boot (initDataSource).
 */
function resolveDb(): string {
  const arg = process.argv.find((a) => a.startsWith("--db="));
  if (arg) return arg.slice(5);
  return (
    process.env.MENTRO_DB || `${process.env.MENTRO_DATA ?? "./data"}/mentro.db`
  );
}

const db = resolveDb();
process.env.MENTRO_DB = db;

const { initDataSource, closeDataSource } =
  await import("../src/db/data-source");

try {
  await initDataSource();
  console.log(`[migration:run] up to date · ${db}`);
} finally {
  await closeDataSource();
}
