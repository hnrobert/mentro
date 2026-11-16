import { Column, Entity, Index, PrimaryColumn } from "typeorm";

/** Per-unit-translation embedding vector. Kept in a parallel table
 *  instead of adding a lang column to unit_embeddings: changing that
 *  table's PK would force a sqlite rebuild and silently change the
 *  runEmbed completeness probe / storeAssetEmbeddings delete semantics.
 *  Purely additive. */
@Entity({ name: "unit_translation_embeddings" })
@Index("idx_unit_translation_embeddings_asset", ["assetId"])
export class UnitTranslationEmbedding {
  @PrimaryColumn({
    name: "unit_id",
    type: "text",
    primaryKeyConstraintName: "pk_unit_translation_embeddings",
  })
  unitId!: string;

  @PrimaryColumn({
    type: "text",
    primaryKeyConstraintName: "pk_unit_translation_embeddings",
  })
  lang!: string;

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
