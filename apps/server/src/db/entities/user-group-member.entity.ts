import { Column, Entity, Index, PrimaryColumn } from "typeorm";

/** Membership row: a user belongs to a user group. */
@Entity({ name: "user_group_members" })
@Index("idx_ugm_user", ["userId"])
@Index("idx_ugm_group", ["groupId"])
export class UserGroupMember {
  @PrimaryColumn({
    name: "user_id",
    type: "text",
    primaryKeyConstraintName: "pk_user_group_members",
  })
  userId!: string;

  @PrimaryColumn({
    name: "group_id",
    type: "text",
    primaryKeyConstraintName: "pk_user_group_members",
  })
  groupId!: string;

  @Column({
    name: "created_at",
    type: "datetime",
    default: () => "CURRENT_TIMESTAMP",
  })
  createdAt!: Date;
}
