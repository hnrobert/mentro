import { AppDataSource } from "./db/data-source";
import { Setting } from "./db/entities";

export interface Settings {
  allowRegistration: boolean;
}

const DEFAULTS: Settings = {
  allowRegistration: true,
};

export async function getSettings(): Promise<Settings> {
  const repo = AppDataSource.getRepository(Setting);
  const rows = await repo.find();
  const out: Settings = { ...DEFAULTS };
  for (const row of rows) {
    if (row.key === "allowRegistration") {
      out.allowRegistration = row.value === "true";
    }
  }
  return out;
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const repo = AppDataSource.getRepository(Setting);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    await repo.upsert({ key, value: String(value) }, ["key"]);
  }
  return getSettings();
}
