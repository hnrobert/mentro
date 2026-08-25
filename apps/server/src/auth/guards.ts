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

export function adminGuard() {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.user?.role !== "super_admin") {
      await reply.code(403).send({ error: "forbidden" });
    }
  };
}
