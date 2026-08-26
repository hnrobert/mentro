import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Append-only changelog driving browser index deltas: one row per unit
 * upsert/remove, ordered by AUTOINCREMENT version. Clients pull
 * `/api/index?since=<version>` to fetch everything after their version;
 * last op per unit wins.
 */
export class IndexLog1766000003000 implements MigrationInterface {
  name = "IndexLog1766000003000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "index_log" (
      "version" INTEGER PRIMARY KEY AUTOINCREMENT,
      "op" TEXT NOT NULL,
      "unit_id" TEXT NOT NULL
    )`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_index_log_unit" ON "index_log" ("unit_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "idx_index_log_unit"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "index_log"`);
  }
}
