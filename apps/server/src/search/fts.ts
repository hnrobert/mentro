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
      // file_name is segmented too: the unicode61 tokenizer emits whole
      // CJK runs as one token (集装箱码头.pptx), so raw names never match
      // substring queries like 码头 in the filename-only scope.
      [
        rid,
        segment(unit.title ?? ""),
        segment(unit.text ?? ""),
        segment(fileName),
      ],
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

// --- translations_fts (cross-lingual leg) ----------------------------------
// Keyed by its own rowid with unit_id/lang as UNINDEXED columns — no
// content_units.rowid linkage, so table-rebuilding migrations cannot
// silently break it (unlike units_fts; see ftsSelfHeal).

export interface TranslationRow {
  unitId: string;
  lang: string;
  title: string;
  text: string;
}

export async function ftsReplaceTranslations(
  rows: TranslationRow[],
  q: Q = defaultQ,
): Promise<void> {
  for (const r of rows) {
    if (!r.text && !r.title) continue;
    await q.query(
      `DELETE FROM translations_fts WHERE unit_id = ? AND lang = ?`,
      [r.unitId, r.lang],
    );
    await q.query(
      `INSERT INTO translations_fts (title, text, unit_id, lang) VALUES (?, ?, ?, ?)`,
      [segment(r.title), segment(r.text), r.unitId, r.lang],
    );
  }
}

export async function ftsDeleteTranslationsByAsset(
  assetId: string,
  q: Q = defaultQ,
): Promise<void> {
  await q.query(
    `DELETE FROM translations_fts WHERE unit_id IN (SELECT id FROM content_units WHERE asset_id = ?)`,
    [assetId],
  );
}

/** SearchHit plus the translation that matched. */
export interface TranslationSearchHit extends SearchHit {
  lang: string;
}

function dirOf(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx > 0 ? p.slice(0, idx) : "";
}

export async function ftsSearchTranslations(
  matchExpr: string,
  limit = 50,
  groups?: Set<string>,
  readable?: Set<string>,
  mtime?: { from?: number; to?: number },
): Promise<TranslationSearchHit[]> {
  if (!matchExpr) return [];
  let groupSql = "";
  const params: unknown[] = [matchExpr];
  if (groups && groups.size > 0) {
    // Groups are pool-relative DIRECTORY paths now; a selected directory
    // includes all its subdirectories (LIKE prefix). "__ungrouped__" =
    // files directly in the pool root (no "/" in path).
    const dirs = [...groups].filter((g) => g !== "__ungrouped__");
    const wantsRoot = groups.has("__ungrouped__");
    const clauses: string[] = [];
    if (dirs.length > 0) {
      clauses.push(`(${dirs.map(() => "a.path LIKE ?").join(" OR ")})`);
      params.push(...dirs.map((d) => `${d}/%`));
    }
    if (wantsRoot) clauses.push("a.path NOT LIKE '%/%'");
    groupSql = ` AND (${clauses.join(" OR ")})`;
  }
  let readableSql = "";
  const readableParams: unknown[] = [];
  if (readable) {
    readableSql = ` AND cu.asset_id IN (${[...readable].map(() => "?").join(",") || "''"})`;
    readableParams.push(...[...readable]);
  }
  let mtimeSql = "";
  const mtimeParams: unknown[] = [];
  if (mtime?.from !== undefined) {
    mtimeSql += " AND a.mtime_ms >= ?";
    mtimeParams.push(mtime.from);
  }
  if (mtime?.to !== undefined) {
    mtimeSql += " AND a.mtime_ms <= ?";
    mtimeParams.push(mtime.to);
  }
  const rows = await AppDataSource.query(
    `SELECT tf.unit_id, tf.lang,
            cu.asset_id, cu.ordinal, cu.unit_type, cu.title,
            a.path AS asset_path, a.kind, a.mtime_ms,
            snippet(translations_fts, 1, '[', ']', '…', 12) AS snip
     FROM translations_fts tf
     JOIN content_units cu ON cu.id = tf.unit_id
     JOIN assets a ON a.id = cu.asset_id
     WHERE translations_fts MATCH ?${groupSql}${readableSql}${mtimeSql}
     ORDER BY rank
     LIMIT ?`,
    [...params, ...readableParams, ...mtimeParams, limit],
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
    mtimeMs: (r.mtime_ms as number | null) ?? null,
    lang: r.lang as string,
  }));
}

/** Boot-time integrity check for the translations mirror (same idea as
 *  ftsSelfHeal, but the count comparison is the only drift signal
 *  needed — there is no rowid linkage to break). The virtual table is
 *  ensured here (idempotent): FTS5 tables are outside entity metadata,
 *  so migrations cannot express them — repo policy is script-generated
 *  migrations only, hence runtime ensure instead of hand-written DDL. */
