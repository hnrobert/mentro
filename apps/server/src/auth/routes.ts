import type { FastifyInstance } from "fastify";
import { ulid } from "ulid";
import { AppDataSource } from "../db/data-source";
import { User } from "../db/entities";
import { getSettings } from "../settings";
import type { Config } from "../config";
import {
  createSession,
  findUserById,
  revokeOtherSessions,
  rotateSession,
  revokeSession,
  signAccessToken,
  type AuthUser,
} from "./tokens";
import { hashPassword, verifyAlways } from "./password";
import { authGuard } from "./guards";

const USERNAME_RE = /^[A-Za-z0-9_-]{3,32}$/;

export interface AuthDeps {
  config: Config;
  jwtSecret: Uint8Array;
}

function publicUser(u: User) {
  return { id: u.id, username: u.username, role: u.role, enabled: u.enabled };
}

async function issueTokens(
  user: User,
  deps: AuthDeps,
): Promise<{ accessToken: string; refreshToken: string }> {
  const auth: AuthUser = {
    id: user.id,
    role: user.role,
    username: user.username,
  };
  const accessToken = await signAccessToken(
    auth,
    deps.jwtSecret,
    deps.config.accessTtlSec,
  );
  const refreshToken = await createSession(user.id, deps.config.refreshTtlSec);
  return { accessToken, refreshToken };
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps) {
  app.post<{ Body: { username?: string; password?: string } }>(
    "/api/auth/register",
    async (request, reply) => {
      const { username, password } = request.body ?? {};
      if (!username || !USERNAME_RE.test(username)) {
        return reply.code(400).send({
          error: "username must match [A-Za-z0-9_-]{3,32}",
        });
      }
      if (typeof password !== "string" || password.length < 8) {
        return reply.code(400).send({ error: "password must be >= 8 chars" });
      }

      const repo = AppDataSource.getRepository(User);
      const count = await repo.count();
      const isFirst = count === 0;
      if (!isFirst) {
        const settings = await getSettings();
        if (!settings.allowRegistration) {
          return reply.code(403).send({ error: "registration disabled" });
        }
      }
      if (await repo.findOneBy({ username })) {
        return reply.code(409).send({ error: "username taken" });
      }

      const user = await repo.save({
        id: ulid(),
        username,
        passwordHash: await hashPassword(password),
        role: isFirst ? "super_admin" : "user",
        lastLoginAt: new Date(),
      });
      const tokens = await issueTokens(user, deps);
      return reply.code(201).send({ user: publicUser(user), ...tokens });
    },
  );

  app.post<{ Body: { username?: string; password?: string } }>(
    "/api/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { username, password } = request.body ?? {};
      const repo = AppDataSource.getRepository(User);
      const user = username ? await repo.findOneBy({ username }) : null;
      const ok = await verifyAlways(user?.passwordHash ?? null, password ?? "");
      if (!user || !ok || !user.enabled) {
        return reply.code(401).send({ error: "invalid credentials" });
      }
      await repo.update({ id: user.id }, { lastLoginAt: new Date() });
      const tokens = await issueTokens(user, deps);
      return reply.send({ user: publicUser(user), ...tokens });
    },
  );

  app.post<{ Body: { refreshToken?: string } }>(
    "/api/auth/refresh",
    async (request, reply) => {
      const { refreshToken } = request.body ?? {};
      if (!refreshToken)
        return reply.code(400).send({ error: "refreshToken required" });
      const rotated = await rotateSession(
        refreshToken,
        deps.config.refreshTtlSec,
      );
      if (!rotated)
        return reply.code(401).send({ error: "invalid refresh token" });
      const user = await findUserById(rotated.userId);
      if (!user || !user.enabled) {
        return reply.code(401).send({ error: "invalid refresh token" });
      }
      const accessToken = await signAccessToken(
        { id: user.id, role: user.role, username: user.username },
        deps.jwtSecret,
        deps.config.accessTtlSec,
      );
      return reply.send({ accessToken, refreshToken: rotated.refreshToken });
    },
  );

  app.post<{ Body: { refreshToken?: string } }>(
    "/api/auth/logout",
    async (request, reply) => {
      const { refreshToken } = request.body ?? {};
      const revoked = refreshToken ? await revokeSession(refreshToken) : false;
      return reply.send({ revoked });
    },
  );

  app.get(
    "/api/auth/me",
    { preHandler: authGuard({ jwtSecret: deps.jwtSecret }) },
    async (request) => {
      const user = await findUserById(request.user!.id);
      return { user: user ? publicUser(user) : null };
    },
  );

  app.post<{
    Body: { oldPassword?: string; newPassword?: string; refreshToken?: string };
  }>(
    "/api/auth/password",
    { preHandler: authGuard({ jwtSecret: deps.jwtSecret }) },
    async (request, reply) => {
      const { oldPassword, newPassword, refreshToken } = request.body ?? {};
      if (typeof newPassword !== "string" || newPassword.length < 8) {
        return reply.code(400).send({ error: "password must be >= 8 chars" });
      }
      const user = await findUserById(request.user!.id);
      if (!user) return reply.code(401).send({ error: "unauthorized" });
      const ok = await verifyAlways(user.passwordHash, oldPassword ?? "");
      if (!ok) return reply.code(403).send({ error: "wrong password" });
      await AppDataSource.getRepository(User).update(
        { id: user.id },
        { passwordHash: await hashPassword(newPassword) },
      );
      if (refreshToken) await revokeOtherSessions(user.id, refreshToken);
      return reply.send({ ok: true });
    },
  );
}
