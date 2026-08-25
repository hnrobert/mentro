import crypto from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { ulid } from "ulid";
import { IsNull, Not, Repository } from "typeorm";
import { AppDataSource } from "../db/data-source";
import { User, UserSession } from "../db/entities";

export interface AuthUser {
  id: string;
  role: string;
  username: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function signAccessToken(
  user: AuthUser,
  secret: Uint8Array,
  ttlSec: number,
): Promise<string> {
  return new SignJWT({ role: user.role, uname: user.username })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${ttlSec}s`)
    .sign(secret);
}

export async function verifyAccessToken(
  token: string,
  secret: Uint8Array,
): Promise<AuthUser | null> {
  try {
    const { payload } = await jwtVerify(token, secret);
    if (!payload.sub || typeof payload.role !== "string") return null;
    return {
      id: payload.sub,
      role: payload.role,
      username: typeof payload.uname === "string" ? payload.uname : "",
    };
  } catch {
    return null;
  }
}

export function newRefreshToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

const sessionRepo = (): Repository<UserSession> =>
  AppDataSource.getRepository(UserSession);

export async function createSession(
  userId: string,
  ttlSec: number,
): Promise<string> {
  const refresh = newRefreshToken();
  const expiresAt = new Date(Date.now() + ttlSec * 1000);
  await sessionRepo().insert({
    id: ulid(),
    userId,
    refreshHash: sha256(refresh),
    expiresAt,
  });
  return refresh;
}

/** Rotate: mark the presented refresh session revoked, issue a fresh one.
 * Reuse of an already-revoked session revokes ALL of the user's sessions. */
export async function rotateSession(
  refresh: string,
  ttlSec: number,
): Promise<{ userId: string; refreshToken: string } | null> {
  const repo = sessionRepo();
  const hash = sha256(refresh);
  const found = await repo.findOne({
    where: { refreshHash: hash },
    order: { createdAt: "DESC" },
  });
  if (!found) return null;
  if (found.revokedAt) {
    await repo.update({ userId: found.userId }, { revokedAt: new Date() });
    return null;
  }
  if (found.expiresAt.getTime() < Date.now()) return null;
  await repo.update({ id: found.id }, { revokedAt: new Date() });
  const next = await createSession(found.userId, ttlSec);
  return { userId: found.userId, refreshToken: next };
}

export async function revokeSession(refresh: string): Promise<boolean> {
  const res = await sessionRepo().update(
    { refreshHash: sha256(refresh), revokedAt: IsNull() },
    { revokedAt: new Date() },
  );
  return (res.affected ?? 0) > 0;
}

export async function revokeOtherSessions(
  userId: string,
  keepRefresh: string,
): Promise<void> {
  await sessionRepo().update(
    { userId, refreshHash: Not(sha256(keepRefresh)) },
    { revokedAt: new Date() },
  );
}

export async function revokeAllSessions(userId: string): Promise<void> {
  await sessionRepo().update({ userId }, { revokedAt: new Date() });
}

export async function findUserById(id: string): Promise<User | null> {
  return AppDataSource.getRepository(User).findOneBy({ id });
}
