import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Add file_name to the FTS index so searches hit by filename (users type
 * "budget" expecting budget-plan.pdf). Rebuilds units_fts with three
 * columns and backfills every existing row; MATCH queries all columns.
 */
export class AddFtsFilename1766000002000 implements MigrationInterface {
  name = "AddFtsFilename1766000002000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "units_fts"`);
    await queryRunner.query(
      `CREATE VIRTUAL TABLE "units_fts" USING fts5(title, text, file_name)`,
    );

    const units = (await queryRunner.query(
      `SELECT cu.rowid AS rid, cu.title, cu.text, a.path
       FROM content_units cu JOIN assets a ON a.id = cu.asset_id`,
    )) as Array<{
      rid: number;
      title: string | null;
      text: string | null;
      path: string;
    }>;

    for (const u of units) {
      const fileName = u.path.split("/").pop() ?? "";
      await queryRunner.query(
        `INSERT INTO units_fts (rowid, title, text, file_name) VALUES (?, ?, ?, ?)`,
        [u.rid, u.title ?? "", u.text ?? "", fileName],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "units_fts"`);
    await queryRunner.query(
      `CREATE VIRTUAL TABLE "units_fts" USING fts5(title, text)`,
    );
  }
}
