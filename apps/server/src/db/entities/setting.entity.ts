import { Column, Entity, PrimaryColumn } from "typeorm";

@Entity({ name: "settings" })
export class Setting {
  @PrimaryColumn({ type: "text", primaryKeyConstraintName: "pk_settings" })
  key!: string;

  @Column({ type: "text", nullable: false })
  value!: string; // JSON-encoded
}
