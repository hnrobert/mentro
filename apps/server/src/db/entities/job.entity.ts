import { Column, Entity, Index, PrimaryColumn } from "typeorm";

@Entity({ name: "jobs" })
@Index("idx_jobs_status", ["status"])
@Index("idx_jobs_asset", ["assetId"])
export class Job {
  @PrimaryColumn({ type: "text", primaryKeyConstraintName: "pk_jobs" })
  id!: string; // ULID

  @Column({ name: "asset_id", type: "text", nullable: true })
  assetId!: string | null; // null for source-level jobs (scan)

  @Column({ type: "text", nullable: false })
  kind!: string; // 'scan' | 'extract' | 'transcribe' | 'embed' | 'export'

  /** Kind-specific JSON: export units/format/artifactPath, etc. */
  @Column({ type: "text", nullable: true })
  payload!: string | null;

  @Column({ type: "text", nullable: false })
  status!: string; // 'pending' | 'running' | 'done' | 'failed' | 'cancelled'

  @Column({ type: "integer", nullable: false, default: 0 })
  attempts!: number;

  @Column({ name: "error_code", type: "text", nullable: true })
  errorCode!: string | null;

  @Column({ type: "text", nullable: true })
  error!: string | null;

  @Column({
    name: "created_at",
    type: "datetime",
    default: () => "CURRENT_TIMESTAMP",
  })
  createdAt!: Date;

  @Column({
    name: "updated_at",
    type: "datetime",
    default: () => "CURRENT_TIMESTAMP",
  })
  updatedAt!: Date;
}
