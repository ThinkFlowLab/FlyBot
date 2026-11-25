import type { FastifyReply, FastifyRequest } from "fastify";
import { assert } from "../errors.js";
import { decodeChatFile } from "./chat-files.js";
import { params, type OtContext } from "./core.js";

export const PUBLIC_MEDIA_SCHEMA = `
CREATE TABLE IF NOT EXISTS ot_listing_media (
  listing_id TEXT PRIMARY KEY REFERENCES ot_listings(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL, mime TEXT NOT NULL, filename TEXT NOT NULL, bytes INTEGER NOT NULL,
  content BLOB NOT NULL CHECK(bytes > 0 AND bytes = length(content))
);
CREATE INDEX IF NOT EXISTS ot_listing_media_owner ON ot_listing_media(owner_id);
`;

const EXTENSIONS = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp",
  "audio/mpeg": "mp3", "audio/ogg": "ogg", "audio/wav": "wav",
  "video/mp4": "mp4", "video/webm": "webm",
} as const;
type PublicMime = keyof typeof EXTENSIONS;
type PublishedMedia = {mime: PublicMime; filename: string; data: Buffer};

export function isMediaWork(kind: string | null) {
  return kind === "media" || kind === "image" || kind === "audio" || kind === "video";
}

function publicMediaMime(value: unknown): value is PublicMime {
  return typeof value === "string" && Object.hasOwn(EXTENSIONS, value);
}

export function decodePublishedMedia(workKind: string | null, body: Record<string, unknown>): PublishedMedia | null {
  const {media_data: data, media_mime: mime, media_filename: filename} = body;
  if (data === undefined && mime === undefined && filename === undefined) return null;
  assert(isMediaWork(workKind) && publicMediaMime(mime) && (workKind === "media" || mime.startsWith(workKind + "/")),
    400, "invalid_request", "Provide a supported media type for this work");
  assert(typeof filename === "string" && filename.length <= 200 && !/[\u0000-\u001f\u007f/\\]/.test(filename),
    400, "invalid_request", "Provide a media filename");
  const file = decodeChatFile({title: filename, mime, data});
  assert(file.mime === mime && file.data.length >= 12, 400, "attachment_type_blocked", "The media bytes do not match the file type");
  const extension = EXTENSIONS[mime];
  const lower = file.title.toLowerCase();
  const name = lower.endsWith("." + extension) || (mime === "image/jpeg" && lower.endsWith(".jpeg"))
    ? file.title : file.title + "." + extension;
  return {mime, filename: name, data: file.data};
}

export function publishedMediaView(ot: OtContext, listing: {id: string; listed: number; work_kind: string | null}) {
  if (!listing.listed || !isMediaWork(listing.work_kind)) return {};
  const file = ot.get<{mime: string; bytes: number}>("SELECT mime, bytes FROM ot_listing_media WHERE listing_id = ?", listing.id);
  return file && publicMediaMime(file.mime)
    ? {file_available: true as const, file_mime: file.mime, file_bytes: file.bytes}
    : {};
}

export function savePublishedMedia(ot: OtContext, id: string, ownerId: string, file: PublishedMedia) {
  ot.run(`INSERT INTO ot_listing_media (listing_id, owner_id, mime, filename, bytes, content) VALUES (?,?,?,?,?,?)
    ON CONFLICT(listing_id) DO UPDATE SET mime=excluded.mime, filename=excluded.filename, bytes=excluded.bytes, content=excluded.content`,
  id, ownerId, file.mime, file.filename, file.data.length, file.data);
}

function byteRange(header: string | undefined, size: number): {start: number; end: number} | false | null {
  if (!header || !/^bytes=/i.test(header) || header.includes(",")) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header);
  if (!match || (!match[1] && !match[2])) return false;
  if (match[1]) {
    const start = Number(match[1]);
    const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    return start <= end ? {start, end} : false;
  }
  const suffix = Number(match[2]);
  return suffix > 0 ? {start: Math.max(0, size - suffix), end: size - 1} : false;
}

export const downloadName = (name: string) => encodeURIComponent(name.replace(/[\ud800-\udfff]/gu, "\ufffd"))
  .replace(/['()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());

export function sendPublishedMedia(ot: OtContext, req: FastifyRequest, reply: FastifyReply) {
  const slug = params(req).slug;
  const head = req.method === "HEAD";
  const file = ot.tx(() => {
    const row = ot.get<{id: string; mime: string; filename: string; bytes: number}>(`
      SELECT l.id, f.mime, f.filename, f.bytes FROM ot_listing_media f JOIN ot_listings l ON l.id = f.listing_id
      WHERE l.slug = ? AND l.listed = 1 AND l.kind = 'work' AND l.work_kind IN ('media','image','audio','video')`, slug);
    if (!row || !publicMediaMime(row.mime)) return undefined;
    const {id, mime, filename, bytes} = row;
    const range = head || req.headers["if-range"] ? null : byteRange(req.headers.range, bytes);
    const offset = range ? range.start : 0;
    const length = range ? range.end - offset + 1 : bytes;
    const content = !head && range !== false
      ? ot.get<{part: Buffer}>("SELECT substr(content, ?, ?) AS part FROM ot_listing_media WHERE listing_id = ?", offset + 1, length, id)!.part
      : undefined;
    return {mime, filename, bytes, range, length, content};
  });
  if (!file) return undefined;
  const {range, bytes, length, mime, filename, content} = file;
  reply.header("Accept-Ranges", "bytes");
  if (range === false) return reply.code(416).header("Content-Range", `bytes */${bytes}`).send();
  if (range) reply.code(206).header("Content-Range", `bytes ${range.start}-${range.end}/${bytes}`);
  return reply.type(mime)
    .header("Content-Length", length)
    .header("Content-Disposition", `inline; filename="${slug}.${EXTENSIONS[mime]}"; filename*=UTF-8''${downloadName(filename)}`)
    .header("X-Content-Type-Options", "nosniff")
    .header("Content-Security-Policy", "default-src 'none'; sandbox")
    .send(content);
}
