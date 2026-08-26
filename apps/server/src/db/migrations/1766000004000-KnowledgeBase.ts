import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Knowledge-base model: user-facing groups (hierarchical) replace the
 * source-as-navigation concept; assets get add-time (upload time or
 * first-index time, survives re-index) and uploader. mtime stays the
 * file's own clock.
 */
export class KnowledgeBase1766000004000 implements MigrationInterface {
  name = "KnowledgeBase1766000004000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "groups" (
      "id" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "parent_id" TEXT,
      "sort_order" INTEGER NOT NULL DEFAULT 0,
      "created_at" datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "pk_groups" PRIMARY KEY ("id")
    )`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_groups_parent" ON "groups" ("parent_id")`,
    );

    await queryRunner.query(`ALTER TABLE "assets" ADD COLUMN "group_id" TEXT`);
    await queryRunner.query(
      `ALTER TABLE "assets" ADD COLUMN "uploaded_at" datetime`,
    );
    await queryRunner.query(
      `ALTER TABLE "assets" ADD COLUMN "uploaded_by" TEXT`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_assets_group" ON "assets" ("group_id")`,
    );

    // Backfill add time: files already indexed get their first-index time.
    // extracted_at is the closest proxy we have.
    await queryRunner.query(
      `UPDATE "assets" SET "uploaded_at" = COALESCE("extracted_at", "created_at", datetime('now'))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "groups"`);
    for (const col of ["group_id", "uploaded_at", "uploaded_by"]) {
      try {
        await queryRunner.query(`ALTER TABLE "assets" DROP COLUMN "${col}"`);
      } catch {
        /* column may not exist */
      }
    }
  }
}
