/** Library domain: the group tree IS the pool directory tree, the flat
 *  asset list (path-prefix directory filter), real file moves between
 *  directories, and asset deletion. Groups are never stored in the DB. */

import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import type { EntityManager } from "typeorm";
import { serializedTx } from "../db/tx";
import { Asset } from "../db/entities";
import {
  deleteAsset as deleteAssetRow,
  findAssetById,
  listAssets,
  saveAssets,
} from "../repositories/asset.repository";
import { deleteJobsOfAsset } from "../repositories/job.repository";
import {
  deleteTranslationEmbeddingsOfAsset,
  deleteTranslationsOfAsset,
} from "../repositories/translation.repository";
import { deleteUnitsOfAsset } from "../repositories/content-unit.repository";
import { ftsDeleteAsset, ftsDeleteTranslationsByAsset } from "../search/fts";
import { logRemoved, logUpserted, unitIdsOfAsset } from "../search/bundle";
import { publish } from "../lib/bus";
import { canWrite, readableAssetIds } from "./acl.service";
import { poolAbs, poolRoot, readDirMeta } from "../storage/pool-paths";
import type { AuthUser } from "../auth/tokens";
import { ServiceError } from "../lib/errors";

export interface GroupNode {
  /** Pool-relative directory path ("" = pool root). */
  id: string;
  name: string;
  parentId: string | null;
  fileCount: number;
  visibility: "internal" | "public";
  children: GroupNode[];
}

/** Recursively enumerate pool directories (including empty ones; dot
 *  dirs are metadata, not groups). */
async function walkDirs(rel: string, out: string[]): Promise<void> {
  const abs = poolAbs(rel);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    out.push(childRel);
    await walkDirs(childRel, out);
  }
}

