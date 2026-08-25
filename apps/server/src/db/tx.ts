import type { EntityManager } from "typeorm";
import { AppDataSource } from "./data-source";

/**
 * SQLite here is a single connection (better-sqlite3 driver): concurrent
 * `AppDataSource.transaction` calls nest/conflict ("cannot start a
 * transaction within a transaction"). Extraction stays parallel; only the
 * commit sections are serialized through this promise chain.
 */
let chain: Promise<unknown> = Promise.resolve();

export function serializedTx<T>(
  fn: (m: EntityManager) => Promise<T>,
): Promise<T> {
  const run = chain.then(() => AppDataSource.transaction(fn));
  chain = run.catch(() => undefined);
  return run;
}
