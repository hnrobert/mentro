/** Search domain: the hybrid pipeline (FTS + translations + semantic
 *  legs, RRF-merged) and as-you-type suggestions. Pure business logic —
 *  request/user resolution stays in routes. */

import { AppDataSource } from "../db/data-source";
import { ftsMatchExpr } from "../search/segment";
import {
  ftsSearch,
  ftsSearchTranslations,
  type SearchHit,
} from "../search/fts";
import { embedTexts, nearestUnits } from "../search/embeddings";
import type { WorkerClient } from "../worker/client";
import { readableAssetIds } from "./acl.service";
import type { AuthUser } from "../auth/tokens";

export type Scope = "everywhere" | "content" | "filename";

export function scopedExpr(q: string, scope: Scope): string {
  const expr = ftsMatchExpr(q);
  if (scope === "filename") return `{file_name} : ${expr}`;
  if (scope === "content") return `{title text} : ${expr}`;
  return expr;
}

/** Last token becomes a prefix term — friendly to partial input. */
export function prefixExpr(q: string): string {
  const expr = ftsMatchExpr(q);
  const tokens = expr.split(" ").filter(Boolean);
  if (tokens.length === 0) return "";
  tokens[tokens.length - 1] = `${tokens[tokens.length - 1]}*`;
  return tokens.join(" ");
}

export async function hybridSearch(
  worker: WorkerClient,
  q: string,
  limit: number,
  mode: "fts" | "semantic" | "hybrid" = "hybrid",
  opts: {
    scope?: Scope;
    groups?: Set<string>;
    readable?: Set<string>;
    /** File-modification window (ms epoch) — advanced filter. */
    mtime?: { from?: number; to?: number };
    /** Post-merge ordering: relevance (default) or file mtime. */
    sort?: "relevance" | "mtime";
    sortDir?: "asc" | "desc";
  } = {},
): Promise<SearchHit[]> {
  const readable = opts.readable; // undefined = no ACL restriction (admin)
  const filenameOnly = opts.scope === "filename";
  // Cross-lingual leg: translations have no file_name, so filename-only
  // scope stays originals-only.
  const runTranslations = mode !== "semantic" && !filenameOnly;
  const [ftsHits, translationHits, semantic] = await Promise.all([
    mode === "semantic"
      ? Promise.resolve([])
      : ftsSearch(
          scopedExpr(q, opts.scope ?? "everywhere"),
          // Over-fetch for filename scope: per-file dedup below
          // collapses dozens of unit rows into one hit each.
          filenameOnly ? limit * 4 : limit,
          opts.groups,
          readable,
          opts.mtime,
        ),
    runTranslations
      ? ftsSearchTranslations(
          // Translation rows carry title+text only — same columns the
          // content scope filters; everywhere keeps the bare expr.
          opts.scope === "content"
            ? `{title text} : ${ftsMatchExpr(q)}`
            : ftsMatchExpr(q),
          limit,
          opts.groups,
          readable,
          opts.mtime,
        )
      : Promise.resolve([]),
    // Filename scope is FTS-only: unit embeddings carry no filename
    // signal, so semantic hits would leak content matches straight
    // through the filter.
    mode === "fts" || filenameOnly
      ? Promise.resolve([])
      : semanticRanking(worker, q, limit, opts.groups, readable),
  ]);

  const merged = new Map<
    string,
    { hit: SearchHit; score: number; viaFts: boolean; viaSem: boolean }
  >();
  ftsHits.forEach((hit, rank) => {
    merged.set(hit.unitId, {
      hit,
      score: 1 / (60 + 1 + rank),
      viaFts: true,
      viaSem: false,
    });
  });
  // Translation leg: same RRF formula; a translated match displays the
  // translated snippet (it contains the query terms in the user's
  // language — that is the whole point of cross-lingual search).
  translationHits.forEach((hit, rank) => {
    const contribution = 1 / (60 + 1 + rank);
    const translated = {
      lang: hit.lang,
      snippet: (hit.snippet ?? "").replaceAll("[", "").replaceAll("]", ""),
    };
    const existing = merged.get(hit.unitId);
    if (existing) {
      existing.score += contribution;
      existing.hit = { ...existing.hit, translated };
    } else {
      merged.set(hit.unitId, {
        hit: { ...hit, translated },
        score: contribution,
        viaFts: false,
        viaSem: false,
      });
    }
  });

  const semOnly = semantic.filter((s) => !merged.has(s.unitId));
  const hydrated = await hydrateSemantic(
    semOnly.map((s) => s.unitId),
    opts.groups,
    readable,
    opts.mtime,
  );
  const hydratedById = new Map(hydrated.map((h) => [h.unitId, h]));

  semantic.forEach(({ unitId }, rank) => {
    const contribution = 1 / (60 + 1 + rank);
    const existing = merged.get(unitId);
    if (existing) {
      existing.score += contribution;
      existing.viaSem = true;
    } else {
      const hit = hydratedById.get(unitId);
      if (hit) {
        merged.set(unitId, {
          hit,
          score: contribution,
          viaFts: false,
          viaSem: true,
        });
      }
    }
  });

  const sorted = [...merged.values()].sort((a, b) => b.score - a.score);
  if (opts.sort === "mtime") {
    // File-time ordering wins; relevance score breaks ties (nulls last).
    const dir = opts.sortDir === "asc" ? 1 : -1;
    sorted.sort((a, b) => {
      const am = a.hit.mtimeMs ?? -1;
      const bm = b.hit.mtimeMs ?? -1;
      if (am !== bm) return (am - bm) * dir;
      return b.score - a.score;
    });
  }
  const ranked = sorted
    .slice(0, limit)
    .map(({ hit, score, viaFts, viaSem }) => ({
      ...hit,
      score,
      source: viaFts && viaSem ? "hybrid" : viaFts ? "fts" : "semantic",
    }));
  // Filename scope: every unit of a matching file matches (same
  // file_name row) — collapse to one hit per file.
  if (filenameOnly) {
    const seen = new Set<string>();
    return ranked.filter((h) => {
      if (seen.has(h.assetId)) return false;
      seen.add(h.assetId);
      return true;
    });
  }
  return ranked;
}

