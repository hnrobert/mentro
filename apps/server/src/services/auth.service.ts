/** Auth domain: registration (first user becomes super_admin), login,
 *  refresh rotation, logout, password change. Token mechanics live in
 *  auth/tokens; this service composes them with user policy. */

import { ulid } from "ulid";
import { User } from "../db/entities";
import { getSettings } from "./settings.service";
import type { Config } from "../lib/config";
import {
  createSession,
  findUserById,
  revokeOtherSessions,
  rotateSession,
  revokeSession,
  signAccessToken,
  type AuthUser,
} from "../auth/tokens";
import { hashPassword, verifyAlways } from "../auth/password";
import {
  countUsers,
  findUserByName,
  saveUser,
} from "../repositories/misc.repository";
import { ServiceError } from "../lib/errors";

const USERNAME_RE = /^[A-Za-z0-9_-]{3,32}$/;

export interface AuthDeps {
  config: Config;
  jwtSecret: Uint8Array;
}

export function publicUser(u: User) {
  return { id: u.id, username: u.username, role: u.role, enabled: u.enabled };
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
}

async function issueTokens(user: User, deps: AuthDeps): Promise<IssuedTokens> {
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

export async function register(
  deps: AuthDeps,
  username: string | undefined,
  password: string | undefined,
): Promise<{ user: ReturnType<typeof publicUser> } & IssuedTokens> {
  if (!username || !USERNAME_RE.test(username)) {
    throw new ServiceError(400, "username must match [A-Za-z0-9_-]{3,32}");
  }
  if (typeof password !== "string" || password.length < 8) {
    throw new ServiceError(400, "password must be >= 8 chars");
  }

  const isFirst = (await countUsers()) === 0;
  if (!isFirst) {
    const settings = await getSettings();
    if (!settings.allowRegistration) {
      throw new ServiceError(403, "registration disabled");
    }
  }
  if (await findUserByName(username)) {
    throw new ServiceError(409, "username taken");
  }

  const user = await saveUser({
    id: ulid(),
    username,
    passwordHash: await hashPassword(password),
    role: isFirst ? "super_admin" : "user",
    lastLoginAt: new Date(),
  } as User);
  return { user: publicUser(user), ...(await issueTokens(user, deps)) };
}

export async function login(
  deps: AuthDeps,
  username: string | undefined,
  password: string | undefined,
) {
  const user = username ? await findUserByName(username) : null;
  const ok = await verifyAlways(user?.passwordHash ?? null, password ?? "");
  if (!user || !ok || !user.enabled) {
    throw new ServiceError(401, "invalid credentials");
  }
  user.lastLoginAt = new Date();
  await saveUser(user);
  return { user: publicUser(user), ...(await issueTokens(user, deps)) };
}

export async function refresh(
  deps: AuthDeps,
  refreshToken: string | undefined,
): Promise<{ accessToken: string; refreshToken: string }> {
  if (!refreshToken) throw new ServiceError(400, "refreshToken required");
  const rotated = await rotateSession(refreshToken, deps.config.refreshTtlSec);
  if (!rotated) throw new ServiceError(401, "invalid refresh token");
  const user = await findUserById(rotated.userId);
  if (!user || !user.enabled) {
    throw new ServiceError(401, "invalid refresh token");
  }
  const accessToken = await signAccessToken(
    { id: user.id, role: user.role, username: user.username },
    deps.jwtSecret,
    deps.config.accessTtlSec,
  );
  return { accessToken, refreshToken: rotated.refreshToken };
}

export async function logout(
  refreshToken: string | undefined,
): Promise<boolean> {
  return refreshToken ? revokeSession(refreshToken) : false;
}

export async function me(userId: string) {
  const user = await findUserById(userId);
  return { user: user ? publicUser(user) : null };
}

export async function changePassword(
  userId: string,
  oldPassword: string | undefined,
  newPassword: string | undefined,
  refreshToken: string | undefined,
): Promise<void> {
  if (typeof newPassword !== "string" || newPassword.length < 8) {
    throw new ServiceError(400, "password must be >= 8 chars");
  }
  const user = await findUserById(userId);
  if (!user) throw new ServiceError(401, "unauthorized");
  const ok = await verifyAlways(user.passwordHash, oldPassword ?? "");
  if (!ok) throw new ServiceError(403, "wrong password");
  user.passwordHash = await hashPassword(newPassword);
  await saveUser(user);
  if (refreshToken) await revokeOtherSessions(user.id, refreshToken);
}
