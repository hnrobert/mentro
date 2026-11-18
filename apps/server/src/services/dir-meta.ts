/** Directory metadata (`.mentro.json`) — the authority for a
 *  directory's visibility + permission entries. Physically stored in
 *  the directory itself, so renames/moves carry metadata for free;
 *  the DB `groups`/`permissions(group)` design is replaced by this.
 *
 *  File shape (all fields optional):
 *  { "visibility": "internal" | "public",
 *    "permissions": [ { "subjectType": "user" | "user_group",
 *                        "subjectId": "…", "level": "read|write|deny" } ] }
 */

import fs from "node:fs";
import path from "node:path";

export interface DirPermissionEntry {
  subjectType: "user" | "user_group";
  subjectId: string;
  level: "read" | "write" | "deny";
}

export interface DirMeta {
  visibility: "internal" | "public";
  permissions: DirPermissionEntry[];
}

/** The pool root: every stored asset path is relative to this. */
export function poolRoot(): string {
  const dataDir = process.env.MENTRO_DATA ?? "./data";
  return process.env.MENTRO_POOL_DIR ?? path.join(dataDir, "pool");
}

/** Absolute path of a pool-relative asset/dir path ("" = pool root). */
export function poolAbs(rel: string): string {
  const normalized = rel.replace(/^\/+/, "");
  const abs = path.join(poolRoot(), normalized);
  if (abs !== poolRoot() && !abs.startsWith(poolRoot() + path.sep)) {
    throw new Error(`path escapes pool: ${rel}`);
  }
  return abs;
}

const EMPTY: DirMeta = { visibility: "internal", permissions: [] };

function parse(raw: string): DirMeta | null {
  try {
    const v = JSON.parse(raw) as {
      visibility?: unknown;
      permissions?: unknown;
    };
    const visibility =
      v.visibility === "public" ? ("public" as const) : ("internal" as const);
    const permissions = Array.isArray(v.permissions)
      ? v.permissions.flatMap((p): DirPermissionEntry[] => {
          if (typeof p !== "object" || p === null) return [];
          const e = p as Record<string, unknown>;
          if (
            (e.subjectType !== "user" && e.subjectType !== "user_group") ||
            typeof e.subjectId !== "string" ||
            (e.level !== "read" && e.level !== "write" && e.level !== "deny")
          ) {
            return [];
          }
          return [
            {
              subjectType: e.subjectType,
              subjectId: e.subjectId,
              level: e.level,
            },
          ];
        })
      : [];
    return { visibility, permissions };
  } catch {
    return null; // malformed JSON = no metadata
  }
}

// Cache keyed by directory relative path; a null value means "read,
// no .mentro.json". Cleared on any fs event (watch) or manual refresh.
const cache = new Map<string, DirMeta | null>();

export function invalidateDirMeta(): void {
  cache.clear();
}

/** Read one directory's .mentro.json (cached; missing/malformed =
 *  internal + no entries). */
export function readDirMeta(relDir: string): DirMeta {
  if (cache.has(relDir)) {
    return cache.get(relDir) ?? EMPTY;
  }
  let meta: DirMeta | null = null;
  try {
    const file = path.join(poolAbs(relDir), ".mentro.json");
    if (fs.existsSync(file)) {
      meta = parse(fs.readFileSync(file, "utf-8"));
    }
  } catch {
    meta = null;
  }
  cache.set(relDir, meta);
  return meta ?? EMPTY;
}

/** Write a directory's .mentro.json (atomic tmp+rename) and refresh
 *  the cache entry. */
export function writeDirMeta(relDir: string, meta: DirMeta): void {
  const abs = poolAbs(relDir);
  fs.mkdirSync(abs, { recursive: true });
  const file = path.join(abs, ".mentro.json");
  const tmp = path.join(abs, `.mentro.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2) + "\n");
  fs.renameSync(tmp, file);
  cache.set(relDir, meta);
}

/** Delete the .mentro.json of a directory (no-op when absent). */
export function clearDirMeta(relDir: string): void {
  try {
    fs.unlinkSync(path.join(poolAbs(relDir), ".mentro.json"));
  } catch {
    /* absent */
  }
  cache.delete(relDir);
}

/** Directory chain from the file's parent up to (and including) the
 *  pool root — nearest-first (index 0 = the file's own directory). */
export function dirChainOf(relPath: string): string[] {
  const parts = relPath.split("/").filter(Boolean);
  parts.pop(); // drop the file name
  const chain: string[] = [];
  for (let i = parts.length; i >= 0; i--) {
    chain.push(parts.slice(0, i).join("/"));
  }
  return chain;
}
