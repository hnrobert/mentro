import { AppDataSource } from "../db/data-source";
import { ContentUnit } from "../db/entities";
import { segment } from "./segment";

/** Contentless FTS5 rows keyed by content_units.rowid; maintained
 * explicitly in the same transaction as the units themselves. */

export async function ftsReplaceUnits(units: ContentUnit[]): Promise<void> {
  if (units.length === 0) return;
  const rows = await AppDataSource.query(
    `SELECT id, rowid AS rid FROM content_units WHERE id IN (${units.map(() => "?").join(",")})`,
    units.map((u) => u.id),
  ) as Array<{ id: string; rid: number }>;
  const rowidById = new Map(rows.map((r) => [r.id, r.rid]));
  for (const unit of units) {
    const rid = rowidById.get(unit.id);
    if (rid === undefined) continue;
    await AppDataSource.query(`DELETE FROM units_fts WHERE rowid = ?`, [rid]);
    await AppDataSource.query(
      `INSERT INTO units_fts (rowid, title, text) VALUES (?, ?, ?)`,
      [rid, segment(unit.title ?? ""), segment(unit.text ?? "")],
    );
  }
}

export async function ftsDeleteAsset(assetId: string): Promise<void> {
  const rows = await AppDataSource.query(
    `SELECT rowid AS rid FROM content_units WHERE asset_id = ?`,
    [assetId],
  ) as Array<{ rid: number }>;
  for (const { rid } of rows) {
    await AppDataSource.query(`DELETE FROM units_fts WHERE rowid = ?`, [rid]);
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
}

export async function ftsSearch(
  matchExpr: string,
  limit = 50,
): Promise<SearchHit[]> {
  if (!matchExpr) return [];
  const rows = await AppDataSource.query(
    `SELECT cu.id AS unit_id, cu.asset_id, cu.ordinal, cu.unit_type, cu.title,
            a.path AS asset_path, a.kind,
            snippet(units_fts, 1, '[', ']', '…', 12) AS snip
     FROM units_fts
     JOIN content_units cu ON cu.rowid = units_fts.rowid
     JOIN assets a ON a.id = cu.asset_id
     WHERE units_fts MATCH ?
     ORDER BY rank
     LIMIT ?`,
    [matchExpr, limit],
  );
  return rows.map((r: Record<string, unknown>) => ({
    unitId: r.unit_id as string,
    assetId: r.asset_id as string,
    ordinal: r.ordinal as number,
    unitType: r.unit_type as string,
    title: (r.title as string) ?? null,
    snippet: (r.snip as string) ?? null,
    fileName: String(r.asset_path ?? "").split("/").pop() ?? "",
    assetPath: r.asset_path as string,
    kind: r.kind as string,
  }));
}
