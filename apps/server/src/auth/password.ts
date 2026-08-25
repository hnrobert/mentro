import { hash as argonHash, verify as argonVerify } from "argon2";

export function hashPassword(plain: string): Promise<string> {
  return argonHash(plain, { type: 2 }); // argon2id
}

export function verifyPassword(digest: string, plain: string): Promise<boolean> {
  return argonVerify(digest, plain);
}

/** Hash used for constant-time miss on unknown users (timing oracle). */
const DUMMY_HASH =
  "$argon2id$v=19$m=65536,t=3,p=4$" +
  "c2FsdHNhbHRzYWx0c2FsdA$Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9v";

export async function verifyAlways(digest: string | null, plain: string): Promise<boolean> {
  return argonVerify(digest ?? DUMMY_HASH, plain).catch(() => false);
}
