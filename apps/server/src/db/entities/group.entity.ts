import { Column, Entity, Index, PrimaryColumn } from "typeorm";

@Entity({ name: "groups" })
@Index("idx_groups_parent", ["parentId"])
export class Group {
  @PrimaryColumn({ type: "text", primaryKeyConstraintName: "pk_groups" })
  id!: string; // ULID

  @Column({ type: "text", nullable: false })
  name!: string;

  @Column({ name: "parent_id", type: "text", nullable: true })
  parentId!: string | null;

  @Column({ name: "sort_order", type: "integer", nullable: false, default: 0 })
  sortOrder!: number;

  /** `public` files/folders are readable by every signed-in user
   *  (对外); `internal` needs an explicit ACL grant. */
  @Column({
    type: "text",
    nullable: false,
    default: "internal",
  })
  visibility!: "internal" | "public";

  @Column({
    name: "created_at",
    type: "datetime",
    default: () => "CURRENT_TIMESTAMP",
  })
  createdAt!: Date;
}
