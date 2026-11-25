/** Face-to-face rooms: 6-digit matching, membership, windowed history. See docs/FACE_ROOMS.md. */
import { randomBytes } from "node:crypto";
import { ApiError } from "./errors.js";
import { limitFromEnv } from "./policy.js";

export const FACE_ROOM_NAME_MAX = 60;
/** A member Bot's role label in a room roster (FlyBot #476): plain text, untrusted. */
export const FACE_ROOM_ROLE_MAX = 80;
/** Why a room ended, as its recap says it: the last seat left on its own, a seat was taken back, or the share that
 *  paid for it lapsed. */
export type FaceRoomCloseReason = "room_left" | "room_closed" | "expired";

export interface FaceRoomLimits {
  ttlMs: number;
  maxMembers: number;
  attemptsPerIp: number;
  attemptsPerAccount: number;
  attemptWindowMs: number;
  createsPerIp: number;
  createsPerAccount: number;
  createWindowMs: number;
  failsBeforeLockout: number;
  lockoutMs: number;
  /** How long an invite ticket for an established room stays valid (default 10 minutes). */
  inviteTtlMs: number;
  /** Invite-link mints. Their own window, not the 6-digit code-attempt budget (#69). */
  invitesPerAccount: number;
  invitesPerIp: number;
  inviteMintWindowMs: number;
}

export const DEFAULT_FACE_ROOM_LIMITS: FaceRoomLimits = {
  ttlMs: 10 * 60 * 1000,
  maxMembers: 8,
  attemptsPerIp: 20,
  attemptsPerAccount: 10,
  attemptWindowMs: 10 * 60 * 1000,
  createsPerIp: 5,
  createsPerAccount: 3,
  createWindowMs: 60 * 60 * 1000,
  failsBeforeLockout: 8,
  lockoutMs: 15 * 60 * 1000,
  inviteTtlMs: 10 * 60 * 1000,
  invitesPerAccount: 30,
  invitesPerIp: 60,
  inviteMintWindowMs: 10 * 60 * 1000,
};

/** Env vars (all optional, positive integers). Operator note: see README / docs/FACE_ROOMS.md. */
export function loadFaceRoomLimits(override: Partial<FaceRoomLimits> = {}): FaceRoomLimits {
  const env: Partial<FaceRoomLimits> = {
    ttlMs: envMs("BOTSOCIAL_FACE_ROOM_TTL_SECONDS", DEFAULT_FACE_ROOM_LIMITS.ttlMs / 1000),
    maxMembers: envN("BOTSOCIAL_FACE_ROOM_MAX_MEMBERS", DEFAULT_FACE_ROOM_LIMITS.maxMembers),
    attemptsPerIp: envN("BOTSOCIAL_FACE_ROOM_ATTEMPTS_PER_IP", DEFAULT_FACE_ROOM_LIMITS.attemptsPerIp),
    attemptsPerAccount: envN("BOTSOCIAL_FACE_ROOM_ATTEMPTS_PER_ACCOUNT", DEFAULT_FACE_ROOM_LIMITS.attemptsPerAccount),
    attemptWindowMs: envMs("BOTSOCIAL_FACE_ROOM_ATTEMPT_WINDOW_SECONDS", DEFAULT_FACE_ROOM_LIMITS.attemptWindowMs / 1000),
    createsPerIp: envN("BOTSOCIAL_FACE_ROOM_CREATES_PER_IP", DEFAULT_FACE_ROOM_LIMITS.createsPerIp),
    createsPerAccount: envN("BOTSOCIAL_FACE_ROOM_CREATES_PER_ACCOUNT", DEFAULT_FACE_ROOM_LIMITS.createsPerAccount),
    createWindowMs: envMs("BOTSOCIAL_FACE_ROOM_CREATE_WINDOW_SECONDS", DEFAULT_FACE_ROOM_LIMITS.createWindowMs / 1000),
    failsBeforeLockout: envN("BOTSOCIAL_FACE_ROOM_FAILS_BEFORE_LOCKOUT", DEFAULT_FACE_ROOM_LIMITS.failsBeforeLockout),
    lockoutMs: envMs("BOTSOCIAL_FACE_ROOM_LOCKOUT_SECONDS", DEFAULT_FACE_ROOM_LIMITS.lockoutMs / 1000),
    inviteTtlMs: envMs("BOTSOCIAL_FACE_ROOM_INVITE_TTL_SECONDS", DEFAULT_FACE_ROOM_LIMITS.inviteTtlMs / 1000),
    invitesPerAccount: envN("BOTSOCIAL_FACE_ROOM_INVITES_PER_ACCOUNT", DEFAULT_FACE_ROOM_LIMITS.invitesPerAccount),
    invitesPerIp: envN("BOTSOCIAL_FACE_ROOM_INVITES_PER_IP", DEFAULT_FACE_ROOM_LIMITS.invitesPerIp),
    inviteMintWindowMs: envMs("BOTSOCIAL_FACE_ROOM_INVITE_MINT_WINDOW_SECONDS", DEFAULT_FACE_ROOM_LIMITS.inviteMintWindowMs / 1000),
  };
  return { ...DEFAULT_FACE_ROOM_LIMITS, ...omitUndef(env), ...omitUndef(override) };
}

function envN(name: string, fallback: number): number | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  return limitFromEnv(v, fallback);
}
function envMs(name: string, fallbackSeconds: number): number | undefined {
  const n = envN(name, fallbackSeconds);
  return n === undefined ? undefined : n * 1000;
}
function omitUndef<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * Sanitize a peer-controlled name (bot display name, owner name) before it is stored or shown.
 * Strips `@`, control characters and newlines, collapses whitespace, caps length.
 */
