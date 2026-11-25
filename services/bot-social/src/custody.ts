/** Custodial bot signing keys: Ed25519 private keys encrypted at rest with AES-256-GCM (key from BOTSOCIAL_KMS_KEY). */
import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function parseKmsKey(v: string): Buffer {
  const s = v.trim();
  const b = /^[0-9a-f]{64}$/i.test(s) ? Buffer.from(s, "hex") : Buffer.from(s, "base64");
  if (b.length !== 32) throw new Error("BOTSOCIAL_KMS_KEY must be 32 bytes (64 hex chars or base64)");
  return b;
}

/** env BOTSOCIAL_KMS_KEY, else a key file (generated once, mode 600). Never commit either. */
export function loadKmsKey(env: string | undefined, file: string): Buffer {
  if (env) return parseKmsKey(env);
  if (existsSync(file)) return parseKmsKey(readFileSync(file, "utf8"));
  mkdirSync(dirname(file), { recursive: true });
  const k = randomBytes(32);
  writeFileSync(file, k.toString("base64") + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
  return k;
}

export function seal(kms: Buffer, plaintext: string, aad: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", kms, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function unseal(kms: Buffer, sealed: string, aad: string): string {
  const [v, iv, tag, ct] = sealed.split(".");
  if (v !== "v1") throw new Error("unknown sealed format");
  const d = createDecipheriv("aes-256-gcm", kms, Buffer.from(iv, "base64url"));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}

/** base64url raw 32-byte public key of an Ed25519 private key PEM. */
export function publicRawFromPrivatePem(pem: string): string {
  const k = createPrivateKey(pem);
  if (k.asymmetricKeyType !== "ed25519") throw new Error("not an Ed25519 key");
  const der = createPublicKey(k).export({ type: "spki", format: "der" });
  return Buffer.from(der.subarray(der.length - 32)).toString("base64url");
}
