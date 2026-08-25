import type { FastifyInstance } from "fastify";
import { AppDataSource } from "../db/data-source";
import { User } from "../db/entities";
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
}
