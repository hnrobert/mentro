/** Admin domain: user management, user groups, ACL permission entries,
 *  visibility flags, and settings/translation control. Pure logic —
 *  guards (auth + admin) stay on the routes. */

import { ulid } from "ulid";
import { Permission, User, UserGroup } from "../db/entities";
import { hashPassword } from "../auth/password";
import { revokeAllSessions } from "../auth/tokens";
import {
  deleteUser,
  findUserById,
  findUserByName,
  findUsers,
  saveUser,
  userGroupMemberRepo,
  userGroupRepo,
  findUserGroupById,
  findUserGroupByName,
  findGroupMembers,
  deletePermission,
  deletePermissionsOfSubject,
  findPermissionByKey,
  findPermissionsOfTarget,
  savePermission,
} from "../repositories/misc.repository";
import { findAssetById, saveAssets } from "../repositories/asset.repository";
import {
  readDirMeta,
  writeDirMeta,
  type DirPermissionEntry,
} from "../storage/pool-paths";
import { ServiceError } from "../lib/errors";

const USERNAME_RE = /^[A-Za-z0-9_-]{3,32}$/;

// --- users -----------------------------------------------------------------

export async function listUsers(): Promise<User[]> {
  return findUsers();
}

export async function updateUser(
  id: string,
  patch: { username?: string; enabled?: boolean; role?: string },
  actorId?: string,
): Promise<{ id: string; username: string; enabled: boolean; role: string }> {
  const user = await findUserById(id);
  if (!user) throw new ServiceError(404, "not found");
  if (patch.username !== undefined) {
    if (!USERNAME_RE.test(patch.username)) {
      throw new ServiceError(400, "invalid username");
    }
    if (
      patch.username !== user.username &&
      (await findUserByName(patch.username))
    ) {
      throw new ServiceError(409, "username taken");
    }
    user.username = patch.username;
  }
  if (patch.enabled !== undefined) {
    // The super_admin account cannot be disabled.
    if (user.role === "super_admin" && !patch.enabled) {
      throw new ServiceError(400, "cannot disable super_admin");
    }
    user.enabled = patch.enabled;
    if (!patch.enabled) await revokeAllSessions(user.id);
  }
  if (patch.role !== undefined) {
    // Only super_admin reaches this service path (adminGuard); they may
    // now grant super_admin too. Guards: no self-demotion, and the
    // last super_admin cannot be demoted.
    if (
      patch.role !== "user" &&
      patch.role !== "admin" &&
      patch.role !== "super_admin"
    ) {
      throw new ServiceError(400, "role must be user|admin|super_admin");
    }
    if (user.role === "super_admin" && patch.role !== "super_admin") {
      if (user.id === actorId) {
        throw new ServiceError(400, "cannot demote yourself");
      }
      const superCount = await (
        await import("../repositories/misc.repository")
      )
        .userRepo()
        .countBy({ role: "super_admin" });
      if (superCount <= 1) {
        throw new ServiceError(400, "cannot demote the last super_admin");
      }
    }
    user.role = patch.role;
    // No session revocation: verifyAccessToken reads role/username from
    // the DB on every request, so the change applies immediately.
  }
  await saveUser(user);
  return {
    id: user.id,
    username: user.username,
    enabled: user.enabled,
    role: user.role,
  };
}

export async function resetUserPassword(id: string, newPassword: string) {
  if (typeof newPassword !== "string" || newPassword.length < 8) {
    throw new ServiceError(400, "password must be >= 8 chars");
  }
  const user = await findUserById(id);
  if (!user) throw new ServiceError(404, "not found");
  user.passwordHash = await hashPassword(newPassword);
  await saveUser(user);
  await revokeAllSessions(user.id);
}

export async function removeUser(actorId: string, id: string): Promise<void> {
  if (id === actorId) throw new ServiceError(400, "cannot delete yourself");
  const user = await findUserById(id);
  if (!user) throw new ServiceError(404, "not found");
  await revokeAllSessions(user.id);
  await deleteUser(user.id);
}

// --- user groups (ACL subjects) ---------------------------------------------

export async function listUserGroups() {
  const groups = await userGroupRepo().find({ order: { name: "ASC" } });
  const members = await findGroupMembers();
  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    memberIds: members.filter((m) => m.groupId === g.id).map((m) => m.userId),
  }));
}

export async function createUserGroup(name: string): Promise<UserGroup> {
  if (!name?.trim()) throw new ServiceError(400, "name required");
  if (await findUserGroupByName(name)) {
    throw new ServiceError(409, "name already exists");
  }
  return userGroupRepo().save({ id: ulid(), name });
}