export function sanitizePeerName(value: unknown, fallback = "", max = FACE_ROOM_NAME_MAX): string {
  const cleaned = String(value ?? "")
    .replace(/@/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
  return cleaned || fallback;
}

/**
 * A display name is peer-written data, whether it is arriving from a caller or already sitting in a row.
 * Clean it the same way in both directions: C0/C1 controls, U+2028/U+2029 and lone surrogates never reach a
 * reader, whitespace collapses, and the length cap counts **code points** so a surrogate pair is never cut in
 * half. The value is not coerced: a non-string yields the fallback, and each door decides what that means
 * (a 400 on an update, the identity's own name on a create).
 */
export function peerDisplayName(value: unknown, fallback = "", max = FACE_ROOM_NAME_MAX): string {
  if (typeof value !== "string") return fallback;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "")
    .replace(/@/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return [...cleaned].slice(0, max).join("") || fallback;
}

/**
 * The label a Bot is shown by on every read surface: its own name, else the fallback, else the cleaned handle.
 * One function so a row written before #106 is cleaned by the same rule wherever a reader meets it — a name is a
 * single-line label and is **not** fenced (fencing would change how every consumer reads it).
 */
export function peerBotName(b: { display_name?: unknown; handle?: unknown } | null | undefined, fallback = ""): string {
  return peerDisplayName(b?.display_name, sanitizePeerName(b?.handle, fallback));
}

/** The owner label that travels next to a Bot (a friend card, a face-room seat), cleaned by the same rule. */
export function peerOwnerName(o: { display_name?: unknown; username?: unknown } | null | undefined, fallback = ""): string {
  return peerDisplayName(o?.display_name, sanitizePeerName(o?.username, fallback));
}

/** Six decimal digits, nothing else. Does not look up a room (no leak). */
export function parseFaceCode(raw: unknown): string {
  const s = String(raw ?? "").trim();
  if (!/^\d{6}$/.test(s)) throw new ApiError(400, "invalid_code", "code must be exactly 6 digits");
  return s;
}

export function isFaceCode(raw: unknown): boolean {
  return /^\d{6}$/.test(String(raw ?? "").trim());
}

/** 32 random bytes, base64url (43 characters, 256 bits): a room invite ticket is a bearer credential. */
export const INVITE_TICKET_BYTES = 32;
export function newInviteTicket(): string {
  return randomBytes(INVITE_TICKET_BYTES).toString("base64url");
}
export function isInviteTicket(raw: unknown): raw is string {
  return typeof raw === "string" && /^[A-Za-z0-9_-]{43}$/.test(raw.trim());
}

export function memberLabel(displayName: string, ownerName: string): string {
  return `${displayName} · ${ownerName}`;
}

export function joinSystemText(ownerName: string, displayName: string): string {
  return `${ownerName}'s ${displayName} joined`;
}

export function leaveSystemText(ownerName: string, displayName: string): string {
  return `${ownerName}'s ${displayName} left`;
}

export function leadSystemText(lead: { display_name: string; owner_name: string } | null, reason: "set" | "cleared" | "lead_left" | "handover"): string {
  if (lead) return `Room lead: ${lead.owner_name}'s ${lead.display_name}`;
  return reason === "lead_left" ? "The room lead left. The default lead takes over." : "The room lead is back to the default.";
}

export const FACE_ROOM_SCHEMA = `
CREATE TABLE IF NOT EXISTS face_rooms (
  id TEXT PRIMARY KEY,
  code TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  started_at TEXT,
  closed_at TEXT,
  created_by_owner_id TEXT,
  lead_bot_id TEXT,
  note TEXT,
  recap TEXT
);
CREATE TABLE IF NOT EXISTS face_room_codes (
  code TEXT PRIMARY KEY,
  room_id TEXT NOT NULL UNIQUE REFERENCES face_rooms(id),
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS face_room_members (
  room_id TEXT NOT NULL REFERENCES face_rooms(id),
  bot_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  handle TEXT NOT NULL,
  display_name TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  published INTEGER NOT NULL DEFAULT 1,
  added_by_owner_id TEXT,
  joined_at TEXT NOT NULL,
  join_seq INTEGER NOT NULL DEFAULT 0,
  left_at TEXT,
  role TEXT,
  PRIMARY KEY (room_id, bot_id)
);
CREATE INDEX IF NOT EXISTS face_room_members_room ON face_room_members (room_id, left_at);
CREATE TABLE IF NOT EXISTS face_room_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  room_id TEXT NOT NULL REFERENCES face_rooms(id),
  type TEXT NOT NULL,
  actor_bot TEXT,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS face_room_events_room ON face_room_events (room_id, seq);
CREATE TABLE IF NOT EXISTS face_room_drafts (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES face_rooms(id),
  sender_bot TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  approval_id TEXT,
  event_seq INTEGER,
  created_at TEXT NOT NULL,
  created_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS face_room_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT,
  ip TEXT,
  code TEXT,
  outcome TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS face_room_attempts_owner ON face_room_attempts (owner_id, created_at);
CREATE INDEX IF NOT EXISTS face_room_attempts_ip ON face_room_attempts (ip, created_at);
CREATE TABLE IF NOT EXISTS face_room_invites (
  ticket TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES face_rooms(id),
  created_by_owner_id TEXT NOT NULL,
  created_by_bot TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  used_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  last_used_by_owner_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS face_room_invites_room ON face_room_invites (room_id, expires_at);
CREATE TABLE IF NOT EXISTS face_room_lockouts (
  key TEXT PRIMARY KEY,
  until TEXT NOT NULL,
  fails INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
`;
