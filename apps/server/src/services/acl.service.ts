/**
 * Permission resolution (ACL): the single decision point for "which
 * assets can this user read/write".
 *
 * Model (directory-as-group era):
 * 1. Asset-level DB Permission entries decide first; user entries beat
 *    user-group entries, deny beats write beats read within a tier.
 * 2. No asset entry -> walk the DIRECTORY chain (file's dir -> pool
 *    root), reading each directory's .mentro.json; the NEAREST
 *    directory with a matching permission entry decides.
 * 3. No entry anywhere -> visibility: `public` on the asset OR in any
 *    directory's .mentro.json up the chain grants read to every
 *    signed-in user; otherwise internal (explicit grant needed).
 *    super_admin and admin see everything.
 *
 * Directory metadata physically lives in each directory (.mentro.json),
 * so renames/moves carry permissions for free — no DB rows to update.
 */

import { AppDataSource } from "../db/data-source";
import { Asset, Permission, UserGroupMember } from "../db/entities";
import type { AuthUser } from "../auth/tokens";
import {
  dirChainOf,
  poolRoot,
  readDirMeta,
  type DirPermissionEntry,
} from "../storage/pool-paths";

export type Readable = "all" | Set<string>;

interface Loaded {
  permissions: Permission[]; // asset-level DB entries only
  userGroupIds: Set<string>;
  assets: Array<{
    id: string;
    relPath: string; // pool-relative
    visibility: string;
    uploadedBy: string | null;
  }>;
}

async function load(user: AuthUser): Promise<Loaded> {
  const [permissions, memberships, assets] = await Promise.all([
    AppDataSource.getRepository(Permission).find(),
    AppDataSource.getRepository(UserGroupMember).find({
      where: { userId: user.id },
    }),
    AppDataSource.getRepository(Asset).find(),
  ]);
  return {
    permissions,
    userGroupIds: new Set(memberships.map((m) => m.groupId)),
    assets: assets.map((a) => ({
      id: a.id,
      relPath: a.path,
      visibility: a.visibility,
      uploadedBy: a.uploadedBy,
    })),
  };
}

/** Best level from entries targeting ONE subject-set at one target. */
function bestLevel(
  entries: DirPermissionEntry[],
  user: AuthUser,
  userGroupIds: Set<string>,
): "read" | "write" | "deny" | null {
  const userEntries = entries.filter(
    (p) => p.subjectType === "user" && p.subjectId === user.id,
  );
  if (userEntries.length > 0) {
    return strongest(userEntries.map((p) => p.level));
  }
  const groupEntries = entries.filter(
    (p) => p.subjectType === "user_group" && userGroupIds.has(p.subjectId),
  );
  if (groupEntries.length > 0) {
    return strongest(groupEntries.map((p) => p.level));
  }
  return null;
}

function strongest(levels: Array<"read" | "write" | "deny">) {
  if (levels.includes("deny")) return "deny";
  if (levels.includes("write")) return "write";
  return "read";
}

export interface Resolved {
  level: "none" | "read" | "write";
}

function resolveAsset(
  asset: Loaded["assets"][number],
  user: AuthUser,
  data: Loaded,
): Resolved {
  // Asset-level DB entries decide first.
  const assetLevel = bestDbLevel(
    data.permissions.filter(
      (p) => p.targetType === "asset" && p.targetId === asset.id,
    ),
    user,
    data.userGroupIds,
  );
  if (assetLevel) {
    return { level: assetLevel === "deny" ? "none" : assetLevel };
  }
  // Walk the directory chain nearest-first; the first directory whose
  // .mentro.json has a matching entry decides.
  for (const dir of dirChainOf(asset.relPath)) {
    const meta = readDirMeta(dir);
    const level = bestLevel(meta.permissions, user, data.userGroupIds);
    if (level) {
      return { level: level === "deny" ? "none" : level };
    }
  }
  // Visibility fallback: asset's own flag or any public ancestor dir.
  if (
    asset.visibility === "public" ||
    dirChainOf(asset.relPath).some(
      (d) => readDirMeta(d).visibility === "public",
    )
  ) {
    return { level: "read" };
  }
  return { level: "none" };
}

/** DB Permission rows use the same shape as dir entries via a mapper. */
function bestDbLevel(
  entries: Permission[],
  user: AuthUser,
  userGroupIds: Set<string>,
): "read" | "write" | "deny" | null {
  const mapped: DirPermissionEntry[] = entries.map((p) => ({
    subjectType: p.subjectType,
    subjectId: p.subjectId,
    level: p.level,
  }));
  return bestLevel(mapped, user, userGroupIds);
}

/** All readable asset ids for the user ("all" short-circuits admins). */
export async function readableAssetIds(user: AuthUser): Promise<Readable> {
  if (user.role === "super_admin" || user.role === "admin") return "all";
  const data = await load(user);
  const readable = new Set<string>();
  for (const asset of data.assets) {
    // Uploader always sees their own uploads.
    if (asset.uploadedBy === user.id) {
      readable.add(asset.id);
      continue;
    }
    if (resolveAsset(asset, user, data).level !== "none") {
      readable.add(asset.id);
    }
  }
  return readable;
}

export async function canRead(
  user: AuthUser,
  assetId: string,
): Promise<boolean> {
  const readable = await readableAssetIds(user);
  if (readable === "all") return true;
  return readable.has(assetId);
}

export async function canWrite(
  user: AuthUser,
  assetId: string,
): Promise<boolean> {
  if (user.role === "super_admin" || user.role === "admin") return true;
  const data = await load(user);
  const asset = data.assets.find((a) => a.id === assetId);
  if (!asset) return false;
  if (asset.uploadedBy === user.id) return true;
  return resolveAsset(asset, user, data).level === "write";
}

/** SQL fragment + params for "asset readable by user" inside WHERE. */
export async function readableFilter(
  user: AuthUser,
): Promise<{ sql: string; params: unknown[] } | null> {
  const readable = await readableAssetIds(user);
  if (readable === "all") return null;
  if (readable.size === 0) return { sql: "0", params: [] };
  return {
    sql: `cu.asset_id IN (${[...readable].map(() => "?").join(",")})`,
    params: [...readable],
  };
}

/** Re-exported for consumers that need the pool root. */
export { poolRoot };
