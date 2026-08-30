import { Column, Entity, Index, PrimaryColumn } from "typeorm";

/** Per-unit embedding vector (M6 semantic search). Vectors are stored as
 *  little-endian float32 blobs; search is brute-force cosine over the
 *  cached table — fine at corpus scale (see docs/search-evaluation.md). */
@Entity({ name: "unit_embeddings" })
@Index("idx_unit_embeddings_asset", ["assetId"])
export class UnitEmbedding {
  @PrimaryColumn({
    name: "unit_id",
    type: "text",
    primaryKeyConstraintName: "pk_unit_embeddings",
  })
  unitId!: string; // content_units.id

  @Column({ name: "asset_id", type: "text", nullable: false })
  assetId!: string;

  @Column({ type: "integer", nullable: false })
  dim!: number;

  @Column({ type: "blob", nullable: false })
  vector!: Uint8Array;

  @Column({
    name: "created_at",
    type: "datetime",
    default: () => "CURRENT_TIMESTAMP",
  })
  createdAt!: Date;
}
