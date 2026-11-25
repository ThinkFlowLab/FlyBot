import { createHash, createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, KeyObject, timingSafeEqual } from "node:crypto";
import canonicalizeImport from "canonicalize";

const canonicalizeFn = canonicalizeImport as unknown as (v: unknown) => string | undefined;

/** RFC 8785 JSON Canonicalization Scheme. */
export function jcs(value: unknown): string {
  const s = canonicalizeFn(value);
  if (s === undefined) throw new Error("cannot canonicalize");
  return s;
}

export const sha256Hex = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

// Ed25519 SPKI DER prefix for a 32-byte raw public key.
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface KeyPair { publicKey: string; privateKeyPem: string } // publicKey = base64url raw 32 bytes

export function generateEd25519(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ type: "spki", format: "der" });
  return {
    publicKey: Buffer.from(der.subarray(der.length - 32)).toString("base64url"),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

export function publicKeyFromRaw(rawB64u: string): KeyObject {
  const raw = Buffer.from(rawB64u, "base64url");
  if (raw.length !== 32) throw new Error("Ed25519 public key must be 32 bytes");
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

export function signString(privateKeyPem: string, data: string): string {
  return sign(null, Buffer.from(data), createPrivateKey(privateKeyPem)).toString("base64url");
}

export function verifyString(publicKeyRaw: string, data: string, sigB64u: string): boolean {
  try {
    return verify(null, Buffer.from(data), publicKeyFromRaw(publicKeyRaw), Buffer.from(sigB64u, "base64url"));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- envelopes
export interface Envelope {
  v: "botsocial/1.0";
  type: string;
  id: string;
  ts: string;
  nonce: string;
  from: string;
  to?: string;
  conversation_id?: string;
  payload_sha256: string;
  payload: unknown;
  sig: { alg: "Ed25519"; kid: string; value: string };
}

/** Signing input: JCS(header fields + payload_sha256), payload itself excluded (design §4.3). */
export function envelopeSigningInput(env: Omit<Envelope, "sig"> | Envelope): string {
  const { sig: _sig, payload: _payload, ...header } = env as Envelope;
  return jcs(header);
}

export function payloadDigest(payload: unknown): string {
  return sha256Hex(jcs(payload ?? null));
}

export function signEnvelope(opts: {
  type: string; from: string; to?: string; conversation_id?: string; payload: unknown;
  kid: string; privateKeyPem: string; id?: string; ts?: string; nonce?: string;
}): Envelope {
  const base: Omit<Envelope, "sig"> = {
    v: "botsocial/1.0",
    type: opts.type,
    id: opts.id ?? `evt_${randomBytes(13).toString("hex")}`,
    ts: opts.ts ?? new Date().toISOString(),
    nonce: opts.nonce ?? randomBytes(8).toString("hex"),
    from: opts.from,
    ...(opts.to ? { to: opts.to } : {}),
    ...(opts.conversation_id ? { conversation_id: opts.conversation_id } : {}),
    payload_sha256: payloadDigest(opts.payload),
    payload: opts.payload ?? null,
  };
  return { ...base, sig: { alg: "Ed25519", kid: opts.kid, value: signString(opts.privateKeyPem, envelopeSigningInput(base)) } };
}

// ---------------------------------------------------------------- webhooks
export function webhookSignature(secret: string, timestamp: string, body: string): string {
  return "v1=" + createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function verifyWebhookSignature(secret: string, timestamp: string, body: string, header: string): boolean {
  const expected = Buffer.from(webhookSignature(secret, timestamp, body));
  const got = Buffer.from(header || "");
  return expected.length === got.length && timingSafeEqual(expected, got);
}

export const hashToken = (t: string) => sha256Hex("tok:" + t);
