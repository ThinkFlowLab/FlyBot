import { randomBytes } from "node:crypto";

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32

/** 26-char ULID (48-bit time + 80-bit randomness). */
export function ulid(now = Date.now()): string {
  let t = now;
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = B32[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const rnd = randomBytes(16);
  let r = "";
  for (let i = 0; i < 16; i++) r += B32[rnd[i] % 32];
  return time + r;
}

export const newId = (prefix: string) => `${prefix}_${ulid()}`;
export const randomToken = (prefix: string) => `${prefix}_${randomBytes(24).toString("base64url")}`;
