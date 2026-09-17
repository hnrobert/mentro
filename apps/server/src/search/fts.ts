import type { EntityManager } from "typeorm";
import { AppDataSource } from "../db/data-source";
import { ContentUnit } from "../db/entities";
import { segment } from "./segment";

/** Query executor: the DataSource by default, or a transaction manager. */
type Q = Pick<EntityManager, "query">;

const defaultQ: Q = AppDataSource;

/** FTS5 rows keyed by content_units.rowid; maintained explicitly — always
 * within the same transaction as the unit writes they mirror. */

export async function ftsReplaceUnits(
  units: ContentUnit[],
  fileName: string,
  q: Q = defaultQ,
): Promise<void> {
  if (units.length === 0) return;
  const rows = (await q.query(
    `SELECT id, rowid AS rid FROM content_units WHERE id IN (${units.map(() => "?").join(",")})`,
    units.map((u) => u.id),
  )) as Array<{ id: string; rid: number }>;
  const rowidById = new Map(rows.map((r) => [r.id, r.rid]));
  for (const unit of units) {
    const rid = rowidById.get(unit.id);
    if (rid === undefined) continue;
    await q.query(`DELETE FROM units_fts WHERE rowid = ?`, [rid]);
    await q.query(
      `INSERT INTO units_fts (rowid, title, text, file_name) VALUES (?, ?, ?, ?)`,
      [rid, segment(unit.title ?? ""), segment(unit.text ?? ""), fileName],
    );
  }
}

export async function ftsDeleteAsset(
  assetId: string,
  q: Q = defaultQ,
): Promise<void> {
  const rows = (await q.query(
    `SELECT rowid AS rid FROM content_units WHERE asset_id = ?`,
    [assetId],
  )) as Array<{ rid: number }>;
  for (const { rid } of rows) {
    await q.query(`DELETE FROM units_fts WHERE rowid = ?`, [rid]);
  }
}

export interface SearchHit {
  unitId: string;
  assetId: string;
  ordinal: number;
  unitType: string;
  title: string | null;
  snippet: string | null;
  fileName: string;
  assetPath: string;
  kind: string;
  groupId: string | null;
}

export async function ftsSearch(
  matchExpr: string,
  limit = 50,
  groups?: Set<string>,
  readable?: Set<string>,
): Promise<SearchHit[]> {
  if (!matchExpr) return [];
  // Group filter (empty set = all). `__ungrouped__` selects null group.
  let groupSql = "";
  const params: unknown[] = [matchExpr];
  if (groups && groups.size > 0) {
    const ids = [...groups].filter((g) => g !== "__ungrouped__");
    const wantsUngrouped = groups.has("__ungrouped__");
    const clauses: string[] = [];
    if (ids.length > 0) {
      clauses.push(`a.group_id IN (${ids.map(() => "?").join(",")})`);
      params.push(...ids);
    }
    if (wantsUngrouped) clauses.push("a.group_id IS NULL");
    groupSql = ` AND (${clauses.join(" OR ")})`;
  }
  let readableSql = "";
  const readableParams: unknown[] = [];
  if (readable) {
    readableSql = ` AND cu.asset_id IN (${[...readable].map(() => "?").join(",") || "''"})`;
    readableParams.push(...[...readable]);
  }
  const rows = await AppDataSource.query(
    `SELECT cu.id AS unit_id, cu.asset_id, cu.ordinal, cu.unit_type, cu.title,
            a.path AS asset_path, a.kind, a.group_id,
            snippet(units_fts, 1, '[', ']', '…', 12) AS snip
     FROM units_fts
     JOIN content_units cu ON cu.rowid = units_fts.rowid
     JOIN assets a ON a.id = cu.asset_id
     WHERE units_fts MATCH ?${groupSql}${readableSql}
     ORDER BY rank
     LIMIT ?`,
    [...params, ...readableParams, limit],
  );
  return rows.map((r: Record<string, unknown>) => ({
    unitId: r.unit_id as string,
    assetId: r.asset_id as string,
    ordinal: r.ordinal as number,
    unitType: r.unit_type as string,
    title: (r.title as string) ?? null,
    snippet: (r.snip as string) ?? null,
    fileName:
      String(r.asset_path ?? "")
        .split("/")
        .pop() ?? "",
    assetPath: r.asset_path as string,
    kind: r.kind as string,
    groupId: (r.group_id as string | null) ?? null,
  }));
}
