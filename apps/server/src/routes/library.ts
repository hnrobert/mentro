/** Knowledge-base library routes: thin HTTP adapters over the library
 *  service (group tree, group CRUD, file list, move, delete). Services
 *  throw ServiceError; the global error handler in index.ts maps it. */

import type { FastifyInstance } from "fastify";
import { authGuard, contentAdminGuard } from "../auth/guards";
import {
  createGroup,
  deleteAssetCompletely,
  groupTree,
  listLibrary,
  moveAssetToGroup,
  removeGroup,
  updateGroup,
} from "../services/library.service";

export function registerLibraryRoutes(
  app: FastifyInstance,
  deps: { jwtSecret: Uint8Array },
) {
  const contentGuarded = {
    preHandler: [authGuard(deps), contentAdminGuard()],
  };
  app.get("/api/groups", async (request) => groupTree(request.user!));

  app.post<{ Body: { name: string; parentId?: string | null } }>(
    "/api/groups",
    contentGuarded,
    async (request, reply) => {
      const group = await createGroup(
        request.body?.name,
        request.body?.parentId,
      );
      return reply.code(201).send({ group });
    },
  );

  app.patch<{
    Params: { id: string };
    Body: { name?: string; parentId?: string | null; sortOrder?: number };
  }>("/api/groups/:id", contentGuarded, async (request) => ({
    group: await updateGroup(request.params.id, request.body ?? {}),
  }));

  app.delete<{ Params: { id: string } }>(
    "/api/groups/:id",
    contentGuarded,
    async (request) => {
      await removeGroup(request.params.id);
      return { ok: true };
    },
  );

  app.get<{
    Querystring: {
      groupId?: string;
      kind?: string;
      q?: string;
      sort?: string;
      sortDir?: string;
      page?: string;
      pageSize?: string;
    };
  }>("/api/library", async (request) =>
    listLibrary(request.user!, {
      groupId: request.query.groupId,
      kind: request.query.kind,
      q: request.query.q,
      sort: request.query.sort,
      sortDir: request.query.sortDir,
      page: Math.max(1, Number(request.query.page ?? 1) || 1),
      pageSize: Math.min(
        200,
        Math.max(1, Number(request.query.pageSize ?? 50) || 50),
      ),
    }),
  );

  app.patch<{ Params: { id: string }; Body: { groupId: string | null } }>(
    "/api/assets/:id/group",
    async (request) => {
      await moveAssetToGroup(
        request.user!,
        request.params.id,
        request.body?.groupId ?? null,
      );
      return { ok: true };
    },
  );

  // Delete asset: index + disk file, uniformly (uploaded or mounted).
  app.delete<{ Params: { id: string } }>("/api/assets/:id", async (request) => {
    await deleteAssetCompletely(request.user!, request.params.id);
    return { ok: true };
  });
}