/** Directory tree with ACL-visible file counts. Root files = ungrouped. */
export async function groupTree(user: AuthUser): Promise<{
  groups: GroupNode[];
  ungrouped: number;
}> {
  const readable = await readableAssetIds(user);
  const [assets, dirList] = await Promise.all([
    (await import("../db/data-source")).AppDataSource.getRepository(Asset).find(
      { select: { id: true, path: true } },
    ),
    (async () => {
      const out: string[] = [];
      await walkDirs("", out);
      return out;
    })(),
  ]);

  // Count visible assets per directory (asset's full parent path).
  const countByDir = new Map<string, number>();
  let rootCount = 0;
  for (const a of assets) {
    if (readable !== "all" && !readable.has(a.id)) continue;
    const parts = a.path.split("/");
    if (parts.length > 1) {
      const dir = parts.slice(0, -1).join("/");
      countByDir.set(dir, (countByDir.get(dir) ?? 0) + 1);
    } else {
      rootCount++;
    }
  }

  const nodes = new Map<string, GroupNode>();
  for (const d of dirList) {
    const parts = d.split("/");
    const name = parts[parts.length - 1]!;
    nodes.set(d, {
      id: d,
      name,
      parentId: parts.length > 1 ? parts.slice(0, -1).join("/") : null,
      fileCount: countByDir.get(d) ?? 0,
      visibility: readDirMeta(d).visibility,
      children: [],
    });
  }
  const roots: GroupNode[] = [];
  for (const node of nodes.values()) {
    if (node.parentId !== null && nodes.has(node.parentId)) {
      nodes.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  roots.sort((a, b) => a.name.localeCompare(b.name));
  return { groups: roots, ungrouped: rootCount };
}

/** Create a directory (group). */
export async function createGroup(
  name: string,
  parentId?: string,
): Promise<{ id: string; name: string }> {
  if (!name?.trim()) throw new ServiceError(400, "name required");
  const rel = parentId ? `${parentId}/${name.trim()}` : name.trim();
  try {
    await fs.mkdir(poolAbs(rel), { recursive: true });
  } catch (err) {
    throw new ServiceError(400, String(err));
  }
  return { id: rel, name: name.trim() };
}

/** Rename a directory: mv + rewrite asset paths + re-log units. */
export async function updateGroup(
  id: string,
  patch: { name?: string },
): Promise<{ id: string; name: string }> {
  if (!patch.name?.trim()) throw new ServiceError(400, "name required");
  const parts = id.split("/");
  const oldName = parts[parts.length - 1]!;
  const newName = patch.name.trim();
  if (oldName === newName) return { id, name: newName };
  const parent = parts.slice(0, -1).join("/");
  const newId = parent ? `${parent}/${newName}` : newName;
  try {
    await fs.rename(poolAbs(id), poolAbs(newId));
  } catch (err) {
    throw new ServiceError(400, String(err));
  }
  await rewriteAssetPaths(id, newId);
  return { id: newId, name: newName };
}

async function rewriteAssetPaths(
  oldPrefix: string,
  newPrefix: string,
): Promise<void> {
  const repo = (await import("../db/data-source")).AppDataSource.getRepository(
    Asset,
  );
  const affected = await repo
    .createQueryBuilder("a")
    .where("a.path LIKE :p", { p: `${oldPrefix}/%` })
    .getMany();
  for (const a of affected) {
    a.path = a.path.replace(`${oldPrefix}/`, `${newPrefix}/`);
  }
  if (affected.length > 0) {
    await repo.save(affected);
    const unitIds = (
      await Promise.all(affected.map((a) => unitIdsOfAsset(a.id)))
    ).flat();
    await logUpserted(unitIds);
  }
  publish({ event: "index.changed" });
}

/** Remove an EMPTY directory (groups are real dirs; non-empty refuses). */
export async function removeGroup(id: string): Promise<void> {
  const abs = poolAbs(id);
  let entries: string[];
  try {
    entries = await fs.readdir(abs);
  } catch {
    throw new ServiceError(404, "not found");
  }
  const visible = entries.filter((e) => !e.startsWith("."));
  if (visible.length > 0) {
    throw new ServiceError(409, "group not empty");
  }
  await fs.rm(abs, { recursive: true });
}

export interface ListLibraryOptions {
  groupId?: string;
  kind?: string;
  q?: string;
  sort?: string;
  sortDir?: string;
  page: number;
  pageSize: number;
}

/** Flat file list, ACL-filtered, with the uploadedAt backfill. */
export async function listLibrary(
  user: AuthUser,
  opts: ListLibraryOptions,
): Promise<{
  total: number;
  page: number;
  pageSize: number;
  assets: Asset[];
}> {
  const readable = await readableAssetIds(user);
  const sort =
    opts.sort === "mtime"
      ? "mtime"
      : opts.sort === "size"
        ? "size"
        : opts.sort === "name"
          ? "name"
          : "uploaded";
  const { items, total } = await listAssets({
    readableIds: readable === "all" ? undefined : [...readable],
    groupId: opts.groupId,
    kind: opts.kind,
    q: opts.q,
    sort,
    sortDir: opts.sortDir === "asc" ? "asc" : "desc",
    page: opts.page,
    pageSize: opts.pageSize,
  });

  const toBackfill = items.filter(
    (a) => a.uploadedAt === null && a.extractedAt !== null,
  );
  if (toBackfill.length > 0) {
    for (const a of toBackfill) a.uploadedAt = a.extractedAt;
    void saveAssets(toBackfill).catch(() => undefined);
  }
  return { total, page: opts.page, pageSize: opts.pageSize, assets: items };
}

/** Move an asset file to another pool directory (real mv). */
export async function moveAssetToGroup(
  user: AuthUser,
  assetId: string,
  groupId: string | null,
): Promise<void> {
  if (!(await canWrite(user, assetId))) {
    throw new ServiceError(403, "no write permission");
  }
  const asset = await findAssetById(assetId);
  if (!asset) throw new ServiceError(404, "not found");
  const name = asset.path.split("/").pop()!;
  const newRel = groupId ? `${groupId}/${name}` : name;
  const oldAbs = poolAbs(asset.path);
  const newAbs = poolAbs(newRel);
  if (oldAbs === newAbs) return;
  try {
    await fs.mkdir(path.dirname(newAbs), { recursive: true });
    await fs.rename(oldAbs, newAbs);
  } catch (err) {
    throw new ServiceError(400, String(err));
  }
  asset.path = newRel;
  await saveAssets([asset]);
  await logUpserted(await unitIdsOfAsset(asset.id));
  publish({ event: "index.changed" });
}

/** Delete an asset: index + translations + disk file. */
export async function deleteAssetCompletely(
  user: AuthUser,
  assetId: string,
): Promise<void> {
  const asset = await findAssetById(assetId);
  if (!asset) throw new ServiceError(404, "not found");
  const isOwner = asset.uploadedBy === user.id;
  const isAdmin = user.role === "super_admin" || user.role === "admin";
  if (!isOwner && !isAdmin) throw new ServiceError(403, "not your file");

  await serializedTx(async (m) => purgeAsset(asset.id, m));
  try {
    await fs.unlink(poolAbs(asset.path));
  } catch {
    /* file may already be gone */
  }
  publish({ event: "index.changed" });
}

/** Row-level cascade shared with the scan prune path. */
export async function purgeAsset(
  assetId: string,
  m: EntityManager,
): Promise<void> {
  await ftsDeleteAsset(assetId, m);
  await ftsDeleteTranslationsByAsset(assetId, m);
  await logRemoved(await unitIdsOfAsset(assetId, m), m);
  await deleteTranslationsOfAsset(assetId, m);
  await deleteTranslationEmbeddingsOfAsset(assetId, m);
  await deleteUnitsOfAsset(assetId, m);
  await deleteJobsOfAsset(assetId, m);
  await deleteAssetRow(assetId, m);
}

export { poolRoot };
