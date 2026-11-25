import { assert } from "../errors.js";
import { checkFile, decodeCanonicalBase64, DEFAULT_ATTACHMENT_LIMITS } from "../attachments.js";
import type { OtContext } from "./core.js";

export const CHAT_FILE_MAX_BYTES = 8 * 1024 * 1024;
export const CHAT_FILE_BODY_LIMIT = Math.ceil(CHAT_FILE_MAX_BYTES / 3) * 4 + 32 * 1024;
const LIMITS = {...DEFAULT_ATTACHMENT_LIMITS, maxBytes: CHAT_FILE_MAX_BYTES};
const MEDIA: Record<string, string> = {
  mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", wav: "audio/wav",
  ogg: "audio/ogg", m4a: "audio/mp4", glb: "model/gltf-binary",
};
const mediaTypes = new Set(Object.values(MEDIA));
const resourceKinds = new Set(["document", "website", "slides", "spreadsheet", "dashboard", "whiteboard", "media"]);
const RESOURCE_COLUMN = "resource TEXT CHECK (resource IS NULL OR json_valid(resource))";
const STICKER_COLUMN = "sticker INTEGER NOT NULL DEFAULT 0 CHECK (sticker IN (0,1))";
const sniffMedia = (data: Buffer, mime: string) => {
  if (mime === "model/gltf-binary") return data.length >= 28 &&
    data.toString("ascii", 0, 4) === "glTF" && data.readUInt32LE(4) === 2 &&
    data.readUInt32LE(8) === data.length && data.toString("ascii", 16, 20) === "JSON";
  if (mime === "video/mp4" || mime === "audio/mp4") return data.toString("ascii", 4, 8) === "ftyp";
  if (mime === "video/webm") return data.subarray(0, 4).toString("hex") === "1a45dfa3";
  if (mime === "audio/ogg") return data.toString("ascii", 0, 4) === "OggS";
  if (mime === "audio/wav") return data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WAVE";
  return data.toString("ascii", 0, 3) === "ID3" || (data[0] === 0xff && (data[1] & 0xe0) === 0xe0);
};
const sniffImage = (data: Buffer, mime: string) => {
  if (mime === "image/png") return data.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
  if (mime === "image/jpeg") return data.subarray(0, 3).toString("hex") === "ffd8ff";
  if (mime === "image/gif") return ["GIF87a", "GIF89a"].includes(data.toString("ascii", 0, 6));
  return mime === "image/webp" && data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP";
};

export const CHAT_FILES_SCHEMA = `
CREATE TABLE IF NOT EXISTS ot_message_attachments (
  message_id TEXT PRIMARY KEY REFERENCES ot_messages(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL, title TEXT NOT NULL, mime TEXT NOT NULL,
  bytes INTEGER NOT NULL, sealed BLOB NOT NULL, ${RESOURCE_COLUMN}, ${STICKER_COLUMN}
);
CREATE INDEX IF NOT EXISTS ot_message_attachments_owner ON ot_message_attachments(owner_id);
`;

type ChatResource = {kind: string; title: string; revision: number};
type ChatFile = {title: string; mime: string; data: Buffer; resource?: ChatResource; sticker?: true};
export type ChatFileMetadata = {title: string; mime: string; bytes: number; resource: string | null; sticker: number};

export function migrateChatFiles(ot: OtContext) {
  const columns = ot.all<{name: string}>("PRAGMA table_info(ot_message_attachments)");
  if (!columns.some(column => column.name === "resource")) {
    ot.run(`ALTER TABLE ot_message_attachments ADD COLUMN ${RESOURCE_COLUMN}`);
  }
  if (!columns.some(column => column.name === "sticker")) {
    ot.run(`ALTER TABLE ot_message_attachments ADD COLUMN ${STICKER_COLUMN}`);
  }
}

function decodeChatResource(value: unknown): ChatResource | undefined {
  if (value === undefined) return undefined;
  assert(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every(key => ["kind", "title", "revision"].includes(key)),
  400, "invalid_request", "Invalid shared resource metadata");
  const {kind, title, revision} = value as Record<string, unknown>;
  assert(typeof kind === "string" && resourceKinds.has(kind)
    && typeof title === "string" && title.length <= 80 && title.trim() && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(title)
    && typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 1,
  400, "invalid_request", "Invalid shared resource metadata");
  return {kind, title, revision};
}