export async function updateUserGroup(
  id: string,
  patch: { name?: string; memberIds?: string[] },
): Promise<UserGroup> {
  const group = await findUserGroupById(id);
  if (!group) throw new ServiceError(404, "not found");
  if (typeof patch.name === "string" && patch.name.trim()) {
    group.name = patch.name.trim();
  }
  await userGroupRepo().save(group);
  if (Array.isArray(patch.memberIds)) {
    const memberRepo = userGroupMemberRepo();
    await memberRepo.delete({ groupId: group.id });
    if (patch.memberIds.length > 0) {
      await memberRepo.insert(
        patch.memberIds.map((userId) => ({ userId, groupId: group.id })),
      );
    }
  }
  return group;
}

export async function removeUserGroup(id: string): Promise<void> {
  const group = await findUserGroupById(id);
  if (!group) throw new ServiceError(404, "not found");
  await userGroupMemberRepo().delete({ groupId: group.id });
  // Deny-by-default: entries referencing the group become inert.
  await deletePermissionsOfSubject("user_group", group.id);
  await userGroupRepo().delete({ id: group.id });
}

// --- permissions (ACL entries) ----------------------------------------------

export async function listPermissions(
  targetType: "dir" | "asset",
  targetId: string,
) {
  const entries: Array<{
    id: string;
    subjectType: "user" | "user_group";
    subjectId: string;
    level: "read" | "write" | "deny";
  }> =
    targetType === "dir"
      ? readDirMeta(targetId).permissions.map((p, i) => ({
          id: `dir:${i}`,
          ...p,
        }))
      : await findPermissionsOfTarget(targetType, targetId);
  const users = await findUsers();
  const userGroups = await userGroupRepo().find();
  const nameOf = (subjectType: string, subjectId: string): string | null => {
    if (subjectType === "user") {
      return users.find((u) => u.id === subjectId)?.username ?? null;
    }
    return userGroups.find((g) => g.id === subjectId)?.name ?? null;
  };
  return entries.map((e) => ({
    ...e,
    subjectName: nameOf(e.subjectType, e.subjectId),
  }));
}

export async function putPermission(body: {
  subjectType: string;
  subjectId: string;
  targetType: string;
  targetId: string;
  level: string | null;
}): Promise<{
  entry?: { id: string } & DirPermissionEntry;
  removed?: boolean;
}> {
  const { subjectType, subjectId, targetType, targetId, level } = body;
  if (
    (subjectType !== "user" && subjectType !== "user_group") ||
    !subjectId ||
    (targetType !== "dir" && targetType !== "asset") ||
    !targetId
  ) {
    throw new ServiceError(400, "invalid subject/target");
  }
  // Directory permissions live in .mentro.json inside the directory.
  if (targetType === "dir") {
    const meta = readDirMeta(targetId);
    const list = meta.permissions.filter(
      (p) => !(p.subjectType === subjectType && p.subjectId === subjectId),
    );
    if (level === null || level === undefined) {
      writeDirMeta(targetId, { ...meta, permissions: list });
      return { removed: true };
    }
    if (level !== "read" && level !== "write" && level !== "deny") {
      throw new ServiceError(400, "level read|write|deny|null");
    }
    const entry: DirPermissionEntry = {
      subjectType: subjectType as "user" | "user_group",
      subjectId,
      level,
    };
    list.push(entry);
    writeDirMeta(targetId, { ...meta, permissions: list });
    return { entry: { id: `dir:${list.length - 1}`, ...entry } };
  }
  // Asset-level permissions stay in the DB.
  const existing = await findPermissionByKey(
    subjectType,
    subjectId,
    targetType,
    targetId,
  );
  if (level === null || level === undefined) {
    if (existing) await deletePermission(existing.id);
    return { removed: true };
  }
  if (level !== "read" && level !== "write" && level !== "deny") {
    throw new ServiceError(400, "level read|write|deny|null");
  }
  if (existing) {
    existing.level = level as "read" | "write" | "deny";
    const saved = await savePermission(existing);
    return { entry: { id: saved.id, ...body2entry(saved) } };
  }
  const saved = await savePermission({
    id: ulid(),
    subjectType,
    subjectId,
    targetType,
    targetId,
    level,
  } as Permission);
  return { entry: { id: saved.id, ...body2entry(saved) } };
}

function body2entry(p: Permission): DirPermissionEntry {
  return {
    subjectType: p.subjectType,
    subjectId: p.subjectId,
    level: p.level,
  };
}

// --- visibility (public/internal) -------------------------------------------

export async function setVisibility(
  targetType: "dir" | "asset",
  targetId: string,
  visibility: "internal" | "public",
): Promise<void> {
  if (targetType === "dir") {
    const meta = readDirMeta(targetId);
    writeDirMeta(targetId, { ...meta, visibility });
  } else {
    const asset = await findAssetById(targetId);
    if (!asset) throw new ServiceError(404, "asset not found");
    asset.visibility = visibility;
    await saveAssets([asset]);
  }
}
