import { Column, Entity, Index, PrimaryColumn } from "typeorm";

@Entity({ name: "users" })
@Index("uq_users_username", ["username"], { unique: true })
export class User {
  @PrimaryColumn({ type: "text", primaryKeyConstraintName: "pk_users" })
  id!: string; // ULID

  @Column({ type: "text", nullable: false })
  username!: string; // /^[A-Za-z0-9_-]{3,32}$/

  @Column({ name: "password_hash", type: "text", nullable: false })
  passwordHash!: string; // argon2id; never logged

  @Column({ type: "text", nullable: false, default: "user" })
  role!: string; // 'super_admin' | 'user'

  @Column({ type: "boolean", nullable: false, default: true })
  enabled!: boolean;

  @Column({
    name: "created_at",
    type: "datetime",
    default: () => "CURRENT_TIMESTAMP",
  })
  createdAt!: Date;

  @Column({ name: "last_login_at", type: "datetime", nullable: true })
  lastLoginAt!: Date | null;
}
