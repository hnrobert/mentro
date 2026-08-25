import "reflect-metadata";
import { DataSource, type Logger } from "typeorm";
import * as entities from "./entities";
import { migrations } from "./migrations";

const dbPath =
  process.env.MENTRO_DB ?? `${process.env.MENTRO_DATA ?? "./data"}/mentro.db`;

class QuietLogger implements Logger {
  logQuery(): void {}
  logQueryError(error: string | Error, query: string): void {
    console.error(`[db] query error: ${error}\n  ${query}`);
  }
  logQuerySlow(): void {}
  logSchemaBuild(message: string): void {
    console.log(`[db] schema · ${message}`);
  }
  logMigration(message: string): void {
    console.log(`[db] migration · ${message}`);
  }
  log(level: "log" | "info" | "warn", message: unknown): void {
    if (level === "warn") console.warn(`[db] ${message}`);
  }
}

export const AppDataSource = new DataSource({
  type: "better-sqlite3",
  database: dbPath,
  entities: Object.values(entities) as never[],
  migrations: migrations as never[],
  // Schema changes go through migrations ONLY (see src/db/migrations/).
  // `synchronize: true` treats renames as drop+create — it must stay off.
  synchronize: false,
  logging: ["error", "warn"],
  logger: new QuietLogger(),
});

export async function initDataSource(): Promise<void> {
  if (AppDataSource.isInitialized) return;
  await AppDataSource.initialize();
  // Auto-apply pending migrations on every boot (dev and prod alike).
  if (await AppDataSource.showMigrations()) {
    const applied = await AppDataSource.runMigrations({ transaction: "each" });
    for (const m of applied) console.log(`[db] migration applied · ${m.name}`);
  }
  console.log(`[db] ready · ${dbPath}`);
}

export async function closeDataSource(): Promise<void> {
  if (AppDataSource.isInitialized) {
    await AppDataSource.destroy();
  }
}
