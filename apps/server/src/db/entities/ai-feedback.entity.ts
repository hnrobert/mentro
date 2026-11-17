import { Column, Entity, PrimaryColumn } from "typeorm";

/** Thumbs feedback on an AI answer (search overview). */
@Entity({ name: "ai_feedback" })
export class AiFeedback {
  @PrimaryColumn({
    type: "text",
    primaryKeyConstraintName: "pk_ai_feedback",
  })
  id!: string; // ULID

  @Column({ name: "user_id", type: "text", nullable: false })
  userId!: string;

  @Column({ type: "text", nullable: false })
  query!: string;

  @Column({ type: "text", nullable: true })
  answer!: string | null;

  @Column({ type: "text", nullable: false })
  rating!: string; // 'up' | 'down'

  @Column({
    name: "created_at",
    type: "datetime",
    default: () => "CURRENT_TIMESTAMP",
  })
  createdAt!: Date;
}
