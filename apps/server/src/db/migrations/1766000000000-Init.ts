import type { MigrationInterface, QueryRunner } from "typeorm";

export class Init1766000000000 implements MigrationInterface {
  name = "Init1766000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const sql of INIT_DDL) {
      await queryRunner.query(sql);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of INIT_TABLES) {
      await queryRunner.query(`DROP TABLE IF EXISTS "${table}"`);
    }
  }
}

const INIT_TABLES = [
  "units_fts",
  "jobs",
  "content_units",
  "assets",
  "sources",
  "settings",
  "user_sessions",
  "users",
] as const;

const INIT_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS "users" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'user',
    "enabled" boolean NOT NULL DEFAULT 1,
    "created_at" datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_login_at" datetime,
    CONSTRAINT "pk_users" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "uq_users_username" ON "users" ("username")`,

  `CREATE TABLE IF NOT EXISTS "user_sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "refresh_hash" TEXT NOT NULL,
    "created_at" datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" datetime NOT NULL,
    "revoked_at" datetime,
    CONSTRAINT "pk_user_sessions" PRIMARY KEY ("id")
  )`,
  `CREATE INDEX IF NOT EXISTS "idx_user_sessions_user" ON "user_sessions" ("user_id")`,
  `CREATE INDEX IF NOT EXISTS "idx_user_sessions_expires" ON "user_sessions" ("expires_at")`,

  `CREATE TABLE IF NOT EXISTS "settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    CONSTRAINT "pk_settings" PRIMARY KEY ("key")
  )`,

  `CREATE TABLE IF NOT EXISTS "sources" (
    "id" TEXT NOT NULL,
    "root_path" TEXT NOT NULL,
    "added_at" datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_scan_at" datetime,
    CONSTRAINT "pk_sources" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "uq_sources_root_path" ON "sources" ("root_path")`,

  `CREATE TABLE IF NOT EXISTS "assets" (
    "id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "size_bytes" integer NOT NULL,
    "mtime_ms" integer NOT NULL,
    "content_hash" TEXT,
    "mime" TEXT,
    "kind" TEXT NOT NULL,
    "extraction_status" TEXT NOT NULL DEFAULT 'pending',
    "extraction_version" integer,
    "extracted_at" datetime,
    "error" TEXT,
    "oversized" boolean NOT NULL DEFAULT 0,
    CONSTRAINT "pk_assets" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "uq_assets_path" ON "assets" ("path")`,
  `CREATE INDEX IF NOT EXISTS "idx_assets_source" ON "assets" ("source_id")`,
  `CREATE INDEX IF NOT EXISTS "idx_assets_status" ON "assets" ("extraction_status")`,

  `CREATE TABLE IF NOT EXISTS "content_units" (
    "id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "ordinal" integer NOT NULL,
    "unit_type" TEXT NOT NULL,
    "title" TEXT,
    "text" TEXT,
    "start_ms" integer,
    "end_ms" integer,
    "thumb_path" TEXT,
    "meta_json" TEXT,
    CONSTRAINT "pk_content_units" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "uq_content_units_asset_ordinal_type" ON "content_units" ("asset_id", "ordinal", "unit_type")`,
  `CREATE INDEX IF NOT EXISTS "idx_content_units_asset" ON "content_units" ("asset_id")`,

  `CREATE TABLE IF NOT EXISTS "jobs" (
    "id" TEXT NOT NULL,
    "asset_id" TEXT,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" integer NOT NULL DEFAULT 0,
    "error_code" TEXT,
    "error" TEXT,
    "created_at" datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pk_jobs" PRIMARY KEY ("id")
  )`,
  `CREATE INDEX IF NOT EXISTS "idx_jobs_status" ON "jobs" ("status")`,
  `CREATE INDEX IF NOT EXISTS "idx_jobs_asset" ON "jobs" ("asset_id")`,

  // FTS5 over segmented title/text (contentful: snippet() works); rowid ==
  // content_units.rowid. Rows are maintained explicitly (src/search/fts.ts).
  `CREATE VIRTUAL TABLE IF NOT EXISTS "units_fts" USING fts5(title, text)`,
];
