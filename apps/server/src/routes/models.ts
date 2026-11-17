/** Model registry routes: admin CRUD (super_admin), user-facing list,
 *  and the per-user preference. Keys are never sent to non-admins. */

import type { FastifyInstance } from "fastify";
import { adminGuard, authGuard } from "../auth/guards";
import {
  createEndpoint,
  deleteEndpoint,
  listEndpoints,
  setUserEndpoint,
  setDefaultEndpoint,
  updateEndpoint,
  type EndpointView,
} from "../services/models.service";
import { findUserById } from "../repositories/misc.repository";

export function registerModelRoutes(
  app: FastifyInstance,
  deps: { jwtSecret: Uint8Array },
) {
  const guarded = { preHandler: [authGuard(deps), adminGuard()] };

  // --- user-facing (any signed-in user) ---

  app.get("/api/models", async () => ({ models: await listEndpoints() }));

  app.patch<{ Body: { endpointId?: string | null } }>(
    "/api/me/model",
    async (request) => {
      await setUserEndpoint(request.user!.id, request.body?.endpointId ?? null);
      return { ok: true };
    },
  );

  app.get("/api/me/model", async (request) => {
    const user = await findUserById(request.user!.id);
    return { endpointId: user?.llmEndpointId ?? null };
  });

  // --- admin CRUD ---

  app.get("/api/admin/models", guarded, async () => ({
    models: await listEndpoints(),
  }));

  app.post<{
    Body: {
      name?: string;
      baseUrl?: string;
      apiKey?: string;
      model?: string;
      makeDefault?: boolean;
    };
  }>("/api/admin/models", guarded, async (request, reply) => {
    const m = await createEndpoint({
      name: request.body?.name ?? "",
      baseUrl: request.body?.baseUrl ?? "",
      apiKey: request.body?.apiKey ?? "",
      model: request.body?.model ?? "",
      makeDefault: request.body?.makeDefault,
    });
    return reply.code(201).send({ model: m });
  });

  app.patch<{
    Params: { id: string };
    Body: Partial<EndpointView & { apiKey?: string; makeDefault?: boolean }> & {
      apiKey?: string;
    };
  }>("/api/admin/models/:id", guarded, async (request) => ({
    model: await updateEndpoint(request.params.id, {
      name: request.body?.name,
      baseUrl: request.body?.baseUrl,
      apiKey: request.body?.apiKey,
      model: request.body?.model,
      enabled: request.body?.enabled,
      makeDefault: request.body?.makeDefault,
    }),
  }));

  app.delete<{ Params: { id: string } }>(
    "/api/admin/models/:id",
    guarded,
    async (request) => {
      await deleteEndpoint(request.params.id);
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/admin/models/:id/default",
    guarded,
    async (request) => {
      await setDefaultEndpoint(request.params.id);
      return { ok: true };
    },
  );
}
