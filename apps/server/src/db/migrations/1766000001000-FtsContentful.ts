import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Contentless FTS5 tables cannot serve snippet()/highlight() — they keep no
 * original text. Rebuild units_fts as a regular FTS5 table (own copy of the
 * segmented title/text). FTS rows are rebuilt by re-extraction (dev) or the
 * M2 index rebuild; nothing references them across the migration boundary.
 */
export class FtsContentful1766000001000 implements MigrationInterface {
  name = "FtsContentful1766000001000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "units_fts"`);
    await queryRunner.query(
      `CREATE VIRTUAL TABLE "units_fts" USING fts5(title, text)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "units_fts"`);
    await queryRunner.query(
      `CREATE VIRTUAL TABLE IF NOT EXISTS "units_fts" USING fts5(title, text, content='')`,
    );
  }
}
