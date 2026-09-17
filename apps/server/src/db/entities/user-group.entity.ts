import { Column, Entity, PrimaryColumn, Unique } from "typeorm";

/** User-managed group of users (authorization subject), unrelated to
 *  knowledge-base folder groups. */
@Entity({ name: "user_groups" })
@Unique("uq_user_groups_name", ["name"])
export class UserGroup {
  @PrimaryColumn({ type: "text", primaryKeyConstraintName: "pk_user_groups" })
  id!: string; // ULID

  @Column({ type: "text", nullable: false })
  name!: string;

  @Column({
    name: "created_at",
    type: "datetime",
    default: () => "CURRENT_TIMESTAMP",
  })
  createdAt!: Date;
}
