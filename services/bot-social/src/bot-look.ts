/**
 * Optional "look" of a Bot: what its owner chose so every home renders the same Bot the same way.
 *
 *  - `avatar`: null, or ONE of
 *      · a preset id        `star`, `blue-whale`   (^[a-z0-9][a-z0-9_-]{0,31}$; the client maps it to artwork)
 *      · a single emoji     `🌟`, `👩‍💻`           (one pictograph sequence, at most 20 UTF-16 units)
 *      · an image data URL  `data:image/(png|jpeg|webp);base64,...`, the whole string at most 64 KiB,
 *        canonical base64, magic bytes must match the declared type; PNG dimensions at most 1024x1024.
 *        SVG, GIF and every other type are refused (no scripts, no external references).
 *  - `color`: null, or `#rrggbb` (lowercase hex).
 * The server never fetches, renders or transcodes the avatar; it only validates and stores it.
 */
import { createHash } from "node:crypto";
import { ApiError } from "./errors.js";

export const AVATAR_MAX_CHARS = 64 * 1024;
const PRESET = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const EMOJI_UNIT = "\\p{Extended_Pictographic}(?:\\uFE0F|\\p{Emoji_Modifier})?";
const EMOJI = new RegExp(`^(?:\\p{Regional_Indicator}{2}|${EMOJI_UNIT}(?:\\u200D${EMOJI_UNIT})*)$`, "u");
const DATA_URL = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
const COLOR = /^#[0-9a-f]{6}$/;

export type AvatarKind = "preset" | "emoji" | "image";

export function avatarKind(avatar: string | null | undefined): AvatarKind | null {
  if (!avatar) return null;
  if (avatar.startsWith("data:")) return "image";
  return PRESET.test(avatar) ? "preset" : "emoji";
}

/** Returns the value to store (null clears). Throws 400 invalid_avatar. */
export function validateAvatar(v: unknown): string | null {
  if (v === null || v === "") return null;
  const bad = (m: string) => new ApiError(400, "invalid_avatar", `avatar: ${m}`);
  if (typeof v !== "string") throw bad("must be a string or null");
  if (v.length > AVATAR_MAX_CHARS) throw bad(`too large (max ${AVATAR_MAX_CHARS} characters)`);
  if (v.startsWith("data:")) {
    const m = DATA_URL.exec(v);
    if (!m) throw bad("image must be a base64 data URL of type image/png, image/jpeg or image/webp");
    const bytes = Buffer.from(m[2], "base64");
    if (bytes.toString("base64") !== m[2]) throw bad("image is not canonical base64");
    const type = m[1];
    const hex = (from: number, to: number) => bytes.subarray(from, to).toString("hex");
    const okMagic = type === "png" ? hex(0, 8) === "89504e470d0a1a0a"
      : type === "jpeg" ? hex(0, 3) === "ffd8ff"
      : bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP";
    if (!okMagic) throw bad(`content is not a valid ${type} image`);
    if (type === "png") {
      const ok = bytes.length >= 33 && bytes.subarray(12, 16).toString("latin1") === "IHDR";
      const w = ok ? bytes.readUInt32BE(16) : 0, h = ok ? bytes.readUInt32BE(20) : 0;
      if (!ok || w < 1 || h < 1 || w > 1024 || h > 1024) throw bad("PNG must be at most 1024x1024");
    }
    return v;
  }
  if (v.length <= 32 && PRESET.test(v)) return v;
  if (v.length <= 20 && EMOJI.test(v)) return v;
  throw bad("must be a preset id (a-z0-9_-, 1-32 chars), a single emoji, or a PNG/JPEG/WebP data URL");
}

/** Returns the value to store (null clears). Throws 400 invalid_color. */
export function validateColor(v: unknown): string | null {
  if (v === null || v === "") return null;
  if (typeof v !== "string" || !COLOR.test(v)) throw new ApiError(400, "invalid_color", "color: must be #rrggbb (lowercase hex) or null");
  return v;
}

/** The public look fields of a bots row. */
export function lookOf(b: { avatar?: string | null; color?: string | null; avatar_updated_at?: string | null }) {
  return { avatar: b.avatar ?? null, avatar_kind: avatarKind(b.avatar), color: b.color ?? null, avatar_updated_at: b.avatar_updated_at ?? null };
}

/** Audit-safe description of an avatar (never the image bytes). */
export function avatarFingerprint(avatar: string | null) {
  return avatar ? { kind: avatarKind(avatar), sha256: createHash("sha256").update(avatar).digest("hex").slice(0, 16), chars: avatar.length } : null;
}
