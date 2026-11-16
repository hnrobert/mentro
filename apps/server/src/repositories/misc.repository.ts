import { AppDataSource } from "../db/data-source";
import {
  Permission,
  Setting,
  Source,
  User,
  UserGroup,
  UserGroupMember,
} from "../db/entities";
import type { EntityManager } from "typeorm";

/** Small aggregates (users, sessions, groups of users, permissions,
 *  sources, settings) — one repository file keeps the layer tidy
 *  without one-file-per-triviality churn. */

type Q = EntityManager;

function em(m?: Q): Q {
  return m ?? AppDataSource.manager;
}

// --- users -----------------------------------------------------------------

export function userRepo(m?: Q) {
  return em(m).getRepository(User);
}

export async function findUsers(m?: Q): Promise<User[]> {
  return userRepo(m).find({ order: { createdAt: "ASC" } });
}

export async function findUserById(id: string, m?: Q): Promise<User | null> {
  return userRepo(m).findOneBy({ id });
}

export async function findUserByName(
  username: string,
  m?: Q,
): Promise<User | null> {
  return userRepo(m).findOneBy({ username });
}

export async function countUsers(m?: Q): Promise<number> {
  return userRepo(m).count();
}

export async function saveUser(user: User, m?: Q): Promise<User> {
  return userRepo(m).save(user);
}

export async function deleteUser(id: string, m?: Q): Promise<void> {
  await userRepo(m).delete({ id });
}

// --- user groups -----------------------------------------------------------

export function userGroupRepo(m?: Q) {
  return em(m).getRepository(UserGroup);
}

export function userGroupMemberRepo(m?: Q) {
  return em(m).getRepository(UserGroupMember);
}

export async function findUserGroups(m?: Q): Promise<UserGroup[]> {
  return userGroupRepo(m).find({ order: { name: "ASC" } });
}

export async function findUserGroupById(
  id: string,
  m?: Q,
): Promise<UserGroup | null> {
  return userGroupRepo(m).findOneBy({ id });
}

export async function findUserGroupByName(
  name: string,
  m?: Q,
): Promise<UserGroup | null> {
  return userGroupRepo(m).findOneBy({ name });
}

export async function findGroupMembers(m?: Q): Promise<UserGroupMember[]> {
  return userGroupMemberRepo(m).find();
}

export async function findGroupsOfUser(
  userId: string,
  m?: Q,
): Promise<UserGroupMember[]> {
  return userGroupMemberRepo(m).findBy({ userId });
}

// --- permissions -----------------------------------------------------------

export function permissionRepo(m?: Q) {
  return em(m).getRepository(Permission);
}

export async function findPermissions(m?: Q): Promise<Permission[]> {
  return permissionRepo(m).find({ order: { createdAt: "ASC" } });
}

export async function findPermissionsOfSubject(
  subjectType: "user" | "user_group",
  subjectId: string,
  m?: Q,
): Promise<Permission[]> {
  return permissionRepo(m).findBy({ subjectType, subjectId });
}

export async function savePermission(
  p: Permission,
  m?: Q,
): Promise<Permission> {
  return permissionRepo(m).save(p);
}

export async function findPermissionByKey(
  subjectType: "user" | "user_group",
  subjectId: string,
  targetType: "group" | "asset",
  targetId: string,
  m?: Q,
): Promise<Permission | null> {
  return permissionRepo(m).findOneBy({
    subjectType,
    subjectId,
    targetType,
    targetId,
  });
}

export async function deletePermissionsOfSubject(
  subjectType: "user" | "user_group",
  subjectId: string,
  m?: Q,
): Promise<void> {
  await permissionRepo(m).delete({ subjectType, subjectId });
}

export async function findPermissionsOfTarget(
  targetType: "group" | "asset",
  targetId: string,
  m?: Q,
): Promise<Permission[]> {
  return permissionRepo(m).find({
    where: { targetType, targetId },
    order: { createdAt: "ASC" },
  });
}

export async function deletePermission(id: string, m?: Q): Promise<void> {
  await permissionRepo(m).delete({ id });
}

// --- sources ---------------------------------------------------------------

export function sourceRepo(m?: Q) {
  return em(m).getRepository(Source);
}

export async function findSources(m?: Q): Promise<Source[]> {
  return sourceRepo(m).find({ order: { addedAt: "ASC" } });
}

export async function findSourceById(
  id: string,
  m?: Q,
): Promise<Source | null> {
  return sourceRepo(m).findOneBy({ id });
}

export async function findSourceByRootPath(
  rootPath: string,
  m?: Q,
): Promise<Source | null> {
  return sourceRepo(m).findOneBy({ rootPath });
}

export async function saveSource(source: Source, m?: Q): Promise<Source> {
  return sourceRepo(m).save(source);
}

export async function deleteSource(id: string, m?: Q): Promise<void> {
  await sourceRepo(m).delete({ id });
}

// --- settings --------------------------------------------------------------

export function settingRepo(m?: Q) {
  return em(m).getRepository(Setting);
}

export async function findSettings(m?: Q): Promise<Setting[]> {
  return settingRepo(m).find();
}

export async function upsertSetting(
  key: string,
  value: string,
  m?: Q,
): Promise<void> {
  await settingRepo(m).upsert({ key, value }, ["key"]);
}
