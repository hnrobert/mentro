/** Library domain: group tree with per-user visible counts, group
 *  CRUD validation, the flat asset list, asset move, and asset
 *  deletion (index + translations + disk). Routes stay thin; ACL
 *  decisions come in as resolved readable sets. */

import fs from "node:fs/promises";
import path from "node:path";
import { ulid } from "ulid";
import type { EntityManager } from "typeorm";
import { serializedTx } from "../db/tx";
import { Asset, Group } from "../db/entities";
import {
  assetGroupProjection,
  countAssetsInGroup,
  deleteAsset as deleteAssetRow,
  findAssetById,
  listAssets,
  saveAssets,
  setAssetGroup,
} from "../repositories/asset.repository";
import {
  countChildGroups,
  deleteGroup,
  findGroupById,
  groupRepo,
  saveGroup,
} from "../repositories/group.repository";
import { deleteJobsOfAsset } from "../repositories/job.repository";
import {
  deleteTranslationEmbeddingsOfAsset,
  deleteTranslationsOfAsset,
} from "../repositories/translation.repository";
import { deleteUnitsOfAsset } from "../repositories/content-unit.repository";
import { ftsDeleteAsset, ftsDeleteTranslationsByAsset } from "../search/fts";
import { logRemoved, logUpserted, unitIdsOfAsset } from "../indexbundle";
import { publish } from "../bus";
import { canWrite, readableAssetIds } from "./acl.service";
import type { AuthUser } from "../auth/tokens";
import { ServiceError } from "./errors";

export interface GroupNode {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
  fileCount: number;
  visibility: "internal" | "public";
  children: GroupNode[];
}

/** Group tree with ACL-visible file counts (admins keep raw counts). */
export async function groupTree(user: AuthUser): Promise<{
  groups: GroupNode[];
  ungrouped: number;
}> {
  const readable = await readableAssetIds(user);
  const [groups, assets] = await Promise.all([
    groupRepo().find({ order: { sortOrder: "ASC", name: "ASC" } }),
    assetGroupProjection(),
  ]);
  const visibleByGroup = new Map<string | null, number>();
  for (const a of assets) {
    if (readable === "all" || readable.has(a.id)) {
      visibleByGroup.set(a.groupId, (visibleByGroup.get(a.groupId) ?? 0) + 1);
    }
  }
  const nodes = new Map<string, GroupNode>();
  for (const g of groups) {
    nodes.set(g.id, {
      id: g.id,
      name: g.name,
      parentId: g.parentId,
      sortOrder: g.sortOrder,
      fileCount: visibleByGroup.get(g.id) ?? 0,
      visibility: g.visibility,
      children: [],
    });
  }
  const roots: GroupNode[] = [];
  for (const node of nodes.values()) {
    if (node.parentId && nodes.has(node.parentId)) {
      nodes.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return { groups: roots, ungrouped: visibleByGroup.get(null) ?? 0 };
}

export async function createGroup(
  name: string,
  parentId?: string | null,
): Promise<Group> {
  if (!name?.trim()) throw new ServiceError(400, "name required");
  if (parentId) {
    const parent = await findGroupById(parentId);
    if (!parent) throw new ServiceError(404, "parent not found");
  }
  return saveGroup({
    id: ulid(),
    name: name.trim(),
    parentId: parentId ?? null,
  } as Group);
}

export async function updateGroup(
  id: string,
  patch: { name?: string; parentId?: string | null; sortOrder?: number },
): Promise<Group> {
  const group = await findGroupById(id);
  if (!group) throw new ServiceError(404, "not found");
  if (patch.name !== undefined) group.name = patch.name.trim();
  if (patch.sortOrder !== undefined) group.sortOrder = patch.sortOrder;
  if (patch.parentId !== undefined) {
    if (patch.parentId === id) {
      throw new ServiceError(400, "cannot be its own parent");
    }
    group.parentId = patch.parentId;
  }
  return saveGroup(group);
}

export async function removeGroup(id: string): Promise<void> {
  const group = await findGroupById(id);
  if (!group) throw new ServiceError(404, "not found");
  const files = await countAssetsInGroup(group.id);
  const children = await countChildGroups(group.id);
  if (files > 0 || children > 0) {
    throw new ServiceError(409, "group not empty");
  }
  await deleteGroup(group.id);
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
): Promise<{ total: number; page: number; pageSize: number; assets: Asset[] }> {
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

  // Backfill: assets indexed before the uploaded_at column existed have
  // it null. Set it to extracted_at (first-index time) on first read.
  const toBackfill = items.filter(
    (a) => a.uploadedAt === null && a.extractedAt !== null,
  );
  if (toBackfill.length > 0) {
    for (const a of toBackfill) a.uploadedAt = a.extractedAt;
    // Fire-and-forget write; the response already has the correct value.
    void saveAssets(toBackfill).catch(() => undefined);
  }
  return { total, page: opts.page, pageSize: opts.pageSize, assets: items };
}

/** Move an asset to a group (admin or asset write). */
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
  if (groupId) {
    const group = await findGroupById(groupId);
    if (!group) throw new ServiceError(404, "group not found");
  }
  await setAssetGroup(asset.id, groupId ?? null);
  // The search bundle carries groupId — re-log the asset's units so
  // deltas propagate the move to browsers.
  await logUpserted(await unitIdsOfAsset(asset.id));
  publish({ event: "index.changed" });
}

/** Delete an asset: index + translations + disk file, uniformly
 *  (uploaded or mounted). Own uploads only unless super_admin. */
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
  // Remove the disk file.
  try {
    if (
      asset.path.startsWith(
        path.join(process.env.MENTRO_DATA ?? "./data", "pool"),
      )
    ) {
      await fs.unlink(asset.path);
    }
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
  // Translations FTS rows resolve unit ids through content_units —
  // delete BEFORE the units themselves go.
  await ftsDeleteTranslationsByAsset(assetId, m);
  await logRemoved(await unitIdsOfAsset(assetId, m), m);
  await deleteTranslationsOfAsset(assetId, m);
  await deleteTranslationEmbeddingsOfAsset(assetId, m);
  await deleteUnitsOfAsset(assetId, m);
  await deleteJobsOfAsset(assetId, m);
  await deleteAssetRow(assetId, m);
}
