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
import { findGroupById, saveGroup } from "../repositories/group.repository";
import { ServiceError } from "./errors";

const USERNAME_RE = /^[A-Za-z0-9_-]{3,32}$/;

// --- users -----------------------------------------------------------------

export async function listUsers(): Promise<User[]> {
  return findUsers();
}

export async function updateUser(
  id: string,
  patch: { username?: string; enabled?: boolean; role?: string },
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
    // Only super_admin reaches this service path (adminGuard); the
    // super_admin role itself is fixed at bootstrap and immutable.
    if (patch.role !== "user" && patch.role !== "admin") {
      throw new ServiceError(400, "role must be user|admin");
    }
    if (user.role === "super_admin") {
      throw new ServiceError(400, "cannot change super_admin role");
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
  targetType: "group" | "asset",
  targetId: string,
) {
  const entries = await findPermissionsOfTarget(targetType, targetId);
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
}): Promise<{ entry?: Permission; removed?: boolean }> {
  const { subjectType, subjectId, targetType, targetId, level } = body;
  if (
    (subjectType !== "user" && subjectType !== "user_group") ||
    !subjectId ||
    (targetType !== "group" && targetType !== "asset") ||
    !targetId
  ) {
    throw new ServiceError(400, "invalid subject/target");
  }
  const existing = await findPermissionByKey(
    subjectType,
    subjectId,
    targetType,
    targetId,
  );
  // level=null removes the entry (falls back to inheritance).
  if (level === null || level === undefined) {
    if (existing) await deletePermission(existing.id);
    return { removed: true };
  }
  if (level !== "read" && level !== "write" && level !== "deny") {
    throw new ServiceError(400, "level read|write|deny|null");
  }
  if (existing) {
    existing.level = level;
    return { entry: await savePermission(existing) };
  }
  return {
    entry: await savePermission({
      id: ulid(),
      subjectType,
      subjectId,
      targetType,
      targetId,
      level,
    } as Permission),
  };
}

// --- visibility (public/internal) -------------------------------------------

export async function setVisibility(
  targetType: "group" | "asset",
  targetId: string,
  visibility: "internal" | "public",
): Promise<void> {
  if (targetType === "group") {
    const group = await findGroupById(targetId);
    if (!group) throw new ServiceError(404, "group not found");
    group.visibility = visibility;
    await saveGroup(group);
  } else {
    const asset = await findAssetById(targetId);
    if (!asset) throw new ServiceError(404, "asset not found");
    asset.visibility = visibility;
    await saveAssets([asset]);
  }
}
