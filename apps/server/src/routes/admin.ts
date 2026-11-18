/** Admin routes: thin adapters (auth + admin guards attached here)
 *  over the admin / settings / translate services. */

import type { FastifyInstance } from "fastify";
import {
  getSettings,
  maskSettings,
  targetLangsOf,
  updateSettings,
  type Settings,
} from "../services/settings.service";
import {
  enqueueTranslateJob,
  scheduleTranslationBackfill,
  translateStatus,
} from "../translate/service";
import { adminGuard, authGuard, contentAdminGuard } from "../auth/guards";
import { ServiceError } from "../lib/errors";
import {
  createUserGroup,
  listPermissions,
  listUserGroups,
  listUsers,
  putPermission,
  removeUser,
  removeUserGroup,
  resetUserPassword,
  setVisibility,
  updateUser,
  updateUserGroup,
} from "../services/admin.service";

export function registerAdminRoutes(
  app: FastifyInstance,
  deps: { jwtSecret: Uint8Array },
) {
  // super_admin only: user management + org settings (users, settings,
  // translate control). Content admins (role 'admin') get the ACL and
  // content-management surface instead.
  const guarded = { preHandler: [authGuard(deps), adminGuard()] };
  const contentGuarded = {
    preHandler: [authGuard(deps), contentAdminGuard()],
  };

  app.get("/api/admin/users", guarded, async () => ({
    users: (await listUsers()).map((u) => ({
      id: u.id,
      username: u.username,
      role: u.role,
      enabled: u.enabled,
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt,
    })),
  }));

  app.patch<{
    Params: { id: string };
    Body: { username?: string; enabled?: boolean; role?: string };
  }>("/api/admin/users/:id", guarded, async (request) => ({
    user: await updateUser(
      request.params.id,
      request.body ?? {},
      request.user!.id,
    ),
  }));

  app.post<{ Params: { id: string }; Body: { newPassword?: string } }>(
    "/api/admin/users/:id/reset-password",
    guarded,
    async (request) => {
      await resetUserPassword(
        request.params.id,
        request.body?.newPassword ?? "",
      );
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/admin/users/:id",
    guarded,
    async (request) => {
      await removeUser(request.user!.id, request.params.id);
      return { ok: true };
    },
  );

  // Masked view: credential values only show whether they are set.
  app.get("/api/admin/settings", guarded, async () =>
    maskSettings(await getSettings()),
  );

  app.patch<{ Body: Partial<Settings> }>(
    "/api/admin/settings",
    guarded,
    async (request) => {
      const before = await getSettings();
      const after = await updateSettings(request.body ?? {});
      // Newly enabled languages start their incremental backfill right
      // away (existing languages are untouched).
      const added = after.translateEnabledLangs.filter(
        (l) => !before.translateEnabledLangs.includes(l),
      );
      if (added.length > 0) {
        void scheduleTranslationBackfill();
      }
      return maskSettings(after);
    },
  );

  // --- translation control (settings page progress + manual run) ---

  app.get("/api/admin/translate/status", guarded, async () =>
    translateStatus(),
  );

  app.post<{ Body: { lang?: string } }>(
    "/api/admin/translate/run",
    guarded,
    async (request) => {
      const lang = (request.body?.lang ?? "").trim();
      if (lang) {
        await enqueueTranslateJob({ lang });
      } else {
        // No lang: kick every enabled language.
        const settings = await getSettings();
        for (const l of targetLangsOf(settings)) {
          await enqueueTranslateJob({ lang: l });
        }
      }
      return { ok: true };
    },
  );

  // --- user groups (ACL subjects) ---

  app.get("/api/admin/user-groups", contentGuarded, async () => ({
    groups: await listUserGroups(),
  }));

  app.post<{ Body: { name?: string } }>(
    "/api/admin/user-groups",
    contentGuarded,
    async (request, reply) => {
      const group = await createUserGroup(request.body?.name ?? "");
      return reply.code(201).send({ group });
    },
  );

  app.patch<{
    Params: { id: string };
    Body: { name?: string; memberIds?: string[] };
  }>("/api/admin/user-groups/:id", contentGuarded, async (request) => ({
    group: await updateUserGroup(request.params.id, request.body ?? {}),
  }));

  app.delete<{ Params: { id: string } }>(
    "/api/admin/user-groups/:id",
    contentGuarded,
    async (request) => {
      await removeUserGroup(request.params.id);
      return { ok: true };
    },
  );

  // --- permissions (ACL entries) ---

  app.get<{
    Querystring: { targetType?: string; targetId?: string };
  }>("/api/admin/permissions", contentGuarded, async (request) => {
    const { targetType, targetId } = request.query;
    if ((targetType !== "dir" && targetType !== "asset") || !targetId) {
      throw new ServiceError(400, "targetType + targetId required");
    }
    return { entries: await listPermissions(targetType, targetId) };
  });

  app.put<{
    Body: {
      subjectType?: string;
      subjectId?: string;
      targetType?: string;
      targetId?: string;
      level?: string | null;
    };
  }>("/api/admin/permissions", contentGuarded, async (request, reply) => {
    const body = request.body ?? {};
    const outcome = await putPermission({
      subjectType: body.subjectType ?? "",
      subjectId: body.subjectId ?? "",
      targetType: body.targetType ?? "",
      targetId: body.targetId ?? "",
      level: body.level ?? null,
    });
    if (outcome.entry) return reply.code(201).send({ entry: outcome.entry });
    return { ok: true, removed: true };
  });

  // --- visibility (public/internal) on folders and files ---

  app.patch<{
    Body: {
      targetType?: string;
      targetId?: string;
      visibility?: string;
    };
  }>("/api/admin/visibility", contentGuarded, async (request) => {
    const { targetType, targetId, visibility } = request.body ?? {};
    if (
      (targetType !== "dir" && targetType !== "asset") ||
      !targetId ||
      (visibility !== "internal" && visibility !== "public")
    ) {
      throw new ServiceError(
        400,
        "targetType + targetId + visibility internal|public",
      );
    }
    await setVisibility(targetType, targetId, visibility);
    return { ok: true, visibility };
  });
}
