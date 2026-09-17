import type { FastifyInstance } from "fastify";
import { ulid } from "ulid";
import { AppDataSource } from "../db/data-source";
import {
  User,
  Asset,
  Group,
  Permission,
  UserGroup,
  UserGroupMember,
} from "../db/entities";
import { getSettings, updateSettings } from "../settings";
import { adminGuard, authGuard } from "../auth/guards";
import { hashPassword } from "../auth/password";
import { revokeAllSessions } from "../auth/tokens";

const USERNAME_RE = /^[A-Za-z0-9_-]{3,32}$/;

export function registerAdminRoutes(
  app: FastifyInstance,
  deps: { jwtSecret: Uint8Array },
) {
  const guarded = { preHandler: [authGuard(deps), adminGuard()] };

  app.get("/api/admin/users", guarded, async () => {
    const users = await AppDataSource.getRepository(User).find({
      order: { createdAt: "ASC" },
    });
    return {
      users: users.map((u) => ({
        id: u.id,
        username: u.username,
        role: u.role,
        enabled: u.enabled,
        createdAt: u.createdAt,
        lastLoginAt: u.lastLoginAt,
      })),
    };
  });

  app.patch<{
    Params: { id: string };
    Body: { username?: string; enabled?: boolean };
  }>("/api/admin/users/:id", guarded, async (request, reply) => {
    const repo = AppDataSource.getRepository(User);
    const user = await repo.findOneBy({ id: request.params.id });
    if (!user) return reply.code(404).send({ error: "not found" });
    const { username, enabled } = request.body ?? {};
    if (username !== undefined) {
      if (!USERNAME_RE.test(username)) {
        return reply.code(400).send({ error: "invalid username" });
      }
      if (username !== user.username && (await repo.findOneBy({ username }))) {
        return reply.code(409).send({ error: "username taken" });
      }
      user.username = username;
    }
    if (enabled !== undefined) {
      // The super_admin account cannot be disabled.
      if (user.role === "super_admin" && !enabled) {
        return reply.code(400).send({ error: "cannot disable super_admin" });
      }
      user.enabled = enabled;
      if (!enabled) await revokeAllSessions(user.id);
    }
    await repo.save(user);
    return {
      user: { id: user.id, username: user.username, enabled: user.enabled },
    };
  });

  app.post<{ Params: { id: string }; Body: { newPassword?: string } }>(
    "/api/admin/users/:id/reset-password",
    guarded,
    async (request, reply) => {
      const { newPassword } = request.body ?? {};
      if (typeof newPassword !== "string" || newPassword.length < 8) {
        return reply.code(400).send({ error: "password must be >= 8 chars" });
      }
      const repo = AppDataSource.getRepository(User);
      const user = await repo.findOneBy({ id: request.params.id });
      if (!user) return reply.code(404).send({ error: "not found" });
      await repo.update(
        { id: user.id },
        { passwordHash: await hashPassword(newPassword) },
      );
      await revokeAllSessions(user.id);
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/admin/users/:id",
    guarded,
    async (request, reply) => {
      if (request.params.id === request.user!.id) {
        return reply.code(400).send({ error: "cannot delete yourself" });
      }
      const repo = AppDataSource.getRepository(User);
      const user = await repo.findOneBy({ id: request.params.id });
      if (!user) return reply.code(404).send({ error: "not found" });
      await revokeAllSessions(user.id);
      await repo.delete({ id: user.id });
      return { ok: true };
    },
  );

  app.get("/api/admin/settings", guarded, async () => getSettings());

  app.patch<{ Body: { allowRegistration?: boolean } }>(
    "/api/admin/settings",
    guarded,
    async (request) => {
      const { allowRegistration } = request.body ?? {};
      return updateSettings(
        allowRegistration === undefined ? {} : { allowRegistration },
      );
    },
  );

  // --- user groups (ACL subjects) ---

  app.get("/api/admin/user-groups", guarded, async () => {
    const groups = await AppDataSource.getRepository(UserGroup).find({
      order: { name: "ASC" },
    });
    const members = await AppDataSource.getRepository(UserGroupMember).find();
    return {
      groups: groups.map((g) => ({
        id: g.id,
        name: g.name,
        memberIds: members
          .filter((m) => m.groupId === g.id)
          .map((m) => m.userId),
      })),
    };
  });

  app.post<{ Body: { name?: string } }>(
    "/api/admin/user-groups",
    guarded,
    async (request, reply) => {
      const name = (request.body?.name ?? "").trim();
      if (!name) return reply.code(400).send({ error: "name required" });
      const exists = await AppDataSource.getRepository(UserGroup).findOneBy({
        name,
      });
      if (exists) return reply.code(409).send({ error: "name already exists" });
      const group = await AppDataSource.getRepository(UserGroup).save({
        id: ulid(),
        name,
      });
      return reply.code(201).send({ group });
    },
  );

  app.patch<{
    Params: { id: string };
    Body: { name?: string; memberIds?: string[] };
  }>("/api/admin/user-groups/:id", guarded, async (request, reply) => {
    const repo = AppDataSource.getRepository(UserGroup);
    const group = await repo.findOneBy({ id: request.params.id });
    if (!group) return reply.code(404).send({ error: "not found" });
    const { name, memberIds } = request.body ?? {};
    if (typeof name === "string" && name.trim()) group.name = name.trim();
    await repo.save(group);
    if (Array.isArray(memberIds)) {
      const memberRepo = AppDataSource.getRepository(UserGroupMember);
      await memberRepo.delete({ groupId: group.id });
      if (memberIds.length > 0) {
        await memberRepo.insert(
          memberIds.map((userId) => ({ userId, groupId: group.id })),
        );
      }
    }
    return { group };
  });

  app.delete<{ Params: { id: string } }>(
    "/api/admin/user-groups/:id",
    guarded,
    async (request, reply) => {
      const repo = AppDataSource.getRepository(UserGroup);
      const group = await repo.findOneBy({ id: request.params.id });
      if (!group) return reply.code(404).send({ error: "not found" });
      await AppDataSource.getRepository(UserGroupMember).delete({
        groupId: group.id,
      });
      // Deny-by-default: entries referencing the group become inert.
      await AppDataSource.getRepository(Permission).delete({
        subjectType: "user_group",
        subjectId: group.id,
      });
      await repo.delete({ id: group.id });
      return { ok: true };
    },
  );

  // --- permissions (ACL entries) ---

  app.get<{
    Querystring: { targetType?: string; targetId?: string };
  }>("/api/admin/permissions", guarded, async (request, reply) => {
    const { targetType, targetId } = request.query;
    if ((targetType !== "group" && targetType !== "asset") || !targetId) {
      return reply.code(400).send({ error: "targetType + targetId required" });
    }
    const entries = await AppDataSource.getRepository(Permission).find({
      where: { targetType, targetId },
      order: { createdAt: "ASC" },
    });
    const users = await AppDataSource.getRepository(
      (await import("../db/entities")).User,
    ).find();
    const userGroups = await AppDataSource.getRepository(UserGroup).find();
    const nameOf = (subjectType: string, subjectId: string): string | null => {
      if (subjectType === "user") {
        return users.find((u) => u.id === subjectId)?.username ?? null;
      }
      return userGroups.find((g) => g.id === subjectId)?.name ?? null;
    };
    return {
      entries: entries.map((e) => ({
        ...e,
        subjectName: nameOf(e.subjectType, e.subjectId),
      })),
    };
  });

  app.put<{
    Body: {
      subjectType?: string;
      subjectId?: string;
      targetType?: string;
      targetId?: string;
      level?: string | null;
    };
  }>("/api/admin/permissions", guarded, async (request, reply) => {
    const { subjectType, subjectId, targetType, targetId, level } =
      request.body ?? {};
    if (
      (subjectType !== "user" && subjectType !== "user_group") ||
      !subjectId ||
      (targetType !== "group" && targetType !== "asset") ||
      !targetId
    ) {
      return reply.code(400).send({ error: "invalid subject/target" });
    }
    const repo = AppDataSource.getRepository(Permission);
    const existing = await repo.findOneBy({
      subjectType,
      subjectId,
      targetType,
      targetId,
    });
    // level=null removes the entry (falls back to inheritance).
    if (level === null || level === undefined) {
      if (existing) await repo.delete({ id: existing.id });
      return { ok: true, removed: true };
    }
    if (level !== "read" && level !== "write" && level !== "deny") {
      return reply.code(400).send({ error: "level read|write|deny|null" });
    }
    if (existing) {
      existing.level = level;
      await repo.save(existing);
      return { entry: existing };
    }
    const entry = await repo.save({
      id: ulid(),
      subjectType,
      subjectId,
      targetType,
      targetId,
      level,
    });
    return reply.code(201).send({ entry });
  });

  // --- visibility (public/internal) on folders and files ---

  app.patch<{
    Body: {
      targetType?: string;
      targetId?: string;
      visibility?: string;
    };
  }>("/api/admin/visibility", guarded, async (request, reply) => {
    const { targetType, targetId, visibility } = request.body ?? {};
    if (
      (targetType !== "group" && targetType !== "asset") ||
      !targetId ||
      (visibility !== "internal" && visibility !== "public")
    ) {
      return reply
        .code(400)
        .send({ error: "targetType + targetId + visibility internal|public" });
    }
    if (targetType === "group") {
      const repo = AppDataSource.getRepository(Group);
      const group = await repo.findOneBy({ id: targetId });
      if (!group) return reply.code(404).send({ error: "group not found" });
      group.visibility = visibility;
      await repo.save(group);
    } else {
      const repo = AppDataSource.getRepository(Asset);
      const asset = await repo.findOneBy({ id: targetId });
      if (!asset) return reply.code(404).send({ error: "asset not found" });
      asset.visibility = visibility;
      await repo.save(asset);
    }
    return { ok: true, visibility };
  });
}