export async function translationsSelfHeal(): Promise<void> {
  await AppDataSource.query(
    `CREATE VIRTUAL TABLE IF NOT EXISTS "translations_fts" USING fts5(title, text, unit_id UNINDEXED, lang UNINDEXED)`,
  );
  const [{ ok }] = (await AppDataSource.query(
    `SELECT COUNT(*) AS ok FROM unit_translations WHERE status = 'ok' AND COALESCE(text,'') != ''`,
  )) as Array<{ ok: number }>;
  const [{ rows }] = (await AppDataSource.query(
    `SELECT COUNT(*) AS rows FROM translations_fts`,
  )) as Array<{ rows: number }>;
  if (ok === rows) return;
  console.warn(
    `[search] translations_fts drift (${rows} rows vs ${ok} translations) — rebuilding`,
  );
  await AppDataSource.query(`DELETE FROM translations_fts`);
  const all = (await AppDataSource.query(
    `SELECT unit_id, lang, title, text FROM unit_translations WHERE status = 'ok'`,
  )) as Array<{
    unit_id: string;
    lang: string;
    title: string | null;
    text: string | null;
  }>;
  await ftsReplaceTranslations(
    all.map((r) => ({
      unitId: r.unit_id,
      lang: r.lang,
      title: r.title ?? "",
      text: r.text ?? "",
    })),
  );
  console.log(`[search] rebuilt translations_fts (${all.length} rows)`);
}

/** The FTS mirror is keyed by content_units.rowid — a linkage that any
 *  migration rebuilding content_units silently breaks (sqlite ALTER =
 *  drop + copy + rename, which reassigns rowids; every search then
 *  returns nothing). Verify on boot; rebuild the mirror when the join
 *  count drifts. */
export async function ftsSelfHeal(): Promise<void> {
  const [{ units }] = (await AppDataSource.query(
    `SELECT COUNT(*) AS units FROM content_units`,
  )) as Array<{ units: number }>;
  const [{ linked }] = (await AppDataSource.query(
    `SELECT COUNT(*) AS linked FROM units_fts
     JOIN content_units cu ON cu.rowid = units_fts.rowid`,
  )) as Array<{ linked: number }>;
  if (linked === units) return;

  console.warn(
    `[search] units_fts linkage broken (${linked}/${units} rows join) — rebuilding`,
  );
  await AppDataSource.query(`DELETE FROM units_fts`);
  const rows = (await AppDataSource.query(
    `SELECT cu.rowid AS rid, cu.title, cu.text,
            COALESCE(a.path, '') AS path
     FROM content_units cu JOIN assets a ON a.id = cu.asset_id`,
  )) as Array<{
    rid: number;
    title: string | null;
    text: string | null;
    path: string;
  }>;
  for (const r of rows) {
    const fileName = r.path.split("/").pop() ?? "";
    await AppDataSource.query(
      `INSERT INTO units_fts (rowid, title, text, file_name) VALUES (?, ?, ?, ?)`,
      [r.rid, segment(r.title ?? ""), segment(r.text ?? ""), segment(fileName)],
    );
  }
  console.log(`[search] rebuilt units_fts (${rows.length} units)`);
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
  /** Pool-relative directory of the file ("" = root) — the new group. */
  dirPath: string;
  /** Set when the unit matched (at least partly) through its
   *  translation: snippet shown to the user is the translated text. */
  translated?: { lang: string; snippet: string };
  /** Source file's modification time (assets.mtime_ms) — advanced
   *  filter/sort on the search page. */
  mtimeMs: number | null;
}

export async function ftsSearch(
  matchExpr: string,
  limit = 50,
  groups?: Set<string>,
  readable?: Set<string>,
  mtime?: { from?: number; to?: number },
): Promise<SearchHit[]> {
  if (!matchExpr) return [];
  // Group filter (empty set = all). `__ungrouped__` selects null group.
  let groupSql = "";
  const params: unknown[] = [matchExpr];
  if (groups && groups.size > 0) {
    // Groups are pool-relative DIRECTORY paths now; a selected directory
    // includes all its subdirectories (LIKE prefix). "__ungrouped__" =
    // files directly in the pool root (no "/" in path).
    const dirs = [...groups].filter((g) => g !== "__ungrouped__");
    const wantsRoot = groups.has("__ungrouped__");
    const clauses: string[] = [];
    if (dirs.length > 0) {
      clauses.push(`(${dirs.map(() => "a.path LIKE ?").join(" OR ")})`);
      params.push(...dirs.map((d) => `${d}/%`));
    }
    if (wantsRoot) clauses.push("a.path NOT LIKE '%/%'");
    groupSql = ` AND (${clauses.join(" OR ")})`;
  }
  let readableSql = "";
  const readableParams: unknown[] = [];
  if (readable) {
    readableSql = ` AND cu.asset_id IN (${[...readable].map(() => "?").join(",") || "''"})`;
    readableParams.push(...[...readable]);
  }
  let mtimeSql = "";
  const mtimeParams: unknown[] = [];
  if (mtime?.from !== undefined) {
    mtimeSql += " AND a.mtime_ms >= ?";
    mtimeParams.push(mtime.from);
  }
  if (mtime?.to !== undefined) {
    mtimeSql += " AND a.mtime_ms <= ?";
    mtimeParams.push(mtime.to);
  }
  const rows = await AppDataSource.query(
    `SELECT cu.id AS unit_id, cu.asset_id, cu.ordinal, cu.unit_type, cu.title,
            a.path AS asset_path, a.kind, a.mtime_ms,
            snippet(units_fts, 1, '[', ']', '…', 12) AS snip
     FROM units_fts
     JOIN content_units cu ON cu.rowid = units_fts.rowid
     JOIN assets a ON a.id = cu.asset_id
     WHERE units_fts MATCH ?${groupSql}${readableSql}${mtimeSql}
     ORDER BY rank
     LIMIT ?`,
    [...params, ...readableParams, ...mtimeParams, limit],
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
    dirPath: dirOf(String(r.asset_path ?? "")),
  }));
}
