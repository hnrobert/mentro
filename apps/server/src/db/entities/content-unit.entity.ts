import { Column, Entity, Index, PrimaryColumn } from "typeorm";

@Entity({ name: "content_units" })
@Index(
  "uq_content_units_asset_ordinal_type",
  ["assetId", "ordinal", "unitType"],
  {
    unique: true,
  },
)
@Index("idx_content_units_asset", ["assetId"])
export class ContentUnit {
  @PrimaryColumn({ type: "text", primaryKeyConstraintName: "pk_content_units" })
  id!: string; // ULID

  @Column({ name: "asset_id", type: "text", nullable: false })
  assetId!: string;

  @Column({ type: "integer", nullable: false })
  ordinal!: number; // 1-based; whole-file kinds use 1

  @Column({ name: "unit_type", type: "text", nullable: false })
  unitType!: string; // 'page' | 'slide' | 'sheet' | 'frame' | 'whole'

  @Column({ type: "text", nullable: true })
  title!: string | null;

  @Column({ type: "text", nullable: true })
  text!: string | null;

  @Column({ name: "start_ms", type: "integer", nullable: true })
  startMs!: number | null;

  @Column({ name: "end_ms", type: "integer", nullable: true })
  endMs!: number | null;

  @Column({ name: "thumb_path", type: "text", nullable: true })
  thumbPath!: string | null;

  @Column({ name: "meta_json", type: "text", nullable: true })
  metaJson!: string | null;
}
