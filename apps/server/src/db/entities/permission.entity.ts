import { Column, Entity, Index, PrimaryColumn, Unique } from "typeorm";

/**
 * One ACL entry: a subject (user or user group) gets a level on a target
 * (knowledge-base folder `group` or file `asset`). Resolution walks the
 * target chain (asset -> folder -> parent folders): the NEAREST target
 * with a matching entry decides; user entries beat user-group entries at
 * the same target; `deny` beats `read`/`write` at the same subject tier.
 * No matching entry anywhere -> the target's visibility decides
 * (`public` = readable by everyone, `internal` = admins only).
 */
@Entity({ name: "permissions" })
@Index("idx_perm_target", ["targetType", "targetId"])
@Index("idx_perm_subject", ["subjectType", "subjectId"])
@Unique("uq_perm_subject_target", [
  "subjectType",
  "subjectId",
  "targetType",
  "targetId",
])
export class Permission {
  @PrimaryColumn({ type: "text", primaryKeyConstraintName: "pk_permissions" })
  id!: string; // ULID

  @Column({
    name: "subject_type",
    type: "text",
    nullable: false,
  })
  subjectType!: "user" | "user_group";

  @Column({ name: "subject_id", type: "text", nullable: false })
  subjectId!: string;

  @Column({
    name: "target_type",
    type: "text",
    nullable: false,
  })
  targetType!: "group" | "asset";

  @Column({ name: "target_id", type: "text", nullable: false })
  targetId!: string;

  @Column({ type: "text", nullable: false })
  level!: "read" | "write" | "deny";

  @Column({
    name: "created_at",
    type: "datetime",
    default: () => "CURRENT_TIMESTAMP",
  })
  createdAt!: Date;
}
