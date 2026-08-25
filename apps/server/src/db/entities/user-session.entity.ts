import { Column, Entity, Index, PrimaryColumn } from "typeorm";

@Entity({ name: "user_sessions" })
@Index("idx_user_sessions_user", ["userId"])
@Index("idx_user_sessions_expires", ["expiresAt"])
export class UserSession {
  @PrimaryColumn({ type: "text", primaryKeyConstraintName: "pk_user_sessions" })
  id!: string; // ULID

  @Column({ name: "user_id", type: "text", nullable: false })
  userId!: string;

  @Column({ name: "refresh_hash", type: "text", nullable: false })
  refreshHash!: string; // sha256 of the refresh token

  @Column({
    name: "created_at",
    type: "datetime",
    default: () => "CURRENT_TIMESTAMP",
  })
  createdAt!: Date;

  @Column({ name: "expires_at", type: "datetime", nullable: false })
  expiresAt!: Date;

  @Column({ name: "revoked_at", type: "datetime", nullable: true })
  revokedAt!: Date | null;
}
