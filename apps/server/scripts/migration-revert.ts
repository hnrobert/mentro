/**
 * Revert the LAST applied migration (one step).
 *
 *   node scripts/dist/migration-revert.js [--db=<path>]
 *
 * Destructive by definition — back up the database first.
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

const { AppDataSource } = await import("../src/db/data-source");

try {
  await AppDataSource.initialize();
  const before = (
    (await AppDataSource.query(
      "SELECT name FROM migrations ORDER BY id DESC LIMIT 1",
    )) as { name: string }[]
  )[0]?.name;
  await AppDataSource.undoLastMigration({ transaction: "each" });
  const after = (
    (await AppDataSource.query(
      "SELECT name FROM migrations ORDER BY id DESC LIMIT 1",
    )) as { name: string }[]
  )[0]?.name;
  console.log(
    `[migration:revert] reverted · ${before ?? "(none)"} → now at ${after ?? "(empty)"} · ${db}`,
  );
} finally {
  if (AppDataSource.isInitialized) await AppDataSource.destroy();
}