async function semanticRanking(
  worker: WorkerClient,
  q: string,
  limit: number,
  groups?: Set<string>,
  readable?: Set<string>,
): Promise<Array<{ unitId: string; score: number }>> {
  const [vector] = await embedTexts(worker, [q]);
  if (!vector) return []; // sidecar unavailable -> FTS-only
  const ranked = await nearestUnits(
    vector,
    readable ? limit * 4 : limit,
    groups,
  );
  if (!readable) return ranked.slice(0, limit);
  // Over-fetch, then drop unreadable ids (unit -> asset hydration filters).
  const allowed = await assetsOfUnits(ranked.map((r) => r.unitId));
  return ranked
    .filter((r) => readable.has(allowed.get(r.unitId) ?? ""))
    .slice(0, limit);
}

/** unitId -> assetId map. */
async function assetsOfUnits(unitIds: string[]): Promise<Map<string, string>> {
  if (unitIds.length === 0) return new Map();
  const rows = (await AppDataSource.query(
    `SELECT id, asset_id FROM content_units WHERE id IN (${unitIds.map(() => "?").join(",")})`,
    unitIds,
  )) as Array<{ id: string; asset_id: string }>;
  return new Map(rows.map((r) => [r.id, r.asset_id]));
}

/** Minimal hit shapes for unit ids the FTS leg never saw. */
async function hydrateSemantic(
  unitIds: string[],
  groups?: Set<string>,
  readable?: Set<string>,
  mtime?: { from?: number; to?: number },
): Promise<SearchHit[]> {
  if (unitIds.length === 0) return [];
  const rows = (await AppDataSource.query(
    `SELECT cu.id AS unit_id, cu.asset_id, cu.ordinal, cu.unit_type, cu.title,
            substr(COALESCE(cu.text, ''), 1, 200) AS snip,
            a.path AS asset_path, a.kind, a.group_id, a.mtime_ms
     FROM content_units cu JOIN assets a ON a.id = cu.asset_id
     WHERE cu.id IN (${unitIds.map(() => "?").join(",")})`,
    unitIds,
  )) as Array<Record<string, unknown>>;
  return rows
    .filter((r) => groupOk(r.group_id as string | null, groups))
    .filter((r) => !readable || readable.has(r.asset_id as string))
    .filter((r) => {
      const ms = (r.mtime_ms as number | null) ?? null;
      if (mtime?.from !== undefined && (ms === null || ms < mtime.from))
        return false;
      if (mtime?.to !== undefined && (ms === null || ms > mtime.to))
        return false;
      return true;
    })
    .map((r) => ({
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
      mtimeMs: (r.mtime_ms as number | null) ?? null,
    }));
}

function groupOk(groupId: string | null, groups?: Set<string>): boolean {
  if (!groups || groups.size === 0) return true;
  return groupId ? groups.has(groupId) : groups.has("__ungrouped__");
}

/** Readable asset set for a user (undefined = admin/all). */
export async function readableSetOf(
  user: AuthUser | undefined,
): Promise<Set<string> | undefined> {
  if (!user || user.role === "super_admin" || user.role === "admin") {
    return undefined;
  }
  const readable = await readableAssetIds(user);
  return readable === "all" ? undefined : readable;
}

// --- suggestions (as-you-type) ----------------------------------------------

export interface SuggestResponse {
  terms: string[];
  hits: Array<{
    unitId: string;
    assetId: string;
    ordinal: number;
    unitType: string;
    title: string | null;
    fileName: string;
    kind: string;
  }>;
}

const CUT_CHARS = new Set(
  " \t，。、；：？！…—·,.;:?!()（）[]【】<>《》\"'`\n\r".split(""),
);

/** Completion candidates: windows starting at query occurrences in the
 *  top hits' text, cut at word/punctuation boundaries, ranked by
 *  frequency. Matching runs on whitespace-squished text (jieba-spaced
 *  CJK still matches contiguous queries) with an index map back to the
 *  original for phrase extraction. */
export function extractCompletions(
  query: string,
  texts: Array<string | null>,
  max: number,
): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const qSq = [...q].filter((c) => !/\s/.test(c)).join("");
  if (!qSq) return [];
  const counts = new Map<string, number>();
  for (const raw of texts) {
    if (!raw) continue;
    // Squish with an index map: squished[i] -> original position.
    const squished: string[] = [];
    const map: number[] = [];
    for (let i = 0; i < raw.length; i++) {
      if (/\s/.test(raw[i])) continue;
      squished.push(raw[i].toLowerCase());
      map.push(i);
    }
    const hay = squished.join("");
    let from = 0;
    for (let seen = 0; seen < 4; seen++) {
      const i = hay.indexOf(qSq, from);
      if (i < 0) break;
      from = i + qSq.length;
      const start = map[i];
      // end in ORIGINAL coordinates: after match + up to 10 more
      // non-punctuation chars.
      let end = start + q.length;
      const hardEnd = start + q.length + 12;
      while (end < raw.length && !CUT_CHARS.has(raw[end]) && end < hardEnd) {
        end++;
      }
      const phrase = raw.slice(start, end).trim();
      if (phrase.length > q.length && phrase.length <= 24) {
        counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)
    .map(([phrase]) => phrase)
    .slice(0, max);
}
