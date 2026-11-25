/** File attachments: limits, type checks and AES-256-GCM sealing of the bytes at rest (same KMS key as custody). */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export interface AttachmentLimits { maxBytes: number; ttlMs: number; maxPerMessage: number; ownerBudgetBytes: number }
/** `ownerBudgetBytes` is the owner-level ceiling over every stored byte (25 files of 20 MB): the per-file and
 *  per-message limits bound one request, this bounds the account's disk. */
export const DEFAULT_ATTACHMENT_LIMITS: AttachmentLimits = { maxBytes: 20 * 1024 * 1024, ttlMs: 7 * 24 * 3600 * 1000, maxPerMessage: 5, ownerBudgetBytes: 512 * 1024 * 1024 };

/** Reference carried in a signed message payload; the signature covers every field. */
export interface AttachmentRef { id: string; name: string; size: number; mime: string; sha256: string }

// Allowed types: documents, data, plain text and raster images. Archives, SVG, HTML and anything executable stay out.
const ALLOWED_MIME = new Set([
  "text/plain", "text/markdown", "text/csv", "text/tab-separated-values",
  "application/json", "application/pdf",
  "image/png", "image/jpeg", "image/gif", "image/webp",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);
const BLOCKED_EXT = new Set(["exe", "dll", "so", "dylib", "bin", "com", "bat", "cmd", "msi", "msp", "scr", "pif", "cpl", "ps1", "psm1", "vbs", "vbe", "js", "jse", "mjs", "wsf", "wsh", "hta", "jar", "apk", "app", "dmg", "pkg", "deb", "rpm", "sh", "bash", "zsh", "command", "lnk", "reg", "iso", "img", "html", "htm", "svg", "xhtml", "docm", "xlsm", "pptm"]);
const EXT_MIME: Record<string, string> = { txt: "text/plain", md: "text/markdown", csv: "text/csv", tsv: "text/tab-separated-values", json: "application/json", pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation" };

/** Executable formats by their first bytes, whatever the name says. */
export function looksExecutable(b: Buffer): boolean {
  const h = b.subarray(0, 4).toString("hex");
  return b.subarray(0, 2).toString("latin1") === "MZ" || h === "7f454c46" || ["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe"].includes(h) || b.subarray(0, 2).toString("latin1") === "#!";
}

export const sha256Hex = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Decodes standard base64 only when the input is canonical (RFC 4648 §4). Node's decoder skips junk, stops at a
 *  mid-string "=", accepts base64url characters and non-zero pad bits, so it can turn malformed text into different
 *  bytes than the caller encoded; the round-trip accepts exactly the input whose bytes re-encode to itself. */
export function decodeCanonicalBase64(s: string): Buffer | null {
  if (s.length % 4 !== 0) return null;
  const bytes = Buffer.from(s, "base64");
  return bytes.toString("base64") === s ? bytes : null;
}

/** Checks name, type and content; returns the clean name and mime or a reason. */
export function checkFile(name: unknown, mime: unknown, bytes: Buffer, limits: AttachmentLimits): { ok: true; name: string; mime: string } | { ok: false; code: string; message: string } {
  const clean = String(name ?? "").replace(/[\u0000-\u001f\u007f/\\]/g, "_").trim().slice(0, 200);
  if (!clean) return { ok: false, code: "invalid_request", message: "file name required" };
  if (bytes.length === 0) return { ok: false, code: "invalid_request", message: "empty file" };
  if (bytes.length > limits.maxBytes) return { ok: false, code: "attachment_too_large", message: `file exceeds ${limits.maxBytes} bytes` };
  const exts = clean.toLowerCase().split(".").slice(1);
  if (exts.some((e) => BLOCKED_EXT.has(e))) return { ok: false, code: "attachment_type_blocked", message: "this file type is not allowed" };
  const type = String(mime ?? "").toLowerCase().split(";")[0].trim() || EXT_MIME[exts.at(-1) ?? ""] || "";
  if (!ALLOWED_MIME.has(type)) return { ok: false, code: "attachment_type_blocked", message: `type ${type || "unknown"} is not allowed` };
  if (looksExecutable(bytes)) return { ok: false, code: "attachment_type_blocked", message: "executable content is not allowed" };
  return { ok: true, name: clean, mime: type };
}

export function sealBytes(kms: Buffer, data: Buffer, aad: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", kms, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(data), c.final()]);
  return Buffer.concat([Buffer.from("A1"), iv, c.getAuthTag(), ct]);
}

export function unsealBytes(kms: Buffer, sealed: Buffer, aad: string): Buffer {
  if (sealed.subarray(0, 2).toString() !== "A1") throw new Error("unknown sealed format");
  const d = createDecipheriv("aes-256-gcm", kms, sealed.subarray(2, 14));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(sealed.subarray(14, 30));
  return Buffer.concat([d.update(sealed.subarray(30)), d.final()]);
}

export const refOf = (row: any): AttachmentRef => ({ id: row.id, name: row.name, size: row.size, mime: row.mime, sha256: row.sha256 });
export const humanSize = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
