/** Auth routes: thin adapters over the auth service. Rate limiting and
 *  the auth guard stay here (HTTP policy, not domain logic). */

import type { FastifyInstance } from "fastify";
import { authGuard } from "../auth/guards";
import {
  changePassword,
  login,
  logout,
  me,
  refresh,
  register,
  type AuthDeps,
} from "../services/auth.service";

export type { AuthDeps };

export function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps) {
  app.post<{ Body: { username?: string; password?: string } }>(
    "/api/auth/register",
    async (request, reply) => {
      const out = await register(
        deps,
        request.body?.username,
        request.body?.password,
      );
      return reply.code(201).send(out);
    },
  );

  app.post<{ Body: { username?: string; password?: string } }>(
    "/api/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const out = await login(
        deps,
        request.body?.username,
        request.body?.password,
      );
      return reply.send(out);
    },
  );

  app.post<{ Body: { refreshToken?: string } }>(
    "/api/auth/refresh",
    async (request) => refresh(deps, request.body?.refreshToken),
  );

  app.post<{ Body: { refreshToken?: string } }>(
    "/api/auth/logout",
    async (request) => ({ revoked: await logout(request.body?.refreshToken) }),
  );

  app.get(
    "/api/auth/me",
    { preHandler: authGuard({ jwtSecret: deps.jwtSecret }) },
    async (request) => me(request.user!.id),
  );

  app.post<{
    Body: { oldPassword?: string; newPassword?: string; refreshToken?: string };
  }>(
    "/api/auth/password",
    { preHandler: authGuard({ jwtSecret: deps.jwtSecret }) },
    async (request) => {
      await changePassword(
        request.user!.id,
        request.body?.oldPassword,
        request.body?.newPassword,
        request.body?.refreshToken,
      );
      return { ok: true };
    },
  );
}
