import { Column, Entity, Index, PrimaryColumn } from "typeorm";

@Entity({ name: "assets" })
@Index("uq_assets_path", ["path"], { unique: true })
@Index("idx_assets_source", ["sourceId"])
@Index("idx_assets_status", ["extractionStatus"])
export class Asset {
  @PrimaryColumn({ type: "text", primaryKeyConstraintName: "pk_assets" })
  id!: string; // ULID

  @Column({ name: "source_id", type: "text", nullable: false })
  sourceId!: string;

  @Column({ type: "text", nullable: false })
  path!: string;

  @Column({ name: "size_bytes", type: "integer", nullable: false })
  sizeBytes!: number;

  @Column({ name: "mtime_ms", type: "integer", nullable: false })
  mtimeMs!: number;

  @Column({ name: "content_hash", type: "text", nullable: true })
  contentHash!: string | null; // blake3 hex

  @Column({ type: "text", nullable: true })
  mime!: string | null;

  @Column({ type: "text", nullable: false })
  kind!: string; // 'text'|'pdf'|'presentation'|... (worker EAssetKind lowercase)

  @Column({ name: "extraction_status", type: "text", nullable: false, default: "pending" })
  extractionStatus!: string; // 'pending' | 'running' | 'done' | 'failed' | 'skipped'

  @Column({ name: "extraction_version", type: "integer", nullable: true })
  extractionVersion!: number | null;

  @Column({ name: "extracted_at", type: "datetime", nullable: true })
  extractedAt!: Date | null;

  @Column({ type: "text", nullable: true })
  error!: string | null;

  @Column({ type: "boolean", nullable: false, default: false })
  oversized!: boolean;
}
