/**
 * Permission resolution (ACL): the single decision point for "which
 * assets can this user read/write".
 *
 * Model (matches the Permission entity doc):
 * 1. Asset-level ACL entries decide first; user entries beat user-group
 *    entries, deny beats write beats read within a subject tier.
 * 2. No asset entry -> walk the folder chain (asset's group -> parents);
 *    the NEAREST folder with a matching entry decides.
 * 3. No entry anywhere -> visibility: `public` on the asset OR any
 *    ancestor folder grants read to every signed-in user; `internal`
 *    needs an explicit grant. super_admin sees everything.
 *
 * Load-per-request (no cache): the tables are tiny at corpus scale and
 * SQLite is local — milliseconds. Revisit when assets reach six figures.
 */

import { AppDataSource } from "../db/data-source";
import { Asset, Group, Permission, UserGroupMember } from "../db/entities";
import type { AuthUser } from "./tokens";

export type Readable = "all" | Set<string>;

interface Loaded {
  permissions: Permission[];
  userGroupIds: Set<string>;
  parentOf: Map<string, string | null>; // groupId -> parentId
  visibilityOfGroup: Map<string, string>;
  assets: Array<{
    id: string;
    groupId: string | null;
    visibility: string;
    uploadedBy: string | null;
  }>;
}

async function load(user: AuthUser): Promise<Loaded> {
  const [permissions, memberships, groups, assets] = await Promise.all([
    AppDataSource.getRepository(Permission).find(),
    AppDataSource.getRepository(UserGroupMember).find({
      where: { userId: user.id },
    }),
    AppDataSource.getRepository(Group).find(),
    AppDataSource.getRepository(Asset).find(),
  ]);
  return {
    permissions,
    userGroupIds: new Set(memberships.map((m) => m.groupId)),
    parentOf: new Map(groups.map((g) => [g.id, g.parentId])),
    visibilityOfGroup: new Map(groups.map((g) => [g.id, g.visibility])),
    assets: assets.map((a) => ({
      id: a.id,
      groupId: a.groupId,
      visibility: a.visibility,
      uploadedBy: a.uploadedBy,
    })),
  };
}

/** Best level from entries targeting ONE subject-set at one target. */
function bestLevel(
  entries: Permission[],
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

/** Folder chain from the given group up to the root (inclusive). */
function chainOf(
  groupId: string | null,
  parentOf: Map<string, string | null>,
): string[] {
  const chain: string[] = [];
  let cur = groupId;
  let guard = 0;
  while (cur && guard++ < 64) {
    chain.push(cur);
    cur = parentOf.get(cur) ?? null;
  }
  return chain;
}

/** Nearest-folder visibility: any `public` ancestor makes it public. */
function publicByFolder(
  groupId: string | null,
  parentOf: Map<string, string | null>,
  visibilityOfGroup: Map<string, string>,
): boolean {
  return chainOf(groupId, parentOf).some(
    (g) => visibilityOfGroup.get(g) === "public",
  );
}

export interface Resolved {
  level: "none" | "read" | "write";
}

function resolveAsset(
  asset: Loaded["assets"][number],
  user: AuthUser,
  data: Loaded,
): Resolved {
  // Asset-level entries decide first.
  const assetLevel = bestLevel(
    data.permissions.filter(
      (p) => p.targetType === "asset" && p.targetId === asset.id,
    ),
    user,
    data.userGroupIds,
  );
  if (assetLevel) {
    return { level: assetLevel === "deny" ? "none" : assetLevel };
  }
  // Walk folders nearest-first; first folder with an entry decides.
  for (const folder of chainOf(asset.groupId, data.parentOf)) {
    const level = bestLevel(
      data.permissions.filter(
        (p) => p.targetType === "group" && p.targetId === folder,
      ),
      user,
      data.userGroupIds,
    );
    if (level) {
      return { level: level === "deny" ? "none" : level };
    }
  }
  // Visibility fallback (asset's own flag or any public ancestor).
  if (
    asset.visibility === "public" ||
    publicByFolder(asset.groupId, data.parentOf, data.visibilityOfGroup)
  ) {
    return { level: "read" };
  }
  return { level: "none" };
}

/** All readable asset ids for the user ("all" short-circuits admins). */
export async function readableAssetIds(user: AuthUser): Promise<Readable> {
  if (user.role === "super_admin") return "all";
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
  if (user.role === "super_admin") return true;
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
