import { Column, Entity, Index, PrimaryColumn } from "typeorm";

/** Per-unit translation (cross-lingual search). One row per
 *  (unit, target lang). `status='skipped'` marks same-source units the
 *  translation job decided to no-op — the row exists so the
 *  missing-count query converges and backfill terminates. Only
 *  `status='ok'` rows are indexed (FTS/embeddings) or served. */
@Entity({ name: "unit_translations" })
@Index("idx_unit_translations_asset", ["assetId"])
export class UnitTranslation {
  @PrimaryColumn({
    name: "unit_id",
    type: "text",
    primaryKeyConstraintName: "pk_unit_translations",
  })
  unitId!: string; // content_units.id

  @PrimaryColumn({
    type: "text",
    primaryKeyConstraintName: "pk_unit_translations",
  })
  lang!: string; // target language code ("en"|"zh"|"ja"|...)

  @Column({ name: "asset_id", type: "text", nullable: false })
  assetId!: string;

  @Column({ name: "source_lang", type: "text", nullable: true })
  sourceLang!: string | null; // detected script of the original

  @Column({ type: "text", nullable: true })
  title!: string | null;

  @Column({ type: "text", nullable: true })
  text!: string | null;

  @Column({ type: "text", nullable: false, default: "ok" })
  status!: string; // 'ok' | 'skipped'

  @Column({ type: "text", nullable: true })
  backend!: string | null; // which chain member produced it ("llm"|"deepl"|...)

  @Column({
    name: "created_at",
    type: "datetime",
    default: () => "CURRENT_TIMESTAMP",
  })
  createdAt!: Date;
}
