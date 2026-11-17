import { Column, Entity, PrimaryColumn } from "typeorm";

/** Admin-configured LLM endpoint (model registry). Users pick one for
 *  the AI assistant; the default entry applies when they haven't. */
@Entity({ name: "llm_endpoints" })
export class LlmEndpoint {
  @PrimaryColumn({
    type: "text",
    primaryKeyConstraintName: "pk_llm_endpoints",
  })
  id!: string; // ULID

  @Column({ type: "text", nullable: false })
  name!: string; // display label, e.g. "Turbo (fast)"

  @Column({ name: "base_url", type: "text", nullable: false })
  baseUrl!: string; // OpenAI-compatible, includes /vN

  @Column({ name: "api_key", type: "text", nullable: false })
  apiKey!: string;

  @Column({ type: "text", nullable: false })
  model!: string; // model id, e.g. glm-5-turbo

  @Column({ type: "boolean", nullable: false, default: false })
  enabled!: boolean;

  @Column({
    name: "created_at",
    type: "datetime",
    default: () => "CURRENT_TIMESTAMP",
  })
  createdAt!: Date;
}
