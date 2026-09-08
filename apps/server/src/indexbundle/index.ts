/** Browser index bundle: full snapshot + versioned deltas from index_log. */

import type { EntityManager } from "typeorm";
import { AppDataSource } from "../db/data-source";

type Q = Pick<EntityManager, "query">;

const defaultQ: Q = AppDataSource;

export interface BundleUnit {
  id: string;
  assetId: string;
  kind: string;
  unitType: string;
  ordinal: number;
  title: string | null;
  text: string | null;
  fileName: string;
  sourcePath: string;
  mtimeMs: number;
  hasThumb: boolean;
  /** Owning asset's knowledge-base group (search filters by group). */
  groupId: string | null;
}

export interface FullBundle {
  version: number;
  generatedAt: number;
  units: BundleUnit[];
}

export interface DeltaBundle {
  version: number;
  upserted: BundleUnit[];
  removed: string[];
}

const UNIT_SELECT = `
  SELECT cu.id, cu.asset_id, cu.ordinal, cu.unit_type, cu.title, cu.text,
         cu.thumb_path, a.path AS asset_path, a.kind, a.mtime_ms, a.group_id
  FROM content_units cu JOIN assets a ON a.id = cu.asset_id`;

/** Current changelog version (0 when nothing logged yet). */
export async function currentVersion(q: Q = defaultQ): Promise<number> {
  const rows = (await q.query(
    `SELECT COALESCE(MAX(version), 0) AS v FROM index_log`,
  )) as Array<{ v: number }>;
  return rows[0]?.v ?? 0;
}

/** Log upserted units (call inside the same transaction as the writes). */
export async function logUpserted(
  unitIds: string[],
  q: Q = defaultQ,
): Promise<void> {
  for (const id of unitIds) {
    await q.query(`INSERT INTO index_log (op, unit_id) VALUES ('upsert', ?)`, [
      id,
    ]);
  }
}

/** Log removed units (call before/with the delete, same transaction). */
export async function logRemoved(
  unitIds: string[],
  q: Q = defaultQ,
): Promise<void> {
  for (const id of unitIds) {
    await q.query(`INSERT INTO index_log (op, unit_id) VALUES ('remove', ?)`, [
      id,
    ]);
  }
}

/** Unit ids of an asset (for logging ahead of deletion). */
export async function unitIdsOfAsset(
  assetId: string,
  q: Q = defaultQ,
): Promise<string[]> {
  const rows = (await q.query(
    `SELECT id FROM content_units WHERE asset_id = ?`,
    [assetId],
  )) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

function rowToUnit(r: Record<string, unknown>): BundleUnit {
  const path = String(r.asset_path ?? "");
  return {
    id: r.id as string,
    assetId: r.asset_id as string,
    kind: r.kind as string,
    unitType: r.unit_type as string,
    ordinal: r.ordinal as number,
    title: (r.title as string) ?? null,
    text: (r.text as string) ?? null,
    fileName: path.split("/").pop() ?? "",
    sourcePath: path,
    mtimeMs: r.mtime_ms as number,
    hasThumb: Boolean(r.thumb_path),
    groupId: (r.group_id as string | null) ?? null,
  };
}

export async function buildFullBundle(q: Q = defaultQ): Promise<FullBundle> {
  const [version, rows] = await Promise.all([
    currentVersion(q),
    q.query(`${UNIT_SELECT} ORDER BY cu.id`),
  ]);
  return {
    version,
    generatedAt: Date.now(),
    units: (rows as Array<Record<string, unknown>>).map(rowToUnit),
  };
}

export async function buildDelta(
  since: number,
  q: Q = defaultQ,
): Promise<DeltaBundle> {
  const version = await currentVersion(q);
  if (since >= version) {
    return { version, upserted: [], removed: [] };
  }
  // Last op per unit wins.
  const rows = (await q.query(
    `SELECT op, unit_id FROM index_log WHERE version > ? ORDER BY version`,
    [since],
  )) as Array<{ op: string; unit_id: string }>;
  const finalOp = new Map<string, string>();
  for (const r of rows) {
    finalOp.set(r.unit_id, r.op);
  }
  const upsertIds = [...finalOp.entries()]
    .filter(([, op]) => op === "upsert")
    .map(([id]) => id);
  const removed = [...finalOp.entries()]
    .filter(([, op]) => op === "remove")
    .map(([id]) => id);

  let upserted: BundleUnit[] = [];
  if (upsertIds.length > 0) {
    const placeholders = upsertIds.map(() => "?").join(",");
    const units = (await q.query(
      `${UNIT_SELECT} WHERE cu.id IN (${placeholders})`,
      upsertIds,
    )) as Array<Record<string, unknown>>;
    upserted = units.map(rowToUnit);
  }
  return { version, upserted, removed };
}