function resourceView(resource: string | null) {
  if (!resource) return {};
  const {kind, title, revision} = JSON.parse(resource) as ChatResource;
  return {resource: {kind, title, revision}};
}

export function chatFileView({title, mime, bytes, resource, sticker}: ChatFileMetadata) {
  return {title, mime, bytes, ...resourceView(resource), ...(sticker === 1 ? {sticker: true} : {})};
}

export function decodeChatFile(input: any): ChatFile {
  assert(typeof input?.title === "string" && typeof input?.data === "string", 400, "invalid_request", "Provide a file");
  const resource = decodeChatResource(input.resource);
  assert(input.data.length <= Math.ceil(CHAT_FILE_MAX_BYTES / 3) * 4,
    413, "attachment_too_large", "Files can contain up to 8 MiB");
  const data = decodeCanonicalBase64(input.data);
  assert(data?.length, 400, "invalid_request", "Invalid file data");
  assert(data.length <= CHAT_FILE_MAX_BYTES, 413, "attachment_too_large", "Files can contain up to 8 MiB");
  const mime = (typeof input.mime === "string" ? input.mime : "").toLowerCase().split(";")[0].trim();
  const extension = input.title.toLowerCase().split(".").at(-1) || "";
  const media = mediaTypes.has(mime) ? mime : Object.hasOwn(MEDIA, extension) ? MEDIA[extension] : "";
  // Reuse the same filename and executable checks for documents and playable media.
  const checked = checkFile(input.title, media ? "text/plain" : mime === "application/octet-stream" ? "" : mime, data, LIMITS);
  assert(checked.ok, 400, checked.ok ? "invalid_request" : checked.code, checked.ok ? "Invalid file" : checked.message);
  const type = media || checked.mime;
  if (media) assert(sniffMedia(data, media), 400, "attachment_type_blocked", "The media bytes do not match the file type");
  if (type.startsWith("image/")) assert(sniffImage(data, type), 400, "attachment_type_blocked", "The image bytes do not match the file type");
  assert(input.sticker === undefined || (input.sticker === true && type.startsWith("image/") && !resource),
    400, "invalid_request", "Stickers must be image attachments");
  return {title: checked.name, mime: type, data, resource, ...(input.sticker === true ? {sticker: true} : {})};
}

export function attachmentView(ot: OtContext, messageId: string) {
  const file = ot.get<ChatFileMetadata>("SELECT title,mime,bytes,resource,sticker FROM ot_message_attachments WHERE message_id=?", messageId);
  return file && chatFileView(file);
}

export function saveAttachment(ot: OtContext, messageId: string, ownerId: string, file: ChatFile) {
  const used = ot.get<{bytes: number}>(
    "SELECT COALESCE(SUM(bytes),0) AS bytes FROM ot_message_attachments WHERE owner_id=?", ownerId);
  assert((used?.bytes ?? 0) + file.data.length <= LIMITS.ownerBudgetBytes,
    413, "attachment_storage_full", "Your conversation attachment storage is full");
  ot.run(`INSERT INTO ot_message_attachments (message_id,owner_id,title,mime,bytes,sealed,resource,sticker) VALUES(?,?,?,?,?,?,?,?)`,
    messageId, ownerId, file.title, file.mime, file.data.length, ot.platform.sealChatAttachment(messageId, file.data),
    file.resource ? JSON.stringify(file.resource) : null, file.sticker ? 1 : 0);
}

export function readAttachment(ot: OtContext, conversationId: string, messageId: string): ChatFile {
  const file = ot.get<Omit<ChatFileMetadata, "bytes"> & {sealed: Buffer}>(`SELECT a.title,a.mime,a.sealed,a.resource,a.sticker FROM ot_message_attachments a
    JOIN ot_messages m ON m.id=a.message_id WHERE m.conversation_id=? AND m.id=? AND m.retracted=0`,
    conversationId, messageId);
  assert(file, 404, "message_not_found", "Attachment is no longer available");
  return {title: file.title, mime: file.mime, data: ot.platform.openChatAttachment(messageId, file.sealed),
    ...resourceView(file.resource), ...(file.sticker === 1 ? {sticker:true} : {})};
}
