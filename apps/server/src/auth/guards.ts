import type { FastifyReply, FastifyRequest } from "fastify";
import { verifyAccessToken, type AuthUser } from "./tokens";

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

export interface AuthDeps {
  jwtSecret: Uint8Array;
}

export function authGuard(deps: AuthDeps) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    const user = token ? await verifyAccessToken(token, deps.jwtSecret) : null;
    if (!user) {
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }
    request.user = user;
  };
}

/** super_admin only: user management, org-wide settings. */
export function adminGuard() {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.user?.role !== "super_admin") {
      await reply.code(403).send({ error: "forbidden" });
    }
  };
}

/** admin OR super_admin: content + ACL management (permissions,
 *  visibility, groups, library content). Admins see and manage all
 *  documents but cannot touch users or org settings. */
export function contentAdminGuard() {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (
      request.user?.role !== "super_admin" &&
      request.user?.role !== "admin"
    ) {
      await reply.code(403).send({ error: "forbidden" });
    }
  };
}
