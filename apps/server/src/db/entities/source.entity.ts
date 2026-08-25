import { Column, Entity, Index, PrimaryColumn } from "typeorm";

@Entity({ name: "sources" })
@Index("uq_sources_root_path", ["rootPath"], { unique: true })
export class Source {
  @PrimaryColumn({ type: "text", primaryKeyConstraintName: "pk_sources" })
  id!: string; // ULID

  @Column({ name: "root_path", type: "text", nullable: false })
  rootPath!: string;

  @Column({
    name: "added_at",
    type: "datetime",
    default: () => "CURRENT_TIMESTAMP",
  })
  addedAt!: Date;

  @Column({ name: "last_scan_at", type: "datetime", nullable: true })
  lastScanAt!: Date | null;
}
