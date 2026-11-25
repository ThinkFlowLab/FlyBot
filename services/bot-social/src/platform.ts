import Database from "better-sqlite3";
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { AuditLog, type AuditRecord } from "./audit.js";
import { openDb } from "./db.js";
import { ApiError, assert } from "./errors.js";
import { newId, randomToken } from "./ids.js";
import { seal, unseal, publicRawFromPrivatePem } from "./custody.js";
import { Envelope, envelopeSigningInput, generateEd25519, signEnvelope, hashToken, jcs, payloadDigest, sha256Hex as sha256Text, signString, verifyString, webhookSignature, publicKeyFromRaw } from "./crypto.js";
import { ACTIONS, CAPABILITIES, DEFAULT_CAPABILITIES, INTENTS, LIMITS, MVP_GRANTABLE, POLICY_VERSION, calendarDetailLeak, detectInjection, detectLoop, dlpScan, dlpText } from "./policy.js";
import { WebhookOptions, WebhookPusher, redactHeaders, redactUrl, validateHeaders, validateUrl } from "./webhooks.js";
import { AttachmentLimits, AttachmentRef, DEFAULT_ATTACHMENT_LIMITS, checkFile, decodeCanonicalBase64, humanSize, refOf, sealBytes, sha256Hex, unsealBytes } from "./attachments.js";
import { avatarFingerprint, lookOf, validateAvatar, validateColor } from "./bot-look.js";
import { PRESENCE_DEFAULT_TTL_S, PRESENCE_MAX_TTL_S, PRESENCE_MIN_TTL_S, PRESENCE_WRITES_PER_MIN, PresenceStore } from "./presence.js";
import { clipToDailyHours, ianaTimezone, isoInTz, localMinutes, localWeekday, overlaps, parseHours } from "./time.js";
import {
  FACE_ROOM_NAME_MAX, FACE_ROOM_ROLE_MAX, FaceRoomCloseReason, FaceRoomLimits, isFaceCode, isInviteTicket, joinSystemText, leadSystemText, leaveSystemText, loadFaceRoomLimits, memberLabel, newInviteTicket, peerBotName, peerDisplayName, peerOwnerName, sanitizePeerName,
} from "./face-rooms.js";
import { LOCAL_INVITE_MAX_BOTS, LOCAL_INVITE_NO_DEADLINE, isLocalInviteTicket, isLocalRoomId, newLocalInviteTicket } from "./local-room-invites.js";
import {
  GITHUB_PROVIDER, OAuthConfig, OAuthExchangeError, OAuthOptions, OAuthProfile,
  newOAuthSecret, newPkceVerifier, oauthBindingCookie, oauthClearCookie, oauthConfigFrom, pkceChallenge,
  readOAuthCookie, subjectFingerprint, timingSafeEqualString,
} from "./oauth.js";
import { AuthRateBlock, AuthRateLimiter, AuthRateLimits, loadAuthRateLimits } from "./auth-limit.js";

export type Principal = { kind: "owner"; ownerId: string; scope?: "connector"; tokenId?: string; attestTyped?: boolean } | { kind: "bot"; botId: string; ownerId: string };

/** One callback turn, as the route needs it: a redirect, the HTML page, or a 502 — always with the cookie clear. */
export interface OAuthCallbackResult {
  status: number;
  location?: string;
  /** The API-side code; the console fragment uses its own namespace (§13). */
  apiCode?: string;
  clearCookie: string;
}

/** Comparison key for a Bot handle: surrounding spaces and an optional leading `@` removed, lowercased.
 *  Writes store this form; lookups compare `LOWER(handle)` with it, so `@Zed.Bot` and `@zed.bot` are one Bot. */
const handleKey = (ref: unknown) => String(ref ?? "").trim().replace(/^@/, "").toLowerCase();
/** The handle as the caller spelled it (spaces and one leading `@` removed, case kept). */
const handleRef = (ref: unknown) => String(ref ?? "").trim().replace(/^@/, "");
/** The owner's one-line card on a Bot: trimmed, 1-280 chars, null when unset. */
const BOT_DESCRIPTION_MAX = 280;
/** A reference that names rows differing only by case is refused, never guessed. */
const ambiguous = (raw: string, n: number) => new ApiError(409, "ambiguous_handle", `"${raw}" matches ${n} Bots that differ only by case; name the exact handle`);
/** In-memory version of the same rule: exact spelling wins, else the unique case-insensitive match. */
const pickByHandle = <T extends { handle?: string | null }>(rows: T[], ref: unknown): T | undefined => {
  const raw = handleRef(ref);
  if (!raw) return undefined;
  const exact = rows.find((r) => String(r.handle ?? "").replace(/^@/, "") === raw);
  if (exact) return exact;
  const ci = rows.filter((r) => handleKey(r.handle) === raw.toLowerCase());
  if (ci.length > 1) throw ambiguous(raw, ci.length);
  return ci[0];
};

/**
 * A row of `relationships`: the two endpoint Bots and the owners behind them. One pair can hold several rows —
 * a friendship (`active`) and one `room` row per shared room — and code that picks a door must say which one.
 */
export type Relationship = { id: string; requester_bot: string; target_bot: string; requester_owner: string; target_owner: string; status: string; created_at: string; updated_at: string; [column: string]: any };

export interface PlatformOptions { kmsKey?: Buffer; dbPath?: string; auditPath?: string; publicBaseUrl?: string; fetchImpl?: typeof fetch; webhooks?: WebhookOptions; attachments?: Partial<AttachmentLimits>; now?: () => number; faceRooms?: Partial<FaceRoomLimits>; authRateLimit?: Partial<AuthRateLimits> }

/** GitHub OAuth (#76) is configured through the constructor like every other option, but the declaration is
 *  kept separate from the line above so the auth work in flight does not collide with it textually. */
export interface PlatformOptions { oauth?: OAuthOptions }

/**
 * Why a held send waits (#49), so a client branches on one field instead of reading `policy.reasons`.
 * The strongest finding wins: risk > attachment > policy > blanket_outbound. `blanket_outbound` is the
 * owner's own default hold and the only one a connector may decide; everything else is the owner's.
 *
 * `face_room_auto_send_off` (#49 follow-up) is a face-room draft that nothing else holds: the room's own
 * Auto-send switch is off. It cannot be folded into `blanket_outbound`, or a connector allowed to clear a
 * blanket hold could clear this card too and send into a room whose Auto-send the owner turned off.
 */
export type HoldReason = "blanket_outbound" | "risk" | "attachment" | "policy" | "face_room_auto_send_off";
export function holdReasonOf(found: { riskFlags?: readonly unknown[]; attachments?: readonly unknown[]; injectionSuspected?: boolean } = {}): HoldReason {
  if ((found.riskFlags?.length ?? 0) > 0) return "risk";
  if ((found.attachments?.length ?? 0) > 0) return "attachment";
  if (found.injectionSuspected) return "policy";
  return "blanket_outbound";
}

const nowIso = () => new Date().toISOString();
/** A chat is live while its row is not stored `closed` and its 72-hour clock has not run out. The clock is a read
 *  rule, not a writer (`materializeExpiry` runs only when a door is touched), so every query that offers a chat asks
 *  the question here; `reportedConvState` answers it for a row already in hand. */
const CHAT_LIVE_SQL = "(c.status != 'closed' AND (c.expires_at IS NULL OR c.expires_at > ?))";
/** Why a home could not hand a delivered message to its Bot (reportNotDelivered). A fixed list: the sender is shown a fixed line. */
const NOT_DELIVERED_REASONS = ["not_shared_yet"];
/** A join budget counts real door checks only, both the 6-digit code and the invite ticket. A request refused
 *  for being over budget is not another check, so counting it cannot keep the budget full by itself. `already_member`
 *  is the opposite of a check: the ticket did its work and this home already holds the seat, so a repeat is an answer
 *  lost in transit, not a guess — recorded, not counted (the local-room door answers the same repeat with success). */
const FACE_JOIN_OUTCOMES = ["invalid_code", "room_full", "code_void", "created", "joined", "rejoined",
  "invited", "invite_not_found", "ended", "revoked", "expired",
  "claimed", "already_claimed", "bot_revoked", "bot_frozen"];
/** Invite previews are reads: they get their own per-address budget and never spend the join one. */
const FACE_PREVIEW_OUTCOMES = ["preview", "invite_not_found", "ended", "revoked", "expired", "bot_frozen"];
const J = (s: string | null | undefined, d: any = null) => (s ? JSON.parse(s) : d);
const ms = (iso: string) => {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new ApiError(400, "invalid_time", `bad timestamp: ${iso}`);
  return t;
};

function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${scryptSync(pw, salt, 32).toString("hex")}`;
}
function checkPassword(pw: string, stored: string): boolean {
  const [, salt, hash] = stored.split("$");
  const got = scryptSync(pw, Buffer.from(salt, "hex"), 32);
  return timingSafeEqual(got, Buffer.from(hash, "hex"));
}

/** A salted scrypt hash of a throwaway password. An unknown username is checked against it so that it costs
 *  the same work as a known one: the reply time must not tell a client whether the account exists. */
const DUMMY_PASSWORD_HASH = hashPassword(randomBytes(16).toString("hex"));

/**
 * The core platform: identity, relationships, grants, conversations, approvals,
 * calendar capability (mock), events/webhooks and audit. HTTP / MCP layers are thin wrappers.
 */
/** Parse a stored mentions column (JSON array of handles, or null). */
function mentionsOf(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch { return []; }
}

/**
 * The most `structured` a message may carry: 32768 bytes of its JSON serialization. It is a machine-readable contract
 * between two Bots -- a schema name and a few fields -- not a document; anything larger belongs in an attachment,
 * which has its own per-file, per-owner and TTL limits. The draft door and the owner-edit door read this one
 * number, so a payload cannot be refused on one and accepted on the other.
 */
const STRUCTURED_MAX_BYTES = 32768;

/** The 413 answer both doors share, named like `attachment_storage_full`'s `used_bytes` / `limit_bytes`. */
function structuredOverLimit(structured: unknown): { size_bytes: number; limit_bytes: number } | null {
  if (structured === undefined || structured === null) return null;
  const size = Buffer.byteLength(JSON.stringify(structured), "utf8");
  return size > STRUCTURED_MAX_BYTES ? { size_bytes: size, limit_bytes: STRUCTURED_MAX_BYTES } : null;
}

function structuredTooLarge(over: { size_bytes: number; limit_bytes: number }) {
  return new ApiError(413, "structured_too_large",
    `structured serializes to ${over.size_bytes} bytes; the limit is ${over.limit_bytes} bytes — put larger payloads in an attachment`, over);
}

/**
 * What an owner's edit may change on a held line: the text, the structured payload, the reply expectation. Nothing
 * else is merged into the delivered payload -- an attachment ref in an edit never passed the draft's attachment
 * checks, and `trust`, a mention list or a platform flag must never be writable through this door. `attachments: []`
 * is tolerated (the console sends the list back), but the draft's own refs are kept because the merge starts from
 * the signed payload. A refused edit throws before anything is written.
 */
function editedPayloadOf(body: any): { text: string; structured?: unknown; expects_reply?: boolean } {
  const ep = body?.edited_payload;
  assert(ep && typeof ep === "object" && !Array.isArray(ep), 400, "invalid_request", "edited_payload must be an object");
  assert(typeof ep.text === "string" && ep.text.length >= 1 && ep.text.length <= 4000, 400, "invalid_request", "edited_payload.text (1-4000 chars) required");
  const out: { text: string; structured?: unknown; expects_reply?: boolean } = { text: ep.text };
  if (ep.structured !== undefined) {
    assert(ep.structured === null || (typeof ep.structured === "object" && !Array.isArray(ep.structured)), 400, "invalid_request", "edited_payload.structured must be an object or null");
    const over = structuredOverLimit(ep.structured);
    if (over) throw structuredTooLarge(over);
    out.structured = ep.structured;
  }
  if (ep.expects_reply !== undefined) {
    assert(typeof ep.expects_reply === "boolean", 400, "invalid_request", "edited_payload.expects_reply must be a boolean");
    out.expects_reply = ep.expects_reply;
  }
  const atts = ep.attachments;
  assert(atts === undefined || (Array.isArray(atts) && atts.length === 0), 400, "invalid_request", "attachments cannot be added or changed at approval; edit the draft instead");
  return out;
}

/** An owner-side write body is a JSON object or absent. `null` is normalised to `{}` by the route, and `{}` is a
 *  legal "take the default" body; a string, number, boolean or array is a 400. Without this, `POST /v1/invites`
 *  with `"x"` minted a live link for the caller's oldest Bot. */
function ownerWriteBody(body: any): any {
  if (body === undefined) return {};
  assert(body !== null && typeof body === "object" && !Array.isArray(body), 400, "invalid_request", "body must be a JSON object");
  return body;
}

/** #211: capabilities whose implementation reads a grant's `scope`. Free/busy is the only one: it bounds the
 *  query by `window_days` and `hours` (`freebusy`); every other capability ignores `scope`, so a scope sent
 *  with it is refused instead of stored with no effect. */
const SCOPED_CAPABILITIES = new Set(["calendar.freebusy.read"]);

export class Platform {
  sealChatAttachment(messageId: string, data: Buffer): Buffer {
    return sealBytes(this.kmsKey, data, `chat-attachment:${messageId}`);
  }

  openChatAttachment(messageId: string, data: Buffer): Buffer {
    return unsealBytes(this.kmsKey, data, `chat-attachment:${messageId}`);
  }

  meetingInviteCode(roomId: string): string {
    return createHmac("sha256", this.kmsKey)
      .update("flybot-workspace/meeting-invite/v1:").update(roomId)
      .digest("base64url").slice(0, 24);
  }
  db: Database.Database;
  audit: AuditLog;
  platformKey = generateEd25519();
  platformKid = "platform_" + new Date().toISOString().slice(0, 7).replace("-", "_");
  publicBaseUrl: string;
  private fetchImpl: typeof fetch;
  readonly webhooks: WebhookPusher;

  private kmsKey: Buffer;
  /** Events written inside `atomically`, waiting for that write to commit before they reach the push queue (#511).
   *  The queue is memory, not a table, so an event row a rollback takes back must not leave a push behind. */
  private afterCommitPushes: { botId: string; ev: { event_id: string; type: string; created_at: string; data: Record<string, unknown> } }[] | null = null;
  /** Audit records written while a transaction is open, waiting for that level of transaction to commit (#575, #578).
   *  The audit log is its own SQLite file, so a record written inside a transaction outlives a rollback of the write
   *  it describes — it would keep naming grants the platform refused to make. Each level holds its own queue: a
   *  commit hands the rows to the enclosing level, and a rollback drops that level's rows and leaves the enclosing
   *  level's alone, so a nested transaction whose failure the enclosing one catches cannot have its records ride the
   *  outer commit. `policy.decision` is never held: it records a decision already answered to the caller, not a
   *  write that can still be taken back. */
  private pendingAudits: { actor: string; action: string; subject: string | null; owners: (string | null | undefined)[]; data: unknown }[] | null = null;
  readonly attachmentLimits: AttachmentLimits;
  readonly faceRoomLimits: FaceRoomLimits;
  /** GitHub OAuth (#76), decided once at startup. `enabled` is the constant every gate and the /ui meta read. */
  readonly oauth: OAuthConfig;
  readonly oauthProviderId: string | null;
  readonly authRateLimits: AuthRateLimits;
  private readonly authLimiter: AuthRateLimiter;
  /** Ephemeral "thinking" signals (memory only, see presence.ts). */
  readonly presence = new PresenceStore();
  nowMs: () => number;
  constructor(opts: PlatformOptions = {}) {
    this.attachmentLimits = { ...DEFAULT_ATTACHMENT_LIMITS, ...Object.fromEntries(Object.entries(opts.attachments ?? {}).filter(([, v]) => typeof v === "number" && v > 0)) };
    this.faceRoomLimits = loadFaceRoomLimits(opts.faceRooms);
    this.nowMs = opts.now ?? (() => Date.now());
    this.authRateLimits = loadAuthRateLimits(opts.authRateLimit);
    this.authLimiter = new AuthRateLimiter(this.authRateLimits, () => this.nowMs());
    this.db = openDb(opts.dbPath ?? ":memory:");
    this.audit = new AuditLog(opts.auditPath ?? ":memory:");
    this.auditFollowsCommit();
    this.publicBaseUrl = opts.publicBaseUrl ?? "http://localhost:8787";
    this.kmsKey = opts.kmsKey ?? randomBytes(32);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.webhooks = new WebhookPusher(this.db, this.fetchImpl, () => this.publicBaseUrl, opts.webhooks);
    this.oauth = oauthConfigFrom(process.env, opts.oauth);
    this.oauthProviderId = this.oauth.enabled ? GITHUB_PROVIDER.id : null;
    this.audit.append("platform", "platform.started", null, [], { policy_version: POLICY_VERSION, platform_kid: this.platformKid, platform_public_key: this.platformKey.publicKey });
  }
  private ts() { return new Date(this.nowMs()).toISOString(); }

  close() { this.webhooks.stop(); this.db.close(); this.audit.db.close(); }
  /** Send queued (debounced) webhook pushes now and wait for them. */
  async flushWebhooks() { await this.webhooks.flush(); }

  // ================================================================ helpers
  private get<T = any>(sql: string, ...args: unknown[]): T | undefined { return this.db.prepare(sql).get(...args) as T | undefined; }
  private all<T = any>(sql: string, ...args: unknown[]): T[] { return this.db.prepare(sql).all(...args) as T[]; }
  private run(sql: string, ...args: unknown[]) { return this.db.prepare(sql).run(...args); }

  bot(id: string) {
    const b = this.get("SELECT * FROM bots WHERE id = ?", id);
    assert(b, 404, "bot_not_found", `bot ${id} not found`);
    return b;
  }
  botByHandle(handle: string) {
    const b = this.botByRef(handle);
    assert(b, 404, "bot_not_found", `bot ${handle} not found`);
    return b;
  }

  /** Bot lookup by handle: the exact spelling wins; only when nothing matches exactly does the unique
   *  case-insensitive match count. Two rows that differ only by case make a case-variant reference
   *  ambiguous — refuse rather than silently pick one, so an old mixed-case row cannot shadow the real Bot. */
  private botByRef(ref: unknown, where = "", args: unknown[] = []) {
    const raw = handleRef(ref);
    if (!raw) return undefined;
    const tail = where ? ` AND ${where}` : "";
    const exact = this.get(`SELECT * FROM bots WHERE handle = ?${tail}`, raw, ...args);
    if (exact) return exact;
    const rows = this.all(`SELECT * FROM bots WHERE LOWER(handle) = ?${tail}`, raw.toLowerCase(), ...args);
    if (rows.length > 1) throw ambiguous(raw, rows.length);
    return rows[0];
  }
  owner(id: string) {
    const o = this.get("SELECT * FROM owners WHERE id = ?", id);
    assert(o, 404, "owner_not_found");
    return o;
  }
  /** Two different things here, and only one of them is opt-in.
   *  `look` (avatar/color) is opt-in per call site: it is added only where the viewer may already see the Bot
   *  (own bots, active friends, grants, profile.read).
   *  `display_name` and `owner_display_name` are not opt-in: they are the peer's own names, written by the
   *  peer's owner, and they reach every surface that names a peer — events, messages, invites, pending
   *  requests and approval cards. They are cleaned here on read as well as on write, because rows written
   *  before the write-side check (legacy SQLite rows are the likeliest) may still hold control characters,
   *  an over-long name or an empty string. */
  private publicBot(b: any, look = false) {
    const o = this.owner(b.owner_id);
    return { bot_id: b.id, handle: "@" + b.handle, display_name: peerBotName(b), owner_display_name: peerOwnerName(o), owner_verified: true, ...(look ? lookOf(b) : {}) };
  }
  /** The Bot as a card: the names every surface already carries, plus the owner's one-line description.
   *  Kept separate from `publicBot` so events, messages and approval cards keep their existing shape; only
   *  the surfaces where a person decides whether to connect (own Bots, invite preview, friends, profile) use it. */
  private botCard(b: any, look = false) {
    return { ...this.publicBot(b, look), description: b.description ?? null };
  }
  private requireOwner(p: Principal): string {
    if (p.kind !== "owner") throw new ApiError(403, "owner_only", "this operation can only be performed by the owner");
    return p.ownerId;
  }
  private requireBot(p: Principal): { botId: string; ownerId: string } {
    if (p.kind !== "bot") throw new ApiError(403, "bot_only", "this operation must be performed with a bot token");
    return p;
  }

  /** Append an event to a bot's queue (pull via /v1/events or MCP) and push to its webhook if configured.
   *  Inside `atomically` the push waits for the commit: the event row rolls back with the write it describes, and a
   *  push naming an event that is in no table would tell the Bot about a change that never happened. */
  emit(botId: string, type: string, data: Record<string, unknown>) {
    const ev = this.appendEvent(botId, type, data);
    if (this.afterCommitPushes) this.afterCommitPushes.push({ botId, ev });
    else this.webhooks.enqueue(botId, ev);
    return ev.event_id;
  }

  /** Run `fn` as one transaction whose events are handed to the push queue only once it commits. A throw rolls every
   *  row back and drops the queued pushes with it, so the Bots are only ever told about writes that are durable. */
  private atomically<T>(fn: () => T): T {
    const outer = this.afterCommitPushes;
    const queued: NonNullable<Platform["afterCommitPushes"]> = [];
    this.afterCommitPushes = queued;
    let out: T;
    try {
      out = this.db.transaction(fn)();
    } catch (e) {
      this.afterCommitPushes = outer;
      throw e;
    }
    this.afterCommitPushes = outer;
    // A nested `atomically` is a savepoint inside the transaction around it: its writes are not durable when it
    // returns, so handing the pushes to the queue here would page a Bot about a write the outer rollback takes back
    // (`settlePendingRelationships` settles a request's cards through `expireApproval`, which opens one of its own).
    // Hand them up instead, exactly as `auditFollowsCommit` hands its records up, and let the outermost commit enqueue.
    if (outer) {
      for (const p of queued) outer.push(p);
      return out;
    }
    for (const p of queued) this.webhooks.enqueue(p.botId, p.ev);
    return out;
  }

  /** Make every audit record follow the write it describes (#575). The audit log is a second SQLite file, so a
   *  record written inside a transaction is durable the moment it is written — a rollback of that transaction
   *  leaves it behind, naming access the platform refused to give (`writeActivation` writes one `grant.created`
   *  per grant and can still refuse the request on a later capability's expiry). Records written while a
   *  transaction is open are therefore held, in order, and appended only once the outermost transaction commits;
   *  a rollback drops them. `policy.decision` is written immediately: a refusal has already been answered to the
   *  caller, so it is a fact even when the write it refused never happened. */
  private auditFollowsCommit() {
    const append = this.audit.append.bind(this.audit);
    this.audit.append = ((actor, action, subject, owners, data = {}) => {
      if (this.db.inTransaction && action !== "policy.decision") {
        (this.pendingAudits ??= []).push({ actor, action, subject, owners, data });
        // No caller reads the record back; the log is the only place it lives.
        return null as unknown as AuditRecord;
      }
      return append(actor, action, subject, owners, data);
    }) as AuditLog["append"];

    // Hooking the transaction, not each call site. Each level holds its own queue: an inner transaction is a
    // savepoint, and a savepoint that fails can be caught by the transaction around it, which then commits. Handing
    // the inner rows up only when the inner level commits — and dropping them when it rolls back — keeps a record
    // from outliving the write it describes at every depth. The outermost commit appends in write order.
    const transaction = this.db.transaction.bind(this.db);
    (this.db as any).transaction = (fn: () => unknown) => {
      const run = transaction(fn);
      const once = (call: () => unknown) => {
        const enclosing = this.pendingAudits;
        const held: NonNullable<Platform["pendingAudits"]> = [];
        this.pendingAudits = held;
        let out: unknown;
        try { out = call(); }
        catch (e) { this.pendingAudits = enclosing; throw e; }
        this.pendingAudits = enclosing;
        if (enclosing === null) {
          for (const r of held) append(r.actor, r.action, r.subject, r.owners, r.data);
        } else {
          enclosing.push(...held);
        }
        return out;
      };
      const wrapped = ((...args: unknown[]) => once(() => (run as any)(...args))) as any;
      for (const kind of ["deferred", "immediate", "exclusive"] as const) {
        wrapped[kind] = (...args: unknown[]) => once(() => (run as any)[kind](...args));
      }
      return wrapped;
    };
  }

  /** Write one event row and hand it back in the shape the webhook queue pushes, so a caller can write the row with
   *  the change it describes, inside that change's transaction, and queue the push only once it has committed. */
  private appendEvent(botId: string, type: string, data: Record<string, unknown>) {
    const id = newId("evt");
    const created_at = nowIso();
    this.run("INSERT INTO events (id, bot_id, type, data, created_at) VALUES (?,?,?,?,?)", id, botId, type, JSON.stringify(data), created_at);
    return { event_id: id, type, created_at, data };
  }

  private countersign(obj: Record<string, unknown>): string {
    return signString(this.platformKey.privateKeyPem, jcs(obj));
  }
  verifyCountersig(obj: Record<string, unknown>): boolean {
    const { platform_countersig, ...rest } = obj as any;
    return verifyString(this.platformKey.publicKey, jcs(rest), platform_countersig);
  }

  // ================================================================ owners & auth
  registerOwner(body: { username: string; display_name?: string; password: string; timezone?: string }) {
    // A username is a string, so the type gate comes before the format regex: `/…/.test(["ab"])` stringifies and
    // passes, and the array then reaches the INSERT (or a boolean reaches the SELECT as a parameter). An absent
    // username keeps the format message it always had.
    assert(body?.username === undefined || typeof body.username === "string", 400, "invalid_request", "username must be a string");
    assert(body?.username && /^[a-z0-9._-]{2,32}$/i.test(body.username), 400, "invalid_request", "username: 2-32 chars [a-z0-9._-]");
    assert(typeof body.password === "string" && body.password.length >= 6, 400, "invalid_request", "password must be >= 6 chars");
    // A name is one account whatever its spelling: the sign-in budget already folds every spelling onto one
    // lowercased key, so "frank" and "Frank" must not both register and then share that budget. The comparison is
    // application-level (SQLite's own `LOWER`, which folds exactly the ASCII this format allows); the schema keeps
    // its exact-spelling unique index, and no row is rewritten.
    assert(!this.get("SELECT 1 FROM owners WHERE LOWER(username) = LOWER(?)", body.username), 409, "username_taken");
    assert(body.display_name === undefined || typeof body.display_name === "string", 400, "invalid_request", "display_name must be a string");
    const displayName = peerDisplayName(body.display_name, body.username);
    // Absent timezone keeps today's default; a supplied one must be a zone Intl can use (P5).
    const timezone = body.timezone ? this.validateTimezone(body.timezone) : "Asia/Shanghai";
    const id = newId("own");
    this.run("INSERT INTO owners (id, username, display_name, password_hash, timezone, created_at) VALUES (?,?,?,?,?,?)",
      id, body.username, displayName, hashPassword(body.password), timezone, nowIso());
    this.audit.append(`owner:${id}`, "owner.registered", id, [id], { username: body.username });
    // The sign-up is not a failed attempt against the account it just created: a brand-new owner starts its window
    // with nothing spent, so the first wrong passwords after it are judged on their own count.
    this.authLimiter.forgiveAccount(body.username);
    return { owner_id: id, owner_token: this.issueToken("owner", id) };
  }

  /** Write-side IANA check (P5): Intl is the authority on what a zone name means, so a string it refuses is a
   *  400 invalid_timezone here instead of an owners row that 500s every calendar/freebusy answer later. */
  private validateTimezone(raw: unknown): string {
    const tz = ianaTimezone(raw);
    if (!tz) throw new ApiError(400, "invalid_timezone", 'timezone must be an IANA zone name, e.g. "Asia/Shanghai" or "UTC"');
    return tz;
  }

  login(body: { username: string; password: string }) {
    // The username goes straight into the SELECT, so a value of the wrong type must be refused before it is bound: an
    // object is read by better-sqlite3 as a named-parameter bag and a boolean is refused outright, and both used to
    // surface as a 500. An absent username is still the missing field it always was, and keeps answering 401.
    assert(body?.username === undefined || typeof body.username === "string", 400, "invalid_request", "username must be a string");
    const o = this.get("SELECT * FROM owners WHERE username = ?", body?.username);
    // The password check runs before the existence branch on purpose: an unknown name pays for one scrypt
    // hash against a fixed dummy, so its timing matches a known name with a wrong password.
    const ok = checkPassword(String(body?.password ?? ""), o?.password_hash ?? DUMMY_PASSWORD_HASH);
    if (!o || !ok) throw new ApiError(401, "invalid_credentials");
    this.audit.append(`owner:${o.id}`, "owner.login", o.id, [o.id]);
    // The door accepted this name and its secret, so the failed attempts before it are not a reason to refuse the next
    // correct one. Only the account bucket is cleared: the address bucket keeps counting the burst (see forgiveAccount).
    this.authLimiter.forgiveAccount(body.username);
    return { owner_id: o.id, owner_token: this.issueToken("owner", o.id) };
  }

  /** One attempt at a password door (login, sign-up, onboarding). Returns a refusal when the client address
   *  or the named account has used up its window; a refused attempt is not counted again. */
  authAttempt(keys: { ip?: string | null; account?: string | null }): AuthRateBlock | null {
    return this.authLimiter.take(keys);
  }

  /** Revoke the login token that made this request. The console's "Log out" used to forget the token locally
   *  only, so a copied token stayed valid. Connector tokens are deliberately not accepted here (they are
   *  listed and revoked separately); this signs out one login session, not every session of the owner. */
  logout(p: Principal, token: string | undefined) {
    const ownerId = this.requireOwner(p);
    const row = token
      ? this.get("SELECT * FROM tokens WHERE token_hash = ? AND kind = 'owner' AND scope IS NULL AND revoked_at IS NULL", hashToken(token))
      : undefined;
    assert(row && row.subject_id === ownerId, 401, "unauthorized", "invalid or revoked token");
    this.run("UPDATE tokens SET revoked_at = ? WHERE token_hash = ?", nowIso(), row.token_hash);
    this.audit.append(`owner:${ownerId}`, "owner.logout", ownerId, [ownerId], {});
    return { ok: true };
  }

  private issueToken(kind: "owner" | "bot", subject: string, via: "password" | "oauth:github" = "password") {
    const t = randomToken(kind === "owner" ? "otk" : "btk");
    this.run("INSERT INTO tokens (token_hash, kind, subject_id, created_at, via) VALUES (?,?,?,?,?)", hashToken(t), kind, subject, nowIso(), via);
    return t;
  }

  authenticate(token: string | undefined): Principal {
    assert(token, 401, "unauthorized", "missing bearer token");
    const row = this.get("SELECT * FROM tokens WHERE token_hash = ? AND revoked_at IS NULL", hashToken(token));
    assert(row, 401, "unauthorized", "invalid or revoked token");
    if (row.kind === "owner") {
      if (row.scope === "connector") {
        this.run("UPDATE tokens SET last_used_at = ? WHERE token_hash = ?", nowIso(), row.token_hash);
        return { kind: "owner", ownerId: row.subject_id, scope: "connector", tokenId: row.id, attestTyped: row.attest_typed === 1 };
      }
      // a login (owner console / REST) session is the person at the keyboard
      return { kind: "owner", ownerId: row.subject_id, attestTyped: true };
    }
    const b = this.bot(row.subject_id);
    return { kind: "bot", botId: b.id, ownerId: b.owner_id };
  }

  // ================================================================ connector tokens (owner MCP)
  /** Labelled, revocable owner token that only works at /mcp. Minting needs a full (login) owner token. */
  createConnectorToken(p: Principal, body: { label?: string; attest_typed_by_owner?: boolean }) {
    const ownerId = this.requireOwner(p);
    assert(p.kind === "owner" && !p.scope, 403, "forbidden", "a connector token cannot mint tokens");
    // A label is the name the owner will read back in the token list, and `String(...)` below is what reads it:
    // an object was stored and answered as "[object Object]", a fraction as "1.5", a boolean as "true", and an
    // array was flattened to its text — a name nobody typed, on a token that is live from that moment. Both
    // doors (`POST /v1/connector-tokens` and `POST /v1/onboard`) come through here, so the type is judged once,
    // before the active-token count and the INSERT: a refusal writes no token, and onboard's owner, bot and key
    // rows roll back with it. An absent, null or empty label still means the default.
    assert(body?.label === undefined || body?.label === null || typeof body.label === "string", 400, "invalid_request", "label must be a string");
    const label = String(body?.label ?? "Grok Bot").trim().slice(0, 60) || "Grok Bot";
    assert((this.get("SELECT COUNT(*) n FROM tokens WHERE kind='owner' AND scope='connector' AND subject_id = ? AND revoked_at IS NULL", ownerId).n) < 20, 409, "too_many_tokens", "revoke an old connector token first (max 20 active)");
    const id = newId("ctk");
    const token = randomToken("otk");
    const attest = body?.attest_typed_by_owner === true ? 1 : 0;
    this.run("INSERT INTO tokens (token_hash, kind, subject_id, created_at, id, label, scope, attest_typed) VALUES (?,?,?,?,?,?,?,?)", hashToken(token), "owner", ownerId, nowIso(), id, label, "connector", attest);
    this.audit.append(`owner:${ownerId}`, "connector_token.created", id, [ownerId], { label, attest_typed_by_owner: !!attest });
    return { token_id: id, label, token, attest_typed_by_owner: !!attest, ...this.connectorConfig(token) };
  }

  connectorConfig(token: string) {
    const url = `${this.publicBaseUrl}/mcp`;
    return {
      mcp_url: url,
      headers: { Authorization: `Bearer ${token}` },
      json_config: { mcpServers: { "bot-social": { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } },
      paste_to_grok_bot: `Please add an MCP server (custom connector): name Bot Social, URL ${url}, transport Streamable HTTP, header Authorization: Bearer ${token}`,
    };
  }

  listConnectorTokens(p: Principal) {
    const ownerId = this.requireOwner(p);
    return this.all("SELECT id, label, created_at, last_used_at, revoked_at, attest_typed FROM tokens WHERE kind='owner' AND scope='connector' AND subject_id = ? ORDER BY created_at DESC", ownerId)
      .map((t) => ({ token_id: t.id, label: t.label, attest_typed_by_owner: t.attest_typed === 1, created_at: t.created_at, last_used_at: t.last_used_at, status: t.revoked_at ? "revoked" : "active", revoked_at: t.revoked_at }));
  }

  revokeConnectorToken(p: Principal, tokenId: string) {
    const ownerId = this.requireOwner(p);
    const t = this.get("SELECT * FROM tokens WHERE id = ? AND kind='owner' AND scope='connector' AND subject_id = ?", tokenId, ownerId);
    assert(t, 404, "token_not_found");
    if (!t.revoked_at) this.run("UPDATE tokens SET revoked_at = ? WHERE id = ?", nowIso(), tokenId);
    this.audit.append(`owner:${ownerId}`, "connector_token.revoked", tokenId, [ownerId], { label: t.label });
    return { token_id: tokenId, status: "revoked" };
  }

  /** One-step onboarding: new owner + their bot (platform-generated key) + a connector token. */
  onboard(body: { username?: string; password?: string; display_name?: string; bot_handle?: string; bot_display_name?: string; label?: string; integration_type?: string }, opts: { attestTyped?: boolean } = {}) {
    body = { ...(body ?? {}) };
    // A handle is a string: `handleKey` is `String(...)`, so a boolean or a number would register a Bot nobody
    // named (@true, @1.5) whose handle every friend, grant and room list reads back, and a falsy one would take
    // the default without saying so. Only an absent, `null` or string handle goes on, and an empty string still
    // means "use the default" below.
    assert(body.bot_handle === undefined || body.bot_handle === null || typeof body.bot_handle === "string", 400, "invalid_request", "bot_handle must be a string");
    // A type is a name, not a value to coerce. The `|| "grok-bot"` at the registerBot call below turns `0` and
    // `false` into the default without saying so, hands `42` and `["x"]` to registerBot which stores them as the
    // text "42.0"/"x", and lets the SQLite binder answer an object with a 500 after the owner row and its key were
    // built. Only an absent, `null` or string type goes on; an empty string still means "use the default" and
    // every string keeps the answer it had.
    assert(body.integration_type === undefined || body.integration_type === null || typeof body.integration_type === "string", 400, "invalid_request", "integration_type must be a string");
    const generated: { username?: string; password?: string } = {};
    if (!body.username) {
      const base = String(body.display_name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 16) || "owner";
      do { body.username = `${base}${randomBytes(3).toString("hex")}`; } while (this.get("SELECT 1 FROM owners WHERE username = ?", body.username));
      generated.username = body.username;
    }
    if (!body.password) { body.password = randomBytes(12).toString("base64url"); generated.password = body.password; }
    const handle = handleKey(body.bot_handle || `${body.username}.bot`);
    assert(/^[a-z0-9._-]{2,40}$/i.test(handle), 400, "invalid_request", "bot handle: 2-40 chars [a-z0-9._-]");
    // A brand-new owner cannot own an existing row yet, so this is always the generic (no-name) refusal.
    this.assertHandleFree(handle);
    let out: any;
    this.db.transaction(() => {
      const o = this.registerOwner(body as { username: string; password: string; display_name?: string });
      const p: Principal = { kind: "owner", ownerId: o.owner_id };
      const bot = this.registerBot(p, { handle, display_name: body.bot_display_name || body.display_name || handle, integration_type: body.integration_type || "grok-bot" });
      // custodial: the platform keeps the (generated) signing key encrypted, so the connector can chat, and the
      // custody record follows the same transaction (a refused sign-up drops both the row and its record).
      this.storeCustody(bot.bot_id, bot.key.kid, bot.key.private_key_pem!, { ownerId: o.owner_id, mode: "onboarded" });
      const conn = this.createConnectorToken(p, { label: body.label, attest_typed_by_owner: opts.attestTyped === true });
      out = {
        owner_id: o.owner_id, username: body.username,
        ...(generated.password ? { generated_password: generated.password, password_note: "auto-generated web login (for /ui); tell the owner once, do not store it" } : {}),
        bot: { bot_id: bot.bot_id, handle: bot.handle, custodial: true },
        connector: conn,
      };
    })();
    return out;
  }

  /** One-call onboarding for a FlyBot install: owner + custodial bot + connector token + optional push webhook. */
  onboardFlybot(body: { username?: string; password?: string; display_name?: string; bot_handle?: string; bot_display_name?: string; webhook_url?: string; webhook_headers?: unknown }) {
    body = { ...(body ?? {}) };
    // Both checks land before onboard() commits: a refused sign-up must not leave an owner, a taken handle or live tokens behind.
    if (body.webhook_url) {
      validateUrl(body.webhook_url);
      if (body.webhook_headers !== undefined) validateHeaders(body.webhook_headers);
    }
    // The bot made here is the owner's FlyBot home (e.g. @danyang.home); local Bots join it as members.
    const base = String(body.display_name ?? body.username ?? "owner").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 20) || "owner";
    // Only an absent, `null` or empty handle means this route's own default; anything else is handed to onboard()
    // unchanged, where the one type gate refuses a non-string instead of this line silently defaulting it.
    const rawHandle: unknown = body.bot_handle;
    const homeHandle = rawHandle === undefined || rawHandle === null || rawHandle === "" ? `${base}.home` : body.bot_handle;
    const out = this.onboard({ ...body, bot_handle: homeHandle, label: "FlyBot", integration_type: "flybot-home" }, { attestTyped: true });
    const p: Principal = { kind: "owner", ownerId: out.owner_id };
    let webhook: unknown = null;
    if (body.webhook_url) {
      this.setWebhook(p, out.bot.bot_id, { url: body.webhook_url, ...(body.webhook_headers !== undefined ? { headers: body.webhook_headers } : {}) });
      const row = this.get("SELECT webhook_url, webhook_secret FROM bots WHERE id = ?", out.bot.bot_id);
      webhook = { url: row.webhook_url, secret: row.webhook_secret, signature_header: "x-botsocial-signature", timestamp_header: "x-botsocial-timestamp", signature_scheme: "v1=hex(HMAC-SHA256(secret, `${timestamp}.${body}`))" };
    }
    return { ...out, home: out.bot, mcp_url: `${this.publicBaseUrl}/mcp`, webhook };
  }

  private ownHome(ownerId: string, homeId: string) {
    const home = this.get("SELECT * FROM bots WHERE id = ? AND owner_id = ?", homeId, ownerId) ?? this.botByRef(homeId, "owner_id = ?", [ownerId]);
    assert(home && home.integration_type === "flybot-home", 404, "home_not_found", "no FlyBot home with that id for this owner");
    return home;
  }

  /** Registers (or reactivates) a local FlyBot Bot as @<name>.<home>, its key custodied with the home. */
  addHomeMember(p: Principal, homeId: string, body: { name?: string; display_name?: string; local_id?: string; avatar?: string | null; color?: string | null }) {
    const ownerId = this.requireOwner(p);
    assert(body?.display_name === undefined || typeof body.display_name === "string", 400, "invalid_request", "display_name must be a string");
    // A name is a string: an object, a boolean or a number reached the sanitiser through `String` and registered a
    // member nobody named (@object-object.<home>, @true.<home>), whose handle every friend and invite reads back.
    // An explicit null stays "not given", so the required-name answer below is unchanged.
    assert(body?.name === undefined || body?.name === null || typeof body.name === "string", 400, "invalid_request", "name must be a string");
    const home = this.ownHome(ownerId, homeId);
    const look = { avatar: body?.avatar !== undefined ? validateAvatar(body.avatar) : undefined, color: body?.color !== undefined ? validateColor(body.color) : undefined };
    const room = 40 - home.handle.length - 1;
    assert(room >= 2, 400, "invalid_request", "home handle too long for members");
    const name = String(body?.name ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, room);
    assert(name.length >= 1, 400, "invalid_request", "member name required");
    const handle = `${name}.${handleKey(home.handle)}`;
    const existing = this.botByRef(handle);
    if (existing) {
      assert(existing.home_bot_id === home.id, 409, "handle_taken");
      // Re-adding the name is the documented way back from a removal (#173) and also lifts an emergency stop, so the
      // row can move `revoked`/`frozen` -> `active` here. That is a state change and is audited like every other one.
      // Re-adding a member that is already active is the idempotent upsert FlyBot does on every start: no entry.
      const previousStatus = existing.status;
      this.run("UPDATE bots SET status = 'active', display_name = ? WHERE id = ?", peerDisplayName(body?.display_name, existing.display_name || handle), existing.id);
      this.applyLook(existing.id, look);
      if (previousStatus !== "active") this.audit.append(`owner:${ownerId}`, "home.member_reactivated", existing.id, [ownerId], { home: home.id, from: previousStatus });
      return { bot_id: existing.id, handle: "@" + handle, home: "@" + home.handle, status: "active", reactivated: true };
    }
    const bot = this.registerBot(p, { handle, display_name: body?.display_name || name, integration_type: "flybot-member" });
    this.run("UPDATE bots SET home_bot_id = ? WHERE id = ?", home.id, bot.bot_id);
    this.applyLook(bot.bot_id, look);
    // The member's signing key comes under this home's custody on this line, so the chain has to name it: every
    // other custody write records `bot.custody_enabled` (a sign-up as `onboarded`, the custody door with its own
    // mode), while a key taken in through a home wrote the `bot_custody` row and no record at all. This is one of
    // the two doors that add a member — the REST route and the `add_home_member` tool both land here.
    this.storeCustody(bot.bot_id, bot.key.kid, bot.key.private_key_pem!, { ownerId, mode: "added" });
    this.audit.append(`owner:${ownerId}`, "home.member_added", bot.bot_id, [ownerId], { home: home.id, handle });
    return { bot_id: bot.bot_id, handle: bot.handle, home: "@" + home.handle, status: "active" };
  }

  removeHomeMember(p: Principal, homeId: string, memberId: string) {
    const ownerId = this.requireOwner(p);
    const home = this.ownHome(ownerId, homeId);
    const m = this.get("SELECT * FROM bots WHERE id = ? AND home_bot_id = ?", memberId, home.id) ?? this.botByRef(memberId, "home_bot_id = ?", [home.id]);
    assert(m, 404, "member_not_found");
    const conversations = this.all("SELECT DISTINCT conversation_id FROM messages WHERE sender_bot = ? AND status = 'pending_approval'", m.id)
      .map((r: any) => r.conversation_id as string);
    const rooms = this.all("SELECT * FROM face_room_members WHERE bot_id = ? AND left_at IS NULL", m.id);
    let revokedInvites = 0;
    let revokedFaceInvites = 0;
    let clearedNotifyOutlet = 0;
    this.db.transaction(() => {
      // Stop the push first: a revoked identity must not keep receiving metadata through its webhook.
      this.run("UPDATE bots SET status = 'revoked', webhook_url = NULL, webhook_headers = '[]', webhook_updated_at = ? WHERE id = ?", nowIso(), m.id);
      this.run("UPDATE tokens SET revoked_at = ? WHERE kind = 'bot' AND subject_id = ? AND revoked_at IS NULL", nowIso(), m.id);
      // An owner who made this Bot the approval outlet would otherwise keep announcing cards into a queue that
      // this transaction just made unreadable: skip the dead outlet instead of silently dropping the cards.
      clearedNotifyOutlet = this.run("UPDATE owners SET notify_bot_id = NULL WHERE notify_bot_id = ?", m.id).changes;
      // An invite for a Bot that no longer exists must not share it again. Pending owner approvals for those
      // invites are cancelled by the bot_id below, with the member's other drafts.
      revokedInvites = this.run("UPDATE invites SET status = 'revoked' WHERE bot_id = ? AND status IN ('active','pending_owner')", m.id).changes;
      // A revoked identity must not keep in-flight drafts: the owner can otherwise approve one later and the
      // platform would deliver a message as a Bot that no longer exists. `cancelPendingFor` cancels the
      // approvals and marks their messages / actions / face-room drafts cancelled.
      this.cancelPendingFor("bot_id = ?", [m.id], "member_revoked", { actor: `owner:${ownerId}` });
      // The other half of the same rule: a line that is held because *this* Bot was to receive it. Its card belongs
      // to the sender's owner, and nothing about it can be delivered any more — approving it answers `bot_revoked`
      // and the sender waits out the card's 24 hours for a line that can never go out. Settle it under its own
      // reason, and tell the sending Bot why: it did not lose its seat, the peer it wrote to is gone.
      this.cancelPendingFor("kind = 'outbound_message' AND subject_id IN (SELECT id FROM messages WHERE recipient_bot = ?)", [m.id], "recipient_revoked", { notify: true, actor: `owner:${ownerId}` });
      for (const id of conversations) this.refreshConversationStatus(id);
      // A revoked identity must also leave the rooms it was in; otherwise it stays a visible member and the
      // room keeps writing events (and countersignatures) for a Bot nobody can read.
      for (const room of rooms) {
        const member = this.get("SELECT * FROM face_room_members WHERE room_id = ? AND bot_id = ? AND left_at IS NULL", room.room_id, m.id);
        if (member) this.removeFaceMember(room.room_id, member, "room_closed");
        this.endRoomGrantsForBots(room.room_id, [m.id]);
      }
      // #90: the local-room tickets this identity minted are reach of its own. Withdraw them and end every claim
      // they made, so the room-scoped grants those claims wrote stop being active. This includes a ticket already
      // withdrawn while the identity lived: owner decision 2026-10-24 keeps the seats of a withdrawn link, not the
      // seats of a revoked identity that can no longer answer in that room.
      for (const inv of this.all("SELECT * FROM local_room_invites WHERE inviter_bot = ?", m.id)) {
        if (!inv.revoked_at) this.run("UPDATE local_room_invites SET revoked_at = ? WHERE ticket = ?", nowIso(), inv.ticket);
        for (const claim of this.localInviteClaims(inv)) {
          this.run("UPDATE local_room_invite_claims SET released_at = ? WHERE ticket = ? AND owner_id = ?", nowIso(), inv.ticket, claim.owner_id);
          this.endLocalPairGrants(inv.room_id, inv.inviter_bot, claim.bots);
        }
      }
      // #90 continues: that rule ends the reach of the tickets this identity minted. The other half is the seats
      // its identity took through someone else's link. A revoked Bot cannot answer in that room any more, so its
      // seat goes with it: the claim drops it (and is released only when it held no one else, so the home can come
      // back with a live link), and the pair grants that seat wrote stop being active. Only this Bot's own seat
      // moves — the Bots that stay in the same claim, and other homes' claims on the same link, keep theirs.
      for (const c of this.all(`SELECT c.ticket, c.owner_id, c.bots, i.room_id, i.inviter_bot FROM local_room_invite_claims c
        JOIN local_room_invites i ON i.ticket = c.ticket WHERE c.released_at IS NULL AND i.inviter_bot <> ?`, m.id)) {
        const bots = J(c.bots, []) as string[];
        if (!bots.includes(m.id)) continue;
        const rest = bots.filter((b) => b !== m.id);
        // The claim row changes first: `endLocalPairGrants` reads a live claim as a seat that still holds the pair.
        if (rest.length) this.run("UPDATE local_room_invite_claims SET bots = ? WHERE ticket = ? AND owner_id = ?", JSON.stringify(rest), c.ticket, c.owner_id);
        else this.run("UPDATE local_room_invite_claims SET released_at = ? WHERE ticket = ? AND owner_id = ?", nowIso(), c.ticket, c.owner_id);
        this.endLocalPairGrants(c.room_id, c.inviter_bot, [m.id]);
      }
      // #183: the same rule holds for the face-room tickets this identity minted. A ticket is a bearer
      // credential, so one handed out before the revocation would otherwise keep previewing the room and
      // seating new people in it. Owner-minted tickets (`created_by_bot IS NULL`) are not this identity's reach.
      revokedFaceInvites = this.run("UPDATE face_room_invites SET revoked_at = ? WHERE created_by_bot = ? AND revoked_at IS NULL", nowIso(), m.id).changes;
    })();
    this.audit.append(`owner:${ownerId}`, "home.member_revoked", m.id, [ownerId], { home: home.id, revoked_invites: revokedInvites, revoked_face_invites: revokedFaceInvites, rooms_left: rooms.length, notify_outlet_cleared: clearedNotifyOutlet > 0 });
    return { bot_id: m.id, handle: "@" + m.handle, status: "revoked" };
  }

  homeMembers(homeId: string) {
    return this.all("SELECT id, handle, display_name, avatar, color, avatar_updated_at FROM bots WHERE home_bot_id = ? AND status = 'active' ORDER BY created_at", homeId)
      .map((b: any) => ({ bot_id: b.id, handle: "@" + b.handle, display_name: b.display_name, ...lookOf(b) }));
  }

  listHomeMembers(p: Principal, homeId: string) {
    const ownerId = this.requireOwner(p);
    return { members: this.homeMembers(this.ownHome(ownerId, homeId).id) };
  }

  /**
   * Bots granted TO me (default deny: nothing appears unless that bot's owner created an
   * active relationship + grant to one of my bots). Home / Chief bots are not a wildcard.
   * `home` is optional grouping: when set, only grants held by that home or its members.
   */
  remoteBots(p: Principal, homeId?: string) {
    return this.listRemoteBots(p, homeId);
  }

  /**
   * `typed_by_owner` attestation: the platform stamps it on a message only when the caller is an owner principal
   * that may attest (owner login, or a connector token minted for a trusted host such as FlyBot) and says so
   * explicitly. Bot tokens and plain connector tokens are refused; message text and signed envelopes are never read for it.
   */
  private typedByOwner(p: Principal, body: any): boolean {
    const v = body?.typed_by_owner;
    if (v === undefined || v === null || v === false) return false;
    assert(v === true, 400, "invalid_request", "typed_by_owner must be a boolean");
    if (p.kind !== "owner") throw new ApiError(403, "typed_attestation_forbidden", "typed_by_owner can only be set with the owner's own credential, never a Bot token");
    if (!p.attestTyped) throw new ApiError(403, "typed_attestation_forbidden", "this connector token may not attest typed_by_owner (use the token FlyBot onboarding issued, or an owner login)");
    return true;
  }

  /**
   * `mentions`: the Bot handles the sender says the line is addressed to (the composer's @ picks). Optional and
   * backward compatible: absent, null and [] all mean "none". Validated, not trusted: a list of at most 8 handles
   * (`@name.home`, 2-40 chars [a-z0-9._-]), normalised to lowercase `@handle`, deduplicated; anything else is a 400.
   * The platform keeps it with the message and countersigns it; whether a receiver acts on it is its own rule.
   */
  private mentionList(raw: unknown): string[] {
    if (raw === undefined || raw === null) return [];
    assert(Array.isArray(raw), 400, "invalid_request", "mentions must be an array of Bot handles");
    assert(raw.length <= 8, 400, "invalid_request", "mentions: at most 8 handles");
    const out: string[] = [];
    for (const item of raw) {
      assert(typeof item === "string" && /^@?[a-z0-9._-]{2,40}$/i.test(item), 400, "invalid_request", "mentions: each item is a Bot handle (2-40 chars [a-z0-9._-], optional leading @)");
      const handle = "@" + item.replace(/^@/, "").toLowerCase();
      if (!out.includes(handle)) out.push(handle);
    }
    return out;
  }

  /** The handles of `mentions` that are current members of the face room right now (lowercase `@handle`). */
  private roomMentions(roomId: string, mentions: string[]): string[] {
    if (!mentions.length) return [];
    const inRoom = new Set(this.all("SELECT handle FROM face_room_members WHERE room_id = ? AND left_at IS NULL", roomId).map((r) => "@" + String(r.handle).replace(/^@/, "").toLowerCase()));
    return mentions.filter((h) => inRoom.has(h));
  }

  // ================================================================ idempotency (#47)
  /** A caller-supplied key makes a retry safe: the same key and the same payload returns the first answer
   * verbatim, the same key with a different payload is a conflict, and an absent key changes nothing.
   * Keys are scoped to the calling owner (home) plus the tool, so two homes may use one string, and kept
   * 24 hours. Only a successful call is recorded, so a failed one can be retried with the same key. */
  private idempotent<T>(p: Principal, tool: string, key: unknown, payload: unknown, run: () => T): T {
    if (key === undefined || key === null) return run();
    assert(typeof key === "string", 400, "invalid_request", "idempotency_key must be a string");
    const k = key.trim();
    assert(k.length >= 8 && k.length <= 128, 400, "invalid_request", "idempotency_key: 8-128 characters");
    const ownerId = this.requireOwner(p);
    const hash = sha256Hex(Buffer.from(jcs(payload as any)));
    const ttlMs = 24 * 60 * 60 * 1000;
    const now = Date.now();
    this.run("DELETE FROM idempotency_keys WHERE created_at <= ?", now - ttlMs);
    // Claim the key first, in one statement, so two overlapping retries cannot both miss and both run:
    // the loser sees the winner's row (and its hash) instead of sending or deciding a second time.
    const claim = this.run("INSERT OR IGNORE INTO idempotency_keys (owner_id, tool, key, request_hash, response, created_at) VALUES (?,?,?,?,?,?)",
      ownerId, tool, k, hash, "", now) as any;
    if (!claim?.changes) {
      const hit = this.get("SELECT request_hash, response, created_at FROM idempotency_keys WHERE owner_id = ? AND tool = ? AND key = ?", ownerId, tool, k);
      assert(hit, 409, "idempotency_conflict", "this idempotency_key is being used by another call");
      assert(String(hit.request_hash) === hash, 409, "idempotency_conflict", "this idempotency_key was used with a different request");
      // An empty stored answer means that call is still running: never run it twice, and let the caller retry.
      assert(String(hit.response) !== "" && hit.response !== null, 409, "idempotency_in_progress", "the same idempotency_key is still being processed; retry shortly");
      return J(hit.response, {}) as T;
    }
    try {
      const out = run();
      this.run("UPDATE idempotency_keys SET response = ?, created_at = ? WHERE owner_id = ? AND tool = ? AND key = ?", JSON.stringify(out ?? null), now, ownerId, tool, k);
      return out;
    } catch (error) {
      // A call that threw wrote nothing that counts, so the key is released for a retry.
      this.run("DELETE FROM idempotency_keys WHERE owner_id = ? AND tool = ? AND key = ?", ownerId, tool, k);
      throw error;
    }
  }

  /** A signed message from one of my home's members to any bot of a friend home; reuses the pair's active conversation. */
  sendAsMember(p: Principal, body: { from_bot_id: string; to: string; text: string; attachments?: AttachmentRef[]; typed_by_owner?: boolean; mentions?: string[] | null; room_id?: string; conversation_id?: string; idempotency_key?: string }) {
    const { idempotency_key: key, ...rest } = body as any;
    return this.idempotent(p, "send_as_member", key, rest, () => this.sendAsMemberOnce(p, rest));
  }

  private sendAsMemberOnce(p: Principal, body: { from_bot_id: string; to: string; text: string; attachments?: AttachmentRef[]; typed_by_owner?: boolean; mentions?: string[] | null; room_id?: string; conversation_id?: string }) {
    const ownerId = this.requireOwner(p);
    // A body field this door hands to SQL is a string or nothing: an object became named parameters and a boolean had
    // no binding at all, so each answered 500 instead of naming the field.
    assert(body?.from_bot_id === undefined || body?.from_bot_id === null || typeof body.from_bot_id === "string", 400, "invalid_request", "from_bot_id must be a string");
    const typed = this.typedByOwner(p, body);
    const mentions = this.mentionList(body?.mentions);
    const cb = this.custodialBot(p, body?.from_bot_id);
    // The recipient is an id or a handle, never a shape. An object or a boolean went into the statement as itself
    // and answered 500; an array was spread over its parameters, so `["@peer.bot"]` sent that Bot a real line.
    assert(body?.to === undefined || body?.to === null || typeof body.to === "string", 400, "invalid_request", "to must be a string");
    const to = this.get("SELECT * FROM bots WHERE id = ?", body?.to) ?? this.botByRef(body?.to);
    assert(to && to.status === "active", 404, "bot_not_found", "no such remote bot");
    void ownerId;
    // #45: optional room context. The line names the room it belongs to; the server checks that a room-scoped grant
    // exists (the owners put both Bots in that room, so that click was the consent) and only then lifts the blanket
    // outbound hold. A room id with no such grant is refused whole: never an approval, never a message.
    // The room this line names is an id, never a shape. An object or a boolean went into the statement as itself
    // (an object answered 500) and an array was stringified, so `["<room>"]` wrote a real line into that room.
    assert(body?.room_id === undefined || body?.room_id === null || typeof body.room_id === "string", 400, "invalid_request", "room_id must be a string");
    const roomId = body?.room_id === undefined || body?.room_id === null ? null : String(body.room_id).trim();
    if (roomId !== null) {
      assert(/^[A-Za-z0-9._:-]{1,64}$/.test(roomId), 400, "invalid_request", "room_id: 1-64 chars [A-Za-z0-9._:-]");
      assert(this.findRoomGrant(to.owner_id, cb.botId, "chat.public", to.id, roomId), 403, "room_not_shared", "no active room-scoped grant for that room between these Bots", { suggestion: "join the room together again, or send without room_id" });
    }
    // #43: a claimed room invite is reach by itself — the guest may answer the inviter in that room, without a
    // friendship and without a fresh conversation elsewhere.
    const roomRel = roomId === null ? null : this.roomReach(cb.botId, to.id, roomId);
    if (roomId !== null) assert(roomRel, 403, "no_relationship", "no room reach to that Bot in this room", { suggestion: "join the room with the invite link first" });
    // The console reads one chat and names it when the owner writes, so the line lands in the thread on screen
    // instead of the pair's newest one. An explicit target must already be a conversation between these two Bots
    // that can still take a line: nothing is created and nothing falls back to another thread. The same answer is
    // given for a conversation that does not exist and for one of another pair, so ids cannot be probed.
    const rawTarget = body?.conversation_id;
    assert(rawTarget === undefined || rawTarget === null || typeof rawTarget === "string", 400, "invalid_request", "conversation_id must be a string");
    const explicit = rawTarget === undefined || rawTarget === null ? null : String(rawTarget).trim();
    assert(explicit === null || explicit.length > 0, 400, "invalid_request", "conversation_id must be a non-empty string");
    // A body field this door reads as a file list is an array or nothing. `draftEnv` below decides whether the field
    // reaches the signed envelope with `body.attachments?.length`, so a JSON object has no length, is dropped whole
    // and the call answered 202 with a line that carried no file -- the refusal `checkRefs` already holds
    // (`payload.attachments must be an array`) never ran. This gate sits before `draftEnv`, hence before the
    // conversation, message, approval and audit writes on both the named-thread and the open-a-thread branch. The
    // spread below stays as it is, so `[]` keeps its present bytes and every element is still checked by `checkRefs`.
    assert(body?.attachments === undefined || body?.attachments === null || Array.isArray(body.attachments), 400, "invalid_request", "attachments must be an array");
    let conversationId: string;
    let message: any;
    /** The draft envelope names the thread the line belongs to, so it is built once that id is known. */
    const draftEnv = (id: string) => cb.sign("message.draft", { text: body.text, ...(body.attachments?.length ? { attachments: body.attachments } : {}) }, { conversation_id: id });
    if (explicit !== null) {
      const named = this.get("SELECT id, initiator_bot, peer_bot, relationship_id, status, outcome FROM conversations WHERE id = ?", explicit);
      const mine = named && ((named.initiator_bot === cb.botId && named.peer_bot === to.id) || (named.initiator_bot === to.id && named.peer_bot === cb.botId));
      assert(mine, 404, "conversation_not_found", "no such conversation between these Bots");
      assert(named.status === "open" || named.status === "awaiting_approval", 409, named.status === "closed" ? "conversation_closed" : "conversation_paused", `conversation is ${named.status}${named.outcome ? ` (${named.outcome})` : ""}`);
      // Naming a conversation must not hop the door this call is judged by: the thread has to be the one opened
      // through that same relationship. Without this, a send naming room R1 could write into the conversation of
      // another room R2 the pair also shares — R2's reach is never resolved here, so a closed room would still take
      // the line — and the 1:1 route could write into a room's thread on nothing but a friendship and a non-room
      // grant. A conversation off that door answers exactly like one that does not exist, so ids cannot be probed.
      const doorId = roomRel?.id ?? this.findActiveRelationship(cb.botId, to.id)?.id ?? null;
      // #515: a thread opened in a room keeps that room's relationship row after the room is over, so its door is
      // neither the friendship's row nor a live room. The 1:1 route accepts that thread only on the evidence the
      // delivery gate already settles such a line on (#67): the thread's own door no longer reads `room`, a
      // room-scoped grant still records that it was one, and the pair still have a friendship to settle on. A live
      // room's thread stays refused here, and a pair with no friendship has no door to settle on.
      const endedRoom = roomRel === null && this.endedRoomDoor(named.relationship_id, doorId !== null);
      assert(named.relationship_id === doorId || endedRoom, 404, "conversation_not_found", "no such conversation between these Bots");
      conversationId = named.id;
      message = this.draftMessage(cb.bp, conversationId, draftEnv(conversationId), typed, mentions, roomId);
    } else {
      const rel = roomRel ?? this.activeRelationship(cb.botId, to.id);
      // Conversation statuses are open / awaiting_approval / closed; 'active' never matches,
      // so every send opened a new conversation and hit newConversationsPerPairPerDay (then 5).
      // The door is part of the lookup: a pair can share several rooms, and reusing the conversation opened in
      // another room would judge this room by that room's relationship (and, once it is gone, fail mid-draft).
      const conv = this.get("SELECT id FROM conversations WHERE status IN ('open', 'awaiting_approval') AND (expires_at IS NULL OR expires_at > ?) AND ((initiator_bot = ? AND peer_bot = ?) OR (initiator_bot = ? AND peer_bot = ?)) AND relationship_id = ? ORDER BY updated_at DESC LIMIT 1", nowIso(), cb.botId, to.id, to.id, cb.botId, rel.id);
      if (conv) {
        conversationId = conv.id;
        message = this.draftMessage(cb.bp, conversationId, draftEnv(conversationId), typed, mentions, roomId);
      } else {
        // This line opens the thread, so the row and its first draft are one decision: a draft the policy layer
        // refuses must leave no empty conversation for either side to read, no `conversation.started` event for the
        // peer, and no new conversation counted against the relationship's daily quota. The row, its event and the
        // draft commit together; the trail and the peer's push wait until that commit is durable.
        let opened: any;
        try {
          opened = this.openConversationWithDraft(cb.bp, cb.sign("conversation.create", { type: "direct", peer_bot_id: to.id, intent: { type: "general_chat", summary: "chat" } }, { to: to.id }), draftEnv, typed, mentions, roomId);
        } catch (error) {
          // A reply-only Bot is refused inside this transaction, and the one thing that refusal leaves behind is the
          // target owner's notice, which the rollback took with it. It is written here, in the refusal's own words.
          if ((error as ApiError)?.code === "bot_not_shared") this.noticeUnshared(cb.botId, to, rel.id, "conversation.create");
          throw error;
        }
        conversationId = opened.made.conversation.conversation_id;
        message = opened.message;
        opened.made.announce();
      }
    }
    return { conversation_id: conversationId, message, typed_by_owner: typed, ...(roomId !== null ? { room_id: roomId } : {}) };
  }

  // ================================================================ attachments
  /** Upload a file for one of my bots (owner: bot_id names it; bot: itself). Stored sealed with the KMS key; expires. */
  uploadAttachment(p: Principal, body: { bot_id?: string; name: string; mime?: string; content_base64: string }) {
    const { botId, ownerId } = this.attachmentBot(p, body?.bot_id);
    assert(typeof body?.content_base64 === "string", 400, "invalid_request", "content_base64 required");
    assert(body.content_base64.length <= Math.ceil(this.attachmentLimits.maxBytes / 3) * 4 + 4, 413, "attachment_too_large", `file exceeds ${this.attachmentLimits.maxBytes} bytes`);
    const bytes = decodeCanonicalBase64(body.content_base64);
    assert(bytes !== null, 400, "invalid_request", "content_base64 must be canonical base64");
    // `name` is the one free-text field of an upload, and `checkFile` below reads it with `String(name ?? "")`: an
    // object was stored as the file name "[object Object]", an array as "1,2" (or "a.png" for `["a.png"]`), a
    // boolean as "true" and a number as "42". Each answered 201 with a real row, its bytes sealed and the owner's
    // storage budget charged, and the peer that later receives the file read that string as its name. A name is a
    // string; refuse every other shape before `checkFile` reads it, before the quota is read or charged, and before
    // the row and the audit line. An absent or `null` name keeps the "file name required" answer below, and a string
    // keeps the sanitiser's output byte for byte.
    assert(body?.name === undefined || body?.name === null || typeof body.name === "string", 400, "invalid_request", "name must be a string");
    const check = checkFile(body.name, body.mime, bytes, this.attachmentLimits);
    if (!check.ok) throw new ApiError(check.code === "attachment_too_large" ? 413 : 415, check.code, check.message);
    this.cleanupAttachments();
    const id = newId("att"), now = Date.now();
    const sha256 = sha256Hex(bytes);
    // The owner-level budget: every stored byte counts, whichever bot uploaded it. Read and insert in one
    // transaction so parallel uploads cannot each see the same "under budget" total, and check before the INSERT so
    // a refusal stores nothing at all — the caller keeps the file and reads `used_bytes`/`limit_bytes`.
    const usedBytes = this.db.transaction(() => {
      const used = (this.get("SELECT COALESCE(SUM(size),0) AS used FROM attachments WHERE owner_id = ?", ownerId) as any).used as number;
      if (used + bytes.length > this.attachmentLimits.ownerBudgetBytes) {
        throw new ApiError(413, "attachment_storage_full", `this owner's stored attachments would exceed ${this.attachmentLimits.ownerBudgetBytes} bytes`, { used_bytes: used, limit_bytes: this.attachmentLimits.ownerBudgetBytes });
      }
      this.run("INSERT INTO attachments (id, owner_id, bot_id, name, mime, size, sha256, sealed, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        id, ownerId, botId, check.name, check.mime, bytes.length, sha256, sealBytes(this.kmsKey, bytes, `attachment:${id}:${sha256}`), new Date(now).toISOString(), new Date(now + this.attachmentLimits.ttlMs).toISOString());
      return used + bytes.length;
    })();
    // The row and the charge landed above, and the line that names them goes to the audit store -- a second SQLite
    // file that can refuse it (its disk full, or a trigger). A refusal there used to leave the file stored and the
    // owner's budget charged while the caller was answered `500 internal_error`: an orphan no door can remove, still
    // counted against the budget. Take the row and its charge back instead, in one transaction on this same
    // connection, so a parallel upload never reads the abandoned total and the caller's end state equals the end
    // state of a refused upload -- no row, nothing charged, no budget figure in the `500` it already gets.
    try {
      this.audit.append(`bot:${botId}`, "attachment.uploaded", id, [ownerId], { name: check.name, mime: check.mime, size: bytes.length, sha256 });
    } catch (err) {
      this.db.transaction(() => {
        this.run("DELETE FROM attachments WHERE id = ?", id);
      })();
      throw err;
    }
    return { attachment: { id, name: check.name, size: bytes.length, mime: check.mime, sha256 }, expires_at: new Date(now + this.attachmentLimits.ttlMs).toISOString(), limits: { ...this.attachmentLimits, used_bytes: usedBytes } };
  }

  /**
   * What this home is storing: the files behind the `used_bytes` an upload judges, never their contents. A read
   * sweeps files past their deadline first, so its totals are the ones the next upload sees and each removed file
   * leaves the `attachment.expired` line every removal writes. The budget is the owner's, so this is an owner door:
   * a Bot token sees neither the home's files nor its totals.
   */
  listAttachments(p: Principal) {
    const ownerId = this.requireOwner(p);
    this.cleanupAttachments();
    const rows = this.all(`SELECT a.id, a.bot_id, a.name, a.mime, a.size, a.sha256, a.message_id, a.created_at, a.expires_at, b.handle AS bot_handle
      FROM attachments a LEFT JOIN bots b ON b.id = a.bot_id
      WHERE a.owner_id = ?
      ORDER BY a.created_at DESC, a.id DESC`, ownerId) as any[];
    return {
      attachments: rows.map((r) => ({
        id: r.id,
        name: r.name,
        mime: r.mime,
        size: r.size,
        sha256: r.sha256,
        bot: { id: r.bot_id, handle: r.bot_handle ? "@" + String(r.bot_handle).replace(/^@/, "") : null },
        message_id: r.message_id ?? null,
        created_at: r.created_at,
        expires_at: r.expires_at,
      })),
      used_bytes: rows.reduce((n, r) => n + (r.size as number), 0),
      limit_bytes: this.attachmentLimits.ownerBudgetBytes,
    };
  }

  private attachmentBot(p: Principal, botId?: string) {
    if (p.kind === "owner") {
      const ownerId = this.requireOwner(p);
      // The bot named on an upload used to reach the owner lookup as it arrived: an object or a boolean
      // answered 500. Only a string goes on to SQL; an absent or null id keeps the default bot.
      assert(botId === undefined || botId === null || typeof botId === "string", 400, "invalid_request", "bot_id must be a string");
      const b = botId ? this.ownBot(ownerId, botId) : this.get("SELECT * FROM bots WHERE owner_id = ? AND status = 'active' ORDER BY created_at LIMIT 1", ownerId);
      assert(b, 404, "bot_not_found", "no bot to upload for");
      return { botId: b.id as string, ownerId };
    }
    return this.requireBot(p);
  }

  /** Validates a draft's refs: each one my bot's upload, unexpired, not yet sent, and matching the stored file exactly. */
  private checkRefs(botId: string, refs: unknown): AttachmentRef[] {
    if (refs === undefined || refs === null) return [];
    assert(Array.isArray(refs), 400, "invalid_request", "payload.attachments must be an array");
    const list = refs as any[];
    assert(list.length <= this.attachmentLimits.maxPerMessage, 400, "invalid_request", `at most ${this.attachmentLimits.maxPerMessage} attachments per message`);
    assert(new Set(list.map((r) => r?.id)).size === list.length, 400, "invalid_request", "duplicate attachment");
    return list.map((r) => {
      const row = this.get("SELECT id, bot_id, name, mime, size, sha256, message_id, expires_at FROM attachments WHERE id = ?", r?.id);
      assert(row && row.bot_id === botId, 404, "attachment_not_found", "no such attachment for this bot");
      assert(Date.parse(row.expires_at) > Date.now(), 410, "attachment_expired", "attachment expired");
      assert(!row.message_id, 409, "attachment_in_use", "attachment already sent; upload it again");
      const ref = refOf(row);
      assert(ref.name === r.name && ref.size === r.size && ref.mime === r.mime && ref.sha256 === r.sha256, 400, "attachment_mismatch", "attachment ref does not match the uploaded file");
      return ref;
    });
  }

  /**
   * A line that will never be delivered gives its files back. `checkRefs` binds a ref to the message while the card
   * waits, so leaving that binding behind after a rejection, an expiry or a cancellation keeps bytes the peer never
   * saw busy: the same ref answers `409 attachment_in_use` on the next draft and the owner has to upload it again.
   * Only the settled-draft paths call this -- a delivered message keeps its binding, because that is how the peer
   * finds the file it received.
   */
  private freeDraftAttachments(messageId?: string | null) {
    if (!messageId) return;
    this.run("UPDATE attachments SET message_id = NULL WHERE message_id = ?", messageId);
  }

  /** Download for the recipient (bot, or its owner) of a delivered message only; the hash is verified. */
  getAttachment(p: Principal, body: { attachment_id: string; bot_id?: string }) {
    const row = this.get("SELECT * FROM attachments WHERE id = ?", body?.attachment_id);
    assert(row, 404, "attachment_not_found", "no such attachment");
    const m = row.message_id ? this.get("SELECT id, recipient_bot, sender_bot, status FROM messages WHERE id = ?", row.message_id) : undefined;
    let allowed = false;
    if (m && m.status === "delivered") {
      if (p.kind === "owner") allowed = this.bot(m.recipient_bot).owner_id === this.requireOwner(p) && (!body.bot_id || body.bot_id === m.recipient_bot);
      else allowed = this.requireBot(p).botId === m.recipient_bot;
    }
    // Same answer whether it exists or not, so ids cannot be probed.
    assert(allowed, 404, "attachment_not_found", "no such attachment");
    assert(Date.parse(row.expires_at) > Date.now(), 410, "attachment_expired", "attachment expired");
    const bytes = unsealBytes(this.kmsKey, row.sealed, `attachment:${row.id}:${row.sha256}`);
    assert(sha256Hex(bytes) === row.sha256, 500, "attachment_corrupt", "attachment hash mismatch");
    this.audit.append("platform", "attachment.downloaded", row.id, [row.owner_id, this.bot(m.recipient_bot).owner_id], { message_id: m.id, sha256: row.sha256 });
    return { attachment: refOf(row), message_id: m.id, from: this.publicBot(this.bot(m.sender_bot)), trust: "peer_untrusted", content_base64: bytes.toString("base64") };
  }

  /**
   * Deletes expired files. Returns how many went.
   *
   * A file a card is still waiting on is not the upload clock's to delete: the sweep leaves a bound row alone while
   * the message it belongs to is `pending_approval`, because that card may still be approved and the peer may still
   * download the bytes. Only a card that can still be decided gets this stay: a card past its own `expires_at` is
   * not waiting for anything, even on an instance whose queue nobody reads (`expireStale` has not run), so the file
   * is collected instead of being held forever. A rejected, cancelled or expired line unbinds its file
   * (`freeDraftAttachments`) and a delivered one keeps its binding on the TTL it always had.
   *
   * Each destroyed row leaves its own `attachment.expired` line. The upload and the download write theirs, and every
   * other settled row in this family names its end (`approval.expired`, `grant.expired`, `relationship.expired`), so
   * a file the sweep deletes in silence leaves the uploader's chain reading uploaded, maybe downloaded, and nothing
   * while the delivered message keeps naming the file: the bytes are gone and no line says why the link stopped
   * resolving. The line names the home that received the ref as well as the uploader's when the message was
   * delivered, and carries the name, size and hash the signed payload already holds. A file a waiting card still
   * holds is not destroyed, so it gets no line, and a second sweep over the same rows writes nothing twice.
   */
  cleanupAttachments(now = Date.now()) {
    const at = new Date(now).toISOString();
    // The rows this run destroys are read before the delete so each one's line can name what went. Both statements
    // ask the same question of the same instant, and the sweep is the only writer of these rows.
    const doomed = this.all(`SELECT a.id, a.owner_id, a.name, a.size, a.sha256, a.message_id, m.status AS message_status, m.recipient_bot
      FROM attachments a LEFT JOIN messages m ON m.id = a.message_id
      WHERE a.expires_at <= ? AND (a.message_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM messages am JOIN approvals ap ON ap.id = am.approval_id
        WHERE am.id = a.message_id AND am.status = 'pending_approval'
          AND ap.status = 'pending' AND ap.expires_at > ?))`, at, at) as any[];
    if (!doomed.length) return 0;
    // The audit log is a second SQLite file (§9.13), so no transaction here can hold a line and the row it names
    // together; `auditFollowsCommit` only ever makes a line arrive after the write it describes. The line is
    // therefore written first and the destructive statement last. A store that refuses a line throws before a
    // single byte is destroyed, and the next sweep — the next read, the next upload — finds the file still stored
    // and writes the line it owed. The other order destroyed the rows first and then had no line left to write:
    // the row a line named was the row the delete had just taken, so no later run could ever repair the gap, and
    // the chain read `attachment.uploaded`, maybe `attachment.downloaded`, and nothing while a delivered message
    // kept naming a file that was gone. What this order leaves behind instead is a line for a row a failed DELETE
    // left standing, so the chain is asked about each row first and a row already named is not named twice; `has`
    // asks the table rather than a page of it, so the answer does not depend on how old the line is. Both callers
    // sweep outside a transaction, so each line is durable here before the delete below runs.
    for (const row of doomed) {
      if (this.audit.has("attachment.expired", row.id)) continue;
      // A received file is both homes' business, as its `attachment.downloaded` line already is; one no message held,
      // or one whose message never reached the peer, is the uploader's alone.
      const peer = row.message_status === "delivered" && row.recipient_bot
        ? this.get("SELECT owner_id FROM bots WHERE id = ?", row.recipient_bot)?.owner_id
        : null;
      this.audit.append("platform", "attachment.expired", row.id, [row.owner_id, peer],
        { name: row.name, size: row.size, sha256: row.sha256, ...(row.message_id ? { message_id: row.message_id } : {}) });
    }
    const r = this.run(`DELETE FROM attachments WHERE expires_at <= ?
      AND (message_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM messages m JOIN approvals a ON a.id = m.approval_id
        WHERE m.id = attachments.message_id AND m.status = 'pending_approval'
          AND a.status = 'pending' AND a.expires_at > ?))`, at, at) as any;
    return r?.changes ?? 0;
  }

  /**
   * Every ref a draft carries must still be a live file when its card is decided. The sweep keeps a waiting card's
   * file, but nothing extends it: a file can outlive its own deadline under a card that waited longer, and a short
   * `BOTSOCIAL_ATTACHMENT_TTL_DAYS` makes that the ordinary case. The caller refuses before its first write, so the
   * card stays pending and the owner can reject it and upload the file again.
   */
  private assertDraftAttachmentsLive(payload: any) {
    const refs = Array.isArray(payload?.attachments) ? payload.attachments : [];
    for (const ref of refs) {
      const row = this.get("SELECT expires_at FROM attachments WHERE id = ?", ref?.id);
      assert(row, 404, "attachment_not_found", "an attachment on this line is gone; reject this card and upload the file again");
      assert(Date.parse(row.expires_at) > Date.now(), 410, "attachment_expired",
        "an attachment on this line has expired; reject this card and upload the file again");
    }
  }

  // ================================================================ custodial signing keys
  /** Store the platform-held signing key. Which key an owner's Bot signs with is a governance fact, so a custody
   *  row is not written without its own `bot.custody_enabled` record: the caller names the owner taking custody and
   *  how the key arrived. Onboarding writes this inside its transaction, and `auditFollowsCommit` holds the record
   *  until that transaction commits — a rollback drops the row and the record together, so the chain never names a
   *  sign-up that was refused. The `enable_custody` door calls the same method, which is why it still writes one. */
  private storeCustody(botId: string, kid: string, pem: string, audit?: { ownerId: string; mode: string }) {
    const now = nowIso();
    this.run(`INSERT INTO bot_custody (bot_id, kid, sealed_key, created_at, updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(bot_id) DO UPDATE SET kid = excluded.kid, sealed_key = excluded.sealed_key, updated_at = excluded.updated_at`, botId, kid, seal(this.kmsKey, pem, `${botId}:${kid}`), now, now);
    if (audit) this.audit.append(`owner:${audit.ownerId}`, "bot.custody_enabled", botId, [audit.ownerId], { kid, mode: audit.mode });
  }

  custodyStatus(p: Principal, botId?: string) {
    const ownerId = this.requireOwner(p);
    const bots = botId ? [this.ownBot(ownerId, botId)] : this.all("SELECT * FROM bots WHERE owner_id = ? ORDER BY created_at", ownerId);
    return bots.map((b: any) => { const c = this.get("SELECT kid, created_at, updated_at FROM bot_custody WHERE bot_id = ?", b.id); return { bot_id: b.id, handle: "@" + b.handle, custodial: !!c, kid: c?.kid ?? null, since: c?.created_at ?? null }; });
  }

  /** Opt a bot into custody. With private_key_pem: upload an already-registered key (kid looked up by public key).
   *  Without: rotate to a new platform-generated kid; existing kids stay valid (botctl keeps working). */
  enableCustody(p: Principal, botId: string | undefined, body: { private_key_pem?: string } = {}) {
    const ownerId = this.requireOwner(p);
    const b = botId ? this.ownBot(ownerId, botId) : this.get("SELECT * FROM bots WHERE owner_id = ? ORDER BY created_at LIMIT 1", ownerId);
    assert(b, 404, "bot_not_found");
    let kid: string, mode: string;
    if (body?.private_key_pem) {
      let pub: string;
      try { pub = publicRawFromPrivatePem(body.private_key_pem); } catch { throw new ApiError(400, "invalid_private_key", "private_key_pem must be an Ed25519 PKCS#8 PEM"); }
      const k = this.get("SELECT * FROM bot_keys WHERE bot_id = ? AND public_key = ? AND status = 'active' AND (expires_at IS NULL OR expires_at > ?)", b.id, pub, nowIso());
      assert(k, 400, "key_not_registered", "this private key does not match any active key of the bot");
      kid = k.kid; mode = "uploaded";
      // Adoption is the moment the platform takes over signing, so the verification window `addKey` stamped on this
      // row (the deadline for the key it replaced) cannot outlive it: left in place, it would expire the platform's
      // own signing identity while the owner no longer holds the private key to rotate. Only the adopted row loses
      // its date; a window that has already closed never reaches here (the lookup above refuses it, fail-closed).
      this.run("UPDATE bot_keys SET expires_at = NULL WHERE bot_id = ? AND kid = ?", b.id, kid);
      this.storeCustody(b.id, kid, body.private_key_pem, { ownerId, mode });
    } else {
      const kp = generateEd25519();
      kid = `cust_${new Date().toISOString().slice(0, 10).replaceAll("-", "")}_${randomBytes(2).toString("hex")}`;
      this.run("INSERT INTO bot_keys (bot_id, kid, alg, public_key, created_at) VALUES (?,?,?,?,?)", b.id, kid, "Ed25519", kp.publicKey, nowIso());
      mode = "rotated";
      this.storeCustody(b.id, kid, kp.privateKeyPem, { ownerId, mode });
    }
    return { bot_id: b.id, handle: "@" + b.handle, custodial: true, kid, mode, note: mode === "rotated" ? "new platform-held key added; existing keys (e.g. botctl) remain valid" : "uploaded key is now also held by the platform" };
  }

  disableCustody(p: Principal, botId: string) {
    const ownerId = this.requireOwner(p);
    const b = this.ownBot(ownerId, botId);
    const c = this.get("SELECT * FROM bot_custody WHERE bot_id = ?", b.id);
    assert(c, 404, "not_custodial");
    this.run("DELETE FROM bot_custody WHERE bot_id = ?", b.id);
    if (c.kid.startsWith("cust_")) this.run("UPDATE bot_keys SET status = 'revoked', expires_at = ? WHERE bot_id = ? AND kid = ?", nowIso(), b.id, c.kid);
    this.audit.append(`owner:${ownerId}`, "bot.custody_disabled", b.id, [ownerId], { kid: c.kid });
    return { bot_id: b.id, custodial: false };
  }

  /** Act as the owner's custodial bot: a bot principal plus a signer using the platform-held key. */
  custodialBot(p: Principal, botId?: string) {
    const ownerId = this.requireOwner(p);
    const c = botId
      ? this.get("SELECT c.* FROM bot_custody c JOIN bots b ON b.id = c.bot_id WHERE b.id = ? AND b.owner_id = ?", botId, ownerId)
      : this.get("SELECT c.* FROM bot_custody c JOIN bots b ON b.id = c.bot_id WHERE b.owner_id = ? ORDER BY b.created_at LIMIT 1", ownerId);
    assert(c, 409, "not_custodial", "this bot's signing key is not held by the platform; enable custody first (enable_custody)");
    // A stopped Bot and a removed one are different answers on every owner-side door (`assertInvitable`): the
    // home page's "send as member" must say the Bot can be resumed, not that its identity is gone.
    this.assertInvitable(this.bot(c.bot_id));
    const bp: Principal = { kind: "bot", botId: c.bot_id, ownerId };
    const pem = unseal(this.kmsKey, c.sealed_key, `${c.bot_id}:${c.kid}`);
    const sign = (type: string, payload: unknown, extra: { to?: string; conversation_id?: string } = {}) => signEnvelope({ type, from: c.bot_id, payload, kid: c.kid, privateKeyPem: pem, ...extra });
    return { botId: c.bot_id as string, bp, sign, cursor: c.events_cursor as number };
  }

  setCustodyCursor(botId: string, cursor: number) { this.run("UPDATE bot_custody SET events_cursor = ? WHERE bot_id = ?", cursor, botId); }

  changePassword(p: Principal, body: { current_password: string; new_password: string }) {
    const ownerId = this.requireOwner(p);
    const o = this.owner(ownerId);
    assert(checkPassword(String(body?.current_password ?? ""), o.password_hash), 401, "invalid_credentials", "current password is wrong");
    assert(typeof body.new_password === "string" && body.new_password.length >= 6, 400, "invalid_request", "new password must be >= 6 chars");
    this.run("UPDATE owners SET password_hash = ? WHERE id = ?", hashPassword(body.new_password), ownerId);
    // log out every web/login session; connector tokens stay (they are listed/revoked separately)
    this.run("UPDATE tokens SET revoked_at = ? WHERE kind = 'owner' AND subject_id = ? AND scope IS NULL AND revoked_at IS NULL", nowIso(), ownerId);
    this.audit.append(`owner:${ownerId}`, "owner.password_changed", ownerId, [ownerId], {});
    return { ok: true, note: "password changed; all login sessions were signed out (connector tokens unaffected)" };
  }

  /** Stores validated look fields (undefined = leave unchanged, null = clear). Returns the audit-safe change list. */
  private applyLook(botId: string, look: { avatar?: string | null; color?: string | null }) {
    const changed: Record<string, unknown> = {};
    if (look.avatar !== undefined) {
      this.run("UPDATE bots SET avatar = ?, avatar_updated_at = ? WHERE id = ?", look.avatar, nowIso(), botId);
      changed.avatar = avatarFingerprint(look.avatar);
    }
    if (look.color !== undefined) {
      this.run("UPDATE bots SET color = ? WHERE id = ?", look.color, botId);
      changed.color = look.color;
    }
    return changed;
  }

  /** Owner (login or connector) changes the display name, the look and/or the one-line card. Fields are optional
   *  but at least one is required; `avatar` / `color` / `description` set to null (or "") clear that field. */
  updateBotProfile(p: Principal, botId: string | undefined, body: { display_name?: string; avatar?: string | null; color?: string | null; description?: string | null }) {
    const ownerId = this.requireOwner(p);
    const b = botId ? this.ownBot(ownerId, botId) : this.get("SELECT * FROM bots WHERE owner_id = ? ORDER BY created_at LIMIT 1", ownerId);
    assert(b, 404, "bot_not_found");
    const has = (k: string) => body?.[k as keyof typeof body] !== undefined;
    assert(has("display_name") || has("avatar") || has("color") || has("description"), 400, "invalid_request", "provide display_name, avatar, color and/or description");
    let name: string | undefined;
    if (has("display_name")) {
      assert(typeof body.display_name === "string", 400, "invalid_request", "display_name must be a string");
      name = peerDisplayName(body.display_name, "");
      assert(name.length >= 1, 400, "invalid_request", "display_name: 1-60 chars");
    }
    let description: string | null | undefined;
    if (has("description")) {
      assert(body.description === null || typeof body.description === "string", 400, "invalid_description", "description must be a string or null");
      const text = String(body.description ?? "").trim();
      assert(text.length <= BOT_DESCRIPTION_MAX, 400, "invalid_description", `description: 1-${BOT_DESCRIPTION_MAX} chars`);
      description = text === "" ? null : text;
    }
    const avatar = has("avatar") ? validateAvatar(body.avatar) : undefined;
    const color = has("color") ? validateColor(body.color) : undefined;
    // The name, the look and the one-line card are the face other homes read about this Bot, so editing them is
    // its outward act even when the owner types it. A stopped or removed identity is refused here for the same
    // reason the room line door refuses it, before the one transaction writes all four fields: clearing a field is
    // a write as well, and the words already published stay on the peer's card until the owner resumes the Bot.
    // The door keeps its own order — a body with no field, a non-string value or an over-long card is still the
    // same 400 it was before this guard is reached.
    this.assertInvitable(b);
    this.db.transaction(() => {
      if (name !== undefined) this.run("UPDATE bots SET display_name = ? WHERE id = ?", name, b.id);
      if (description !== undefined) this.run("UPDATE bots SET description = ? WHERE id = ?", description, b.id);
      const changed = this.applyLook(b.id, { avatar, color });
      this.audit.append(this.actorOf(p), "bot.profile_updated", b.id, [ownerId], { ...(name !== undefined ? { display_name: name } : {}), ...(description !== undefined ? { description: description === null ? "cleared" : "set" } : {}), ...changed });
    })();
    return this.botCard(this.bot(b.id), true);
  }

  me(p: Principal) {
    if (p.kind === "owner") {
      const o = this.owner(p.ownerId);
      // #44: `home` is the owner's FlyBot home Bot in the "@handle" spelling used by event.from / item.peer, so a
      // connector never has to parse connector_identity or reconcile the two spellings. `bots[].handle` stays bare.
      const home = this.get("SELECT handle, display_name FROM bots WHERE owner_id = ? AND integration_type = 'flybot-home' ORDER BY created_at LIMIT 1", p.ownerId);
      return { kind: "owner", owner_id: o.id, username: o.username, display_name: o.display_name, timezone: o.timezone, sensitive_terms: J(o.sensitive_terms, []), auto_approve_face_rooms: !!o.auto_approve_face_rooms, notify_bot_id: o.notify_bot_id ?? null, quiet_start: o.quiet_start ?? null, quiet_end: o.quiet_end ?? null, home: home ? "@" + home.handle : null, home_name: home ? home.display_name : null, bots: this.listBots(p) };
    }
    const b = this.bot(p.botId);
    return { kind: "bot", ...this.botCard(b, true), status: b.status };
  }

  updateSettings(p: Principal, body: { sensitive_terms?: string[]; timezone?: string; display_name?: string; auto_approve_face_rooms?: boolean; notify_bot_id?: string | null; quiet_start?: string | null; quiet_end?: string | null }) {
    const ownerId = this.requireOwner(p);
    // A refused field must not leave the other fields of the same request written: validate first.
    let displayName: string | undefined;
    if (body?.display_name !== undefined) {
      assert(typeof body.display_name === "string", 400, "invalid_request", "display_name must be a string");
      displayName = peerDisplayName(body.display_name, "");
      assert(displayName.length >= 1, 400, "invalid_request", "display_name: 1-60 chars");
    }
    // #139 ② C: the outlet is one of the owner's own Bots, chosen here rather than through a new route. `null` clears it.
    // The refusal never says whether the id exists, so it cannot be used to probe another owner's Bots.
    let notifyBotId: string | null | undefined;
    if (body?.notify_bot_id !== undefined) {
      if (body.notify_bot_id === null) notifyBotId = null;
      else {
        assert(typeof body.notify_bot_id === "string" && body.notify_bot_id.length > 0, 400, "invalid_request", "notify_bot_id must be a Bot id or null");
        const outlet = this.get("SELECT id, owner_id, status FROM bots WHERE id = ?", body.notify_bot_id);
        assert(outlet && outlet.owner_id === ownerId, 400, "invalid_request", "notify_bot_id must name one of your own Bots");
        // A revoked identity can never read its event queue (#177 ③) nor get a token again, so a card announced to
        // it is written and then lost. A frozen one is still a valid outlet: its queue survives the stop and is
        // read after resume.
        assert(outlet.status !== "revoked", 400, "invalid_request", "a revoked Bot cannot be the approval outlet");
        notifyBotId = outlet.id;
      }
    }
    // Quiet hours are the owner's own wall clock: `HH:MM` read in their zone, so the pair is what makes a window.
    // One without the other, a malformed clock, or a window that starts where it ends is refused before any write;
    // both null clears the window and turns the immediate announcement back on.
    let quiet: { start: string | null; end: string | null } | undefined;
    if (body?.quiet_start !== undefined || body?.quiet_end !== undefined) {
      assert(body?.quiet_start !== undefined && body?.quiet_end !== undefined, 400, "invalid_request", "quiet_start and quiet_end must be set together");
      const clock = (v: unknown, field: string): string | null => {
        if (v === null) return null;
        assert(typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v), 400, "invalid_request", `${field} must be HH:MM (24-hour) or null`);
        return v;
      };
      const start = clock(body.quiet_start, "quiet_start");
      const end = clock(body.quiet_end, "quiet_end");
      assert((start === null) === (end === null), 400, "invalid_request", "quiet_start and quiet_end must both be a time or both be null");
      assert(start === null || start !== end, 400, "invalid_request", "quiet_start and quiet_end must differ");
      quiet = { start, end };
    }
    // Validate before any write, so a bad zone cannot leave the rest of the patch behind it half-applied.
    const timezone = body.timezone ? this.validateTimezone(body.timezone) : undefined;
    // The words are matched against message text verbatim, so a coerced number or object is a word nobody typed; refuse
    // every shape but an array of strings before the first write. `invalid_request` is the 400 this file uses for a bad
    // field (mentions, attachments and capabilities are validated the same way).
    assert(body.sensitive_terms === undefined || (Array.isArray(body.sensitive_terms) && body.sensitive_terms.every((t) => typeof t === "string")), 400, "invalid_request", "sensitive_terms must be an array of strings");
    // `fields` names what this patch wrote, not the keys the caller sent: `{"nope":1}` writes nothing, `{"timezone":""}`
    // is dropped by the validation above, and an empty body writes nothing at all. A patch that writes nothing must not
    // append an "updated account settings" row — the chain would claim a change that never happened.
    const changed: string[] = [];
    if (Array.isArray(body.sensitive_terms)) { this.run("UPDATE owners SET sensitive_terms = ? WHERE id = ?", JSON.stringify(body.sensitive_terms), ownerId); changed.push("sensitive_terms"); }
    if (timezone) { this.run("UPDATE owners SET timezone = ? WHERE id = ?", timezone, ownerId); changed.push("timezone"); }
    if (displayName !== undefined) { this.run("UPDATE owners SET display_name = ? WHERE id = ?", displayName, ownerId); changed.push("display_name"); }
    if (typeof body.auto_approve_face_rooms === "boolean") { this.run("UPDATE owners SET auto_approve_face_rooms = ? WHERE id = ?", body.auto_approve_face_rooms ? 1 : 0, ownerId); changed.push("auto_approve_face_rooms"); }
    if (notifyBotId !== undefined) { this.run("UPDATE owners SET notify_bot_id = ? WHERE id = ?", notifyBotId, ownerId); changed.push("notify_bot_id"); }
    if (quiet) { this.run("UPDATE owners SET quiet_start = ?, quiet_end = ? WHERE id = ?", quiet.start, quiet.end, ownerId); changed.push("quiet_start", "quiet_end"); }
    // `fields` alone cannot tell a switch turned on from one turned off: both rows would read alike. Record the value
    // where the value is the point — the auto-approve flag, and how many sensitive words were set, never the words
    // themselves, which are the owner's secrets. Every other field stays a name only.
    if (changed.length > 0) this.audit.append(`owner:${ownerId}`, "owner.settings_updated", ownerId, [ownerId], {
      fields: changed,
      ...(typeof body.auto_approve_face_rooms === "boolean" ? { auto_approve_face_rooms: body.auto_approve_face_rooms } : {}),
      ...(Array.isArray(body.sensitive_terms) ? { sensitive_terms: body.sensitive_terms.length } : {}),
    });
    return this.me(p);
  }

  // ================================================================ GitHub OAuth (#76)
  private oauthReady() {
    assert(this.oauth.enabled, 404, "oauth_not_configured", "GitHub sign-in is not configured on this server");
  }
  private oauthProviderOr404(providerId: unknown) {
    this.oauthReady();
    const id = typeof providerId === "string" ? providerId : "";
    assert(id === GITHUB_PROVIDER.id, 404, "unknown_provider", "unknown identity provider");
    return GITHUB_PROVIDER;
  }
  /** `signin` counts starts; `connect`/`unbind` count failures. One window shape: 5 failures / 15 min. */
  private oauthAttempts(action: "signin" | "connect" | "unbind", key: string, windowMs: number): number {
    const since = new Date(this.nowMs() - windowMs).toISOString();
    return (this.get("SELECT COUNT(*) n FROM oauth_attempts WHERE action = ? AND attempt_key = ? AND created_at > ?", action, key, since) as any).n as number;
  }
  private oauthLocked(action: "connect" | "unbind", ownerId: string): boolean {
    return this.oauthAttempts(action, ownerId, 15 * 60_000) >= 5;
  }
  private oauthRecordFailure(action: "connect" | "unbind", ownerId: string) {
    this.run("INSERT INTO oauth_attempts (action, attempt_key, created_at) VALUES (?,?,?)", action, ownerId, this.ts());
    this.run("DELETE FROM oauth_attempts WHERE created_at <= ?", new Date(this.nowMs() - 24 * 3600_000).toISOString());
  }
  private oauthClearFailures(action: "connect" | "unbind", ownerId: string) {
    this.run("DELETE FROM oauth_attempts WHERE action = ? AND attempt_key = ?", action, ownerId);
  }

  /**
   * One state row and the browser binding that goes with it. The state and the cookie are stored only as
   * sha256; the verifier is stored because the token exchange needs it, and the callback nulls it on consume.
   */
  private oauthMintState(mode: "link" | "signin", ownerId: string | null) {
    const cfg = this.oauth;
    const now = this.nowMs();
    this.run("DELETE FROM oauth_states WHERE expires_at <= ?", new Date(now).toISOString());
    if (ownerId) {
      const pending = (this.get("SELECT COUNT(*) n FROM oauth_states WHERE owner_id = ? AND consumed_at IS NULL AND expires_at > ?", ownerId, new Date(now).toISOString()) as any).n;
      if (pending >= 5) throw new ApiError(429, "oauth_too_many_pending", "too many GitHub sign-ins are waiting; finish one or wait for them to expire");
    }
    const state = newOAuthSecret();
    const verifier = newPkceVerifier(); // base64url(32 bytes) = 43 chars: the CHECK's floor
    const cookie = newOAuthSecret();
    const expiresAt = new Date(now + 10 * 60_000).toISOString();
    this.run(`INSERT INTO oauth_states (state_hash, provider, mode, owner_id, cookie_hash, code_verifier, redirect_uri, created_at, expires_at)
      VALUES (?,?,?,?,?,?,?,?,?)`,
      sha256Text(state), GITHUB_PROVIDER.id, mode, ownerId, sha256Text(cookie), verifier, cfg.redirectUri!, new Date(now).toISOString(), expiresAt);
    const authorize_url = GITHUB_PROVIDER.authorizeUrl({
      state, redirectUri: cfg.redirectUri!, codeChallenge: pkceChallenge(verifier), clientId: cfg.clientId!,
      ...(mode === "signin" ? { prompt: "select_account" } : {}),
    });
    return { authorize_url, expires_at: expiresAt, cookie: oauthBindingCookie(cookie, cfg) };
  }

  oauthProviders(p: Principal) {
    this.oauthReady();
    this.requireOwner(p);
    const provider = GITHUB_PROVIDER;
    return { providers: [{ id: provider.id, label: provider.label, scopes: [...provider.scopes] }] };
  }

  /** Link start: owner login token + the account password (D4 + E1 = (a), the `connect` bucket). */
  oauthLinkStart(p: Principal, providerId: unknown, body: any) {
    this.oauthProviderOr404(providerId);
    const ownerId = this.requireOwner(p);
    if (this.oauthLocked("connect", ownerId)) throw new ApiError(429, "oauth_too_many_attempts", "too many wrong passwords; try again later");
    const o = this.owner(ownerId);
    let ok = false;
    if (typeof body?.current_password === "string" && typeof o.password_hash === "string" && o.password_hash) {
      try { ok = checkPassword(body.current_password, o.password_hash); } catch { ok = false; }
    }
    if (!ok) {
      this.oauthRecordFailure("connect", ownerId);
      throw new ApiError(401, "invalid_credentials", "current password is wrong");
    }
    this.oauthClearFailures("connect", ownerId);
    const minted = this.oauthMintState("link", ownerId);
    return { authorize_url: minted.authorize_url, expires_at: minted.expires_at, cookie: minted.cookie };
  }

  /** Sign-in start: no auth, no body, no password. The address half of the budget is a courtesy (§12 T8). */
  oauthSigninStart(ip: string | undefined) {
    this.oauthReady();
    const key = ip || "unknown";
    if (this.oauthAttempts("signin", key, 10 * 60_000) >= 20) throw new ApiError(429, "oauth_too_many_attempts", "too many GitHub sign-ins from this address; try again later");
    const hourAgo = new Date(this.nowMs() - 3600_000).toISOString();
    if ((this.get("SELECT COUNT(*) n FROM oauth_attempts WHERE action = 'signin' AND created_at > ?", hourAgo) as any).n >= 200) {
      throw new ApiError(429, "oauth_too_many_attempts", "too many GitHub sign-ins right now; try again later");
    }
    this.run("INSERT INTO oauth_attempts (action, attempt_key, created_at) VALUES (?,?,?)", "signin", key, this.ts());
    this.run("DELETE FROM oauth_attempts WHERE created_at <= ?", new Date(this.nowMs() - 24 * 3600_000).toISOString());
    const minted = this.oauthMintState("signin", null);
    return { authorize_url: minted.authorize_url, cookie: minted.cookie };
  }

  /**
   * The callback. Burn the state first (single atomic UPDATE, verifier read before and nulled by it), then
   * talk to GitHub. Every return path carries the cookie-clearing header; the route decides page vs redirect.
   */
  async oauthCallback(providerId: unknown, query: Record<string, unknown>, cookieHeader: string | undefined): Promise<OAuthCallbackResult> {
    const clearCookie = oauthClearCookie(this.oauth);
    const invalid = (): OAuthCallbackResult => ({ status: 400, apiCode: "oauth_state_invalid", clearCookie });
    this.oauthReady();
    if (providerId !== GITHUB_PROVIDER.id) return invalid();
    // Presence is optional; singularity is not. An array (repeated key) or a nested value is never coerced.
    const one = (v: unknown) => v === undefined || typeof v === "string";
    if (!one(query?.code) || !one(query?.state) || !one(query?.error)) return invalid();
    const state = typeof query?.state === "string" ? query.state : "";
    const code = typeof query?.code === "string" ? query.code : "";
    const providerError = typeof query?.error === "string" ? query.error : "";
    if (!state || (!code && !providerError)) return invalid();

    const row = this.get("SELECT * FROM oauth_states WHERE state_hash = ?", sha256Text(state));
    if (!row || row.consumed_at || Date.parse(row.expires_at) <= this.nowMs()) return invalid();
    const cookie = readOAuthCookie(cookieHeader);
    if (!cookie || !row.cookie_hash || !timingSafeEqualString(sha256Text(cookie), row.cookie_hash)) return invalid();

    const verifier = row.code_verifier;
    const consumed = this.run("UPDATE oauth_states SET consumed_at = ?, code_verifier = NULL WHERE state_hash = ? AND consumed_at IS NULL", this.ts(), row.state_hash);
    if (consumed.changes === 0) return invalid();

    if (providerError) {
      return { status: 302, location: `/ui#/login?oauth=${providerError === "access_denied" ? "cancelled" : "rejected"}`, clearCookie };
    }

    let profile: OAuthProfile;
    try {
      profile = await GITHUB_PROVIDER.exchange({
        code,
        codeVerifier: String(verifier ?? ""),
        redirectUri: row.redirect_uri,
        clientId: this.oauth.clientId!,
        clientSecret: this.oauth.clientSecret!,
      }, this.fetchImpl);
    } catch (e) {
      const kind = e instanceof OAuthExchangeError ? e.kind : "provider_unavailable";
      if (kind === "bad_profile") return { status: 502, apiCode: "oauth_provider_rejected", clearCookie };
      return { status: 302, location: `/ui#/login?oauth=${kind === "rejected" ? "rejected" : "provider_unavailable"}`, clearCookie };
    }

    if (row.mode === "link") {
      const ownerId = String(row.owner_id ?? "");
      const existing = this.get("SELECT * FROM oauth_identities WHERE provider = ? AND subject = ?", GITHUB_PROVIDER.id, profile.subject);
      if (existing && existing.owner_id !== ownerId) return { status: 302, location: "/ui#/login?oauth=identity_taken", clearCookie };
      const mine = this.get("SELECT * FROM oauth_identities WHERE provider = ? AND owner_id = ?", GITHUB_PROVIDER.id, ownerId);
      if (mine && mine.subject !== profile.subject) return { status: 302, location: "/ui#/login?oauth=identity_conflict", clearCookie };
      try {
        this.db.transaction(() => {
          if (existing) this.run("UPDATE oauth_identities SET login = ? WHERE provider = ? AND subject = ?", profile.login, GITHUB_PROVIDER.id, profile.subject);
          else this.run("INSERT INTO oauth_identities (provider, subject, owner_id, login, created_at) VALUES (?,?,?,?,?)", GITHUB_PROVIDER.id, profile.subject, ownerId, profile.login, this.ts());
          this.audit.append(`owner:${ownerId}`, "oauth.identity_linked", ownerId, [ownerId], { provider: GITHUB_PROVIDER.id, subject_fp: subjectFingerprint(profile.subject) });
        })();
      } catch {
        return { status: 302, location: "/ui#/login?oauth=identity_conflict", clearCookie };
      }
      return { status: 302, location: "/ui#/settings?oauth=ok", clearCookie };
    }

    // Sign-in: resolve the subject, refuse an unknown one, mint the one-time code the browser reads.
    const identity = this.get("SELECT * FROM oauth_identities WHERE provider = ? AND subject = ?", GITHUB_PROVIDER.id, profile.subject);
    if (!identity) return { status: 302, location: "/ui#/login?oauth=not_linked", clearCookie };
    const now = this.nowMs();
    this.run("DELETE FROM oauth_step_codes WHERE expires_at <= ?", new Date(now).toISOString());
    const stepCode = newOAuthSecret();
    this.run("INSERT INTO oauth_step_codes (code_hash, provider, owner_id, created_at, expires_at) VALUES (?,?,?,?,?)",
      sha256Text(stepCode), GITHUB_PROVIDER.id, identity.owner_id, this.ts(), new Date(now + 60_000).toISOString());
    return { status: 302, location: `/ui#/oauth?code=${stepCode}`, clearCookie };
  }

  /** Redeem the step code: consume, re-check the identity, mint the token — one transaction (§6.3). */
  oauthExchange(body: any) {
    this.oauthReady();
    const code = typeof body?.code === "string" ? body.code : "";
    const invalid = () => new ApiError(400, "oauth_code_invalid", "this sign-in code is invalid or expired; sign in with GitHub again");
    if (!code) throw invalid();
    const row = this.get("SELECT * FROM oauth_step_codes WHERE code_hash = ?", sha256Text(code));
    let token = "";
    this.db.transaction(() => {
      if (!row) throw invalid();
      if (Date.parse(row.expires_at) <= this.nowMs()) throw invalid();
      const consumed = this.run("UPDATE oauth_step_codes SET consumed_at = ? WHERE code_hash = ? AND consumed_at IS NULL", this.ts(), row.code_hash);
      if (consumed.changes === 0) throw invalid();
      const still = this.get("SELECT 1 AS ok FROM oauth_identities WHERE provider = ? AND owner_id = ?", row.provider, row.owner_id);
      if (!still) throw invalid();
      token = this.issueToken("owner", row.owner_id, "oauth:github");
      this.audit.append(`owner:${row.owner_id}`, "oauth.signin", row.owner_id, [row.owner_id], { provider: row.provider });
    })();
    return { owner_token: token };
  }

  oauthIdentities(p: Principal) {
    this.oauthReady();
    const ownerId = this.requireOwner(p);
    return { identities: this.all("SELECT provider, login, created_at FROM oauth_identities WHERE owner_id = ? ORDER BY created_at, provider", ownerId) };
  }

  /**
   * Unbind: the password gate (D4, the `unbind` bucket), then the last-method predicate, then one transaction
   * that drops the row, every state for it (consumed included) and the sessions it minted.
   */
  oauthUnlink(p: Principal, providerId: unknown, body: any) {
    this.oauthProviderOr404(providerId);
    const ownerId = this.requireOwner(p);
    const o = this.owner(ownerId);
    const hasPassword = typeof o.password_hash === "string" && o.password_hash.length > 0;
    const identity = this.get("SELECT * FROM oauth_identities WHERE provider = ? AND owner_id = ?", GITHUB_PROVIDER.id, ownerId);
    if (hasPassword) {
      if (this.oauthLocked("unbind", ownerId)) throw new ApiError(429, "too_many_attempts", "too many wrong passwords; try again later");
      let ok = false;
      if (typeof body?.current_password === "string") {
        try { ok = checkPassword(body.current_password, o.password_hash); } catch { ok = false; }
      }
      if (!ok) {
        this.oauthRecordFailure("unbind", ownerId);
        throw new ApiError(401, "invalid_credentials", "current password is wrong");
      }
      this.oauthClearFailures("unbind", ownerId);
    }
    assert(identity, 404, "oauth_not_linked", "this account has no such identity linked");
    const others = (this.get("SELECT COUNT(*) n FROM oauth_identities WHERE owner_id = ? AND provider <> ?", ownerId, GITHUB_PROVIDER.id) as any).n;
    if (!hasPassword && others === 0) {
      throw new ApiError(409, "last_signin_method", "connect another way to sign in, or set a password, before removing this one");
    }
    this.db.transaction(() => {
      this.run("DELETE FROM oauth_identities WHERE provider = ? AND owner_id = ?", GITHUB_PROVIDER.id, ownerId);
      this.run("DELETE FROM oauth_states WHERE owner_id = ? AND provider = ?", ownerId, GITHUB_PROVIDER.id);
      this.run("UPDATE tokens SET revoked_at = ? WHERE kind = 'owner' AND subject_id = ? AND via = 'oauth:github' AND revoked_at IS NULL", this.ts(), ownerId);
      this.audit.append(`owner:${ownerId}`, "oauth.identity_unlinked", ownerId, [ownerId], { provider: GITHUB_PROVIDER.id, subject_fp: subjectFingerprint(String(identity!.subject)) });
    })();
  }

  // ================================================================ bots & keys
  /**
   * Handle uniqueness is global and case-insensitive (see `botByRef`). The refusal names the stored spelling only when
   * the caller already owns that row: for another owner's Bot the message stays generic, because naming it would echo
   * back the one string that addresses that exact row (with a legacy mixed-case pair, the exact spelling) to a caller
   * who could not have known it — a probe for other people's handles.
   */
  private assertHandleFree(handle: string, ownerId?: string) {
    const taken = this.get("SELECT handle, owner_id FROM bots WHERE LOWER(handle) = ?", handle);
    const own = !!taken && ownerId !== undefined && taken.owner_id === ownerId;
    assert(!taken, 409, "handle_taken", own ? `handle @${taken!.handle} is already taken` : "that handle is already taken");
    return taken;
  }

  registerBot(p: Principal, body: { handle: string; display_name?: string; avatar?: string | null; color?: string | null; integration_type?: string; webhook_url?: string; public_key?: { alg?: string; kid: string; value: string } }) {
    const ownerId = this.requireOwner(p);
    assert(body?.display_name === undefined || typeof body.display_name === "string", 400, "invalid_request", "display_name must be a string");
    // A handle is a string, and the type gate stands before `handleKey` coerces: `String(ref ?? "")` turned `true`
    // into "@true" and `1.5` into "@1.5" — live Bots at globally unique handles nobody wrote, which then refused the
    // real ones — and `["xy"]` slipped past the format check as "xy". One refusal for every shape claims nothing. An
    // absent or `null` handle still reaches the format check as "" and keeps the "2-40 chars" answer it always had.
    assert(body?.handle === undefined || body?.handle === null || typeof body.handle === "string", 400, "invalid_request", "handle must be a string");
    // A type is a name, not a value to coerce. The insert below hands the value to SQLite as it came: `42`, `1.5`
    // and `["x"]` were stored as the text "42.0", "1.5" and "x" and answered 201 with a live Bot under a type nobody
    // wrote, which every later `GET /v1/bots` reads back; an object, an array or `true` crashed the binder as a 500
    // after the key had been generated; and `0` and `false` were swallowed by `|| "rest"` into the default without
    // saying so. Only an absent, `null` or string type goes on; an empty string still means "use the default" and
    // every string keeps the answer it had.
    assert(body?.integration_type === undefined || body?.integration_type === null || typeof body.integration_type === "string", 400, "invalid_request", "integration_type must be a string");
    const handle = handleKey(body?.handle);
    assert(/^[a-z0-9._-]{2,40}$/i.test(handle), 400, "invalid_request", "handle: 2-40 chars [a-z0-9._-]");
    this.assertHandleFree(handle, ownerId);
    const look = { avatar: body?.avatar !== undefined ? validateAvatar(body.avatar) : undefined, color: body?.color !== undefined ? validateColor(body.color) : undefined };
    let generated: { kid: string; publicKey: string; privateKeyPem: string } | undefined;
    let key = body.public_key;
    if (!key) {
      // platform-generated key for hosts that cannot manage keys (returned once; KMS custody is out of MVP scope)
      const kp = generateEd25519();
      generated = { kid: "key_" + new Date().toISOString().slice(0, 7).replace("-", "_"), ...kp };
      key = { alg: "Ed25519", kid: generated.kid, value: kp.publicKey };
    }
    assert(!key.alg || key.alg === "Ed25519", 400, "invalid_request", "only Ed25519 keys are supported");
    // A key's name is the string the caller wrote, and only a string reaches SQL. Handed straight to the binder,
    // `["k1"]` was flattened and stored "k1" while the answer echoed the array, `42` was stored as the text "42.0"
    // so `DELETE /keys/42` never found the key its registration had just echoed, and an object, a boolean, a
    // multi-element array or an absent name crashed the INSERT as a 500 after the key had been generated. Every
    // surface that names a key (`bot_keys.kid`, the register answer, `GET /v1/bots`, `DELETE`, the envelope's
    // `sig.kid`) reads this one value, so all of them now see the caller's string or the request is refused whole.
    assert(typeof key.kid === "string", 400, "invalid_request", "public_key.kid must be a string");
    try { publicKeyFromRaw(key.value); } catch { throw new ApiError(400, "invalid_public_key", "public_key.value must be base64url raw 32-byte Ed25519 key"); }
    const id = newId("bot");
    const webhookSecret = randomToken("whs");
    this.db.transaction(() => {
      this.run("INSERT INTO bots (id, owner_id, handle, display_name, integration_type, webhook_url, webhook_secret, created_at) VALUES (?,?,?,?,?,?,?,?)",
        id, ownerId, handle, peerDisplayName(body.display_name, handle), body.integration_type || "rest", body.webhook_url ? validateUrl(body.webhook_url) : null, webhookSecret, nowIso());
      this.run("INSERT INTO bot_keys (bot_id, kid, alg, public_key, created_at) VALUES (?,?,?,?,?)", id, key!.kid, "Ed25519", key!.value, nowIso());
    })();
    const botToken = this.issueToken("bot", id);
    const lookChanged = this.applyLook(id, look);
    this.audit.append(`owner:${ownerId}`, "bot.registered", id, [ownerId], { handle, kid: key.kid, public_key: key.value, integration_type: body.integration_type || "rest", ...lookChanged });
    return {
      ...lookOf(this.bot(id)),
      bot_id: id, owner_id: ownerId, handle: "@" + handle, status: "active", bot_token: botToken, webhook_secret: webhookSecret,
      key: { kid: key.kid, public_key: key.value, ...(generated ? { private_key_pem: generated.privateKeyPem, note: "platform-generated; returned once, store it securely" } : {}) },
      mcp: { transport: "stdio", command: "npm run mcp", env: { BOTSOCIAL_URL: this.publicBaseUrl, BOTSOCIAL_BOT_ID: id } },
    };
  }

  listBots(p: Principal) {
    const ownerId = this.requireOwner(p);
    // `custodial` is read-only: whether the platform holds this Bot's signing key (`bot_custody`), which is the only
    // thing that decides if the owner's console may send as it (`custodialBot`). Never inferred from integration_type.
    return this.all("SELECT id, handle, display_name, description, avatar, color, avatar_updated_at, integration_type, webhook_url, status, created_at, EXISTS (SELECT 1 FROM bot_custody c WHERE c.bot_id = bots.id) AS custodial FROM bots WHERE owner_id = ?", ownerId).map((b) => ({
      ...b, custodial: !!b.custodial, ...lookOf(b), webhook_url: redactUrl(b.webhook_url), webhook: { configured: !!b.webhook_url }, keys: this.all("SELECT kid, alg, public_key, status, created_at, expires_at FROM bot_keys WHERE bot_id = ?", b.id),
      draft_budget: this.draftBudget(b.id),
    }));
  }

  private ownBot(ownerId: string, botId: string) {
    const b = this.bot(botId);
    assert(b.owner_id === ownerId, 403, "forbidden", "not your bot");
    return b;
  }

  addKey(p: Principal, botId: string, body: { kid: string; value: string; retire_others_in_days?: number }) {
    const ownerId = this.requireOwner(p);
    this.ownBot(ownerId, botId);
    assert(body?.kid && body?.value, 400, "invalid_request", "kid and value required");
    // The kid is the binding of the lookup below and of the insert: an object was taken for named parameters
    // (RangeError) and a boolean had no binding (TypeError), which answered 500 inside better-sqlite3; a number
    // bound as REAL, so kid 7 and the flattened [1] were stored in the TEXT column as "7.0"/"1.0" and the key
    // could never be revoked by its name. A kid is a string, and only a string reaches SQL.
    assert(typeof body.kid === "string", 400, "invalid_request", "kid must be a string");
    try { publicKeyFromRaw(body.value); } catch { throw new ApiError(400, "invalid_public_key"); }
    // `retire_others_in_days` is the caller's day count for every key already on the Bot, so it is checked as one
    // before anything is written: whole days, 0 to 365. Taken raw, "abc" became an invalid Date and answered 500
    // on a write path, and 0 or a negative count pulled every existing key's expiry into the past while the rows
    // still read `active` — the Bot then silently stopped signing. 0 stays legal with its meaning: the other keys
    // expire at once, which is what an owner replacing a lost key wants. Only the range and the whole-day rule are new.
    const raw = (body as any)?.retire_others_in_days as unknown;
    const days = raw === undefined || raw === null ? 7 : raw;
    assert(typeof days === "number" && Number.isInteger(days) && days >= 0 && days <= 365, 400, "invalid_request", "retire_others_in_days must be a whole number of days from 0 to 365");
    assert(!this.get("SELECT 1 FROM bot_keys WHERE bot_id = ? AND kid = ?", botId, body.kid), 409, "kid_exists");
    // rotation: old keys stay valid for the requested window, one week by default
    const until = new Date(Date.now() + (days as number) * 86400e3).toISOString();
    // The key the platform signs this Bot's owner-side sends with (`bot_custody.kid`) is not one of the caller's old
    // keys: dating it would answer 401 invalid_signature on every owner-side send once the window closed, so the
    // sweep retires the caller's keys and leaves the platform's own signing identity alone.
    this.run(`UPDATE bot_keys SET expires_at = ? WHERE bot_id = ? AND status = 'active' AND expires_at IS NULL
      AND kid NOT IN (SELECT kid FROM bot_custody WHERE bot_id = ?)`, until, botId, botId);
    this.run("INSERT INTO bot_keys (bot_id, kid, alg, public_key, created_at) VALUES (?,?,?,?,?)", botId, body.kid, "Ed25519", body.value, nowIso());
    this.audit.append(`owner:${ownerId}`, "bot.key_added", botId, [ownerId], { kid: body.kid, old_keys_expire_at: until });
    return { bot_id: botId, kid: body.kid, status: "active" };
  }

  revokeKey(p: Principal, botId: string, kid: string) {
    const ownerId = this.requireOwner(p);
    this.ownBot(ownerId, botId);
    // The same key cannot be revoked from this door: the connector would answer 401 invalid_signature on every send.
    // Custody is what has to move first, and the reachable way is `enable_custody` in rotate mode: it moves custody to
    // a fresh key and leaves this one in place, so this door can then revoke it like any other key.
    const custody = this.get("SELECT kid FROM bot_custody WHERE bot_id = ?", botId);
    assert(!custody || custody.kid !== kid, 409, "custody_key_held",
      "the platform signs this bot's owner-side sends with this key; move custody to a new key first (enable_custody, rotate), then revoke this one");
    const r = this.run("UPDATE bot_keys SET status = 'revoked' WHERE bot_id = ? AND kid = ?", botId, kid);
    assert(r.changes, 404, "key_not_found");
    this.audit.append(`owner:${ownerId}`, "bot.key_revoked", botId, [ownerId], { kid });
    return { bot_id: botId, kid, status: "revoked" };
  }

  /** Owner of the bot, or the bot itself, may manage its webhook. */
  private webhookBot(p: Principal, botId: string) {
    if (p.kind === "bot") { assert(p.botId === botId, 403, "forbidden", "a bot may only manage its own webhook"); return this.bot(botId); }
    return this.ownBot(p.ownerId, botId);
  }
  /** The actor an audit row is written under. A connector token is the owner's assistant writing for them, so it is
   *  tagged `:mcp` here: one rule for the MCP tools and for the REST routes a connector token may pass (`ownerAny`),
   *  the same door the `set_webhook` description points at. A login session keeps the bare actor. */
  private actorOf(p: Principal) { return p.kind === "bot" ? `bot:${p.botId}` : `owner:${p.ownerId}${p.scope === "connector" ? ":mcp" : ""}`; }

  webhookView(botId: string) {
    const b = this.get("SELECT id, handle, webhook_url, webhook_headers, webhook_updated_at FROM bots WHERE id = ?", botId);
    const headers = J(b.webhook_headers, []);
    const o = this.webhooks.opts;
    return {
      bot_id: b.id, configured: !!b.webhook_url, url: redactUrl(b.webhook_url), headers: redactHeaders(headers), updated_at: b.webhook_updated_at,
      queued_events: this.webhooks.queued(botId),
      policy: { debounce_seconds: o.debounceMs / 1000, max_pushes_per_hour: o.maxPerHour, max_attempts: o.maxAttempts, signature: "X-BotSocial-Signature: v1=HMAC-SHA256(webhook_secret, timestamp + '.' + body)" },
      recent_deliveries: this.webhooks.deliveries(botId, 10),
    };
  }
  getWebhook(p: Principal, botId: string) { this.webhookBot(p, botId); return this.webhookView(botId); }

  /** body: { url | webhook_url, headers?: ["Name: value"] | {Name: value} | [{name,value}] (omit = keep, [] = clear; any other shape is 400) */
  setWebhook(p: Principal, botId: string, body: any) {
    const b = this.webhookBot(p, botId);
    const rawUrl = body?.url !== undefined ? body.url : body?.webhook_url;
    // An empty URL is the clear door, and taking reach away stays allowed; hanging a new outlet on a revoked
    // identity does not (#177: revocation is final, and removeHomeMember's own comment says a revoked identity
    // must not keep receiving metadata through its webhook).
    if (rawUrl === null || rawUrl === "") return this.clearWebhook(p, botId);
    assert(b.status !== "revoked", 403, "bot_revoked", "this bot identity was revoked");
    const url = validateUrl(rawUrl);
    // `headers: null` is not "omit": passing it through as [] cleared the live set on a 200 before the type gate.
    const headers = body?.headers === undefined ? J(b.webhook_headers, []) : validateHeaders(body.headers);
    this.run("UPDATE bots SET webhook_url = ?, webhook_headers = ?, webhook_updated_at = ? WHERE id = ?", url, JSON.stringify(headers), nowIso(), botId);
    this.audit.append(this.actorOf(p), "bot.webhook_set", botId, [b.owner_id], { url: redactUrl(url), header_names: headers.map((h: any) => h.name) });
    return this.webhookView(botId);
  }
  clearWebhook(p: Principal, botId: string) {
    const b = this.webhookBot(p, botId);
    this.run("UPDATE bots SET webhook_url = NULL, webhook_headers = '[]', webhook_updated_at = ? WHERE id = ?", nowIso(), botId);
    this.audit.append(this.actorOf(p), "bot.webhook_cleared", botId, [b.owner_id], {});
    return this.webhookView(botId);
  }
  /** The test push is the one webhook write that appends its row after an await, so it takes its actor from the
   *  principal like the others: `actorOf` knows a connector token from a login session whatever the timing. */
  async testWebhook(p: Principal, botId: string) {
    const b = this.webhookBot(p, botId);
    assert(b.status !== "revoked", 403, "bot_revoked", "this bot identity was revoked");
    assert(b.webhook_url, 409, "no_webhook", "no webhook configured");
    const d = await this.webhooks.test(botId);
    this.audit.append(this.actorOf(p), "bot.webhook_tested", botId, [b.owner_id], { delivery_id: d.delivery_id, status: d.status, response_status: d.response_status });
    return d;
  }
  webhookDeliveries(p: Principal, botId: string, limit = 30) { this.webhookBot(p, botId); return { deliveries: this.webhooks.deliveries(botId, Math.min(limit, 200)) }; }

  /** Kill switch: freeze outbound, pause conversations, revoke bot tokens, cancel pending drafts. */
  emergencyStop(p: Principal, body: { bot_id: string }) {
    const ownerId = this.requireOwner(p);
    // The kill switch takes its bot from the body, and that value used to reach the lookup as it arrived: an
    // object was taken for named parameters and a boolean had no binding, so the route answered 500 instead of
    // naming the field. Only a string goes on to the lookup; an absent or null id keeps the old 404.
    assert(body?.bot_id === undefined || body?.bot_id === null || typeof body?.bot_id === "string", 400, "invalid_request", "bot_id must be a string");
    const b = this.ownBot(ownerId, body?.bot_id);
    // A removed home member is `revoked`, not `frozen`: freezing it would put the identity in the one state
    // resumeBot accepts, handing the owner a working token for an identity whose invites, drafts, rooms and
    // seats were already torn down. Re-adding the handle through the home is the supported way back.
    assert(b.status !== "revoked", 403, "bot_revoked", "this bot identity was revoked");
    // `atomically`, not a plain transaction: a pause's push waits for this commit, so a throw later in the stop
    // (the card sweep below) cannot leave the other Bot told about a pause the rollback takes back.
    this.atomically(() => {
      this.run("UPDATE bots SET status = 'frozen' WHERE id = ?", b.id);
      this.run("UPDATE tokens SET revoked_at = ? WHERE kind = 'bot' AND subject_id = ? AND revoked_at IS NULL", nowIso(), b.id);
      // The chats are paused through the one door a pause is written by, so both ends learn why: the
      // `conversation.paused` entry `pauseConversation` records and the event each side reads. A bare UPDATE here
      // moved the status with neither, so the peer -- whose own token still worked -- met a refusal on its next
      // line and had nothing telling it why. A chat that is already `paused_stop` does not move, so a repeated
      // stop announces nothing twice.
      for (const c of this.all("SELECT * FROM conversations WHERE (initiator_bot = ? OR peer_bot = ?) AND status != 'closed'", b.id, b.id)) {
        if (c.status !== "paused_stop") this.pauseConversation(c, "paused_stop", "emergency_stop");
      }
      // The stop is told to the Bot that owned each card: for an invite that is also the only honest answer to
      // "what happened to my link?" after its card is settled. The invite row is swept by `cancelPendingFor`.
      this.cancelPendingFor("bot_id = ?", [b.id], "emergency_stop", { notify: true, actor: `owner:${ownerId}` });
      // The kill switch also stops the outbound side. Settle the queue now, with a terminal row, so a push queued
      // before the stop cannot leave after it or be replayed on resume; the webhook URL itself stays (resume must
      // not make the owner hang it again), so this is a state check, not a URL change.
      this.webhooks.drop(b.id, "frozen");
    });
    this.audit.append(`owner:${ownerId}`, "bot.emergency_stop", b.id, [ownerId], {});
    return { bot_id: b.id, status: "frozen", tokens_revoked: true };
  }

  /** Re-enable a frozen bot and issue a fresh bot token. Paused conversations stay paused until an owner extends them. */
  resumeBot(p: Principal, botId: string) {
    const ownerId = this.requireOwner(p);
    const b = this.ownBot(ownerId, botId);
    // A removed home member is `revoked`, not `frozen`: removeHomeMember already cleared its webhook and revoked its
    // invites, drafts, rooms and seats, and nothing here would restore them. The way back is addHomeMember.
    assert(b.status !== "revoked", 403, "bot_revoked", "this bot identity was revoked");
    this.run("UPDATE bots SET status = 'active' WHERE id = ?", b.id);
    const token = this.issueToken("bot", b.id);
    this.audit.append(`owner:${ownerId}`, "bot.resumed", b.id, [ownerId], {});
    return { bot_id: b.id, status: "active", bot_token: token };
  }

  rotateBotToken(p: Principal, botId: string) {
    const ownerId = this.requireOwner(p);
    const b = this.ownBot(ownerId, botId);
    // A revoked identity is final: removeHomeMember already revoked its tokens and cleared its webhook, invites,
    // drafts and rooms, and rotating would hand it a working token again without restoring any of them. Re-adding
    // the handle through the home is the supported way back.
    assert(b.status !== "revoked", 403, "bot_revoked", "this bot identity was revoked");
    this.run("UPDATE tokens SET revoked_at = ? WHERE kind = 'bot' AND subject_id = ? AND revoked_at IS NULL", nowIso(), b.id);
    const token = this.issueToken("bot", b.id);
    this.audit.append(`owner:${ownerId}`, "bot.token_rotated", b.id, [ownerId], {});
    return { bot_id: b.id, bot_token: token };
  }

  // ================================================================ signatures
  /** Verify a bot's signed envelope (§4.3): signer = caller, active kid, digest, Ed25519 sig, ts skew, nonce replay. */
  verifyEnvelope(p: Principal, env: Envelope, expectedType: string): Envelope {
    const { botId, ownerId } = this.requireBot(p);
    const reject = (status: number, code: string, msg: string): never => {
      this.audit.append(`bot:${botId}`, "signature.rejected", botId, [ownerId], { code, reason: msg, type: env?.type, envelope_id: env?.id });
      throw new ApiError(status, code, msg);
    };
    if (!env || typeof env !== "object" || env.v !== "botsocial/1.0" || !env.sig || !env.id || !env.nonce || !env.ts) reject(400, "invalid_envelope", "request body must be a signed botsocial/1.0 envelope");
    if (env.type !== expectedType) reject(400, "invalid_envelope", `envelope type must be ${expectedType}`);
    if (env.from !== botId) reject(401, "invalid_signature", "envelope.from does not match the authenticated bot");
    const b = this.bot(botId);
    if (b.status !== "active") {
      const frozen = b.status === "frozen";
      reject(403, frozen ? "bot_frozen" : "bot_revoked", frozen ? "bot is frozen (emergency stop)" : "this bot identity was revoked");
    }
    // A key id is a string, and it is judged before the lookup that binds it. `env.sig.kid` went straight into the
    // bind list: `{}`/`[]` were read as a named-parameter map (RangeError: too few parameter values), booleans threw
    // the bind TypeError, and both surfaced as a 500 `internal_error` before any reject() — so the refusal was
    // neither a 4xx nor a `signature.rejected` audit line. A single-element array is worse: SQLite's binder
    // flattens it as a positional parameter, so `["k1"]` verified exactly as the string `"k1"` and the request ran.
    // The rejection goes through reject() to keep the audit line that every other envelope refusal writes.
    if (env.sig.kid !== undefined && env.sig.kid !== null && typeof env.sig.kid !== "string") reject(400, "invalid_envelope", "sig.kid must be a string");
    const key = this.get("SELECT * FROM bot_keys WHERE bot_id = ? AND kid = ? AND status = 'active'", botId, env.sig.kid);
    if (!key || (key.expires_at && Date.parse(key.expires_at) < Date.now())) reject(401, "invalid_signature", "unknown, revoked or expired kid");
    if (env.payload_sha256 !== payloadDigest(env.payload)) reject(401, "invalid_signature", "payload digest mismatch");
    if (env.sig.alg !== "Ed25519" || !verifyString(key.public_key, envelopeSigningInput(env), env.sig.value)) reject(401, "invalid_signature", "signature verification failed");
    const ts = Date.parse(env.ts);
    if (Number.isNaN(ts) || Math.abs(Date.now() - ts) > LIMITS.tsSkewMs) reject(401, "replay_detected", "timestamp outside allowed skew");
    this.run("DELETE FROM nonces WHERE seen_at < ?", Date.now() - LIMITS.nonceTtlMs);
    try { this.run("INSERT INTO nonces (bot_id, nonce, seen_at) VALUES (?,?,?)", botId, env.nonce, Date.now()); }
    catch { reject(401, "replay_detected", "nonce already used"); }
    return env;
  }

  // ================================================================ relationships
  private pairRelationships(a: string, b: string) {
    return this.all("SELECT * FROM relationships WHERE (requester_bot = ? AND target_bot = ?) OR (requester_bot = ? AND target_bot = ?) ORDER BY created_at DESC", a, b, b, a);
  }

  private expireStale() {
    // Only the share half of the face-room sweep belongs here. `expireLapsedShares` writes down a share whose own
    // clock ran out (and settles the cards it was holding), which any door may do: the share already ended, this only
    // records it. Room promotion is the other half and is not a bystander's to run — `advanceFaceRooms` flips a
    // candidate room to `open`, voids its number, deletes the `face_room_codes` rows, writes `room.started` and wakes
    // every member, so the six reads that reach this sweep (relationships, friends-overview, approvals, a Bot's
    // grants, remote bots, the Bot's own events) each turned one read into another home's room start. A room is
    // settled by the room's own read and write doors, which call `advanceFaceRooms` themselves (#661).
    this.expireLapsedShares();
    const now = nowIso();
    this.settlePendingRelationships(this.all("SELECT * FROM relationships WHERE status IN ('pending_requester_owner','pending_target') AND expires_at < ?", now));
    for (const a of this.all("SELECT * FROM approvals WHERE status = 'pending' AND expires_at < ?", now)) this.expireApproval(a);
  }

  /** Settle the pending relationships in `rows`, with the writes the sweep makes. The sweep passes every lapsed row;
   *  a door whose own check needs this pair, or this link's joins, fresh passes only those rows, so a refused call
   *  settles nothing of another owner's. */
  private settlePendingRelationships(rows: any[]) {
    const now = nowIso();
    for (const r of rows) {
      // One request is one write: the relationship row, its cards, the audit line and the invite use the join spent
      // settle together or not at all. `expireApproval` settles a card in a transaction of its own, but the row that
      // made the sweep pick this request (`pending_*`) used to be flipped outside any transaction, so a refusal while
      // a card was settling left the request already terminal. The sweep selects `pending_*` rows only, so nothing
      // ever reached this request again: `releaseInviteUse` never ran and the invite's use was spent for good, and the
      // `relationship.expired` audit line was never written. Transaction per request, not one for the loop: a refused
      // request rolls back alone and the sweep's other rows settle on the next run.
      this.atomically(() => {
        this.run("UPDATE relationships SET status = 'expired', updated_at = ? WHERE id = ?", now, r.id);
        // Flip each pending approval through `expireApproval`, not one bulk UPDATE. The bulk form is why the
        // `relationship_request` Bot was never told: it flipped the row (no `decided_at`, no `approval.expired` audit,
        // no event) before the approval sweep below could see it, so the real-world path stayed silent. The
        // relationship row above is already terminal, so a reader reacting to the event sees the end state.
        for (const a of this.all("SELECT * FROM approvals WHERE subject_id = ? AND status = 'pending'", r.id)) this.expireApproval(a);
        this.audit.append("platform", "relationship.expired", r.id, [r.requester_owner, r.target_owner], {});
        this.releaseInviteUse(r.id);
      });
    }
  }

  /** The lapsed requests between these two Bots. A door that reads this pair to answer `relationship_exists` settles
   *  these first, and only these: a request that timed out must not keep the pair unreachable, while a refused call
   *  must not open the delivery moment for the whole platform. */
  private expirePendingBetween(a: string, b: string) {
    this.settlePendingRelationships(this.all("SELECT * FROM relationships WHERE status IN ('pending_requester_owner','pending_target') AND expires_at < ? AND ((requester_bot = ? AND target_bot = ?) OR (requester_bot = ? AND target_bot = ?))", nowIso(), a, b, b, a));
  }

  /** The lapsed joins this invite is still counting. A join spends a use when its relationship is written and gives it
   *  back when that request expires (`releaseInviteUse`); the join door must see that return before it asks whether the
   *  link has a use left, so it settles exactly the requests recorded against this invite. */
  private expirePendingOnInvite(inviteId: string) {
    this.settlePendingRelationships(this.all(`SELECT r.* FROM relationships r JOIN relationship_invites ri ON ri.relationship_id = r.id
      WHERE ri.invite_id = ? AND r.status IN ('pending_requester_owner','pending_target') AND r.expires_at < ?`, inviteId, nowIso()));
  }

  /** The home a FlyBot sub-identity belongs to; any other bot is its own home. Display grouping only — never an access wildcard. */
  homeOf(botId: string): string {
    return this.get("SELECT home_bot_id FROM bots WHERE id = ?", botId)?.home_bot_id ?? botId;
  }

  activeRelationship(a: string, b: string) {
    const rel = this.findActiveRelationship(a, b);
    if (!rel) {
      this.audit.append(`bot:${a}`, "policy.denied", b, [this.bot(a).owner_id], { code: "no_relationship" });
      throw new ApiError(403, "no_relationship", "no active relationship between these bots");
    }
    // Revoking a FlyBot home member keeps the relationship rows (so re-adding the same handle can restore
    // them), but the identity itself is gone: a friend must not be able to open a new conversation or draft
    // into an existing one toward it. A frozen Bot is deliberately not filtered here: the kill switch stops its
    // outbound side and stops anything new starting toward it, but it does that where reach is decided -- the peer
    // check in createConversation and the recipient check in deliverMessage -- while a conversation that already
    // exists stays paused_stop, so a draft into it still answers conversation_paused (that pause outlives a
    // resume). The owner's own resume, token rotate, audit read, grant revoke and block never come through here:
    // they resolve the owner principal.
    for (const id of [a, b]) {
      if (this.bot(id).status === "revoked") throw new ApiError(403, "bot_revoked", "a Bot in this relationship was revoked");
    }
    return rel;
  }

  /** The target of reach must be an active Bot: frozen (kill switch) and revoked (identity gone) both refuse. */
  private assertReachable(b: any) {
    if (b.status === "frozen") throw new ApiError(403, "bot_frozen", "a Bot in this relationship is frozen (emergency stop)");
    if (b.status === "revoked") throw new ApiError(403, "bot_revoked", "a Bot in this relationship was revoked");
  }

  /**
   * Is this invitation the one this conversation may answer? A booking is made *with* the peer of the chat it was
   * booked in (`calendar.book` insists `attendees` is exactly that Bot), so the answer to it belongs there too. The
   * two sides are homes, not Bots: a home's other Bot may answer for the same home in the same chat.
   */
  private inviteIsWithPeer(inv: any, peerOwnerId: string) {
    return inv.organizer_owner === peerOwnerId || J(inv.attendees, []).includes(peerOwnerId);
  }

  /** Access is only the two endpoint bots. Home / Chief never cover their members. */
  private findActiveRelationship(a: string, b: string): any {
    return this.pairRelationships(a, b).find((r) => r.status === "active");
  }

  /**
   * #515: a thread a room opened keeps that room's relationship row after the room is over — the guest's seat is
   * released, the share lapses — and the row stops reading `room`. Its room-scoped grants are revoked with it, so
   * the thread reports no room and a console shows it as a chat, yet the row it was opened through is neither the
   * friendship's nor a live room. This answers whether a named thread is one of those: its own door no longer
   * reads `room`, a grant on that door still records the room it served, and the pair have a friendship to settle
   * it on (the 1:1 door). A live room reads `room` and is refused, and an unfriended pair has no door at all.
   */
  private endedRoomDoor(relId: string, hasFriendship: boolean): boolean {
    if (!hasFriendship) return false;
    const rel = this.get("SELECT status FROM relationships WHERE id = ?", relId);
    if (!rel || rel.status === "room") return false;
    return !!this.get("SELECT 1 FROM grants WHERE relationship_id = ? AND room_id IS NOT NULL LIMIT 1", relId);
  }

  /** The bot the grantor is sharing (their endpoint on the relationship). */
  private grantedBotOf(g: any, r?: any): string {
    const rel = r ?? this.get("SELECT * FROM relationships WHERE id = ?", g.relationship_id);
    if (!rel) return "";
    return g.grantor_owner === rel.requester_owner ? rel.requester_bot : rel.target_bot;
  }

  requestRelationship(p: Principal, body: any) {
    let fromBot: any, payload: any, viaBot = false;
    if (p.kind === "bot") {
      const env = this.verifyEnvelope(p, body, "relationship.request");
      payload = env.payload ?? {};
      fromBot = this.bot(p.botId);
      viaBot = true;
    } else {
      payload = body ?? {};
      assert(payload.from_bot_id, 400, "invalid_request", "from_bot_id required when an owner sends a request");
      // The sender's id went from the body straight into the owner lookup: an object or a boolean answered 500.
      // A missing id keeps its own message above; only a string goes on to SQL.
      assert(payload.from_bot_id === undefined || payload.from_bot_id === null || typeof payload.from_bot_id === "string", 400, "invalid_request", "from_bot_id must be a string");
      fromBot = this.ownBot(p.ownerId, payload.from_bot_id);
      // The kill switch closes every door that names a Bot: a frozen or revoked sender is refused here, exactly as
      // the invite doors refuse it, instead of asking a peer for a friendship that its own owner already stopped.
      this.assertInvitable(fromBot);
    }
    assert(payload.target_handle || payload.target_bot_id, 400, "invalid_request", "target_handle or target_bot_id required");
    // The target bot id is the other value this route hands to SQL as it arrived; a non-string answered 500.
    assert(payload.target_bot_id === undefined || payload.target_bot_id === null || typeof payload.target_bot_id === "string", 400, "invalid_request", "target_bot_id must be a string");
    // `target_handle` is read by `handleRef`'s `String(ref ?? "")` below: an array stringifies to its element, so
    // `[handle]` named the Bot and created a pending relationship with the target's event and audit entry, and an
    // object, number or boolean stringified into a handle that then answered 404 with a name the caller never
    // typed. A handle is a string; judge it before the lookup and before the relationship row, the event, the
    // approval and the audit entry. Absent and null keep the "required" message above.
    assert(payload.target_handle === undefined || payload.target_handle === null || typeof payload.target_handle === "string", 400, "invalid_request", "target_handle must be a string");
    const target = payload.target_bot_id ? this.bot(payload.target_bot_id) : this.botByHandle(payload.target_handle);
    // #90: a revoked Bot answers exactly like one that never existed — same status, code, message and fields.
    // Any difference would turn this door into an oracle for "which handle was revoked".
    assert(target.status === "active", 404, "bot_not_found", payload.target_bot_id ? `bot ${payload.target_bot_id} not found` : `bot ${payload.target_handle} not found`);
    assert(target.id !== fromBot.id && target.owner_id !== fromBot.owner_id, 400, "invalid_request", "cannot befriend your own bot");
    // The request message is peer text another owner's Bot reads, so it is stored as a string or not at all. The gate
    // sits before `expireStale` can write, before the DLP scan sees it and before the row: a non-string used to reach
    // SQL as it arrived (500) or be coerced to "1.0", and a refused request must leave no row, audit line or event.
    assert(payload.message === undefined || payload.message === null || typeof payload.message === "string", 400, "invalid_request", "message must be a string");
    // A pending request that timed out must not keep answering relationship_exists: expire this pair's own rows
    // here, before the duplicate check, because requesting again is the first call after the 7-day window in many
    // clients. Only this pair: a refusal below settles nothing of another owner's.
    this.expirePendingBetween(fromBot.id, target.id);
    const existing = this.pairRelationships(fromBot.id, target.id);
    assert(!existing.some((r) => r.status === "blocked"), 403, "blocked", "relationship is blocked");
    assert(!existing.some((r) => ["active", "pending_target", "pending_requester_owner"].includes(r.status)), 409, "relationship_exists");
    const declined = existing.find((r) => r.status === "declined" && r.requester_bot === fromBot.id);
    assert(!declined || Date.now() - Date.parse(declined.updated_at) > LIMITS.declineCooldownMs, 429, "decline_cooldown", "request was declined within the last 30 days");
    const requested = this.validCaps(payload.requested_capabilities ?? DEFAULT_CAPABILITIES);
    const offered = this.validCaps(payload.offered_capabilities ?? DEFAULT_CAPABILITIES);
    // The message is outbound text another owner's Bot reads, so it takes the scan the message draft door runs;
    // only a `block` finding refuses, with that door's 422 verbatim. The refusal is settled here, before the row,
    // its audit line and its event exist — the owner's queue and the target Bot never hear of a request that was not
    // written. Approve-class findings (an email, a phone number) never blocked a draft and do not block one here.
    const blocked = this.dlp(fromBot.owner_id, { text: payload.message ?? "" }).filter((f) => f.action === "block");
    if (blocked.length) {
      throw new ApiError(422, "dlp_blocked", "outbound DLP blocked this draft", { categories: blocked.map((b) => b.category) });
    }
    // This door is about to write a card (a Bot's request waits for its owner), so it opens a delivery moment: the
    // queue is settled first, so the announcement never counts a card its owner can no longer decide. It sits here,
    // past every refusal above, so a refused request opens no delivery moment.
    this.expireStale();
    const id = newId("rel");
    const status = viaBot ? "pending_requester_owner" : "pending_target";
    const expires = new Date(Date.now() + LIMITS.relationshipRequestTtlMs).toISOString();
    this.run(`INSERT INTO relationships (id, requester_bot, target_bot, requester_owner, target_owner, status, message, requested_caps, offered_caps, created_at, updated_at, expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, id, fromBot.id, target.id, fromBot.owner_id, target.owner_id, status, payload.message ?? null, JSON.stringify(requested), JSON.stringify(offered), nowIso(), nowIso(), expires);
    this.audit.append(viaBot ? `bot:${fromBot.id}` : `owner:${fromBot.owner_id}`, "relationship.requested", id, [fromBot.owner_id, target.owner_id], { from: fromBot.id, to: target.id, status, requested, offered });
    let approval_id: string | undefined;
    if (viaBot) {
      approval_id = this.createApproval(fromBot.owner_id, "relationship_request", id, fromBot.id, null, `Your bot wants to send a friend request to @${target.handle}`, ["relationship.requires_owner"], [], LIMITS.relationshipRequestTtlMs);
    } else {
      this.notifyTarget(id);
    }
    return { relationship_id: id, status, awaiting: viaBot ? "requester_owner_approval" : "target_owner_consent", approval_id, expires_at: expires };
  }

  private notifyTarget(relId: string) {
    const r = this.get("SELECT * FROM relationships WHERE id = ?", relId);
    this.emit(r.target_bot, "relationship.requested", { relationship_id: r.id, from: this.publicBot(this.bot(r.requester_bot)), note: "Only your owner can accept this request.", trust: "peer_untrusted", untrusted_content: { message: r.message } });
  }

  private validCaps(caps: unknown): string[] {
    assert(Array.isArray(caps), 400, "invalid_request", "capabilities must be an array");
    for (const c of caps as string[]) {
      assert(CAPABILITIES[c], 400, "unknown_capability", `unknown capability ${c}`);
      assert(MVP_GRANTABLE.includes(c) && CAPABILITIES[c].pregrantable, 400, "capability_not_pregrantable", `${c} cannot be pre-granted`);
    }
    return [...new Set(caps as string[])];
  }

  /** #211: a caller-supplied `scope` before it can reach `insertGrant`. `{}` is accepted everywhere because
   *  internal callers write it; a non-empty scope only for a capability whose implementation reads it, and its
   *  values must be ones the read path can enforce (`window_days` a positive whole number, `hours` a parseable
   *  range). */
  private assertScope(capability: string, scope: unknown) {
    if (scope == null) return;
    assert(typeof scope === "object" && !Array.isArray(scope), 400, "invalid_request", "scope must be an object");
    const s = scope as Record<string, unknown>;
    if (!Object.keys(s).length) return;
    assert(SCOPED_CAPABILITIES.has(capability), 400, "invalid_request", `scope is not supported for ${capability}`);
    if (s.window_days != null) assert(Number.isInteger(s.window_days) && (s.window_days as number) > 0, 400, "invalid_request", "scope.window_days must be a positive whole number");
    if (s.hours != null) assert(typeof s.hours === "string" && parseHours(s.hours) !== null, 400, "invalid_request", "scope.hours must be a time range like 09:00-18:00");
  }

  consent(p: Principal, relId: string, body: { decision: "accept" | "decline"; grant_capabilities?: (string | { capability: string; scope?: any; expires_in_days?: number })[] }) {
    const ownerId = this.requireOwner(p);
    // Whether this request is the caller's to answer is answered before anything is settled: a 404 or a 403 must not
    // be the call that expires another owner's cards, messages, requests and conversations. That is the same shape as
    // #712's refused writes and #718's refused decision, and this door was reachable with any owner's token naming an
    // id that is missing or whose target owner is somebody else. The same function backs the MCP
    // `respond_friend_request` tool.
    let r = this.get("SELECT * FROM relationships WHERE id = ?", relId);
    assert(r, 404, "relationship_not_found");
    assert(r.target_owner === ownerId, 403, "forbidden", "only the target owner can consent");
    // The request is this owner's to answer, so this door judges this row -- and it settles only this row. A refusal
    // below (the `409` for a request that lapsed while it waited, a `403` after a stop or a removal) is an answer
    // about this row, not a delivery moment: the platform-wide sweep here used to settle every other owner's lapsed
    // cards, requests, events and webhook pushes on the way out, the same shape #712's refused writes settled. A pair
    // is the whole of what this door settles, so a row of this pair that lapsed still answers `409`. Read it again
    // afterwards, because the copy above may be the one that just lapsed.
    this.expirePendingBetween(r.requester_bot, r.target_bot);
    r = this.get("SELECT * FROM relationships WHERE id = ?", relId);
    assert(r.status === "pending_target", 409, "invalid_state", `relationship is ${r.status}`);
    assert(["accept", "decline"].includes(body?.decision), 400, "invalid_request", "decision must be accept|decline");
    // The body declares a list of capability names, and `(body.grant_capabilities ?? []).map(...)` below has no
    // `.map` on a string, a number, an object or a boolean: those answered `500 internal_error` instead of naming
    // the field they got wrong. An entry that is not a name (a number, `null`, a nested list, an object without one)
    // reached the capability check as `unknown capability undefined`, which names neither the field nor the entry.
    // Both are the same mistake - the field is a list of names, as the MCP schema declares - so both are refused
    // here, before the decision is acted on and before any grant, approval, event or audit row. Absent, `null` and
    // `[]` keep meaning "the defaults", and a known-name check still refuses an unknown name as before. The object
    // form (`{capability, scope, expires_in_days}`) stays accepted: the platform's type is a union of a name and
    // that object, and tests reach it over this route.
    const caps = body.grant_capabilities;
    assert(
      caps === undefined || caps === null ||
        (Array.isArray(caps) && caps.every((g) => typeof g === "string" || (g !== null && typeof g === "object" && !Array.isArray(g) && typeof (g as any).capability === "string"))),
      400, "invalid_request", "grant_capabilities must be an array of strings",
    );
    if (body.decision === "decline") {
      // Declining really answers the request, so the delivery moment is here, exactly as it always was: the queue is
      // settled before the row is written. Only the refusals above (and the ones below) answer without it.
      this.expireStale();
      this.run("UPDATE relationships SET status = 'declined', updated_at = ? WHERE id = ?", nowIso(), relId);
      // A declined join never became a friendship: give the invite slot back, exactly as `expireStale` and a
      // rejected approval do, so a 1-use link does not read "used" while no relationship exists (P9).
      this.releaseInviteUse(relId);
      this.audit.append(`owner:${ownerId}`, "relationship.declined", relId, [r.requester_owner, r.target_owner], {});
      this.emit(r.requester_bot, "relationship.changed", { relationship_id: relId, status: "declined" });
      return { relationship_id: relId, status: "declined" };
    }
    // A pending row names two Bots and can wait for days; either side may be removed from its home while it waits,
    // and a removed member is `revoked` (#173). Every later reach is refused by activeRelationship, so activating
    // here would write an `active` friendship with a full grant set for an identity that cannot answer - and tell
    // both owners it is live. The row stays pending: this is a refusal, not a cancellation.
    for (const id of [r.requester_bot, r.target_bot]) {
      assert(this.bot(id).status !== "revoked", 403, "bot_revoked", "a Bot in this relationship was revoked");
    }
    // A frozen Bot is the same refusal: the kill switch says the identity is down, and a consent that was sent
    // before it cannot bring it back. `assertInvitable` is the one answer for both states (both ends, exactly as
    // `autoAcceptSpecs` asks of the auto-accept half), and it comes before `activateRelationship` writes anything.
    this.assertInvitable(this.bot(r.requester_bot));
    this.assertInvitable(this.bot(r.target_bot));
    const specs = (body.grant_capabilities ?? []).map((g) => (typeof g === "string" ? { capability: g } : g));
    this.validCaps(specs.map((s) => s.capability));
    for (const s of specs) this.assertScope(s.capability, s.scope);
    // Every refusal is behind us and this call really answers the request, so this is the delivery moment the door has
    // always taken: settle the platform's lapsed shares, requests and cards. This row is this owner's own and it is not
    // lapsed (the check above), so the sweep leaves it standing and `activateRelationship` writes it next.
    this.expireStale();
    this.activateRelationship(r, specs, `owner:${ownerId}`);
    return { relationship_id: relId, status: "active", grants: this.grantsFor(relId) };
  }

  /** Activate a relationship: minimal defaults both ways + target owner's choices + requester's offered caps. */
  private activateRelationship(r: any, targetSpecs: { capability: string; scope?: any; expires_in_days?: number }[], actor: string) {
    this.writeActivation(r, targetSpecs, actor);
    this.announceActivation(r, targetSpecs, actor);
  }

  /** #30: the grants are written before the relationship reads `active`, in one transaction, so nothing can see a
   *  confirmed friendship whose grants are not durable yet. Announcing it is announceActivation, after the commit. */
  private writeActivation(r: any, targetSpecs: { capability: string; scope?: any; expires_in_days?: number }[], actor: string) {
    const fbScope = { window_days: 14, hours: "09:00-18:00" };
    this.db.transaction(() => {
      const targetToRequester = new Map<string, any>(DEFAULT_CAPABILITIES.map((c) => [c, { capability: c }]));
      for (const s of targetSpecs) targetToRequester.set(s.capability, { scope: s.capability === "calendar.freebusy.read" ? fbScope : {}, ...s });
      for (const s of targetToRequester.values()) this.insertGrant(r.id, r.target_owner, r.requester_bot, s.capability, s.scope, s.expires_in_days, actor);
      const requesterToTarget = new Set<string>([...DEFAULT_CAPABILITIES, ...J(r.offered_caps, [])]);
      // #23: on an invite-born friendship the requester is the joiner. What the joiner's owner gives the inviter's Bot
      // by joining is reply-only: it may answer in a conversation the joiner's Bot started, never start one.
      const replyOnly = !!this.get("SELECT 1 FROM relationship_invites ri JOIN invites i ON i.id = ri.invite_id WHERE ri.relationship_id = ? AND i.bot_id = ?", r.id, r.target_bot);
      for (const c of requesterToTarget) this.insertGrant(r.id, r.requester_owner, r.target_bot, c, c === "calendar.freebusy.read" ? fbScope : {}, undefined, `owner:${r.requester_owner}`, { replyOnly });
      this.run("UPDATE relationships SET status = 'active', updated_at = ?, expires_at = NULL WHERE id = ?", nowIso(), r.id);
    })();
  }

  /** Runs only after writeActivation committed. Both Bots' `relationship.changed` carries the grants already written
   *  (`grants_ready: true`), so a home can record them before it handles the first message (FlyBot #442). */
  private announceActivation(r: any, targetSpecs: { capability: string }[], actor: string) {
    this.audit.append(actor, "relationship.accepted", r.id, [r.requester_owner, r.target_owner], { granted_to_requester: targetSpecs.map((s) => s.capability) });
    const grants = this.grantSummary(r.id);
    for (const b of [r.requester_bot, r.target_bot]) this.emit(b, "relationship.changed", { relationship_id: r.id, status: "active", grants_ready: true, grants });
  }

  /** The active relationship-level grants of one relationship, one entry per direction: the Bot that is shared
   *  (`granted_bot`), the Bot it is shared with (`grantee_bot`), the capabilities, and whether it is reply-only (#23). */
  grantSummary(relId: string) {
    const r = this.get("SELECT * FROM relationships WHERE id = ?", relId);
    if (!r) return [];
    const groups = new Map<string, any>();
    // Only unexpired rows: this is the internal summary behind `announceActivation`, the join response's
    // `grants_ready` and `grantBotToFriend`, and it used to list a grant whose `expires_at` had already passed —
    // `grantsFor`/`findGrant`/`listBotGrants` expired lazily but this aggregate did not. Strict `>`: an expiry
    // equal to now is already over.
    for (const g of this.all("SELECT * FROM grants WHERE relationship_id = ? AND status = 'active' AND room_id IS NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at, id", relId, nowIso())) {
      const key = `${g.grantor_owner}:${g.grantee_bot}`;
      const granted = this.bot(this.grantedBotOf(g, r));
      const grantee = this.bot(g.grantee_bot);
      const cur = groups.get(key) ?? { grant_id: g.id, granted_bot: { bot_id: granted.id, handle: "@" + granted.handle }, grantee_bot: { bot_id: grantee.id, handle: "@" + grantee.handle }, capabilities: [] as string[], reply_only: this.replyOnlyAccess(relId, g.grantor_owner, g.grantee_bot) };
      if (!cur.capabilities.includes(g.capability)) cur.capabilities.push(g.capability);
      groups.set(key, cur);
    }
    return [...groups.values()];
  }

  /** A caller-supplied `expires_in_days` becomes an expiry here, before anything is written. `null`/omitted keeps
   *  LIMITS.grantDefaultDays; a number or a numeric string is read as days, and anything else (`true`, an array, an
   *  object) is a type error named as such instead of being coerced. A value that is not a finite positive number of
   *  days, or that lands outside the Date range, is a 400. Doing it in `insertGrant` covers every path that writes a
   *  grant (the owner route, the approval branch's `edited_params`, consent), so a typo is refused instead of
   *  superseding a live grant and then answering 500 from `toISOString()`. */
  private grantExpiry(expiresInDays: unknown): string {
    // `Number(true)` is 1 and `Number([30])` is 30: without this, a boolean or an array is written as a live grant.
    assert(expiresInDays == null || typeof expiresInDays === "number" || typeof expiresInDays === "string", 400, "invalid_request", "expires_in_days must be a number of days");
    const days = expiresInDays == null ? LIMITS.grantDefaultDays : Number(expiresInDays);
    assert(Number.isFinite(days) && days > 0, 400, "invalid_request", "expires_in_days must be a positive number of days");
    const ms = Date.now() + days * 86400e3;
    assert(Number.isFinite(ms) && Math.abs(ms) <= 8.64e15, 400, "invalid_request", "expires_in_days is too large: the expiry date would be invalid");
    return new Date(ms).toISOString();
  }

  /** `extra.replyOnly` (#23): the grantee may answer in a conversation the granted Bot started, but not start one
   *  or bring the Bot into a face room. Set only for the joiner-side grants a join writes; every explicit grant is full. */
  private insertGrant(relId: string, grantorOwner: string, granteeBot: string, cap: string, scope: any, expiresInDays: unknown, actor: string, extra: { roomId?: string; replyOnly?: boolean } = {}) {
    // Validate and compute the expiry before the supersede: a rejected value must never take the live grant down
    // with it (the UPDATE below would mark the old grant superseded and nothing would replace it).
    const exp = extra.roomId ? null : this.grantExpiry(expiresInDays);
    this.run("UPDATE grants SET status = 'superseded' WHERE relationship_id = ? AND grantor_owner = ? AND capability = ? AND status = 'active' AND IFNULL(room_id,'') = ?", relId, grantorOwner, cap, extra.roomId ?? "");
    const id = newId("grt");
    const sc = extra.roomId ? { ...(scope ?? {}), kind: "room", room_id: extra.roomId } : { ...(scope ?? {}) };
    const replyOnly = !!extra.replyOnly && !extra.roomId;
    this.run("INSERT INTO grants (id, relationship_id, grantor_owner, grantee_bot, capability, scope, created_at, expires_at, room_id, reply_only) VALUES (?,?,?,?,?,?,?,?,?,?)",
      id, relId, grantorOwner, granteeBot, cap, JSON.stringify(sc), nowIso(), exp, extra.roomId ?? null, replyOnly ? 1 : 0);
    const r = this.get("SELECT * FROM relationships WHERE id = ?", relId);
    this.audit.append(actor, "grant.created", id, [r.requester_owner, r.target_owner], { relationship_id: relId, grantor_owner: grantorOwner, grantee_bot: granteeBot, capability: cap, scope: sc, expires_at: exp, room_id: extra.roomId ?? null, ...(replyOnly ? { reply_only: true } : {}) });
    return id;
  }

  /** The relationship-level grants of one relationship, as `/v1/relationships` lists them.
   *
   *  A row whose expiry has passed is written back to `expired` and left out: this is the read the reach checks share
   *  the shape of, and a lapsed grant must never look live. `includeExpired` is for the owner's own overview only
   *  (#218's expired + Renew has nothing to renew on a cold page): it does the same lazy write-back, then returns the
   *  `expired` rows too, each carrying its `status`, so the card can say the grant ended and offer to renew it.
   *  Nothing about access changes here — `findGrant`, `listBotGrants`, `sendAsMember` and room reach keep dropping a
   *  lapsed row on their own. */
  grantsFor(relId: string, opts: { includeExpired?: boolean } = {}) {
    const out: any[] = [];
    const rows = this.all(
      opts.includeExpired
        ? "SELECT * FROM grants WHERE relationship_id = ? AND status IN ('active','expired') ORDER BY created_at, id"
        : "SELECT * FROM grants WHERE relationship_id = ? AND status = 'active'",
      relId,
    );
    for (const g of rows) {
      // The lazy expiry `findGrant` and `listBotGrants` already do: a row whose expiry has passed must not be listed
      // by `/v1/relationships` while `/v1/bots/:id/grants` hides it.
      const lapsed = g.status === "expired" || (!!g.expires_at && Date.parse(g.expires_at) < Date.now());
      if (lapsed && g.status !== "expired") this.run("UPDATE grants SET status = 'expired' WHERE id = ?", g.id);
      if (lapsed && !opts.includeExpired) continue;
      out.push({ ...g, status: lapsed ? "expired" : "active", scope: J(g.scope, {}) });
    }
    if (!opts.includeExpired) return out;
    // A capability that lapsed and was granted again has two rows: the ended one and the live one. The card shows one
    // chip per capability, so keep the live row; with nothing live, the most recently created ended row.
    const one = new Map<string, any>();
    for (const g of out) {
      const key = `${g.grantee_bot}:${g.capability}`;
      const cur = one.get(key);
      if (!cur || (cur.status === "expired" && (g.status === "active" || (g.status === "expired" && g.created_at > cur.created_at)))) one.set(key, g);
    }
    return [...one.values()];
  }

  /** An active relationship-level grant; a full grant wins over a reply-only one (#23), so check `reply_only` on the result. */
  findGrant(grantorOwner: string, granteeBot: string, cap: string, grantedBot?: string): any {
    const rows = this.all("SELECT g.*, r.requester_bot, r.target_bot, r.requester_owner, r.target_owner FROM grants g JOIN relationships r ON r.id = g.relationship_id WHERE g.grantor_owner = ? AND g.grantee_bot = ? AND g.capability = ? AND g.status = 'active' AND r.status = 'active' AND g.room_id IS NULL ORDER BY g.reply_only", grantorOwner, granteeBot, cap);
    for (const g of rows) {
      if (g.expires_at && Date.parse(g.expires_at) < Date.now()) { this.run("UPDATE grants SET status = 'expired' WHERE id = ?", g.id); continue; }
      if (grantedBot && this.grantedBotOf(g, g) !== grantedBot) continue;
      return { ...g, scope: J(g.scope, {}) };
    }
    return null;
  }

  /**
   * #43: reach without a friendship. A Bot that joined a room with a ticket may send to another Bot of that room
   * while both are in it and the room-scoped grant is alive. Nothing here creates a friendship: the pair can only
   * talk with this room id, and the reach dies with the room.
   *
   * The door is the one named by the grant that was actually checked, never "the newest room between the pair":
   * a pair can share several rooms, and searching for a room relationship hands back whichever room was created
   * last (pairRelationships is ORDER BY created_at DESC), so room 1 would ride on room 2's door.
   */
  private roomReach(a: string, b: string, roomId: string): Relationship | null {
    const room = this.get("SELECT * FROM face_rooms WHERE id = ?", roomId);
    // #60: a room that lives in one FlyBot home has no face_rooms row; its door is a live claimed ticket for that
    // room that seats exactly this pair (the inviter's Bot and one Bot the claim brought).
    if (!room) return this.localPairClaim(roomId, a, b) ? this.roomRelationshipOf(a, b, roomId) : null;
    if (room.status === "closed") return null;
    const inRoom = (botId: string) => !!this.get("SELECT 1 FROM face_room_members WHERE room_id = ? AND bot_id = ? AND left_at IS NULL", roomId, botId);
    if (!inRoom(a) || !inRoom(b)) return null;
    return this.roomRelationshipOf(a, b, roomId);
  }
  private roomRelationshipOf(a: string, b: string, roomId: string): Relationship | null {
    const grant = this.findRoomGrant(this.bot(b).owner_id, a, "chat.public", b, roomId);
    if (!grant) return null;
    return this.get("SELECT * FROM relationships WHERE id = ? AND status = 'room'", grant.relationship_id) ?? null;
  }

  /**
   * #45: an active grant scoped to one room, written when the owners put these two Bots in that room together
   * (syncFaceRoomAccess) or when a room ticket is claimed (#43). It is what lets a send name a room context.
   */
  private findRoomGrant(grantorOwner: string, granteeBot: string, cap: string, grantedBot: string, roomId: string): any {
    // A block is a decision about the pair, and a room door is still a door between the same two Bots: a grant
    // that outlived the block (a row blocked before this rule existed, or one the block could not reach) must not
    // answer for them. Checked here, at the single lookup every room door goes through.
    if (this.pairRelationships(grantedBot, granteeBot).some((r: any) => r.status === "blocked")) return null;
    const rows = this.all("SELECT g.*, r.requester_bot, r.target_bot, r.requester_owner, r.target_owner FROM grants g JOIN relationships r ON r.id = g.relationship_id WHERE g.grantor_owner = ? AND g.grantee_bot = ? AND g.capability = ? AND g.status = 'active' AND g.room_id = ? AND r.status = 'room'", grantorOwner, granteeBot, cap, roomId);
    for (const g of rows) {
      if (g.expires_at && Date.parse(g.expires_at) < Date.now()) { this.run("UPDATE grants SET status = 'expired' WHERE id = ?", g.id); continue; }
      if (this.grantedBotOf(g, g) !== grantedBot) continue;
      return { ...g, scope: J(g.scope, {}) };
    }
    return null;
  }

  addGrant(p: Principal, relId: string, body: { capability: string; scope?: any; expires_in_days?: number }) {
    const ownerId = this.requireOwner(p);
    const r = this.get("SELECT * FROM relationships WHERE id = ?", relId);
    assert(r, 404, "relationship_not_found");
    assert(r.status === "active", 409, "invalid_state", `relationship is ${r.status}`);
    assert(ownerId === r.requester_owner || ownerId === r.target_owner, 403, "forbidden");
    this.validCaps([body?.capability]);
    this.assertScope(body.capability, body.scope);
    const grantee = ownerId === r.requester_owner ? r.target_bot : r.requester_bot;
    // Both ends of the share must be able to answer. The auto-accept invite path refuses a frozen or revoked Bot at
    // the same point, and this door writes the same grants -- a stop must not be undone by a share that arrives
    // later. The refusal comes before the transaction, so nothing is superseded and no row is written.
    this.assertInvitable(this.bot(ownerId === r.requester_owner ? r.requester_bot : r.target_bot));
    this.assertInvitable(this.bot(grantee));
    // The supersede and the insert are one write: a throw between them must not leave the old grant revoked.
    const id = this.db.transaction(() => this.insertGrant(relId, ownerId, grantee, body.capability, body.scope, body.expires_in_days, `owner:${ownerId}`)).immediate();
    this.emit(grantee, "grant.changed", { relationship_id: relId, capability: body.capability, status: "granted" });
    return { grant_id: id, capability: body.capability, grantee_bot: grantee, status: "active" };
  }

  revokeGrant(p: Principal, grantId: string) {
    const ownerId = this.requireOwner(p);
    const g = this.get("SELECT * FROM grants WHERE id = ?", grantId);
    assert(g, 404, "grant_not_found");
    assert(g.grantor_owner === ownerId, 403, "forbidden", "only the grantor can revoke");
    // Only a live row can be ended. A `superseded` row is the history a renewal left behind: it still owns the room
    // usages that paid for the guest's seat, so ending it would take a seat the live row is responsible for.
    assert(g.status === "active", 409, "invalid_state", `the grant is ${g.status}`);
    this.run("UPDATE grants SET status = 'revoked', revoked_at = ? WHERE id = ?", nowIso(), grantId);
    const r = this.get("SELECT * FROM relationships WHERE id = ?", g.relationship_id);
    this.endGrantRooms(this.shareLineage([grantId]), `owner:${ownerId}`);
    this.settleCardsForEndedShare([g], "grant_revoked", `owner:${ownerId}`);
    this.audit.append(`owner:${ownerId}`, "grant.revoked", grantId, [r?.requester_owner, r?.target_owner], { capability: g.capability, grantee_bot: g.grantee_bot });
    this.emit(g.grantee_bot, "grant.changed", { relationship_id: g.relationship_id, capability: g.capability, status: "revoked" });
    return { grant_id: grantId, status: "revoked" };
  }

  /**
   * Revoke one person's access to one of my bots (every capability in that bundle) without
   * touching grants of my other bots. Removes the bot from rooms where that grant was used.
   */
  revokeBotGrant(p: Principal, grantId: string, botId?: string) {
    const ownerId = this.requireOwner(p);
    const g = this.get("SELECT * FROM grants WHERE id = ?", grantId);
    assert(g, 404, "grant_not_found");
    assert(g.grantor_owner === ownerId, 403, "forbidden", "only the grantor can revoke");
    const r = this.get("SELECT * FROM relationships WHERE id = ?", g.relationship_id);
    const granted = this.grantedBotOf(g, r);
    if (botId) {
      const bot = this.ownBot(ownerId, this.resolveOwnBot(ownerId, botId).id);
      assert(granted === bot.id, 404, "grant_not_found", "that grant is not for this bot");
    }
    // Only a live row says which bundle is live. A `superseded` row is the history a renewal left behind, and it
    // shares its relationship, grantee and room with the rows that replaced it: revoking by that id tore the live
    // bundle down. The single-grant door refuses the same row with the same answer.
    assert(g.status === "active", 409, "invalid_state", `the grant is ${g.status}`);
    const bundle = this.all("SELECT * FROM grants WHERE relationship_id = ? AND grantor_owner = ? AND grantee_bot = ? AND status = 'active' AND IFNULL(room_id,'') = ?",
      g.relationship_id, ownerId, g.grantee_bot, g.room_id ?? "");
    const ids = bundle.map((x: any) => x.id);
    const now = nowIso();
    for (const id of ids) this.run("UPDATE grants SET status = 'revoked', revoked_at = ? WHERE id = ?", now, id);
    const rooms = this.endGrantRooms(this.shareLineage(ids), `owner:${ownerId}`);
    this.settleCardsForEndedShare(bundle, "grant_revoked", `owner:${ownerId}`);
    this.audit.append(this.actorOf(p), "grant.revoked", grantId, [r?.requester_owner, r?.target_owner], {
      capability: g.capability, grantee_bot: g.grantee_bot, granted_bot: granted, bundle: ids, rooms,
    });
    this.emit(g.grantee_bot, "grant.changed", { relationship_id: g.relationship_id, capability: g.capability, status: "revoked", granted_bot: granted });
    return { grant_id: grantId, status: "revoked", revoked: ids, granted_bot: granted, grantee_bot: g.grantee_bot, rooms_removed: rooms };
  }

  /**
   * Recipient side of revoke_bot_grant: the GRANTEE's owner removes a grant that was given to one of their bots.
   * The whole full-share bundle (every non-reply-only capability of that grant to that bot) ends as 'declined';
   * it disappears from the granting owner's list_bot_grants and from the grantee's list_remote_bots. Only this
   * direction ends: the friendship and any grants the other way stay. Reply-only rows (#23 / #35) are kept so
   * the caller's Bot can still answer in conversations the friend's Bot started after "Remove this Bot".
   * Declining a grant_id that is only reply-only is refused (nothing to remove as a share). The Bot leaves
   * rooms where the declined grants were used (same as a revoke). The granting owner may share the Bot again
   * with a fresh invite (see joinInvite). Needs no confirm code: it only reduces the caller's own access.
   */
  declineBotGrant(p: Principal, grantId: string, botId?: string) {
    const ownerId = this.requireOwner(p);
    const g = this.get("SELECT * FROM grants WHERE id = ?", grantId);
    assert(g, 404, "grant_not_found");
    const grantee = this.bot(g.grantee_bot);
    assert(grantee.owner_id === ownerId && g.grantor_owner !== ownerId, 403, "forbidden", "only the owner of the grantee bot can decline this grant");
    assert(g.status === "active", 404, "grant_not_found", "that grant is no longer active");
    const r = this.get("SELECT * FROM relationships WHERE id = ?", g.relationship_id);
    const granted = this.grantedBotOf(g, r);
    if (botId) {
      const ref = this.get("SELECT id FROM bots WHERE id = ?", botId) ?? this.botByRef(botId);
      assert(ref && ref.id === granted, 404, "grant_not_found", "that grant is not for this bot");
    }
    // #35: never decline reply-only rows — those let this Bot answer the friend's Bot after a join.
    const bundle = this.all("SELECT * FROM grants WHERE relationship_id = ? AND grantor_owner = ? AND grantee_bot = ? AND status = 'active' AND IFNULL(room_id,'') = ? AND IFNULL(reply_only, 0) = 0",
      g.relationship_id, g.grantor_owner, g.grantee_bot, g.room_id ?? "");
    assert(bundle.length > 0, 404, "grant_not_found", "that grant is reply-only; decline removes a full share only");
    const ids = bundle.map((x: any) => x.id as string);
    const now = nowIso();
    for (const id of ids) this.run("UPDATE grants SET status = 'declined', revoked_at = ? WHERE id = ?", now, id);
    const rooms = this.endGrantRooms(this.shareLineage(ids), `owner:${ownerId}`);
    this.settleCardsForEndedShare(bundle, "grant_revoked", `owner:${ownerId}`);
    this.audit.append(this.actorOf(p), "grant.declined", grantId, [r?.requester_owner, r?.target_owner], {
      capability: g.capability, grantee_bot: g.grantee_bot, granted_bot: granted, grantor_owner: g.grantor_owner, bundle: ids, rooms,
    });
    for (const b of new Set([granted, g.grantee_bot].filter(Boolean))) {
      this.emit(b, "grant.changed", { relationship_id: g.relationship_id, capability: g.capability, status: "declined", granted_bot: granted, grantee_bot: g.grantee_bot });
    }
    return { grant_id: grantId, status: "declined", declined: ids, granted_bot: granted, grantee_bot: g.grantee_bot, rooms_removed: rooms };
  }

  /**
   * #34: owner grants an existing friend access to one of their Bots without an invite code.
   * Creates the same per-Bot full share (and reciprocal reply-only if missing) that accepting an invite would.
   * Idempotent when a live full grant of this Bot to the friend already exists. Friend is notified via grant.changed;
   * they may decline_bot_grant; the owner may revoke_bot_grant.
   * The friend is named by `friend_bot_id` (the peer Bot id `list_friends` returns, #592) or by the older
   * `friend_owner_id`; with a Bot id the owner is derived from it, so a caller never needs an owner id.
   */
  grantBotToFriend(p: Principal, botId: string, friendOwnerId?: string | null, friendBotId?: string | null) {
    const ownerId = this.requireOwner(p);
    // Both fields name the friend: `friend_bot_id` one of their Bots, `friend_owner_id` their account. The reads
    // below keep only a string, so a wrong type was never refused and never named: it read as "nothing named". With
    // a valid `friend_owner_id` beside it the door then picked the friend's Bot off the friendship edge and wrote a
    // live share of a Bot the caller never named — naming Bob's un-friended Bot with an array shared Alice's Bot
    // with Bob's other Bot — and beside a real `friend_bot_id` a wrong-typed owner was silently dropped where a
    // string naming another owner is refused. Refuse the field here, before the friendship is read and before
    // anything is written; absent and null keep their meaning, and both absent still says what it always said.
    assert(friendOwnerId === undefined || friendOwnerId === null || typeof friendOwnerId === "string", 400, "invalid_request", "friend_owner_id must be a string");
    assert(friendBotId === undefined || friendBotId === null || typeof friendBotId === "string", 400, "invalid_request", "friend_bot_id must be a string");
    const namedOwner = typeof friendOwnerId === "string" ? friendOwnerId.trim() : "";
    const namedBot = typeof friendBotId === "string" ? friendBotId.trim() : "";
    assert(namedOwner || namedBot, 400, "invalid_request", "friend_owner_id or friend_bot_id required");
    const bot = this.resolveOwnBot(ownerId, botId);
    const peerBot = namedBot
      ? this.get("SELECT * FROM bots WHERE id = ?", namedBot) ?? this.botByRef(namedBot)
      : undefined;
    if (namedBot) assert(peerBot, 404, "friend_not_found", "no such Bot");
    if (peerBot) assert(peerBot.owner_id !== ownerId, 400, "invalid_request", "cannot grant a Bot to yourself");
    if (peerBot && namedOwner) assert(namedOwner === peerBot.owner_id, 400, "invalid_request", "friend_owner_id and friend_bot_id name different owners");
    const friendOwnerKey: string = peerBot ? String(peerBot.owner_id) : namedOwner;
    assert(friendOwnerKey !== ownerId, 400, "invalid_request", "cannot grant a Bot to yourself");
    friendOwnerId = friendOwnerKey;
    const friendOwner = this.get("SELECT * FROM owners WHERE id = ?", friendOwnerKey);
    assert(friendOwner, 404, "friend_not_found", "no such owner");

    const friendships = this.all(
      `SELECT * FROM relationships WHERE status = 'active'
        AND ((requester_owner = ? AND target_owner = ?) OR (requester_owner = ? AND target_owner = ?))
        ORDER BY updated_at DESC`,
      ownerId, friendOwnerId, friendOwnerId, ownerId,
    );
    assert(friendships.length > 0, 404, "friend_not_found", "that owner is not an active friend");
    if (peerBot) {
      // Named by Bot: the share targets that friend Bot itself, not any other Bot of the same owner.
      const named = friendships.filter((r: any) => r.requester_bot === peerBot.id || r.target_bot === peerBot.id);
      assert(named.length > 0, 404, "friend_not_found", "that Bot is not an active friend");
      friendships.length = 0;
      friendships.push(...named);
    }

    // A block is per Bot pair. Never let this shortcut create a fresh relationship around one:
    // `requestRelationship` and `joinInvite` both refuse a blocked pair, and so must this.
    const pairBotOf = (r: any) => (r.requester_owner === ownerId ? r.target_bot : r.requester_bot);
    const blockedPair = (otherBot: string) => this.pairRelationships(bot.id, otherBot).some((r: any) => r.status === "blocked");
    const usable = friendships.filter((r: any) => !blockedPair(pairBotOf(r)));
    assert(usable.length > 0, 403, "blocked", "relationship is blocked");

    // A stopped Bot is not a place to start a share, and a stopped Bot is not a place to aim one: every other door
    // that hands reach out answers a stopped identity through `assertInvitable` (`test/home_send_frozen.test.ts`: "every
    // other owner-side door says so with `bot_frozen`"), and the invite path this door's docstring says it mirrors
    // checks both ends. This is the share's own end, and it sits behind the refusals above -- a stranger is still
    // `404 friend_not_found`, a blocked pair still `403 blocked` -- and ahead of the sweep and the idempotent answer
    // below, so a stop is never swallowed by either: a frozen Bot's repeat is a 403, not `idempotent: true`. The far
    // end is checked once the relationship this call would use is known, a few lines down.
    this.assertInvitable(bot);

    // Reads only, lifted above the sweep so the far end can be checked before anything settles or writes: which
    // relationship this door would use, the friend Bot it names, and the pair that may already exist. `expireStale()`
    // settles `pending_*` requests and lapsed shares and never touches an `active` relationship, so these answer what
    // they answered from below it. The write that follows the sweep stays where it was: an `active` row must not exist
    // for a call this door refuses.
    let chosenRel = usable.find((r: any) => (r.requester_owner === ownerId ? r.requester_bot : r.target_bot) === bot.id);
    let chosenFriendBot: string;
    let existingPair: any;
    if (chosenRel) {
      chosenFriendBot = pairBotOf(chosenRel);
    } else {
      const chosenBase = usable[0];
      chosenFriendBot = chosenBase.requester_owner === friendOwnerId ? chosenBase.requester_bot : chosenBase.target_bot;
      existingPair = this.findActiveRelationship(bot.id, chosenFriendBot);
    }
    // The far end, from either way of naming it. When the friend named a Bot, the list above was narrowed to the
    // relationships that touch it, so this read lands on that Bot from either branch (the relationship whose own end is
    // the share, or the fallback pair); when only the owner was named, it lands on the Bot that pair names. A row that
    // names a Bot no longer in `bots` keeps the answer it had (this door adds no 404 of its own); a Bot that is there
    // and stopped is the stop's answer.
    const farEnd = this.get("SELECT * FROM bots WHERE id = ?", chosenFriendBot);
    if (farEnd) this.assertInvitable(farEnd);

    // Idempotent: already a live full share of this Bot to any of the friend's bots.
    for (const rel of usable) {
      const myBot = rel.requester_owner === ownerId ? rel.requester_bot : rel.target_bot;
      const friendBot = rel.requester_owner === ownerId ? rel.target_bot : rel.requester_bot;
      if (myBot !== bot.id) continue;
      if (this.hasLiveGrant(ownerId, friendBot, rel.id)) {
        // The answer below names this relationship's far end, so it takes the same check the chosen far end above
        // took. The loop can answer from an older friendship than the one `chosenBase` reads (the newest one), and
        // that older friendship's Bot may have been stopped after its share was written: without this read, a repeat
        // naming only the owner would hand back `status: "active"` for a Bot this door refuses everywhere else, and
        // the stop rule it enforces on both ends would be bypassed by a retry. A row that names a Bot no longer in
        // `bots` keeps the answer it had, exactly as above; a Bot that is there and stopped is the stop's answer,
        // and this sits before the sweep and before every write, so the refusal writes nothing.
        const namedFarEnd = this.get("SELECT * FROM bots WHERE id = ?", friendBot);
        if (namedFarEnd) this.assertInvitable(namedFarEnd);
        // This answer writes nothing, so it settles nothing: name the share from this one relationship. The read it
        // used to end with, `listBotGrants`, is a documented delivery moment of its own ("a read also settles lapsed
        // access"), so it ran the platform-wide sweep a second time from behind the door's -- and a repeat of a share
        // is exactly the call a client makes on a retry. `findGrant` names the live `chat.public` row, the first row
        // of this bundle as the writing path returns it, and `grantSummary` its capabilities: both answer from the
        // relationship alone, without a sweep.
        const summary = this.grantSummary(rel.id).find((g: any) => g.granted_bot.bot_id === bot.id && g.grantee_bot.bot_id === friendBot && !g.reply_only);
        return {
          grant_id: this.findGrant(ownerId, friendBot, "chat.public", bot.id)?.id ?? summary?.grant_id,
          bot_id: bot.id,
          friend_owner_id: friendOwnerId,
          grantee_bot: friendBot,
          relationship_id: rel.id,
          status: "active",
          capabilities: summary?.capabilities ?? ["chat.public", "profile.read"],
          reply_only: false,
          idempotent: true,
        };
      }
    }

    // A delivery moment, not a gate. Every refusal of this door is above it (`a_refused_write_settles_nothing_else`
    // pins that a 404 or a 403 must not be the call that expires another owner's cards), and so is the answer that
    // writes nothing: a repeat of a live share writes no byte, so it must settle nothing either
    // (`an_idempotent_grant_settles_nothing_else`). The sweep used to stand in front of both, and the read the
    // idempotent answer named its share with ran it again; the queue is settled once, here, right before the first
    // write.
    this.expireStale();

    // Prefer an existing relationship whose endpoint on our side is this Bot; else open one with the friend's bot from the newest friendship.
    let rel = chosenRel;
    let friendBot: string = chosenFriendBot;
    let createdRel = false;
    if (!rel) {
      if (existingPair) {
        rel = existingPair;
      } else {
        // Mirror an invite join: friend bot is requester, our Bot is target (we are the "inviter").
        const id = newId("rel");
        const now = nowIso();
        this.run(
          `INSERT INTO relationships (id, requester_bot, target_bot, requester_owner, target_owner, status, message, requested_caps, offered_caps, created_at, updated_at, expires_at, requester_scope, target_scope)
            VALUES (?,?,?,?,?,'active',?,?,?,?,?,NULL,'bot','bot')`,
          id, friendBot, bot.id, friendOwnerId, ownerId,
          `Granted by owner (no invite)`, JSON.stringify(DEFAULT_CAPABILITIES), JSON.stringify(DEFAULT_CAPABILITIES), now, now,
        );
        rel = this.get("SELECT * FROM relationships WHERE id = ?", id);
        createdRel = true;
      }
    }

    const actor = this.actorOf(p);
    const fbScope = { window_days: 14, hours: "09:00-18:00" };
    const caps = [...DEFAULT_CAPABILITIES];
    this.db.transaction(() => {
      for (const c of caps) this.insertGrant(rel.id, ownerId, friendBot, c, c === "calendar.freebusy.read" ? fbScope : {}, undefined, actor);
      // Reciprocal reply-only (#23), same as a join, only when missing.
      for (const c of caps) {
        if (!this.findGrant(friendOwnerKey, bot.id, c, friendBot)) {
          this.insertGrant(rel.id, friendOwnerKey, bot.id, c, c === "calendar.freebusy.read" ? fbScope : {}, undefined, `owner:${friendOwnerKey}`, { replyOnly: true });
        }
      }
    })();

    this.audit.append(actor, "grant.created", rel.id, [ownerId, friendOwnerId], {
      relationship_id: rel.id, granted_bot: bot.id, grantee_bot: friendBot, friend_owner_id: friendOwnerId, via: "grant_bot_to_friend", created_relationship: createdRel,
    });
    for (const b of [bot.id, friendBot]) {
      this.emit(b, "grant.changed", { relationship_id: rel.id, status: "granted", granted_bot: bot.id, grantee_bot: friendBot });
    }

    const listed = this.listBotGrants(p, bot.id).grants.find((g: any) => g.grantee.bot_id === friendBot || handleKey(g.grantee.handle) === handleKey(this.bot(friendBot).handle));
    const summary = this.grantSummary(rel.id).find((g: any) => g.granted_bot.bot_id === bot.id && g.grantee_bot.bot_id === friendBot && !g.reply_only);
    return {
      grant_id: listed?.grant_id ?? summary?.grant_id ?? this.findGrant(ownerId, friendBot, "chat.public", bot.id)?.id,
      bot_id: bot.id,
      friend_owner_id: friendOwnerId,
      grantee_bot: friendBot,
      relationship_id: rel.id,
      status: "active",
      capabilities: listed?.capabilities ?? summary?.capabilities ?? caps,
      reply_only: false,
      idempotent: false,
      ...(createdRel ? { created_relationship: true } : {}),
    };
  }

  /** This owner's side of a relationship: "joiner" when their Bot joined the other's invite (or sent the friend
   *  request, the requester), "inviter" when the other side joined theirs. Derived from what every relationship
   *  already stores (requester_* / target_*), so old relationships are classified too. Null for room-only grants. */
  private sideOf(r: { requester_owner: string; rel_status?: string; status?: string }, ownerId: string): "joiner" | "inviter" | null {
    if ((r.rel_status ?? r.status) === "room") return null;
    return r.requester_owner === ownerId ? "joiner" : "inviter";
  }

  /** Grants of one of my bots: who has it, scope, rooms, created/expiry. */
  listBotGrants(p: Principal, botId: string) {
    const ownerId = this.requireOwner(p);
    const bot = this.resolveOwnBot(ownerId, botId);
    this.expireStale();
    const rows = this.all(`SELECT g.*, r.requester_bot, r.target_bot, r.requester_owner, r.target_owner, r.status AS rel_status
      FROM grants g JOIN relationships r ON r.id = g.relationship_id
      WHERE g.grantor_owner = ? AND g.status = 'active' AND r.status IN ('active','room')
      ORDER BY g.created_at`, ownerId);
    const groups = new Map<string, any>();
    for (const g of rows) {
      const granted = this.grantedBotOf(g, g);
      if (granted !== bot.id) continue;
      if (g.expires_at && Date.parse(g.expires_at) < Date.now()) { this.run("UPDATE grants SET status = 'expired' WHERE id = ?", g.id); continue; }
      const key = `${g.relationship_id}:${g.grantee_bot}:${g.room_id ?? ""}`;
      const grantee = this.bot(g.grantee_bot);
      const moreRooms = this.activeGrantRooms(g.id);
      const scope = g.room_id || J(g.scope, {}).kind === "room" ? "room" : (moreRooms.length ? "group" : "person");
      const cur = groups.get(key) ?? {
        grant_id: g.id, grantee: this.publicBot(grantee, true), scope,
        room: g.room_id ? this.grantRoomPublic(g.room_id) : moreRooms[0] ?? null,
        rooms: [] as any[], capabilities: [] as string[], created_at: g.created_at, expires_at: g.expires_at,
        relationship_id: g.rel_status === "room" ? null : g.relationship_id, side: this.sideOf(g, ownerId),
        reply_only: !g.room_id && this.replyOnlyAccess(g.relationship_id, ownerId, g.grantee_bot),
      };
      for (const room of moreRooms) if (!cur.rooms.some((x: any) => x.room_id === room.room_id)) cur.rooms.push(room);
      if (moreRooms.length && cur.scope === "person") cur.scope = "group";
      if (!cur.room) cur.room = g.room_id ? this.grantRoomPublic(g.room_id) : moreRooms[0] ?? null;
      if (!cur.capabilities.includes(g.capability)) cur.capabilities.push(g.capability);
      if (g.created_at < cur.created_at) cur.created_at = g.created_at;
      groups.set(key, cur);
    }
    return { bot: this.publicBot(bot, true), grants: [...groups.values()] };
  }

  /** Bots other owners have granted TO me. */
  listRemoteBots(p: Principal, homeId?: string) {
    const ownerId = this.requireOwner(p);
    let mine: string[];
    if (homeId) {
      const home = this.ownHome(ownerId, homeId);
      mine = [home.id, ...this.homeMembers(home.id).map((m: any) => m.bot_id)];
    } else {
      mine = this.all("SELECT id FROM bots WHERE owner_id = ? AND status = 'active'", ownerId).map((b: any) => b.id);
    }
    if (!mine.length) return { bots: [], homes: [] };
    this.expireStale();
    const marks = mine.map(() => "?").join(",");
    const rows = this.all(`SELECT g.*, r.requester_bot, r.target_bot, r.requester_owner, r.target_owner, r.status AS rel_status
      FROM grants g JOIN relationships r ON r.id = g.relationship_id
      WHERE g.grantee_bot IN (${marks}) AND g.grantor_owner != ? AND g.status = 'active' AND r.status IN ('active','room')
      ORDER BY g.created_at`, ...mine, ownerId);
    const bots: any[] = [];
    const byHome = new Map<string, any>();
    const seen = new Set<string>();
    for (const g of rows) {
      if (g.expires_at && Date.parse(g.expires_at) < Date.now()) { this.run("UPDATE grants SET status = 'expired' WHERE id = ?", g.id); continue; }
      const grantedId = this.grantedBotOf(g, g);
      if (!grantedId || mine.includes(grantedId) || seen.has(grantedId + ":" + g.grantee_bot)) continue;
      const granted = this.get("SELECT * FROM bots WHERE id = ? AND status = 'active'", grantedId);
      if (!granted) continue;
      seen.add(grantedId + ":" + g.grantee_bot);
      const rooms = this.activeGrantRooms(g.id);
      const scope = g.room_id || J(g.scope, {}).kind === "room" ? "room" : (rooms.length ? "group" : "person");
      const item = {
        bot_id: granted.id, handle: "@" + granted.handle, display_name: peerBotName(granted), ...lookOf(granted),
        owner_display_name: peerOwnerName(this.owner(granted.owner_id)),
        grant_id: g.id, scope, room: g.room_id ? this.grantRoomPublic(g.room_id) : rooms[0] ?? null, rooms,
        via: "@" + this.bot(g.grantee_bot).handle, created_at: g.created_at, expires_at: g.expires_at,
        relationship_id: g.rel_status === "room" ? null : g.relationship_id, side: this.sideOf(g, ownerId),
        reply_only: !g.room_id && this.replyOnlyAccess(g.relationship_id, g.grantor_owner, g.grantee_bot),
      };
      bots.push(item);
      const peerHome = this.bot(this.homeOf(granted.id));
      const entry = byHome.get(peerHome.id) ?? {
        relationship_id: item.relationship_id, relationship_ids: [] as string[], side: item.side, relationship_sides: {} as Record<string, "joiner" | "inviter" | null>,
        home: { bot_id: peerHome.id, handle: "@" + peerHome.handle, display_name: peerBotName(peerHome), ...lookOf(peerHome), owner_display_name: peerOwnerName(this.owner(peerHome.owner_id)) },
        bots: [] as any[], scope: "member", via: [] as string[],
      };
      if (item.relationship_id && !entry.relationship_ids.includes(item.relationship_id)) { entry.relationship_ids.push(item.relationship_id); entry.relationship_sides[item.relationship_id] = item.side; }
      if (!entry.bots.some((x: any) => x.bot_id === granted.id)) {
        entry.bots.push({ bot_id: granted.id, handle: "@" + granted.handle, display_name: peerBotName(granted), ...lookOf(granted), grant_id: g.id, scope, room: item.room, rooms, created_at: g.created_at, expires_at: g.expires_at, relationship_id: item.relationship_id, side: item.side, reply_only: item.reply_only });
      }
      if (!entry.via.includes(item.via)) entry.via.push(item.via);
      byHome.set(peerHome.id, entry);
    }
    return { bots, homes: [...byHome.values()] };
  }

  /** #23: is this grantee's access to the grantor's Bot on this relationship reply-only? True when it holds a reply-only
   *  grant from the join and no full `chat.public`: it may answer that Bot, not start a conversation with it or bring it
   *  into a room. A full grant of another capability (say calendar.freebusy.read) does not share the Bot for talking. */
  private replyOnlyAccess(relId: string, grantorOwner: string, granteeBot: string): boolean {
    const rows = this.all("SELECT capability, reply_only, expires_at FROM grants WHERE relationship_id = ? AND grantor_owner = ? AND grantee_bot = ? AND status = 'active' AND room_id IS NULL", relId, grantorOwner, granteeBot)
      .filter((g: any) => !g.expires_at || Date.parse(g.expires_at) >= Date.now());
    return rows.some((g: any) => g.reply_only) && !rows.some((g: any) => g.capability === "chat.public" && !g.reply_only);
  }

  /**
   * #23: `senderBot` holds only the reply-only grant a join gave it on `target`, so it may not start a conversation
   * with `target` (or bring it into a face room). Refuse with 403 bot_not_shared, store nothing, and tell the target's
   * owner with a `share.requested` event on the target Bot (at most once a day per sender) so they can choose to
   * share the Bot. Nothing is ever granted automatically.
   */
  private refuseUnshared(senderBot: string, target: any, relId: string, attempted: "conversation.create" | "message.draft" | "face_room.join", convId: string | null = null): never {
    const sender = this.bot(senderBot);
    this.policyDecision(senderBot, convId, [sender.owner_id, target.owner_id], attempted, "deny", ["grant.reply_only:chat.public"]);
    // This refusal always throws, so a caller holding a transaction rolls it back and would take the notice with it;
    // that caller writes the notice itself once the rollback is done (`noticeUnshared`), never from inside.
    if (!this.db.inTransaction) this.noticeUnshared(senderBot, target, relId, attempted);
    throw new ApiError(403, "bot_not_shared",
      `@${target.handle} is not shared with your Bot: its owner allows replies only in conversations their Bot starts. Nothing was delivered. Their owner has been told and can choose to share it.`,
      { suggestion: "ask_owner_to_share", bot_id: target.id, relationship_id: relId, owner_notified: true });
  }

  /** The one thing a reply-only refusal leaves behind: the target owner's notice, at most once a day per sender. */
  private noticeUnshared(senderBot: string, target: any, relId: string, attempted: "conversation.create" | "message.draft" | "face_room.join") {
    if (this.get("SELECT 1 FROM events WHERE bot_id = ? AND type = 'share.requested' AND created_at > ? AND json_extract(data, '$.from.bot_id') = ?", target.id, new Date(Date.now() - 86400e3).toISOString(), senderBot)) return;
    this.emit(target.id, "share.requested", {
      relationship_id: relId, bot_id: target.id, from: this.publicBot(this.bot(senderBot)), attempted, trust: "platform",
      note: "This Bot is not shared with the sender, so their attempt to start a conversation was refused and nothing was delivered. Only your owner can share this Bot (for example with an invite link for this Bot); nothing is shared automatically.",
    });
  }

  private resolveOwnBot(ownerId: string, ref: string) {
    const b = this.get("SELECT * FROM bots WHERE owner_id = ? AND id = ?", ownerId, ref) ?? this.botByRef(ref, "owner_id = ?", [ownerId]);
    assert(b, 404, "bot_not_found", "no such bot on this account");
    return b;
  }

  private grantRoomPublic(roomId: string) {
    const room = this.get("SELECT id, status, expires_at, started_at FROM face_rooms WHERE id = ?", roomId);
    if (!room) return { room_id: roomId, status: "unknown" };
    return { room_id: room.id, status: room.status, expires_at: this.faceRoomDeadline(room), started_at: room.started_at };
  }

  private activeGrantRooms(grantId: string) {
    return this.all("SELECT room_id FROM grant_rooms WHERE grant_id = ? AND ended_at IS NULL", grantId)
      .map((x: any) => this.grantRoomPublic(x.room_id));
  }

  private recordGrantRoomUse(grantId: string, roomId: string, actor: string, owners: (string | null | undefined)[]) {
    const existing = this.get("SELECT * FROM grant_rooms WHERE grant_id = ? AND room_id = ?", grantId, roomId);
    if (existing && !existing.ended_at) return;
    if (existing) this.run("UPDATE grant_rooms SET ended_at = NULL, created_at = ? WHERE grant_id = ? AND room_id = ?", nowIso(), grantId, roomId);
    else this.run("INSERT INTO grant_rooms (grant_id, room_id, created_at) VALUES (?,?,?)", grantId, roomId, nowIso());
    this.audit.append(actor, "grant.used_in_room", grantId, owners, { room_id: roomId });
  }

  /** The rows a share was renewed from: `insertGrant` marks the live row `superseded` and writes a new one, and the
   *  old row keeps the room usages that made its guest seat. Ending the current row must hand those rows over too,
   *  or the seat outlives the share. Only rows created strictly before it are ancestors — a row created later is
   *  the live share itself, and its seats are not this end's to take. */
  private shareLineage(grantIds: string[]): string[] {
    const out = new Set(grantIds);
    for (const gid of grantIds) {
      const g = this.get("SELECT * FROM grants WHERE id = ?", gid);
      if (!g) continue;
      for (const p of this.all(`SELECT id FROM grants WHERE relationship_id = ? AND grantor_owner = ? AND grantee_bot = ?
          AND capability = ? AND IFNULL(room_id,'') = ? AND status IN ('superseded','expired') AND created_at < ? AND id != ?`,
        g.relationship_id, g.grantor_owner, g.grantee_bot, g.capability, g.room_id ?? "", g.created_at, gid)) out.add(p.id);
    }
    return [...out];
  }

  /** A seat in a face room is paid for by the share that can bring a Bot in: `chat.public`, never a reply-only row.
   *  `accessGrantTo` seats a guest on that row alone, and the room's own grants are written back for every capability,
   *  so ending a calendar or profile share must not take a seat. The record alone cannot say this — the old sibling
   *  loop wrote a `grant_rooms` row for every share of the bringer, and those rows are still in the database — so the
   *  judgement belongs here, where a seat is actually given back. */
  private grantPaysForSeat(g: any) {
    return g.capability === "chat.public" && !g.reply_only;
  }

  /** End room usages for these grants and remove the granted bot from those rooms when we added it. */
  private endGrantRooms(grantIds: string[], actor: string, reason: FaceRoomCloseReason = "room_closed"): string[] {
    if (!grantIds.length) return [];
    const now = nowIso();
    const removed: string[] = [];
    for (const gid of grantIds) {
      const g = this.get("SELECT * FROM grants WHERE id = ?", gid);
      if (!g) continue;
      const r = this.get("SELECT * FROM relationships WHERE id = ?", g.relationship_id);
      const granted = this.grantedBotOf(g, r);
      const granteeOwner = this.bot(g.grantee_bot).owner_id;
      // Every usage row is checked, not only the open ones: the room's own sweep closes a usage when a member
      // leaves, and that used to hide the seat from this door. A usage this door finds already ended is not a seat
      // given back — the seat may still be there (its bringer left first), so look at the room before deciding.
      // An ended usage can only claim a seat that was already there when it ended: a seat that arrived later was
      // made by the share that let the Bot back in, and this end reaching the older row through the lineage must
      // not take it. It is the same bound the lapse door uses in its pre-filter. A usage still open short-circuits
      // it: it has not handed its seat over yet, so the seat it sees is its own.
      // A usage already ended whose room no longer seats the Bot is history and stays out of `removed`.
      // A row this share never paid for is not a claim on the seat: it is closed with the share (it is history once
      // the share ends), but no seat is given back. See `grantPaysForSeat`: this covers rows written before that rule.
      const pays = this.grantPaysForSeat(g);
      const usages = this.all("SELECT * FROM grant_rooms WHERE grant_id = ?", gid);
      for (const u of usages) {
        const live = !u.ended_at;
        const member = this.get("SELECT * FROM face_room_members WHERE room_id = ? AND bot_id = ? AND left_at IS NULL", u.room_id, granted);
        const seated = pays && !!member && member.added_by_owner_id === granteeOwner && member.added_by_owner_id !== member.owner_id
          && (live || member.joined_at <= u.ended_at);
        // Nothing to give back and no seat to take: the room closed, or its owner already walked the Bot out.
        if (!live && !seated) continue;
        if (live) this.run("UPDATE grant_rooms SET ended_at = ? WHERE grant_id = ? AND room_id = ?", now, gid, u.room_id);
        if (seated) {
          this.removeFaceMember(u.room_id, member, reason);
          this.settleHeldRoomCards(u.room_id, granted);
          this.endRoomGrantsForBots(u.room_id, [granted]);
        }
        removed.push(u.room_id);
      }
      // The room's own row is addressed to the other members: it did not bring the grantor's own Bot in, and
      // `DELETE /v1/grants/{id}` reaches it. Only a guest seat is given back here — the same judgement the usage
      // rows above make, where a seat its own owner took is not the grant's to take. Ending the host's row ends
      // that row alone: the seat, the room's other grants and `removed` stay untouched.
      if (g.room_id && pays) {
        const member = this.get("SELECT * FROM face_room_members WHERE room_id = ? AND bot_id = ? AND left_at IS NULL", g.room_id, granted);
        const seated = !!member && member.added_by_owner_id === granteeOwner && member.added_by_owner_id !== member.owner_id;
        if (seated) {
          this.removeFaceMember(g.room_id, member, reason);
          this.settleHeldRoomCards(g.room_id, granted);
          this.endRoomGrantsForBots(g.room_id, [granted]);
          if (!removed.includes(g.room_id)) removed.push(g.room_id);
        }
      }
    }
    void actor;
    return [...new Set(removed)];
  }

  /**
   * A line waiting in a room its sender no longer sits in can never be approved: the delivery door refuses it as
   * `not_a_member`, so the card would wait out its 24-hour clock, and until then the owner's only way out is to
   * reject it. A seat ends when the Bot leaves, when an owner takes a guest seat back, when the share that brought
   * the Bot in is revoked, and when a home member is revoked, so settle those lines the moment the seat goes — and
   * only those: this Bot's own face-room lines in this room, never another member's card, another room's card, or
   * an action card.
   */
  private settleHeldRoomCards(roomId: string, botId: string) {
    this.cancelPendingFor(
      `bot_id = ? AND kind = 'face_room_message' AND subject_id IN (
         SELECT id FROM face_room_drafts WHERE room_id = ? AND sender_bot = ?)`,
      [botId, roomId, botId],
      "room_left",
      { notify: true },
    );
  }

  /** Access grant held by one of my bots on someone else's bot (relationship grants only). Only `chat.public` counts:
   *  bringing a Bot into a room seats the pair and `ensurePairRoomGrant` writes the room grants back with
   *  `DEFAULT_CAPABILITIES`, so a share that kept only profile/freebusy must not open that door. */
  private accessGrantTo(ownerId: string, myBotIds: string[], targetBotId: string) {
    if (!myBotIds.length) return null;
    const marks = myBotIds.map(() => "?").join(",");
    const rows = this.all(`SELECT g.*, r.requester_bot, r.target_bot, r.requester_owner, r.target_owner, r.status AS rel_status
      FROM grants g JOIN relationships r ON r.id = g.relationship_id
      WHERE g.grantee_bot IN (${marks}) AND g.grantor_owner != ? AND g.status = 'active' AND r.status = 'active' AND g.room_id IS NULL
        AND g.capability = 'chat.public'`,
      ...myBotIds, ownerId).filter((g: any) => {
      // A share that ran out on its own clock is not reach, even though the row still says `active` until a reader
      // flips it: seating a Bot in a room must not be the reader that treats a lapsed share as live.
      if (g.expires_at && Date.parse(g.expires_at) < Date.now()) {
        this.run("UPDATE grants SET status = 'expired' WHERE id = ?", g.id);
        return false;
      }
      return this.grantedBotOf(g, g) === targetBotId;
    });
    // #23: a grant whose access is reply-only comes last; the caller refuses it (bot_not_shared).
    const full = rows.find((g: any) => !this.replyOnlyAccess(g.relationship_id, g.grantor_owner, g.grantee_bot));
    return full ? { ...full, reply_only_access: false } : rows[0] ? { ...rows[0], reply_only_access: true } : null;
  }

  requestGrant(p: Principal, env: Envelope) {
    this.verifyEnvelope(p, env, "grant.request");
    const { botId, ownerId } = this.requireBot(p);
    const pl: any = env.payload ?? {};
    const r = this.get("SELECT * FROM relationships WHERE id = ? AND status = 'active'", pl.relationship_id);
    assert(r && (r.requester_bot === botId || r.target_bot === botId), 403, "no_relationship");
    this.validCaps([pl.capability]);
    this.assertScope(pl.capability, pl.scope);
    const peerOwner = r.requester_bot === botId ? r.target_owner : r.requester_owner;
    // Writing a card is a delivery moment: the new card is announced, and outside the owner's quiet window any batch
    // that waited through it goes out with that announcement. So the queue is settled first. A card whose own deadline
    // passed is not waiting any more, and a summary that named it would close its ledger line as if it had been
    // announced, leaving the outlet never told the card settled (`flushHeldApprovals` sweeps first for the same
    // reason). Without it, the requester's peer owner hears "one item needs your decision" about a card they can no
    // longer decide.
    this.expireStale();
    const aprId = this.createApproval(peerOwner, "grant_request", r.id, botId, null, `@${this.bot(botId).handle} requests capability ${pl.capability}`, ["grant.requires_owner"], [], LIMITS.approvalTtlMs,
      { capability: pl.capability, scope: pl.scope ?? {}, reason: pl.reason ?? null, grantee_bot: botId });
    this.audit.append(`bot:${botId}`, "grant.requested", r.id, [ownerId, peerOwner], { capability: pl.capability, scope: pl.scope ?? {}, approval_id: aprId });
    return { status: "pending_owner_approval", approval_id: aprId };
  }

  private endRelationship(ownerId: string, r: any, status: "revoked" | "blocked") {
    // The shares this row still had alive end with it, and so do the seats they made: the same `endGrantRooms` the
    // three revoke paths call. Rows scoped to one room are the door a seat wrote, not the share that paid for it, so
    // they are left out here — `endGrantRooms` ends them together with the seat itself.
    const endedShareRows = this.all("SELECT * FROM grants WHERE relationship_id = ? AND status = 'active' AND room_id IS NULL", r.id);
    const endedShares = endedShareRows.map((g: any) => g.id);
    // The same share holding a seat: the UPDATE below ends it too (a Block ends every row of the pair, the room's own
    // row included), but the room door settles only rows that are still `active` -- it runs after this call and finds
    // these already `revoked`, so it writes nothing for them. Read with the UPDATE's predicate and named here, or the
    // rows this door changes and the rows it writes down are two different counts.
    const endedRoomRows = this.all("SELECT * FROM grants WHERE relationship_id = ? AND status = 'active' AND room_id IS NOT NULL", r.id);
    // The chats this call closes, read before the write closes them: the door that closes a chat is the door that
    // names it, and the same row read afterwards only says `closed`.
    const endedChats = this.all("SELECT * FROM conversations WHERE relationship_id = ? AND status != 'closed'", r.id);
    this.db.transaction(() => {
      this.run("UPDATE relationships SET status = ?, blocked_by = ?, updated_at = ? WHERE id = ?", status, status === "blocked" ? ownerId : null, nowIso(), r.id);
      this.run("UPDATE grants SET status = 'revoked', revoked_at = ? WHERE relationship_id = ? AND status = 'active'", nowIso(), r.id);
      this.run("UPDATE conversations SET status = 'closed', outcome = 'revoked', updated_at = ? WHERE relationship_id = ? AND status != 'closed'", nowIso(), r.id);
      // One row per row this door ends, as every other revoke door writes one: the pair's own row below says the
      // relationship ended, but not which capability a Bot lost with it -- nor in which room. Both scopes are named,
      // because the UPDATE above ends both; `room_id` carries the row's own scope (`null` for a relationship-level
      // share) and is the field the room doors write, so the two readings join on it. The reason is the word this
      // door settles its cards by (`revoked`/`blocked`), and the rows go in inside the transaction so the chain
      // commits with the state they describe.
      for (const g of [...endedShareRows, ...endedRoomRows]) {
        this.audit.append(`owner:${ownerId}`, "grant.revoked", g.id, [r.requester_owner, r.target_owner], {
          capability: g.capability, grantee_bot: g.grantee_bot, relationship_id: r.id, room_id: g.room_id ?? null, reason: status,
        });
      }
      // A chat closed here is closed as the clock and the owner's own door close one, so it carries the same entry
      // and, after the commit, tells both Bots the same thing.
      for (const c of endedChats) {
        this.audit.append(`owner:${ownerId}`, "conversation.closed", c.id, [r.requester_owner, r.target_owner], { outcome: "revoked" });
      }
      // Blocked or revoked ends every card hanging off this relationship. Tell each Bot that owned one: the card
      // leaves its owner's list, and without this the Bot kept waiting on a decision that can no longer arrive.
      // Only this call site opts in — member_revoked and emergency_stop must stay silent (the Bot has no token).
      this.cancelPendingFor("(conversation_id IN (SELECT id FROM conversations WHERE relationship_id = ?) OR subject_id = ?)", [r.id, r.id], status, { notify: true, actor: `owner:${ownerId}` });
      // A join that is still waiting never became a friendship, so cancelling or blocking it gives its invite slot
      // back, exactly as `consent` decline, `expireStale` and a rejected approval do (P9). Only the two pending
      // states: an active row's use is the join it paid for, and a terminal row already gave the slot back (or
      // never spent one), so a second Remove of the same row must not refund another.
      if (r.status === "pending_target" || r.status === "pending_requester_owner") this.releaseInviteUse(r.id);
    })();
    if (endedShares.length) this.endGrantRooms(this.shareLineage(endedShares), `owner:${ownerId}`);
    this.audit.append(`owner:${ownerId}`, `relationship.${status}`, r.id, [r.requester_owner, r.target_owner], {});
    for (const b of [r.requester_bot, r.target_bot]) this.emit(b, "relationship.changed", { relationship_id: r.id, status });
    // Same event every other close sends, to the same two Bots: a chat that stopped working without a word is the
    // defect this door had. Sent after the commit, like the pair's own event above.
    for (const c of endedChats) {
      for (const b of [c.initiator_bot, c.peer_bot]) this.emit(b, "conversation.closed", { conversation_id: c.id, outcome: "revoked", trust: "platform", summary: null });
    }
  }

  removeRelationship(p: Principal, relId: string) {
    const ownerId = this.requireOwner(p);
    const r = this.get("SELECT * FROM relationships WHERE id = ?", relId);
    assert(r, 404, "relationship_not_found");
    assert(ownerId === r.requester_owner || ownerId === r.target_owner, 403, "forbidden");
    assert(r.status !== "blocked", 409, "invalid_state", "relationship is blocked");
    this.endRelationship(ownerId, r, "revoked");
    return { relationship_id: relId, status: "revoked" };
  }

  /** Undo a Block the caller wrote. The row and its pair become `revoked` (what an Unfriend leaves), `blocked_by`
   *  is cleared, and nothing is restored: the grants stay void and the chats stay closed, so the pair can only start
   *  again by asking. `block` ends every row the pair holds (the friendship and one row per shared room), so the undo
   *  takes back every row this owner blocked -- the id locates the pair and decides who may undo it, nothing more. */
  undoBlock(p: Principal, relId: string) {
    const ownerId = this.requireOwner(p);
    const r = this.get("SELECT * FROM relationships WHERE id = ?", relId);
    // A pair this owner is not part of reads exactly like an id that does not exist: an undo must not become a way
    // to learn whether another pair is blocked (and by whom).
    assert(r && (ownerId === r.requester_owner || ownerId === r.target_owner), 404, "relationship_not_found");
    assert(r.status === "blocked", 409, "invalid_state", "relationship is not blocked");
    assert(r.blocked_by === ownerId, 403, "forbidden", "only the owner who blocked can undo it");
    const rows = this.pairRelationships(r.requester_bot, r.target_bot).filter((x) => x.status === "blocked" && x.blocked_by === ownerId);
    // `updated_at` is left alone: on a revoked row it is the moment the friendship ended, and `connected_at`/the
    // console's "Removed <time>" read it -- undoing the block must not move that moment to the undo.
    this.db.transaction(() => {
      for (const row of rows) this.run("UPDATE relationships SET status = 'revoked', blocked_by = NULL WHERE id = ?", row.id);
    })();
    this.audit.append(`owner:${ownerId}`, "relationship.unblocked", r.id, [r.requester_owner, r.target_owner], { relationship_ids: rows.map((x) => x.id), rows: rows.length });
    for (const botId of new Set(rows.flatMap((x) => [x.requester_bot, x.target_bot]))) this.emit(botId as string, "relationship.changed", { relationship_id: r.id, status: "revoked" });
    return { relationship_id: relId, status: "revoked" };
  }

  block(p: Principal, body: { bot_id?: string; relationship_id?: string; my_bot_id?: string }) {
    const ownerId = this.requireOwner(p);
    // Every one of these arrives as it is and goes straight into a SQL binding: an object was taken for named
    // parameters and a boolean had no binding, so the route answered 500 before any of the refusals below could
    // speak. Check the shape first; a missing or null id still falls through to the same defaults and refusals as
    // before, and null never reaches SQL because every read below tests the field for truth.
    assert(body?.bot_id === undefined || body?.bot_id === null || typeof body?.bot_id === "string", 400, "invalid_request", "bot_id must be a string");
    assert(body?.my_bot_id === undefined || body?.my_bot_id === null || typeof body?.my_bot_id === "string", 400, "invalid_request", "my_bot_id must be a string");
    assert(body?.relationship_id === undefined || body?.relationship_id === null || typeof body?.relationship_id === "string", 400, "invalid_request", "relationship_id must be a string");
    let r: any;
    if (body?.relationship_id) {
      r = this.get("SELECT * FROM relationships WHERE id = ?", body.relationship_id);
      assert(r && (ownerId === r.requester_owner || ownerId === r.target_owner), 404, "relationship_not_found");
    } else {
      assert(body?.bot_id, 400, "invalid_request", "bot_id or relationship_id required");
      const other = this.bot(body.bot_id);
      const mine = body.my_bot_id ? this.ownBot(ownerId, body.my_bot_id) : this.get("SELECT * FROM bots WHERE owner_id = ? ORDER BY created_at LIMIT 1", ownerId);
      assert(mine, 400, "invalid_request", "you have no bot");
      // A pair can hold several rows (the friendship and one room per shared room, newest first). Blocking a
      // Bot must end every door between the two, not whichever row happens to be newest: a newer room row left
      // the friendship active after "Block". The blocked friendship still makes requestRelationship refuse.
      const rows = this.pairRelationships(mine.id, other.id);
      if (!rows.length) {
        const id = newId("rel");
        this.run(`INSERT INTO relationships (id, requester_bot, target_bot, requester_owner, target_owner, status, requested_caps, offered_caps, created_at, updated_at) VALUES (?,?,?,?,?,'none','[]','[]',?,?)`,
          id, mine.id, other.id, ownerId, other.owner_id, nowIso(), nowIso());
        rows.push(this.get("SELECT * FROM relationships WHERE id = ?", id));
      }
      for (const row of rows) if (row.status !== "blocked") this.endRelationship(ownerId, row, "blocked");
      this.releaseBlockedSeats(this.actorOf(p), other.id, mine.id);
      return { relationship_id: rows[0].id, status: "blocked" };
    }
    // The Block button (`public/ui.js`, `scripts/botctl.ts`) sends the friendship's `relationship_id`, and the
    // room row written when the pair shared a face room is a door between the same two Bots. Ending only the row
    // the caller named left that room open (P23), so both doors now end the whole pair.
    for (const row of this.pairRelationships(r.requester_bot, r.target_bot)) {
      if (row.status !== "blocked") this.endRelationship(ownerId, row, "blocked");
    }
    this.releaseBlockedSeats(this.actorOf(p), r.requester_owner === ownerId ? r.target_bot : r.requester_bot, r.requester_owner === ownerId ? r.requester_bot : r.target_bot);
    return { relationship_id: r.id, status: "blocked" };
  }

  /**
   * The seat a Block takes with it. The room's read door (`faceRequireMember`) and its message door
   * (`deliverFaceRoomMessage`) only ask whether the caller still holds a seat, so a seat left behind kept the pair
   * reading and writing each other in every room both were seated in, while the friendship itself read `blocked`.
   * `endRelationship` gives a seat back only through `endGrantRooms`, and only when a share paid for it
   * (`grantPaysForSeat`); the seat an owner takes for its own Bot belongs to no share and no relationship row
   * carries it. The block is the moment the pair's door ends, so every live room the two Bots still share is
   * swept with the two calls the room's own leave door makes: `removeFaceMember`, then `endRoomGrantsForBots`.
   * Only the blocked Bot's seat ends: the owner who blocked keeps its own seat and the room, and no other seat in
   * the room is touched. Undoing the block restores no seat — it is a seat, not a grant.
   */
  private releaseBlockedSeats(actor: string, blockedBot: string, peerBot: string) {
    const shared = this.all(`SELECT DISTINCT m.room_id AS room_id FROM face_room_members m
        JOIN face_room_members p ON p.room_id = m.room_id AND p.bot_id = ? AND p.left_at IS NULL
        JOIN face_rooms r ON r.id = m.room_id AND r.status != 'closed'
      WHERE m.bot_id = ? AND m.left_at IS NULL`, peerBot, blockedBot) as { room_id: string }[];
    if (!shared.length) return;
    const blockedOwner = this.bot(blockedBot).owner_id;
    this.db.transaction(() => {
      for (const { room_id } of shared) {
        const member = this.get("SELECT * FROM face_room_members WHERE room_id = ? AND bot_id = ? AND left_at IS NULL", room_id, blockedBot);
        if (member) this.removeFaceMember(room_id, member, "room_closed");
        this.endRoomGrantsForBots(room_id, [blockedBot]);
      }
    }).immediate();
    // The seat ended by a block is written down where the leave door writes the same end: the room's audit trail
    // names the Bot and the caller, so an operator reading the room sees who took the seat and not a silent exit.
    for (const { room_id } of shared) {
      this.audit.append(actor, "face_room.left", room_id, [...this.faceOwnerIds(room_id), blockedOwner], { bots: [blockedBot] });
    }
  }

  listRelationships(p: Principal) {
    this.expireStale();
    const botId = p.kind === "bot" ? p.botId : null;
    const rows = botId
      ? this.all("SELECT * FROM relationships WHERE (requester_bot = ? OR target_bot = ?) AND status != 'room' ORDER BY created_at DESC", botId, botId)
      : this.all("SELECT * FROM relationships WHERE (requester_owner = ? OR target_owner = ?) AND status != 'room' ORDER BY created_at DESC", p.ownerId, p.ownerId);
    return rows.map((r) => {
      const meIsRequester = botId ? r.requester_bot === botId : r.requester_owner === p.ownerId;
      const myBot = meIsRequester ? r.requester_bot : r.target_bot;
      const peerBot = meIsRequester ? r.target_bot : r.requester_bot;
      const grants = this.grantsFor(r.id);
      const fmt = (g: any) => ({ grant_id: g.id, capability: g.capability, scope: g.scope, expires_at: g.expires_at, reply_only: !!g.reply_only });
      return {
        relationship_id: r.id, status: r.status, direction: meIsRequester ? "outgoing" : "incoming", side: meIsRequester ? "joiner" : "inviter", my_bot_id: myBot,
        peer: this.botCard(this.bot(peerBot), r.status === "active"), message: r.message, requested_capabilities: J(r.requested_caps, []), offered_capabilities: J(r.offered_caps, []),
        created_at: r.created_at, expires_at: r.expires_at, blocked_by_me: r.blocked_by === p.ownerId,
        settings: this.settingsFor(r.id, p.ownerId),
        capabilities: { me_on_peer: grants.filter((g) => g.grantee_bot === myBot).map(fmt), peer_on_me: grants.filter((g) => g.grantee_bot === peerBot).map(fmt) },
      };
    });
  }

  // ================================================================ relationship settings & invites
  settingsFor(relId: string, ownerId: string) {
    const row = this.get("SELECT auto_approve_chat FROM relationship_settings WHERE relationship_id = ? AND owner_id = ?", relId, ownerId);
    return { auto_approve_chat: !!row?.auto_approve_chat };
  }

  /** Per-relationship owner settings. auto_approve_chat: clean low-risk chat messages skip manual approval (DLP flags still force it). */
  updateRelationshipSettings(p: Principal, relId: string, body: { auto_approve_chat?: boolean }) {
    const ownerId = this.requireOwner(p);
    const r = this.get("SELECT * FROM relationships WHERE id = ?", relId);
    assert(r && (r.requester_owner === ownerId || r.target_owner === ownerId), 404, "relationship_not_found");
    assert(typeof body?.auto_approve_chat === "boolean", 400, "invalid_request", "auto_approve_chat (boolean) required");
    this.run(`INSERT INTO relationship_settings (relationship_id, owner_id, auto_approve_chat, updated_at) VALUES (?,?,?,?)
      ON CONFLICT(relationship_id, owner_id) DO UPDATE SET auto_approve_chat = excluded.auto_approve_chat, updated_at = excluded.updated_at`, relId, ownerId, body.auto_approve_chat ? 1 : 0, nowIso());
    this.audit.append(`owner:${ownerId}`, "relationship.settings_updated", relId, [r.requester_owner, r.target_owner], { auto_approve_chat: body.auto_approve_chat });
    return { relationship_id: relId, settings: this.settingsFor(relId, ownerId) };
  }

  private inviteUrl(code: string) { return `${this.publicBaseUrl.replace(/\/$/, "")}/i/${code}`; }
  private inviteView(i: any) {
    return { invite_id: i.id, code: i.code, url: this.inviteUrl(i.code), bot: this.botCard(this.bot(i.bot_id)), scope: i.scope ?? null, status: this.inviteStatus(i), offered_capabilities: J(i.offered_caps, []), requested_capabilities: J(i.requested_caps, []), message: i.message, auto_accept: !!i.auto_accept, uses: i.uses, max_uses: i.max_uses, expires_at: i.expires_at, created_at: i.created_at };
  }
  private inviteStatus(i: any) {
    // Stored terminal states win over the clock: a revoked or rejected invite never flips back to expired.
    if (i.status !== "active" && i.status !== "pending_owner") return i.status;
    // Both live states carry their own clock. A pending_owner invite whose approval is gone (or whose own window ran
    // out) must read expired instead of "Awaiting your approval" forever.
    if (Date.parse(i.expires_at) < Date.now()) return "expired";
    if (i.uses >= i.max_uses) return "used";
    return i.status;
  }

  /** The one Bot an owner names as id and/or handle, resolved inside that owner's account with the platform's
   *  usual handle semantics (`resolveOwnBot`). Naming a Bot that does not resolve is a 404 instead of a silent
   *  fallback, and two names that resolve to different Bots are a 400 — `bot_id` never wins silently. */
  private namedOwnBot(ownerId: string, idRef: unknown, handleRef: unknown, idField = "bot_id", handleField = "bot_handle"): any | undefined {
    // An id in a body is a string or nothing. `String(...)` below is what reads the value, so a wrong type used to
    // reach it: an array stringifies to the empty string and reads as "no Bot named", which makes both call sites
    // fall back to `inviteBotFor` — an invite shared, or a join made, for a different Bot than the caller named,
    // with no error. Objects, booleans and numbers were answered 404 `bot_not_found` instead, naming the wrong
    // problem. Refusing the field here, before the lookup and before anything is written, keeps "not given" (absent
    // or null) exactly as it was.
    assert(idRef === undefined || idRef === null || typeof idRef === "string", 400, "invalid_request", `${idField} must be a string`);
    assert(handleRef === undefined || handleRef === null || typeof handleRef === "string", 400, "invalid_request", `${handleField} must be a string`);
    const id = idRef === undefined || idRef === null ? "" : String(idRef).trim();
    const handle = handleRef === undefined || handleRef === null ? "" : String(handleRef).trim();
    const byId = id ? this.resolveOwnBot(ownerId, id) : undefined;
    const byHandle = handle ? this.resolveOwnBot(ownerId, handle) : undefined;
    if (byId && byHandle && byId.id !== byHandle.id) throw new ApiError(400, "invalid_request", "bot_id and bot_handle name different Bots");
    return byId ?? byHandle;
  }

  /** The Bot an unnamed invite shares or joins with. Compatibility order (owner decision 2026-10-29): the oldest
   *  active member Bot, then any other active non-home Bot, then the active FlyBot home — a home-only account keeps
   *  minting. A home Bot is still only ever shared when it is named. No active Bot at all is a 400. */
  private inviteBotFor(ownerId: string): any {
    const active = this.all("SELECT * FROM bots WHERE owner_id = ? AND status = 'active' ORDER BY created_at, id", ownerId);
    const bot = active.find((b: any) => b.integration_type === "flybot-member")
      ?? active.find((b: any) => b.integration_type !== "flybot-home")
      ?? active.find((b: any) => b.integration_type === "flybot-home");
    assert(bot, 400, "invalid_request", "you have no active member Bot: name one explicitly");
    return bot;
  }

  /** The same answer as `assertInvitable`, as a value: a caller that has to record the attempt first cannot throw,
   *  because a throw inside its transaction would roll the record back. */
  private invitableFailure(bot: any): { status: number; code: string; message: string } | null {
    if (bot.status === "active") return null;
    const frozen = bot.status === "frozen";
    return { status: 403, code: frozen ? "bot_frozen" : "bot_revoked",
      message: frozen ? "this bot is frozen (emergency stop)" : "this bot identity was revoked" };
  }

  /** A frozen or revoked Bot is handed out by no invite: the kill switch also closes links that name it, and the
   *  link is checked again when it is joined. A named Bot that exists but is down is a 403, not a 404.
   *  The same check guards the last write of an auto-accept invite, so a stop that happened while the card
   *  waited cannot be undone by approving it. */
  private assertInvitable(bot: any) {
    const failure = this.invitableFailure(bot);
    if (failure) throw new ApiError(failure.status, failure.code, failure.message);
  }

  /** Create an invite link. Owner-created invites are active at once (creating it is the owner's consent);
   *  bot-created invites (signed invite.create) need the owner's approval first. */
  createInvite(p: Principal, body: any) {
    let bot: any, payload: any, viaBot = false;
    if (p.kind === "bot") { const env = this.verifyEnvelope(p, body, "invite.create"); payload = env.payload ?? {}; bot = this.bot(p.botId); viaBot = true; }
    else {
      payload = ownerWriteBody(body);
      bot = this.namedOwnBot(p.ownerId, payload.bot_id, payload.bot_handle) ?? this.inviteBotFor(p.ownerId);
      this.assertInvitable(bot);
    }
    // #90: a revoked identity cannot hand itself out again — an invite for it would share a Bot that no longer answers.
    assert(bot.status === "active", 403, "bot_revoked", "this bot identity was revoked");
    // The invite message is free text the joiner's console renders, so it is stored only as a string: an object, an
    // array, a boolean or a number reached the INSERT as it arrived (500) or was coerced to text ("1.0"). Absent or
    // null still means "no message"; the empty string stays a legitimate message.
    assert(payload.message === undefined || payload.message === null || typeof payload.message === "string", 400, "invalid_request", "message must be a string");
    const offered = this.validCaps(payload.offered_capabilities ?? DEFAULT_CAPABILITIES);
    const requested = this.validCaps(payload.requested_capabilities ?? DEFAULT_CAPABILITIES);
    // max_uses is a count, so a body that is not a whole number of uses is refused rather than coerced. The old
    // Number(...) read stored 1.5 as REAL 1.5 and admitted ceil(1.5) = 2 joins — a link wider than the caller can
    // have meant. Absent or null keeps the 1-use default; a value over the 50 ceiling still clamps as before.
    if (payload.max_uses !== undefined && payload.max_uses !== null) {
      assert(typeof payload.max_uses === "number" && Number.isInteger(payload.max_uses) && payload.max_uses >= 1, 400, "invalid_request", "max_uses must be a positive integer");
    }
    const maxUses = Math.max(1, Math.min(payload.max_uses ?? 1, 50));
    // auto_accept decides whether a join skips the inviter's approval and writes its grants at once, so a body that
    // is not a boolean is refused rather than read as yes. The old read was `payload.auto_accept === false`, so only
    // the JSON literal `false` asked first: "false", "0", 0, {}, [] and a number all fell through to 1 and minted a
    // link that activated a relationship, wrote its grants and could rebuild a revoked one, with no approval in the
    // path. Absent or null keeps the auto-accept default; the literal false still asks the inviter's owner first.
    assert(payload.auto_accept === undefined || payload.auto_accept === null || typeof payload.auto_accept === "boolean", 400, "invalid_request", "auto_accept must be a boolean");
    const hours = Math.max(1, Math.min(Number(payload.expires_in_hours) || 72, 24 * 30));
    // A Bot-created invite writes an approval card, and writing a card is a delivery moment (see `requestGrant`): the
    // queue is settled before this door's own writes, so a card that lapsed while the batch waited is settled and its
    // outlet told, instead of being named in the summary as still waiting.
    if (viaBot) this.expireStale();
    const id = newId("inv");
    const code = randomBytes(9).toString("base64url").replace(/[-_]/g, "x");
    const status = viaBot ? "pending_owner" : "active";
    // Per-bot only: an invite for a home or Chief grants that one bot, never its members.
    const scope = "bot";
    this.run("INSERT INTO invites (id, code, bot_id, owner_id, created_by, offered_caps, requested_caps, message, auto_accept, max_uses, status, expires_at, created_at, scope) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      id, code, bot.id, bot.owner_id, viaBot ? `bot:${bot.id}` : `owner:${bot.owner_id}`, JSON.stringify(offered), JSON.stringify(requested), payload.message ?? null, payload.auto_accept === false ? 0 : 1, maxUses, status,
      new Date(Date.now() + hours * 3600e3).toISOString(), nowIso(), scope);
    let approval_id: string | undefined;
    if (viaBot) approval_id = this.createApproval(bot.owner_id, "invite", id, bot.id, null, `Your bot wants to create a friend invite link (grants to the joiner: ${offered.join(", ")})`, ["invite.requires_owner"], [], LIMITS.approvalTtlMs);
    this.audit.append(viaBot ? `bot:${bot.id}` : `owner:${bot.owner_id}`, "invite.created", id, [bot.owner_id], { offered, requested, max_uses: maxUses, status });
    return { ...this.inviteView(this.get("SELECT * FROM invites WHERE id = ?", id)), approval_id };
  }

  listInvites(p: Principal) {
    const rows = p.kind === "owner" ? this.all("SELECT * FROM invites WHERE owner_id = ? ORDER BY created_at DESC", p.ownerId) : this.all("SELECT * FROM invites WHERE bot_id = ? ORDER BY created_at DESC", p.botId);
    return rows.map((i) => this.inviteView(i));
  }

  revokeInvite(p: Principal, id: string) {
    const ownerId = this.requireOwner(p);
    const i = this.get("SELECT * FROM invites WHERE id = ? OR code = ?", id, id);
    assert(i && i.owner_id === ownerId, 404, "invite_not_found");
    this.run("UPDATE invites SET status = 'revoked' WHERE id = ?", i.id);
    // The card that was waiting on this invite is decided by the revoke: leaving it pending offers the owner an
    // Approve that can no longer mean anything (the decision path refuses a revoked invite). Same shape as the
    // other revokes: the record stays, settled, with the reason, and the Bot that asked hears it.
    this.cancelPendingFor("kind = 'invite' AND subject_id = ?", [i.id], "invite_revoked", { notify: true, actor: `owner:${ownerId}` });
    this.audit.append(`owner:${ownerId}`, "invite.revoked", i.id, [ownerId], {});
    return { invite_id: i.id, status: "revoked" };
  }

  /** Public preview of an invite (no secrets). */
  inviteInfo(code: string) {
    const i = this.get("SELECT * FROM invites WHERE code = ?", code);
    assert(i, 404, "invite_not_found");
    const v = this.inviteView(i);
    // A link names one Bot, and an emergency stop closes that Bot's reach until it is resumed. The preview is the
    // first door a leaked link knocks on, and `public/invite.html` renders exactly this `active` answer as "tell your
    // assistant to join" — so a live link answers what the join answers (`assertInvitable`) instead of advertising a
    // Bot that will refuse the stranger. The row is not touched: this is a state gate, not a withdrawal, and Resume
    // reopens the same link (#488's rule). A link that is already used, expired or revoked keeps its own answer,
    // which is the order `joinInvite` reads the two facts in as well.
    if (v.status === "active") this.assertInvitable(this.bot(i.bot_id));
    return { code: v.code, url: v.url, status: v.status, inviter: v.bot, offered_capabilities: v.offered_capabilities, requested_capabilities: v.requested_capabilities, message: v.message, expires_at: v.expires_at, server: this.publicBaseUrl };
  }

  /** Join via invite: creates the friend request from the joiner to the inviter's bot. */
  joinInvite(p: Principal, code: string, body: any) {
    let payload: any, joiner: any, viaBot = false;
    if (p.kind === "bot") { const env = this.verifyEnvelope(p, body, "invite.join"); payload = env.payload ?? {}; joiner = this.bot(p.botId); viaBot = true; }
    else {
      payload = ownerWriteBody(body);
      joiner = this.namedOwnBot(p.ownerId, payload.from_bot_id, payload.bot_handle, "from_bot_id", "bot_handle") ?? this.inviteBotFor(p.ownerId);
      this.assertInvitable(joiner);
    }
    // The code from the body overrides the one in the path and used to reach the invite lookup as it arrived:
    // an object, an array or a boolean answered 500. An absent or null code keeps the path's code.
    assert(payload?.code === undefined || payload?.code === null || typeof payload.code === "string", 400, "invalid_request", "code must be a string");
    code = payload.code ?? code;
    let i = this.get("SELECT * FROM invites WHERE code = ?", code);
    assert(i, 404, "invite_not_found");
    // Give back the use of any earlier pending join before reading this invite's status: the expired relationship may
    // have been the one use this 1-use link had. The lapsed join is found through this invite, and a lapsed request
    // between these two Bots must not answer relationship_exists either -- both scopes are this door's own business,
    // so a refused join settles nothing of another owner's. The link is read again after the settle: the use it gave
    // back is a column of this row, not of the copy read before it.
    this.expirePendingOnInvite(i.id);
    this.expirePendingBetween(joiner.id, i.bot_id);
    i = this.get("SELECT * FROM invites WHERE id = ?", i.id);
    const st = this.inviteStatus(i);
    assert(st === "active", 410, "invite_unavailable", `invite is ${st}`, { invite_status: st });
    const inviter = this.bot(i.bot_id);
    // A link minted before an emergency stop must not outlive it: both ends are checked at join time, before
    // anything is written. A frozen or revoked Bot at either end is a 403 and spends no use.
    this.assertInvitable(joiner);
    this.assertInvitable(inviter);
    assert(inviter.owner_id !== joiner.owner_id, 400, "invalid_request", "cannot join your own invite");
    const existing = this.pairRelationships(joiner.id, inviter.id);
    assert(!existing.some((r) => r.status === "blocked"), 403, "blocked", "relationship is blocked");
    const live = existing.find((r) => r.status === "active");
    // Re-share: already friends, but the inviter's access to this Bot was removed (declined by the joiner or revoked by the
    // inviter). A fresh owner-joined invite from the inviter (auto_accept) restores it instead of failing with relationship_exists.
    if (live && !viaBot && i.auto_accept && !this.hasLiveGrant(inviter.owner_id, joiner.id, live.id)) return this.regrantViaInvite(i, live, inviter, joiner, payload);
    const blocking = existing.find((r) => ["active", "pending_target", "pending_requester_owner"].includes(r.status));
    assert(!blocking, 409, "relationship_exists", "you are already connected to this Bot (or a request is pending)", { relationship_id: blocking?.id });
    // `payload.message` is free text the inviter's owner reads; an object or a boolean reached the INSERT as bindings
    // (a 500), and an array or a fraction was stored as text ("1.0", "1.5"). Absent or null still means "no message";
    // the empty string stays a legitimate message.
    assert(payload?.message === undefined || payload?.message === null || typeof payload.message === "string", 400, "invalid_request", "message must be a string");
    // The join message is outbound text another owner's Bot reads, so it takes the scan the message draft door runs;
    // only a `block` finding refuses, with that door's 422 verbatim. The refusal is settled here, before the row, its
    // audit line and its event exist and before the invite spends a use — the inviter's queue and the target Bot never
    // hear of a join that was not written. Approve-class findings (an email, a phone number) never blocked a draft and
    // do not block one here. An auto-accept regrant above stores no message, so it keeps its own path.
    const blocked = this.dlp(joiner.owner_id, { text: payload.message ?? "" }).filter((f) => f.action === "block");
    if (blocked.length) {
      throw new ApiError(422, "dlp_blocked", "outbound DLP blocked this draft", { categories: blocked.map((b) => b.category) });
    }
    const offered = this.validCaps(payload.offered_capabilities ?? J(i.requested_caps, DEFAULT_CAPABILITIES));
    // A Bot's join writes a card for its own owner, so this door opens a delivery moment before it writes: the queue is
    // settled first, so the announcement never counts a card its owner can no longer decide. Past every refusal above,
    // so a refused join opens no delivery moment.
    this.expireStale();
    const id = newId("rel");
    const status = viaBot ? "pending_requester_owner" : "pending_target";
    // Per-bot only. Legacy invite.scope / home endpoints are recorded as 'bot' and never cover members.
    const targetScope = "bot";
    const requesterScope = "bot";
    // #30: the relationship, the invite use and (for an auto-accept invite) every grant are written in one
    // transaction, and only then announced, so a join is never confirmed before its grants are durable.
    const autoAccept = this.db.transaction(() => {
      this.run(`INSERT INTO relationships (id, requester_bot, target_bot, requester_owner, target_owner, status, message, requested_caps, offered_caps, created_at, updated_at, expires_at, requester_scope, target_scope)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, joiner.id, inviter.id, joiner.owner_id, inviter.owner_id, status, payload.message ?? `Joined via invite link`, i.offered_caps, JSON.stringify(offered), nowIso(), nowIso(), new Date(Date.now() + LIMITS.relationshipRequestTtlMs).toISOString(), requesterScope, targetScope);
      this.run("INSERT INTO relationship_invites (relationship_id, invite_id) VALUES (?,?)", id, i.id);
      this.run("UPDATE invites SET uses = uses + 1 WHERE id = ?", i.id);
      return viaBot ? null : this.autoAcceptSpecs(id);
    })();
    this.audit.append(viaBot ? `bot:${joiner.id}` : `owner:${joiner.owner_id}`, "invite.joined", i.id, [joiner.owner_id, inviter.owner_id], { relationship_id: id, offered });
    let approval_id: string | undefined;
    if (viaBot) approval_id = this.createApproval(joiner.owner_id, "relationship_request", id, joiner.id, null, `Your bot wants to befriend @${inviter.handle} via invite (you grant: ${offered.join(", ")})`, ["relationship.requires_owner", "invite"], [], LIMITS.relationshipRequestTtlMs);
    else if (autoAccept) this.announceActivation(this.get("SELECT * FROM relationships WHERE id = ?", id), autoAccept.specs, autoAccept.actor);
    else this.notifyTarget(id);
    const r = this.get("SELECT status FROM relationships WHERE id = ?", id);
    const active = r.status === "active";
    return { relationship_id: id, status: r.status, approval_id, inviter: this.publicBot(inviter), joined_as: { bot_id: joiner.id, handle: "@" + joiner.handle }, awaiting: active ? null : r.status === "pending_requester_owner" ? "your_owner_approval" : "inviter_owner_consent", ...(active ? { grants_ready: true, grants: this.grantSummary(id) } : {}) };
  }

  /** Does `grantorOwner` still share its Bot with `granteeBot` on this relationship (an unexpired, active relationship-level
   *  grant, and not reply-only access)? A reply-only join grant (#23) is not a share: a fresh invite for that Bot shares it. */
  private hasLiveGrant(grantorOwner: string, granteeBot: string, relId: string): boolean {
    const live = this.all("SELECT * FROM grants WHERE relationship_id = ? AND grantor_owner = ? AND grantee_bot = ? AND status = 'active' AND room_id IS NULL", relId, grantorOwner, granteeBot)
      .some((g: any) => !g.expires_at || Date.parse(g.expires_at) >= Date.now());
    return live && !this.replyOnlyAccess(relId, grantorOwner, granteeBot);
  }

  private regrantViaInvite(i: any, rel: any, inviter: any, joiner: any, payload: any) {
    // The regrant writes the same grants a first join would, so the same kill-switch rule applies to both ends.
    this.assertInvitable(joiner);
    this.assertInvitable(inviter);
    const offered = this.validCaps(payload.offered_capabilities ?? J(i.requested_caps, DEFAULT_CAPABILITIES));
    const actor = `owner:${i.owner_id}(invite:${i.id})`;
    this.db.transaction(() => {
      this.run("UPDATE invites SET uses = uses + 1 WHERE id = ?", i.id);
      this.run("INSERT OR IGNORE INTO relationship_invites (relationship_id, invite_id) VALUES (?,?)", rel.id, i.id);
      const fbScope = { window_days: 14, hours: "09:00-18:00" };
      // inviter owner -> joiner bot: the same bundle a fresh friendship would give
      for (const c of new Set<string>([...DEFAULT_CAPABILITIES, ...J(i.offered_caps, [])])) this.insertGrant(rel.id, inviter.owner_id, joiner.id, c, c === "calendar.freebusy.read" ? fbScope : {}, undefined, actor);
      // joiner owner -> inviter bot: add only what is missing; never replaces grants the joiner already holds.
      // What a join adds on the joiner's side is reply-only (#23), as on a first join.
      for (const c of new Set<string>([...DEFAULT_CAPABILITIES, ...offered])) {
        if (!this.findGrant(joiner.owner_id, inviter.id, c, joiner.id)) this.insertGrant(rel.id, joiner.owner_id, inviter.id, c, c === "calendar.freebusy.read" ? fbScope : {}, undefined, `owner:${joiner.owner_id}`, { replyOnly: true });
      }
    })();
    this.audit.append(`owner:${joiner.owner_id}`, "invite.joined", i.id, [joiner.owner_id, inviter.owner_id], { relationship_id: rel.id, regrant: true, offered });
    for (const b of [inviter.id, joiner.id]) this.emit(b, "grant.changed", { relationship_id: rel.id, status: "granted", granted_bot: inviter.id, grantee_bot: joiner.id });
    return { relationship_id: rel.id, status: "active", approval_id: undefined, inviter: this.publicBot(inviter), joined_as: { bot_id: joiner.id, handle: "@" + joiner.handle }, awaiting: null, regranted: true };
  }

  /** A join that never became a friendship (requester owner rejected / request expired) must give its
   *  invite slot back; otherwise a 1-use invite reads "used" while no relationship exists. */
  private releaseInviteUse(relId: string) {
    const link = this.get("SELECT invite_id FROM relationship_invites WHERE relationship_id = ?", relId);
    if (link) this.run("UPDATE invites SET uses = MAX(uses - 1, 0) WHERE id = ?", link.invite_id);
  }

  /** If the relationship came from an auto-accept invite, the inviter owner already consented: activate it. */
  private maybeAutoAcceptInvite(relId: string): boolean {
    const accepted = this.autoAcceptSpecs(relId);
    if (!accepted) return false;
    this.announceActivation(this.get("SELECT * FROM relationships WHERE id = ?", relId), accepted.specs, accepted.actor);
    return true;
  }

  /** Writes (grants first, #30) the activation of an auto-accept invite's relationship without announcing it; the
   *  caller announces once its own transaction has committed. Null when the invite does not auto-accept. */
  private autoAcceptSpecs(relId: string): { specs: { capability: string }[]; actor: string } | null {
    const link = this.get("SELECT i.* FROM relationship_invites ri JOIN invites i ON i.id = ri.invite_id WHERE ri.relationship_id = ?", relId);
    if (!link || !link.auto_accept || link.status === "revoked" || link.status === "pending_owner") return null;
    const r = this.get("SELECT * FROM relationships WHERE id = ?", relId);
    if (r.status !== "pending_target") return null;
    // The one place an auto-accept invite writes grants: both ends are checked here, before writeActivation, so a
    // stop that happened while the card waited cannot be undone by approving it. A refusal leaves the card pending.
    this.assertInvitable(this.bot(r.requester_bot));
    this.assertInvitable(this.bot(r.target_bot));
    const specs = J(link.offered_caps, []).map((c: string) => ({ capability: c }));
    const actor = `owner:${link.owner_id}(invite:${link.id})`;
    this.writeActivation(r, specs, actor);
    return { specs, actor };
  }

  /** Per-bot friend overview for the /friends page. Owners may view any of their own bots; a bot only itself. */
  friendsOverview(p: Principal, botId?: string) {
    let bots: any[];
    if (p.kind === "bot") bots = [this.bot(p.botId)];
    else bots = this.all("SELECT * FROM bots WHERE owner_id = ? ORDER BY created_at", p.ownerId);
    const selected = botId ? bots.find((b) => b.id === botId) ?? pickByHandle(bots, botId) : bots[0];
    if (botId && !selected) throw new ApiError(403, "forbidden", "not your bot");
    const list = bots.map((b) => ({ bot_id: b.id, handle: "@" + b.handle, display_name: peerBotName(b), ...lookOf(b), status: b.status }));
    if (!selected) return { bots: list, bot: null, friends: [], pending_incoming: [], pending_outgoing: [], others: [] };
    this.expireStale();
    const rows = this.all("SELECT * FROM relationships WHERE (requester_bot = ? OR target_bot = ?) AND status != 'room' ORDER BY updated_at DESC", selected.id, selected.id);
    const items = rows.map((r) => {
      const outgoing = r.requester_bot === selected.id;
      const peerId = outgoing ? r.target_bot : r.requester_bot;
      // The overview is the one read that keeps a lapsed grant: the owner must see it ended and be able to renew it
      // from the card. `/v1/relationships` (and every reach check) keeps the default read, which drops it.
      const grants = this.grantsFor(r.id, { includeExpired: true });
      // `expires_at` is read for the computed state only: it is never handed to the client here.
      const convs = this.all("SELECT id, status, outcome, intent, turn_count, max_turns, created_at, updated_at, expires_at FROM conversations WHERE relationship_id = ? ORDER BY updated_at DESC", r.id);
      const lastMsg = this.get("SELECT MAX(COALESCE(delivered_at, created_at)) t FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE relationship_id = ?)", r.id)?.t ?? null;
      const last = convs[0];
      const times = [r.updated_at, last?.updated_at, lastMsg].filter(Boolean).sort();
      return {
        relationship_id: r.id, status: r.status, direction: outgoing ? "outgoing" : "incoming", side: outgoing ? "joiner" : "inviter",
        peer: this.botCard(this.bot(peerId), r.status === "active"),
        connected_at: r.status === "active" || r.status === "revoked" || r.status === "blocked" ? r.updated_at : null,
        requested_at: r.created_at, expires_at: r.expires_at, message: r.message, requested_capabilities: J(r.requested_caps, []), offered_capabilities: J(r.offered_caps, []), settings: this.settingsFor(r.id, selected.owner_id), blocked_by_me: !!r.blocked_by && r.blocked_by === selected.owner_id,
        capabilities: {
          granted_to_peer: grants.filter((g) => g.grantee_bot === peerId).map((g) => ({ capability: g.capability, scope: g.scope, expires_at: g.expires_at, status: g.status })),
          granted_to_me: grants.filter((g) => g.grantee_bot === selected.id).map((g) => ({ capability: g.capability, scope: g.scope, expires_at: g.expires_at, status: g.status })),
        },
        conversation_count: convs.length,
        last_conversation: last ? { conversation_id: last.id, ...this.reportedConvState(last), intent: J(last.intent).type, summary: J(last.intent).summary, turn: { count: last.turn_count, max: null }, updated_at: last.updated_at } : null,
        last_activity_at: times[times.length - 1] ?? null,
      };
    });
    return {
      bots: list, bot: { bot_id: selected.id, handle: "@" + selected.handle, display_name: peerBotName(selected), ...lookOf(selected), status: selected.status, owner_display_name: peerOwnerName(this.owner(selected.owner_id)) },
      friends: items.filter((i) => i.status === "active"),
      pending_incoming: items.filter((i) => i.direction === "incoming" && ["pending_target", "pending_requester_owner"].includes(i.status)),
      pending_outgoing: items.filter((i) => i.direction === "outgoing" && ["pending_target", "pending_requester_owner"].includes(i.status)),
      others: items.filter((i) => ["blocked", "revoked", "declined", "expired", "cancelled"].includes(i.status) && !(i.status === "none")),
    };
  }

  listFriends(p: Principal) {
    return this.listRelationships(p).filter((r) => r.status === "active");
  }

  profile(p: Principal, botId: string) {
    const target = this.bot(botId);
    if (p.kind === "bot" && p.botId !== botId) {
      this.activeRelationship(p.botId, botId);
      assert(this.findGrant(target.owner_id, p.botId, "profile.read", target.id), 403, "capability_not_granted", "profile.read not granted", { suggestion: "request_grant" });
    }
    if (p.kind === "owner" && target.owner_id !== p.ownerId) {
      const mine = this.all("SELECT id FROM bots WHERE owner_id = ? AND status = 'active'", p.ownerId);
      assert(mine.some((m: any) => this.findActiveRelationship(m.id, target.id) && this.findGrant(target.owner_id, m.id, "profile.read", target.id)), 404, "bot_not_found", "no such bot");
    }
    const o = this.owner(target.owner_id);
    return { ...this.botCard(target, true), owner_timezone: o.timezone };
  }

  // ================================================================ approvals
  private createApproval(ownerId: string, kind: string, subjectId: string, botId: string | null, convId: string | null, summary: string, reasons: string[], riskFlags: unknown[], ttlMs: number, extra?: unknown, holdReason: HoldReason | null = null) {
    const id = newId("apr");
    this.run("INSERT INTO approvals (id, owner_id, kind, subject_id, bot_id, conversation_id, summary, reasons, risk_flags, hold_reason, created_at, expires_at, note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      id, ownerId, kind, subjectId, botId, convId, summary, JSON.stringify(reasons), JSON.stringify(riskFlags), holdReason, nowIso(), new Date(Date.now() + ttlMs).toISOString(), extra ? JSON.stringify(extra) : null);
    // #139 ② C: a card that waits only in the database is invisible until someone opens a page. Tell the owner
    // through the Bot they designated, at the one place every card is created.
    this.notifyOwnerOfApproval(id);
    return id;
  }

  /**
   * #139 ② C: announce one waiting card to the owner's designated Bot. Delivery is that Bot's existing webhook,
   * so the owner needs no page open and the platform needs no mail or push service. The event carries no text: the
   * card id, its kind, how many cards wait and when this one expires. One ledger row per card makes a second
   * announcement (a retried or replayed path) a no-op.
   *
   * Quiet hours: inside the owner's window the row is still written (that is what makes the announcement once-only)
   * but nothing is emitted; the cards it holds leave together as one summary at the first delivery moment after the
   * window ends (`announceHeldApprovals`), so a night of cards wakes the Bot once instead of once per card.
   */
  notifyOwnerOfApproval(approvalId: string): boolean {
    const a = this.get("SELECT a.id, a.owner_id, a.kind, a.expires_at, o.notify_bot_id, o.timezone, o.quiet_start, o.quiet_end FROM approvals a JOIN owners o ON o.id = a.owner_id WHERE a.id = ?", approvalId);
    if (!a?.notify_bot_id) return false;
    // Defense in depth: a setting written before the revocation checks above can still name a revoked identity.
    // Its queue is refused (#177 ③), so an announcement there would be write-only. A frozen outlet is fine: the
    // queue is read again after resume.
    const outlet = this.get("SELECT status FROM bots WHERE id = ?", a.notify_bot_id);
    if (!outlet || outlet.status === "revoked") return false;
    const quiet = this.inQuietHours(a);
    // Outside the window the cards held overnight go out first, as one summary, so the new card's own event is not
    // folded into a batch the Bot already heard about.
    if (!quiet) this.announceHeldApprovals(a.owner_id, a.notify_bot_id);
    const ins = this.run(
      "INSERT OR IGNORE INTO approval_notifications (approval_id, owner_id, bot_id, created_at, delivered_at) VALUES (?,?,?,?,?)",
      a.id, a.owner_id, a.notify_bot_id, nowIso(), quiet ? null : nowIso(),
    );
    if (!ins.changes) return false;
    if (quiet) return false;
    const pending_count = this.get("SELECT COUNT(*) n FROM approvals WHERE owner_id = ? AND status = 'pending'", a.owner_id).n;
    this.emit(a.notify_bot_id, "approval.created", { approval_id: a.id, kind: a.kind, pending_count, expires_at: a.expires_at });
    return true;
  }

  /** The owner's wall clock now, as `HH:MM`, read in their own zone; a legacy zone Intl refuses reads as UTC. */
  private ownerClock(o: { timezone?: string | null }): string {
    const fmt = (zone: string) => new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hour12: false });
    try { return fmt(o.timezone || "Asia/Shanghai").format(new Date(this.nowMs())); }
    catch { return fmt("UTC").format(new Date(this.nowMs())); }
  }

  /** Is the owner's quiet window open? The window is `[start, end)` and may cross midnight (22:00–07:00 means the
   *  evening and the night, not the day between); an unset pair is no window. */
  private inQuietHours(o: { timezone?: string | null; quiet_start?: string | null; quiet_end?: string | null }): boolean {
    if (!o.quiet_start || !o.quiet_end || o.quiet_start === o.quiet_end) return false;
    const now = this.ownerClock(o);
    return o.quiet_start < o.quiet_end
      ? now >= o.quiet_start && now < o.quiet_end
      : now >= o.quiet_start || now < o.quiet_end;
  }

  /** One summary for every card that waited through quiet hours, then mark the batch delivered so the same cards are
   *  never announced twice. The summary names the count and the few earliest cards, never their text.
   *
   *  The batch belongs to the owner, not to the Bot that happened to be the outlet when each card was written: the
   *  owner may switch outlets while the batch waits (the ledger row keeps the old `bot_id` as the record of that
   *  moment), and a per-outlet query then looked for the batch under a Bot nobody consults again — the cards waited
   *  forever, past the promise that they leave when the window ends (#423). Read the batch by owner and send it to
   *  the outlet of the moment; one owner has one outlet, so two of a home's Bots cannot swallow each other's cards. */
  private announceHeldApprovals(ownerId: string, botId: string): boolean {
    const outlet = this.get("SELECT status FROM bots WHERE id = ?", botId);
    if (!outlet || outlet.status === "revoked") return false;
    // The ledger records the outlet a card was written for; whether the card still waits is the queue's question,
    // asked now. A card settled during the night (approved, rejected, expired, cancelled) is not named in the
    // summary, and its line is not marked delivered: the ledger keeps the record, the queue says what is waiting.
    const held = this.all("SELECT n.approval_id FROM approval_notifications n JOIN approvals a ON a.id = n.approval_id WHERE n.owner_id = ? AND n.delivered_at IS NULL AND a.status = 'pending' ORDER BY n.rowid ASC", ownerId);
    if (!held.length) return false;
    const pending_count = this.get("SELECT COUNT(*) n FROM approvals WHERE owner_id = ? AND status = 'pending'", ownerId).n;
    this.emit(botId, "approval.digest", { count: held.length, approval_ids: held.slice(0, 5).map((r: any) => r.approval_id), pending_count });
    this.run("UPDATE approval_notifications SET delivered_at = ? WHERE owner_id = ? AND delivered_at IS NULL AND EXISTS (SELECT 1 FROM approvals a WHERE a.id = approval_notifications.approval_id AND a.status = 'pending')", nowIso(), ownerId);
    return true;
  }

  /** The delivery moment the platform owns. Quiet hours postpone an announcement, but nothing in the account has to
   *  move for the batch to leave: a window that ends while the owner sleeps must still wake the outlet once. Every
   *  existing delivery moment is somebody else's action (a card written outside the window, the queue opened), so an
   *  owner who touches nothing after the night never hears the batch. Walk the undelivered ledger rows by owner and
   *  let each batch go through `announceHeldApprovals`, which is idempotent: an open window leaves the batch where it
   *  is, and a batch already announced has no undelivered row left to send. Returns how many batches left.
   *  Caller: the hourly tick in `src/main.ts`. It must never take that timer down. */
  flushHeldApprovals(): number {
    // The batch is a delivery moment, so it is also the moment a card that died during the night settles. A summary
    // names only cards that still wait, and a card settled here is announced by `expireApproval`, which closes its
    // ledger line with that decision. Skipping the sweep let the digest name a card past its own deadline and close
    // its ledger line, so the outlet was told the card still needed the owner and never heard it settle.
    this.expireStale();
    let delivered = 0;
    const waiting = this.all("SELECT DISTINCT owner_id FROM approval_notifications WHERE delivered_at IS NULL");
    for (const r of waiting) {
      const o = this.get("SELECT id, notify_bot_id, timezone, quiet_start, quiet_end FROM owners WHERE id = ?", r.owner_id);
      if (!o?.notify_bot_id || this.inQuietHours(o)) continue;
      if (this.announceHeldApprovals(o.id, o.notify_bot_id)) delivered++;
    }
    return delivered;
  }

  /** Every door that ends a share settles the cards that share was holding: the lines a Bot already wrote toward the
   *  other side, and its drafts of actions there. Only a share that carried `chat.public` held any of them, a room
   *  thread is the room's business, and an invite acceptance keeps its draft (the peer's answer outlives the chat).
   *  The reason is the door's: a revoke or a decline takes the share back (`grant_revoked`), and a share that ran out
   *  of time lapsed (`grant_expired`) — the owner's card and the drafting Bot read the word for what happened. */
  private settleCardsForEndedShare(grants: any[], reason = "grant_revoked", actor = "platform") {
    for (const g of grants) {
      if (g.capability !== "chat.public" || g.room_id) continue;
      const granted = this.grantedBotOf(g);
      if (!granted) continue;
      this.cancelPendingFor(
        `kind IN ('outbound_message', 'action') AND bot_id = ? AND conversation_id IN (
           SELECT c.id FROM conversations c JOIN relationships cr ON cr.id = c.relationship_id
           WHERE c.relationship_id = ? AND cr.status != 'room'
             AND NOT EXISTS (SELECT 1 FROM grants rg WHERE rg.relationship_id = c.relationship_id AND rg.room_id IS NOT NULL)
             AND ((c.initiator_bot = ? AND c.peer_bot = ?) OR (c.initiator_bot = ? AND c.peer_bot = ?)))`,
        [g.grantee_bot, g.relationship_id, g.grantee_bot, granted, granted, g.grantee_bot],
        reason,
        {
          keep: { where: "NOT (kind = 'action' AND subject_id IN (SELECT id FROM actions WHERE action_type = 'calendar.accept_invite'))", args: [] },
          notify: true,
          actor,
        },
      );
    }
  }

  /** Is this card held on a share that no longer exists, a line or an action alike? Read from the rows now, so a card
   *  an older build left pending (or one held while the share ended) is judged by the same rule. */
  private heldCardShareGone(a: any): boolean {
    if (!["outbound_message", "action"].includes(a.kind) || !a.conversation_id) return false;
    const m = a.kind === "outbound_message" ? this.get("SELECT * FROM messages WHERE id = ?", a.subject_id) : null;
    if (a.kind === "outbound_message" && !m) return false;
    const x = a.kind === "action" ? this.get("SELECT * FROM actions WHERE id = ?", a.subject_id) : null;
    if (a.kind === "action" && !x) return false;
    // The invitee's answer to a booking is not a line this share was carrying: the booking outlives the chat it was
    // made in, so the accept stays decidable after the chat share ends.
    if (x?.action_type === "calendar.accept_invite") return false;
    const c = this.get("SELECT * FROM conversations WHERE id = ?", m ? m.conversation_id : a.conversation_id);
    const rel = c ? this.get("SELECT * FROM relationships WHERE id = ?", c.relationship_id) : null;
    // A room thread is the room's business: its own door says "the room grant is gone", not this share. Read the room
    // off the grants that made it, because the relationship stops being a room when the seat ends.
    if (!c || rel?.status === "room") return false;
    if (this.get("SELECT 1 FROM grants WHERE relationship_id = ? AND room_id IS NOT NULL LIMIT 1", c.relationship_id)) return false;
    const sender = m ? this.bot(m.sender_bot) : this.bot(x.actor_bot);
    const recipient = m ? this.bot(m.recipient_bot) : this.bot(c.initiator_bot === sender.id ? c.peer_bot : c.initiator_bot);
    return !this.findGrant(recipient.owner_id, sender.id, "chat.public", recipient.id);
  }

  private cancelPendingFor(where: string, args: unknown[], reason: string, opts: { keep?: { where: string; args: unknown[] }; notify?: boolean; actor?: string } = {}) {
    // Who the line credits: the owner whose own door settled the card, or the platform when a clock or a cascade
    // did — the same actor the door's other records carry, and `platform` the way `approval.expired` is written.
    const actor = opts.actor ?? "platform";
    // Which Bots this sweep already tells: the outlet may be one of them, and one Bot must hear one decision.
    const told = new Set<string>();
    // `keep` is one extra condition on the rows to cancel: a row it excludes (the caller spells that as a NOT) keeps
    // both its pending status and the side effect on its subject row, so the card stays decidable.
    const keepSql = opts.keep ? ` AND ${opts.keep.where}` : "";
    const keepArgs = opts.keep ? opts.keep.args : [];
    for (const a of this.all(`SELECT * FROM approvals WHERE status = 'pending' AND ${where}${keepSql}`, ...args, ...keepArgs)) {
      // One card is one settlement: a refused write rolls this card back whole, so no card is left `cancelled`
      // beside a subject row that still waits, and no audit line or event describes a cancellation that never
      // happened.
      const settle = () => {
        this.run("UPDATE approvals SET status = 'cancelled', decision = ?, decided_at = ? WHERE id = ?", reason, nowIso(), a.id);
        // The card entered the chain when it was drafted, and two of its three ends name it there: a decision writes
        // `approval.decided` and the clock writes `approval.expired`. This end wrote nothing, so an owner's own page
        // read the draft and then stopped. The line belongs to the settlement, not to the announcement: the call sites
        // that deliberately tell nobody still leave it, and on those it is the only trace there is.
        this.audit.append(actor, "approval.cancelled", a.id, [a.owner_id], { kind: a.kind, subject_id: a.subject_id, reason });
        if (a.kind === "outbound_message") {
          this.run("UPDATE messages SET status = 'cancelled' WHERE id = ?", a.subject_id);
          // The line dies with the card; the files it held at draft time never reached the peer, so they are free.
          this.freeDraftAttachments(a.subject_id);
        }
        if (a.kind === "action") this.run("UPDATE actions SET status = 'cancelled' WHERE id = ?", a.subject_id);
        if (a.kind === "face_room_message") this.run("UPDATE face_room_drafts SET status = 'cancelled' WHERE id = ?", a.subject_id);
        // A Bot-created invite waits at status `pending_owner` for this card, so settling only the card leaves a link
        // nobody can use: the owner's list keeps offering it, the decision door answers 409 and the join door reports
        // `pending_owner` until its own 72h clock. `expireApproval` settles the same two rows for the same reason; the
        // guard keeps an invite the owner already approved (or one the Bot itself revoked) out of the sweep.
        if (a.kind === "invite") this.run("UPDATE invites SET status = 'expired' WHERE id = ? AND status = 'pending_owner'", a.subject_id);
        // A Bot-created friend request waits at `pending_requester_owner` for this card, so settling only the card
        // leaves the pair unreachable: no door decides a cancelled card, so only the 7-day TTL in `expireStale` would
        // ever move the row, and every later request to the same peer answers `relationship_exists` until then — the
        // stop locks the pair out for a week by itself. `expireApproval` settles the same row for the same reason; the
        // guard keeps a request the owner already approved (or one a block/unfriend settled) out of the sweep, and
        // `updated_at` is written so a row settled here has the same shape as one `expireStale` settles.
        if (a.kind === "relationship_request") {
          // A join that never became a friendship gives its invite slot back and names its end, exactly as a declined
          // consent, a rejected approval and the expiry sweep do (the invariant is written over `releaseInviteUse`).
          // This end — the stop, a removed home member, a block — flipped the row and did neither, so the link read
          // "used" for a relationship that never existed: for a 1-use link that was the link, permanently.
          // The row's own pending check is read rather than assumed: `endRelationship` (Remove/Block) writes this row
          // to `revoked` before it cancels the cards hanging off it, and gives the use back itself, so a refund here
          // would pay twice — a free join on a `max_uses` link — and an `expired` line would name a row that ended
          // another way. Both writes ride the settlement's transaction, so a refusal takes them back whole.
          const moved = this.run("UPDATE relationships SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending_requester_owner'", nowIso(), a.subject_id).changes;
          if (moved) {
            const rel = this.get("SELECT requester_owner, target_owner FROM relationships WHERE id = ?", a.subject_id);
            this.releaseInviteUse(a.subject_id);
            this.audit.append(actor, "relationship.expired", a.subject_id, [rel.requester_owner, rel.target_owner], {});
          }
        }
        // A cancelled room line names its room, as its approved, rejected and expired decisions do: the Bot reads the
        // room off the event, and it can hold the same kind of line in more than one room.
        const roomId = a.kind === "face_room_message"
          ? this.get("SELECT room_id FROM face_room_drafts WHERE id = ?", a.subject_id)?.room_id
          : undefined;
        // A cancelled card is not pending any more: the chat it was holding must stop saying it waits for one.
        if (a.conversation_id) this.refreshConversationStatus(a.conversation_id);
        // A cancelled card is never silent: the Bot that owned it hears the outcome and the reason it can show.
        if (opts.notify && a.bot_id) {
          told.add(a.bot_id);
          this.emit(a.bot_id, "approval.decided", {
            approval_id: a.id, kind: a.kind, decision: "cancelled", reason,
            ...(a.kind === "outbound_message" || a.kind === "face_room_message" ? { message_id: a.subject_id } : {}),
            ...(roomId ? { room_id: roomId } : {}),
            ...(a.kind === "action" ? { action_id: a.subject_id } : {}),
            ...(a.kind === "invite" ? { invite_id: a.subject_id } : {}),
            // These two kinds carry the relationship in subject_id; without it the Bot cannot tell which relationship
            // the cancelled card belonged to (the expiry path in `expireApproval` already sends it).
            ...(a.kind === "relationship_request" || a.kind === "grant_request" ? { relationship_id: a.subject_id } : {}),
          });
        }
        // The same settlement reaches the owner's designated outlet: quiet hours hold a card that still waits, and the
        // batch only ever names cards that still wait, so a card cancelled in the night is silence for good. Only the
        // call sites that opt into `notify` announce it; the silent ones keep their ledger line undelivered on purpose.
        if (opts.notify) this.tellSettledCardToOutlet(a, told, "cancelled", reason);
      };
      // A caller that already opened a transaction (the stop, a block) owns the commit, so this adds none: an inner
      // `atomically` would hand its pushes over before the outer commit, the shape #702 fixed. On its own - a
      // revoke, a close, a lapse - the card gets a transaction of its own, one card at a time, never the sweep.
      if (this.db.inTransaction) settle(); else this.atomically(settle);
}
  }

  private expireApproval(a: any) {
    // One card is one write: the card and the row it holds are settled together, so a store that refuses the second
    // write must not leave the first behind (the torn-write shape of #516, read at the settle end). `atomically`, not
    // a plain transaction: the settlement is announced through `emit`, and a push naming a decision the rollback
    // takes back would tell the Bot about a settlement that is in no table.
    this.atomically(() => {
      this.run("UPDATE approvals SET status = 'expired', decided_at = ? WHERE id = ?", nowIso(), a.id);
      // Which Bots this settlement already tells: the outlet may be one of them, and one Bot must hear one decision.
      const told = new Set<string>();
      const tell = (botId: string, data: Record<string, unknown>) => { told.add(botId); this.emit(botId, "approval.decided", data); };
      if (a.kind === "outbound_message") {
        this.run("UPDATE messages SET status = 'expired' WHERE id = ?", a.subject_id);
        // Same as a rejection: the line never went out, so the files it held are not "already sent".
        this.freeDraftAttachments(a.subject_id);
        const m = this.get("SELECT * FROM messages WHERE id = ?", a.subject_id);
        if (m) {
          // An expired draft is settled like a rejected one (`rejectMessage`): the peer never sees it and is not told.
          // It never received the line, so there is nothing for it to act on, and its queue and webhook stay quiet.
          tell(m.sender_bot, { approval_id: a.id, kind: a.kind, message_id: m.id, decision: "expired" });
        }
      }
      if (a.kind === "action") {
        this.run("UPDATE actions SET status = 'expired' WHERE id = ?", a.subject_id);
        tell(a.bot_id, { approval_id: a.id, kind: a.kind, action_id: a.subject_id, decision: "expired" });
      }
      if (a.kind === "face_room_message") {
        this.run("UPDATE face_room_drafts SET status = 'expired' WHERE id = ?", a.subject_id);
        const d = this.get("SELECT * FROM face_room_drafts WHERE id = ?", a.subject_id);
        if (d) tell(d.sender_bot, { approval_id: a.id, kind: a.kind, message_id: d.id, room_id: d.room_id, decision: "expired" });
      }
      if (a.kind === "grant_request") {
        // The request exists only as this approval: the grant row is created when the owner approves, so there is
        // nothing else to sweep. Without this branch the card simply left the owner's pending list and the Bot that
        // asked for the capability was never told; the peer owner is not the addressee (same as the invite, #104).
        tell(a.bot_id, { approval_id: a.id, kind: a.kind, relationship_id: a.subject_id, decision: "expired" });
      }
      if (a.kind === "invite") {
        // A Bot-created invite waits at status pending_owner for this approval. Expiring only the approval row left
        // the link stuck: decide answered 409, the joining side read 410 pending_owner, and the Bot heard nothing.
        // Only a still-waiting invite is expired, so an invite approved earlier is never flipped by a later sweep.
        this.run("UPDATE invites SET status = 'expired' WHERE id = ? AND status = 'pending_owner'", a.subject_id);
        tell(a.bot_id, { approval_id: a.id, kind: a.kind, invite_id: a.subject_id, decision: "expired" });
      }
      if (a.kind === "relationship_request") {
        // The relationship row is the business object: `expireStale` flips it before working the approvals, so this
        // branch must not touch any row — it only tells the Bot that asked. Without it the card left the owner's list
        // and the Bot sat in "waiting for my owner" with nothing to read (same shape as #104's invite, P19's grant
        // request). The peer Bot is not the addressee: the requester's owner owns this decision.
        tell(a.bot_id, { approval_id: a.id, kind: a.kind, relationship_id: a.subject_id, decision: "expired" });
      }
      this.tellSettledCardToOutlet(a, told);
      if (a.conversation_id) this.refreshConversationStatus(a.conversation_id);
      this.audit.append("platform", "approval.expired", a.id, [a.owner_id], { kind: a.kind, subject_id: a.subject_id });
    });
  }

  /** A card that waited through quiet hours and settled before the window ended was announced to nobody: the held batch
   *  names only cards that still wait, so a delivery moment that will never name it is silence for good (a 4h card
   *  inside a 9h night). A decision is not an announcement the window may postpone, so the outlet hears it once here.
   *  Both settlements that can take a waiting card out of the batch come through here: an expiry (`decision`
   *  `expired`) and a cancellation (`decision` `cancelled`, with the same `reason` the drafting Bot reads).
   *  The ledger line is settled in the same breath: a row that keeps saying "never delivered" for a card the outlet was
   *  told about cannot be told apart from the defect this fixes. An owner who cleared the outlet, or whose outlet was
   *  revoked, cannot be told at all; the line then stays undelivered as the record of the announcement never made. */
  private tellSettledCardToOutlet(a: any, told: Set<string>, decision = "expired", reason?: string) {
    const held = this.get("SELECT bot_id FROM approval_notifications WHERE approval_id = ? AND delivered_at IS NULL", a.id);
    if (!held) return;
    const outletId = this.get("SELECT notify_bot_id FROM owners WHERE id = ?", a.owner_id)?.notify_bot_id;
    if (!outletId) return;
    const outlet = this.get("SELECT status FROM bots WHERE id = ?", outletId);
    if (!outlet || outlet.status === "revoked") return;
    if (!told.has(outletId)) this.emit(outletId, "approval.decided", { approval_id: a.id, kind: a.kind, decision, ...(reason ? { reason } : {}) });
    this.run("UPDATE approval_notifications SET delivered_at = ? WHERE approval_id = ? AND delivered_at IS NULL", nowIso(), a.id);
  }

  listApprovals(p: Principal, status = "pending") {
    const ownerId = this.requireOwner(p);
    this.expireStale();
    // Opening the queue is a delivery moment too: a batch held through quiet hours goes out here once the window is
    // over, so the Bot hears about it without waiting for the next card to be created.
    const o = this.owner(ownerId);
    if (o.notify_bot_id && !this.inQuietHours(o)) this.announceHeldApprovals(ownerId, o.notify_bot_id);
    const rows = status === "all" ? this.all("SELECT * FROM approvals WHERE owner_id = ? ORDER BY created_at DESC", ownerId) : this.all("SELECT * FROM approvals WHERE owner_id = ? AND status = ? ORDER BY created_at ASC", ownerId, status);
    return rows.map((a) => this.approvalCard(a));
  }

  private approvalCard(a: any) {
    const card: any = { approval_id: a.id, kind: a.kind, status: a.status, decision: a.decision, summary: a.summary, reasons: J(a.reasons, []), risk_flags: J(a.risk_flags, []), ...(a.hold_reason ? { hold_reason: a.hold_reason } : {}), bot_id: a.bot_id, conversation_id: a.conversation_id, created_at: a.created_at, decided_at: a.decided_at, sender: a.bot_id ? this.publicBot(this.bot(a.bot_id)) : undefined, expires_at: a.expires_at };
    if (a.kind === "outbound_message") {
      const m = this.get("SELECT * FROM messages WHERE id = ?", a.subject_id);
      // A card whose `messages` row is missing is the shape a torn write leaves (#516): it is listed without its
      // detail, as the `action` and `face_room_message` branches below do, so one such row cannot take every other
      // card of this owner down. The read settles nothing; the decision door cancels it by id.
      if (m) {
        const pl = J(m.payload);
        card.message = { message_id: m.id, to: this.publicBot(this.bot(m.recipient_bot)), payload: pl, ...(mentionsOf(m.mentions).length ? { mentions: mentionsOf(m.mentions) } : {}), status: m.status, ...(pl.attachments ? { attachments: pl.attachments.map((r: AttachmentRef) => ({ ...r, size_label: humanSize(r.size) })) } : {}) };
      }
    } else if (a.kind === "action") {
      const x = this.get("SELECT * FROM actions WHERE id = ?", a.subject_id);
      // A card whose subject row is missing — a write an older build allowed to fail between the two rows — is
      // still a card the owner can settle by id. It is reported without its action detail, so one such row cannot
      // take every other card down with it. The read settles nothing.
      if (x) card.action = { action_id: x.id, action_type: x.action_type, params: J(x.params), justification: x.justification, status: x.status };
    } else if (a.kind === "relationship_request") {
      const r = this.get("SELECT * FROM relationships WHERE id = ?", a.subject_id);
      // Same shape as the two branches above: an orphan card is listed without its detail, not made a 500 (#516).
      if (r) card.relationship = { relationship_id: r.id, target: this.publicBot(this.bot(r.target_bot)), message: r.message, requested_capabilities: J(r.requested_caps, []), offered_capabilities: J(r.offered_caps, []) };
    } else if (a.kind === "invite") {
      const it = this.get("SELECT * FROM invites WHERE id = ?", a.subject_id);
      if (it) card.invite = this.inviteView(it);
    } else if (a.kind === "grant_request") {
      card.grant_request = { relationship_id: a.subject_id, ...J(a.note, {}), from: this.publicBot(this.bot(a.bot_id)) };
    } else if (a.kind === "face_room_message") {
      const d = this.get("SELECT * FROM face_room_drafts WHERE id = ?", a.subject_id);
      if (d) {
        // What the owner is approving includes whom the line is addressed to; only handles still in the room (as at delivery).
        const listed = d.status === "pending_approval" ? this.roomMentions(d.room_id, mentionsOf(d.mentions)) : mentionsOf(d.mentions);
        card.face_room = { room_id: d.room_id, message_id: d.id, payload: J(d.payload), ...(listed.length ? { mentions: listed } : {}), status: d.status };
      }
    }
    if (a.conversation_id) {
      const c = this.get("SELECT * FROM conversations WHERE id = ?", a.conversation_id);
      // The chat a card hangs off is reported the way the conversation read reports it (`reportedConvState`), not with
      // the raw row: a chat past its own clock reads closed/expired here too, or the owner's pending list would keep
      // calling it open while the chat page already says it expired. The read never writes the row -- the expiry is
      // materialized by the next door that touches the chat, not by looking at a card.
      if (c) card.conversation = { conversation_id: c.id, intent: J(c.intent), ...this.reportedConvState(c), turn: { count: c.turn_count, max: null } };
    }
    return card;
  }

  decideApproval(p: Principal, aprId: string, body: { decision: "approved" | "approved_with_edits" | "rejected"; edited_payload?: any; edited_params?: any; note_to_bot?: string; idempotency_key?: string }, actorOverride?: string) {
    const { idempotency_key: key, ...rest } = body as any;
    // The one-time confirm code is stripped from the request the key is compared against, never from what is
    // decided: a real retry carries a fresh code, so counting it would answer every retry with
    // idempotency_conflict instead of the first outcome. The code itself still travels on `rest`.
    const { confirm_code: _code, ...hashed } = rest;
    // The card being decided is part of the call, so the path's id goes in last: a client that passes its whole
    // object through carries an `approval_id` of its own, and spreading the body after the id let that copy replace
    // the path's inside the fingerprint. Two different cards then shared one fingerprint, and the second call
    // answered with the first card's result while its own card stayed pending — a decision reported as done and
    // never performed.
    return this.idempotent(p, "decide_approval", key, { ...hashed, approval_id: aprId }, () => this.decideApprovalOnce(p, aprId, rest, actorOverride));
  }

  private decideApprovalOnce(p: Principal, aprId: string, body: { decision: "approved" | "approved_with_edits" | "rejected"; edited_payload?: any; edited_params?: any; note_to_bot?: string }, actorOverride?: string) {
    const ownerId = this.requireOwner(p);
    // Whether this card is the caller's to decide is answered before anything is settled: a 404 or a 403 must not be
    // the call that expires another owner's cards, messages and requests. That is the same shape as #712's refused
    // writes, and it was reachable here with any owner's token naming an id that is missing or not theirs.
    let a = this.get("SELECT * FROM approvals WHERE id = ?", aprId);
    assert(a, 404, "approval_not_found");
    assert(a.owner_id === ownerId, 403, "forbidden", "not your approval");
    // A connector token decides only the owner's own default hold (README "Who may decide a hold"). A row that carries
    // a finding of its own — `risk`, `attachment`, `policy` — or a face-room line standing in for the owner's Auto-send
    // switch is the owner's, whatever the client thinks. A row that carries no hold at all keeps the old rule, so the
    // connector does not lose the request cards it has always been able to decide. The refusal names no peer content:
    // the connector already sees the card, not the line.
    if (p.kind === "owner" && p.scope === "connector"
      && a.hold_reason != null && !(a.kind === "outbound_message" && a.hold_reason === "blanket_outbound")) {
      throw new ApiError(403, "owner_must_decide", "this hold is the owner's to decide; a connector token can only decide a blanket outbound hold");
    }

    // The same question asked of the text that would actually run. An action card is decided with its params as
    // drafted or as edited here, and an edit can put a title on it that the owner's own scan flags: reading the hold
    // off the row alone lets a clean card be booked with text the platform would have held. Owner logins keep every
    // edit; only the connector's own decision is never the step that settles what a finding means.
    if (p.kind === "owner" && p.scope === "connector" && a.kind === "action") {
      const x = this.get("SELECT params, justification FROM actions WHERE id = ?", a.subject_id);
      const effective = { ...J(x?.params), ...(body.decision === "approved_with_edits" && body.edited_params ? body.edited_params : {}) };
      if (this.actionHold(a.owner_id, effective, x?.justification ?? null) != null) {
        throw new ApiError(403, "owner_must_decide", "this hold is the owner's to decide; a connector token can only decide a blanket outbound hold");
      }
    }
    // The card is this owner's to decide, so this door judges this card -- and a `grant_request` settles only this
    // card. Every refusal below (the `409` for a card that lapsed or was cancelled, the `403` for a Bot a stop or a
    // removal took down) is an answer about this card, not a delivery moment: the platform-wide sweep here used to
    // settle every other owner's cards, burn their links and tell their Bots on the way to that answer. A card that
    // lapsed under its own owner's hand is still settled here, so it still answers `409` rather than being decided.
    // Every kind settles only what this door has to judge before it knows whether the call is the caller's:
    // `grant_request` its own card, `relationship_request` its own request and card, and the remaining kinds their own
    // card. A card that lapsed under its own owner's hand is still settled here, so it still answers `409` rather than
    // being decided. The platform-wide sweep waits for the branch that actually writes a decision: a refused decision
    // used to settle every other owner's lapsed card, request and spent link on the way to its answer.
    if (a.kind === "grant_request") {
      const lapsed = this.get("SELECT * FROM approvals WHERE id = ? AND status = 'pending' AND expires_at < ?", aprId, nowIso());
      if (lapsed) this.expireApproval(lapsed);
    } else if (a.kind === "relationship_request") {
      // The request this card was written for is the one row this door may settle before it knows whether the call is
      // the caller's. A lapsed request still settles itself, its own card and the invite use its join spent -- so the
      // door still answers `409 invalid_state` rather than deciding a request that ran out -- and a card that lapsed
      // under its own owner's hand is settled whether or not the row did. Both are this request's own rows: the sweep
      // below used to take every other owner's lapsed card, lapsed request and spent link with them.
      this.settlePendingRelationships(this.all("SELECT * FROM relationships WHERE id = ? AND status IN ('pending_requester_owner','pending_target') AND expires_at < ?", a.subject_id, nowIso()));
      const lapsed = this.get("SELECT * FROM approvals WHERE id = ? AND status = 'pending' AND expires_at < ?", aprId, nowIso());
      if (lapsed) this.expireApproval(lapsed);
    } else {
      const lapsed = this.get("SELECT * FROM approvals WHERE id = ? AND status = 'pending' AND expires_at < ?", aprId, nowIso());
      if (lapsed) this.expireApproval(lapsed);
    }
    a = this.get("SELECT * FROM approvals WHERE id = ?", aprId);
    // #84 follow-up: a settled card stays as a record, never as a decision. Say why, so the owner is not left
    // guessing at "approval is cancelled": a revoked sender and a revoked share have their own sentence, a share
    // that ran out of time has another (a lapse is not a revoke), and so do the two ways the room settles a line
    // (its sender walked out, or the room closed while it waited). A reason this build does not map, and a row that
    // was decided rather than settled, keep the plain state.
    const revokedReason = "the sending Bot was revoked; this draft can no longer be approved";
    const recipientGoneReason = "the receiving Bot was revoked; this draft can no longer be approved";
    const shareGoneReason = "the share this draft was waiting on was revoked; this draft can no longer be approved";
    const shareLapsedReason = "the share this draft was waiting on lapsed; this draft can no longer be approved";
    const leftRoomReason = "the Bot is no longer in the room this draft was for; this draft can no longer be approved";
    const closedRoomReason = "the room closed before this draft was decided; this draft can no longer be approved";
    if (a.status !== "pending") {
      const known = a.status === "cancelled" ? a.decision : null;
      const sentence = known === "member_revoked" ? revokedReason
        : known === "recipient_revoked" ? recipientGoneReason
        : known === "grant_revoked" ? shareGoneReason
        : known === "grant_expired" ? shareLapsedReason
        : known === "room_left" ? leftRoomReason
        : known === "room_closed" ? closedRoomReason
        : `approval is ${a.status}`;
      throw new ApiError(409, "invalid_state", sentence);
    }
    // Last line of defence for a stale row an older build left pending after its sender was revoked. Cancel it
    // now (same record the revoke leaves behind) instead of delivering as a Bot that no longer exists.
    if (a.bot_id && ["outbound_message", "face_room_message", "action"].includes(a.kind) && this.bot(a.bot_id).status !== "active") {
      this.cancelPendingFor("id = ?", [a.id], "member_revoked", { actor: `owner:${ownerId}` });
      throw new ApiError(409, "invalid_state", revokedReason);
    }
    // The same defence for the other side: a line addressed to a Bot that has since been revoked. The revoke settles
    // its cards, so this is a row an older build left pending; cancel it now rather than answering `bot_revoked`
    // from deep in the delivery door, where the owner learns nothing about why the card cannot be decided.
    if (a.kind === "outbound_message" && this.get("SELECT 1 FROM messages WHERE id = ? AND recipient_bot IN (SELECT id FROM bots WHERE status = 'revoked')", a.subject_id)) {
      this.cancelPendingFor("id = ?", [a.id], "recipient_revoked", { notify: true, actor: `owner:${ownerId}` });
      throw new ApiError(409, "invalid_state", recipientGoneReason);
    }
    // A card that outlived its conversation is not a decision. Settle the chat first if its own clock ran out, then
    // refuse instead of delivering into a conversation that no longer exists; the invitee's accept is the one draft
    // a closed chat keeps (#105), so it still decides. This runs before the share guard below: settling the chat is
    // what closes it, and a card held in a chat that is already closed is the chat's business, not the share's.
    if (a.conversation_id) {
      // The chat is context, not the thing being decided: the line the card holds and the chat it was written in
      // both hang off `messages`, so a pointer at a chat that is not there is a row a torn write left behind. Read
      // it tolerantly and skip the closed-chat check rather than answering a `404 conversation_not_found` about a
      // chat the owner never asked about, which left the card pending forever.
      const c = this.get("SELECT * FROM conversations WHERE id = ?", a.conversation_id);
      if (c) {
        const wasClosed = c.status === "closed";
        this.materializeExpiry(c);
        if (c.status === "closed") {
          const keepsInvite = a.kind === "action" && this.get("SELECT 1 FROM actions WHERE id = ? AND action_type = 'calendar.accept_invite'", a.subject_id);
          if (!keepsInvite) {
            // A chat already closed before this line (a row an older build left pending) is settled here, once. When
            // the clock just ran out, `materializeExpiry` above is what cancelled the card: nothing to repeat.
            if (wasClosed) this.cancelPendingFor("id = ?", [a.id], c.outcome === "expired" ? "conversation_expired" : "conversation_closed", { notify: true, actor: `owner:${ownerId}` });
            throw new ApiError(409, "invalid_state", c.outcome === "expired"
              ? "the conversation expired; this draft can no longer be approved"
              : "the conversation is closed; this draft can no longer be approved");
          }
        }
      }
    }
    // Same defence for the other half: a card left pending while the share that allowed the line was revoked under
    // an older build is settled now, not delivered past a door the peer's owner already closed.
    if (this.heldCardShareGone(a)) {
      this.cancelPendingFor("id = ?", [a.id], "grant_revoked", { notify: true, actor: `owner:${ownerId}` });
      throw new ApiError(409, "invalid_state", shareGoneReason);
    }
    const decision = body?.decision;
    assert(["approved", "approved_with_edits", "rejected"].includes(decision), 400, "invalid_request", "decision must be approved|approved_with_edits|rejected");
    const approve = decision !== "rejected";
    // A card whose subject row was never written (a torn write an older build allowed) is settled here by id, with
    // the reason, instead of failing deep in the delivery door as a 500 that names nothing (#516). Same shape as the
    // invite branch below: the card is cancelled and the owner is told what it was waiting on is gone.
    const messageGone = "the message this card was for was never written; this card can no longer be approved";
    const requestGone = "the request this card was for was never written; this card can no longer be approved";
    const actionGone = "the action this card was for was never written; this card can no longer be approved";
    const draftGone = "the draft this card was for was never written; this card can no longer be approved";
    if (a.kind === "outbound_message" && !this.get("SELECT 1 FROM messages WHERE id = ?", a.subject_id)) {
      this.cancelPendingFor("id = ?", [a.id], "message_unavailable", { notify: true, actor: `owner:${ownerId}` });
      throw new ApiError(409, "invalid_state", messageGone);
    }
    if (a.kind === "relationship_request" && !this.get("SELECT 1 FROM relationships WHERE id = ?", a.subject_id)) {
      this.cancelPendingFor("id = ?", [a.id], "relationship_unavailable", { notify: true, actor: `owner:${ownerId}` });
      throw new ApiError(409, "invalid_state", requestGone);
    }
    // The same defence for an action card, and only on the approve side: `draftAction` writes the `actions` row and
    // the card together, and a torn write an older build allowed can leave the card without its subject. Approving it
    // fails inside `executeAction`, which reads that row unconditionally — a 500 that names nothing and leaves the
    // card pending, so the owner's queue keeps offering a decision that cannot succeed. Rejecting such a card writes
    // no action row, so that decision never needed the subject and stays available.
    if (approve && a.kind === "action" && !this.get("SELECT 1 FROM actions WHERE id = ?", a.subject_id)) {
      this.cancelPendingFor("id = ?", [a.id], "action_unavailable", { notify: true, actor: `owner:${ownerId}` });
      throw new ApiError(409, "invalid_state", actionGone);
    }
    // The same defence for a room line, and on both decisions: `draftFaceRoomMessage` writes the draft and the card
    // together, and a torn write an older build allowed can leave the card without its draft. Unlike the action card
    // above, neither leg can settle this one without the row — approving reads it in `deliverFaceRoomMessage` and
    // rejecting reads it in `rejectFaceRoomMessage` to mark it rejected — so both answered a 500 that names nothing
    // and left the card pending. Settle it once, with the reason, and refuse instead.
    if (a.kind === "face_room_message" && !this.get("SELECT 1 FROM face_room_drafts WHERE id = ?", a.subject_id)) {
      this.cancelPendingFor("id = ?", [a.id], "draft_unavailable", { notify: true, actor: `owner:${ownerId}` });
      throw new ApiError(409, "invalid_state", draftGone);
    }
    // These three kinds have every refusal behind them now: the card's own state, a revoked sender or recipient, a
    // conversation that closed, the share the line waited on, and the subject row a torn write left out. This is their
    // delivery moment -- approving or rejecting both answer the caller -- and it is taken here, before the line moves.
    if (a.kind === "outbound_message" || a.kind === "face_room_message" || a.kind === "action") this.expireStale();
    let result: any = {};
    if (a.kind === "outbound_message") result = approve ? this.deliverMessage(a, body) : this.rejectMessage(a, body.note_to_bot);
    else if (a.kind === "face_room_message") result = approve ? this.deliverFaceRoomMessage(a, body) : this.rejectFaceRoomMessage(a, body.note_to_bot);
    else if (a.kind === "action") result = approve ? this.executeAction(a, body) : this.rejectAction(a, body.note_to_bot);
    else if (a.kind === "relationship_request") {
      const r = this.get("SELECT * FROM relationships WHERE id = ?", a.subject_id);
      // A card can outlive the request it was written for: the peer's owner accepts through `consent`, and a row an
      // older build left `active` behind a card that still waits is the same shape. Deciding that card answers with
      // the relationship it finds and writes neither the row nor its grants — moving a live friendship back to
      // `pending_target` re-activates it, superseding every grant the pair holds and announcing it a second time.
      if (r.status === "active") {
        result = { relationship_id: r.id, status: r.status };
      } else {
        // The row and the auto-accept gate are one write. `maybeAutoAcceptInvite` refuses a frozen or revoked Bot
        // from inside `autoAcceptSpecs` ("a refusal leaves the card pending"), and that refusal must leave no half
        // write behind: moving the row first let a 403 `bot_frozen` leave the pair at `pending_target`, the card
        // still waiting, and the peer's owner reading a request nobody announced. In one transaction the refusal
        // takes the row back with it, and `atomically` holds the announcement until that commit.
        result = this.atomically(() => {
          this.run("UPDATE relationships SET status = ?, updated_at = ? WHERE id = ?", approve ? "pending_target" : "cancelled", nowIso(), r.id);
          if (approve && !this.maybeAutoAcceptInvite(r.id)) this.notifyTarget(r.id);
          if (!approve) this.releaseInviteUse(r.id);
          return { relationship_id: r.id, status: this.get("SELECT status FROM relationships WHERE id = ?", r.id).status };
        });
      }
      // The decision is taken and every refusal of this kind is behind it -- the `409` for a request that was never
      // written, the `403` the auto-accept gate answers for a stopped or removed end. This is the delivery moment, and
      // it is the only thing that moved: the platform-wide sweep belongs here, not ahead of an answer the door may
      // never give.
      this.expireStale();
      this.emit(a.bot_id, "approval.decided", { approval_id: a.id, kind: a.kind, relationship_id: r.id, decision, note_to_bot: body.note_to_bot ?? null });
    } else if (a.kind === "invite") {
      // The stored invite state is the same witness here as in `inviteStatus` and the expiry sweep: a link that was
      // revoked, expired or used before this decision is not reopened by it. A card an older build left pending is
      // settled now, with the reason, instead of writing `active`/`rejected` over what the owner already decided.
      const it = this.get("SELECT * FROM invites WHERE id = ?", a.subject_id);
      const state = it ? this.inviteStatus(it) : "gone";
      if (state !== "pending_owner") {
        this.cancelPendingFor("id = ?", [a.id], state === "revoked" ? "invite_revoked" : "invite_unavailable", { notify: true, actor: `owner:${ownerId}` });
        throw new ApiError(409, "invalid_state", `the invite is ${state}; this card can no longer be approved`);
      }
      // The link's own state is the last refusal this card has: a revoked, expired or used link answers `409` above
      // and writes nothing. Past this line the decision lands, so this is where the platform-wide sweep belongs.
      this.expireStale();
      this.run("UPDATE invites SET status = ? WHERE id = ?", approve ? "active" : "rejected", a.subject_id);
      this.emit(a.bot_id, "approval.decided", { approval_id: a.id, kind: a.kind, invite_id: a.subject_id, decision, url: approve ? this.inviteUrl(this.get("SELECT code FROM invites WHERE id = ?", a.subject_id).code) : null });
      result = { invite_id: a.subject_id, status: approve ? "active" : "rejected" };
    } else if (a.kind === "grant_request") {
      const req = J(a.note, {});
      if (approve) {
        // A share is a share wherever it is written: the owner route and the auto-accept invite both refuse a frozen
        // or revoked Bot (`assertInvitable`), and a card decided later writes the same pair of rows. A stop that
        // happened while the card waited is not undone by approving it -- the refusal leaves the card pending and
        // writes neither the grant nor its `grant.created` line. Both ends are asked: the Bot this owner shares and
        // the friend's Bot that asked for it.
        const r = this.get("SELECT * FROM relationships WHERE id = ?", a.subject_id);
        const shared = ownerId === r.requester_owner ? r.requester_bot : r.target_bot;
        const asking = req.grantee_bot ?? (ownerId === r.requester_owner ? r.target_bot : r.requester_bot);
        this.assertInvitable(this.bot(shared));
        this.assertInvitable(this.bot(asking));
        // One write, like the owner route: the supersede cannot survive a throw from the insert. The edited scope
        // re-runs the same #211 guard before the transaction, so a bad edit leaves the card pending and writes nothing.
        const scope = body.edited_params?.scope ?? req.scope;
        this.assertScope(req.capability, scope);
        // Every refusal this card has is behind us: both ends answer, the edited scope is accepted, and the value check
        // the insert itself runs is asked here first, because a refusal is not the call that settles another owner's
        // queue. What is left is the answer, so this is the delivery moment this door has always taken before it writes.
        this.grantExpiry(body.edited_params?.expires_in_days);
        this.expireStale();
        result.grant_id = this.db.transaction(() => this.insertGrant(a.subject_id, ownerId, req.grantee_bot, req.capability, scope, body.edited_params?.expires_in_days, `owner:${ownerId}`)).immediate();
      } else {
        // A rejection answers the card too, so the delivery moment stays on that path as well.
        this.expireStale();
      }
      this.emit(a.bot_id, "approval.decided", { approval_id: a.id, kind: a.kind, capability: req.capability, decision, note_to_bot: body.note_to_bot ?? null });
    }
    // #266: a retryable execution failure is not a decision. The owner said yes and the server found the slot busy
    // on a calendar the owner can clear — `fail()` already wrote `actions.status='failed'`, the audit row and the
    // `action.failed` event, so the Bot still learns what happened. Consuming the card here would spend it on a
    // failure the owner can fix, and `approved_with_edits` — the one affordance built for corrected times — would
    // be dead on that same card. `calendar.accept_invite`'s `invite_not_found` and `unsupported_action` stay
    // terminal: consuming the card there is right.
    if (a.kind === "action" && approve && result?.status === "failed" && result?.reason === "calendar_conflict") {
      return { approval_id: a.id, decision, ...result };
    }
    this.run("UPDATE approvals SET status = ?, decision = ?, decided_at = ? WHERE id = ?", approve ? "approved" : "rejected", decision, nowIso(), a.id);
    const flags = J(a.risk_flags, []);
    this.audit.append(actorOverride ?? `owner:${ownerId}`, "approval.decided", a.id, [ownerId], { kind: a.kind, subject_id: a.subject_id, decision, risk_flags: flags, known_risk_approved: approve && flags.length > 0, note_to_bot: body.note_to_bot ?? null });
    if (a.conversation_id) this.refreshConversationStatus(a.conversation_id);
    return { approval_id: a.id, decision, ...result };
  }

  // ================================================================ conversations
  private conv(id: string) {
    const c = this.get("SELECT * FROM conversations WHERE id = ?", id);
    assert(c, 404, "conversation_not_found");
    return c;
  }

  private refreshConversationStatus(convId: string) {
    // A status refresh is housekeeping, never a reason to fail the settlement that asked for it: the kill switch and
    // the clock both settle the card first and refresh the chat after, so a row whose pointer names a chat that is
    // not there skips the refresh instead of rolling the whole stop back.
    const c = this.get("SELECT * FROM conversations WHERE id = ?", convId);
    if (!c) return;
    if (!["open", "awaiting_approval"].includes(c.status)) return;
    const pending = this.get("SELECT COUNT(*) n FROM approvals WHERE conversation_id = ? AND status = 'pending'", convId).n;
    const s = pending ? "awaiting_approval" : "open";
    if (s !== c.status) this.run("UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?", s, nowIso(), convId);
  }

  private memberConv(botId: string, convId: string) {
    const c = this.conv(convId);
    assert(c.initiator_bot === botId || c.peer_bot === botId, 403, "not_a_member");
    return { c, peer: c.initiator_bot === botId ? c.peer_bot : c.initiator_bot };
  }

  /** The one card a closed chat keeps: the invitee's decision about a booking made in it (#105). The subquery is
   *  narrowed to this conversation, so an accept drafted in another chat is never exempted. */
  private acceptInviteCardOf(convId: string) {
    return { where: "NOT (kind = 'action' AND subject_id IN (SELECT id FROM actions WHERE conversation_id = ? AND action_type = 'calendar.accept_invite'))", args: [convId] };
  }

  /** Close a conversation whose own clock ran out: the same write the assert used to do inline, without throwing.
   *  Callers that may still act on a closed conversation (an invite acceptance) read the closed state off the row.
   *  The clock is a close like any other, so it settles what a manual close settles: the cards hanging off the chat
   *  are cancelled (except the invitee's accept, #105), the audit gets one entry and both Bots are told. All of it
   *  runs only on the open -> closed transition; `c` is updated in place, so a caller coming back through this door
   *  sees `closed` and does nothing. */
  private materializeExpiry(c: any) {
    if (!(c.expires_at && Date.parse(c.expires_at) < Date.now() && c.status !== "closed")) return;
    const owners = [this.bot(c.initiator_bot).owner_id, this.bot(c.peer_bot).owner_id];
    this.run("UPDATE conversations SET status = 'closed', outcome = 'expired', updated_at = ? WHERE id = ?", nowIso(), c.id);
    c.status = "closed";
    c.outcome = "expired";
    // A card the clock cancelled carries its own reason (`conversation_expired`, next to the manual close's
    // `conversation_closed`), and `notify` tells the Bot that owned it why it died.
    this.cancelPendingFor("conversation_id = ?", [c.id], "conversation_expired", { keep: this.acceptInviteCardOf(c.id), notify: true });
    this.audit.append("platform", "conversation.closed", c.id, owners, { outcome: "expired" });
    // No peer wrote anything on this path, so the line is the platform's own and carries no untrusted_content.
    for (const b of [c.initiator_bot, c.peer_bot]) this.emit(b, "conversation.closed", { conversation_id: c.id, outcome: "expired", trust: "platform", summary: null });
  }

  /** What a read reports for a chat: a row whose own clock ran out is closed/expired even on an instance where nothing
   *  has touched it yet, because `materializeExpiry` only runs on a write path. The read is computed and never writes
   *  the row -- a console that lists a lapsed chat as Active is the reason this exists. A closed row keeps the outcome
   *  it was closed with (agreed, declined, expired). */
  private reportedConvState(c: any) {
    return c.status !== "closed" && c.expires_at && Date.parse(c.expires_at) < Date.now()
      ? { status: "closed", outcome: "expired" }
      : { status: c.status, outcome: c.outcome };
  }

  /** Refuse only a chat an owner stopped; a closed chat is not a pause, and a pre-removal paused_limit resumes on use. */
  private assertNotPaused(c: any) {
    if (c.status === "paused_limit") this.resumeConversation(c, "platform", { reason: "turn_limit_removed" });
    else assert(!["paused_loop", "paused_stop"].includes(c.status), 409, "conversation_paused", `conversation is ${c.status}`);
  }

  private assertConvActive(c: any) {
    this.materializeExpiry(c);
    assert(c.status !== "closed", 409, "conversation_closed", `conversation is closed (${c.outcome})`);
    this.assertNotPaused(c);
  }

  private policyDecision(actor: string, convId: string | null, owners: string[], action: string, decision: string, reasons: string[], extra: Record<string, unknown> = {}) {
    this.audit.append(`bot:${actor}`, "policy.decision", convId, owners, { action, decision, reasons, policy_version: POLICY_VERSION, ...extra });
  }

  /** Opens a direct conversation, stores it and announces it to the peer. */
  createConversation(p: Principal, env: Envelope, roomId: string | null = null) {
    const opened = this.openConversation(p, env, roomId);
    opened.announce();
    return opened.conversation;
  }

  /** A thread's row, its event and its first draft as one write: a first line the policy layer refuses takes the
   *  conversation, its `conversation.started` event and the quota it would have spent with it. The caller announces
   *  only after that write has committed; a refusal inside the transaction leaves the peer's notice to the caller. */
  private openConversationWithDraft(p: Principal, env: Envelope, draftEnv: (conversationId: string) => Envelope, typed = false, mentions: string[] = [], roomId: string | null = null) {
    return this.db.transaction(() => {
      const made = this.openConversation(p, env, roomId);
      const message = this.draftMessage(p, made.conversation.conversation_id, draftEnv(made.conversation.conversation_id), typed, mentions, roomId);
      return { made, message };
    }).immediate();
  }

  /** Opens a direct conversation and drafts its first line as one write, then announces it to the peer. A reply-only
   *  refusal is the one that leaves something behind: its notice is written here, after the rollback, as
   *  `sendAsMemberOnce` does with its own `to` and `rel.id`. */
  startConversationWithDraft(p: Principal, env: Envelope, draftEnv: (conversationId: string) => Envelope) {
    try {
      const { made, message } = this.openConversationWithDraft(p, env, draftEnv);
      made.announce();
      return { conversation: made.conversation, message };
    } catch (error) {
      if ((error as ApiError)?.code === "bot_not_shared") {
        // Looking the notice up must never replace the refusal: if either read fails, the caller still gets `bot_not_shared`.
        try {
          const { botId } = this.requireBot(p);
          const peer = this.bot((env.payload as any)?.peer_bot_id);
          this.noticeUnshared(botId, peer, this.activeRelationship(botId, peer.id).id, "conversation.create");
        } catch { /* the refusal is the answer; the notice is best effort */ }
      }
      throw error;
    }
  }

  /** The write half of `createConversation`: the conversation row, its event row and the one way to announce it. The
   *  allow decision, the audit entry and the peer's webhook push are left to `announce`, which a caller holding the row
   *  in a transaction runs only once that transaction has committed; the event row stays here, so a rollback takes it
   *  with the conversation and neither side reads an event about a conversation that never happened. */
  private openConversation(p: Principal, env: Envelope, roomId: string | null = null) {
    this.verifyEnvelope(p, env, "conversation.create");
    const { botId, ownerId } = this.requireBot(p);
    const pl: any = env.payload ?? {};
    assert((pl.type ?? "direct") === "direct", 400, "invalid_request", "MVP supports only direct (1:1) conversations");
    // `peer_bot_id` is handed straight to the Bot lookup below, so the value's type decides what happens: an
    // array was unrolled as the SQL parameter and opened a real conversation for a value that is not a string;
    // an object, an array of the wrong length and a boolean made the binding throw and answered 500; a number
    // answered 404 with the number in the message. A peer id is a string; judge it before the lookup and before
    // the conversation row, its event and the audit entries. Absent and null fall through to their own message
    // below, and a present falsy non-string (false, 0) is named as the type error it is.
    assert(pl.peer_bot_id === undefined || pl.peer_bot_id === null || typeof pl.peer_bot_id === "string", 400, "invalid_request", "peer_bot_id must be a string");
    assert(pl.peer_bot_id, 400, "invalid_request", "peer_bot_id required");
    const peer = this.bot(pl.peer_bot_id);
    // #43: a conversation opened from a claimed room runs on that room's grants, not on a friendship.
    const roomRel = roomId ? this.roomReach(botId, peer.id, roomId) : null;
    const rel = roomRel ?? this.activeRelationship(botId, peer.id);
    // A stranger is still answered `no_relationship` above: the peer's status is not a probe. Past that, the room
    // path can reach a peer without a friendship, so the peer's own status is checked here too (activeRelationship
    // only filters a revoked identity). Nothing is written and no event is queued for a Bot the kill switch has
    // taken offline: the check sits before the INSERT and the emit(peer) that follows it.
    this.assertReachable(peer);
    const intentDef = INTENTS[pl.intent?.type];
    if (!intentDef) {
      this.policyDecision(botId, null, [ownerId], "conversation.create", "deny", ["intent.unsupported"]);
      throw new ApiError(403, "intent_scope_violation", "MVP intents: schedule_meeting, general_chat");
    }
    const chat = roomRel ? this.findRoomGrant(peer.owner_id, botId, "chat.public", peer.id, roomId!) : this.findGrant(peer.owner_id, botId, "chat.public", peer.id);
    if (!chat) {
      this.policyDecision(botId, null, [ownerId, peer.owner_id], "conversation.create", "deny", ["capability_not_granted:chat.public"]);
      throw new ApiError(403, "capability_not_granted", "peer has not granted chat.public", { suggestion: "request_grant" });
    }
    if (chat.reply_only) this.refuseUnshared(botId, peer, rel.id, "conversation.create");
    const since = new Date(Date.now() - 86400e3).toISOString();
    const today = this.get("SELECT COUNT(*) n FROM conversations WHERE relationship_id = ? AND created_at > ?", rel.id, since).n;
    if (today >= LIMITS.newConversationsPerPairPerDay) throw new ApiError(429, "rate_limited", "too many new conversations for this relationship today", { retry_after: 3600 });
    const allowed = (pl.intent.allowed_capabilities ?? intentDef.allowed).filter((c: string) => intentDef.allowed.includes(c));
    // The intent summary is peer text: the other owner's console and event queue render it the moment the chat opens,
    // so it is stored as a string or not at all. A non-string used to be coerced by `String(...)` ("[object Object]",
    // "1", "1.5") and then stored and announced; refusing it here, before the DLP scan, the row, the audit entry and
    // the events, keeps a summary nobody wrote from reaching the peer. Absent or null still means "no summary".
    assert(pl.intent.summary === undefined || pl.intent.summary === null || typeof pl.intent.summary === "string", 400, "invalid_request", "summary must be a string");
    const intent = { type: intentDef.type, summary: String(pl.intent.summary ?? ""), params: pl.intent.params ?? {}, allowed_capabilities: allowed, success_criteria: pl.intent.success_criteria ?? null, max_turns: null };
    // #512: the peer reads this intent the moment the chat opens (`conversation.started`), so the half the caller
    // wrote is scanned before anything is stored — the same `dlp()` the draft door runs, and the same rule: a `block`
    // finding refuses with `categories` (never the value), everything else stays as the draft door leaves it. A
    // refusal writes no row and queues no event, so the door cannot hand the peer a thread about a blocked value.
    const intentText = [intent.summary, intent.success_criteria == null ? "" : typeof intent.success_criteria === "string" ? intent.success_criteria : JSON.stringify(intent.success_criteria)].filter(Boolean).join("\n");
    const intentBlocked = this.dlp(ownerId, { text: intentText, structured: intent.params }).filter((f) => f.action === "block");
    if (intentBlocked.length) {
      this.policyDecision(botId, null, [ownerId, peer.owner_id], "conversation.create", "deny", ["dlp.blocked"], { categories: intentBlocked.map((b) => b.category) });
      throw new ApiError(422, "dlp_blocked", "outbound DLP blocked this conversation intent", { categories: intentBlocked.map((b) => b.category) });
    }
    const id = newId("cnv");
    const expires = pl.intent.expires_at ? new Date(ms(pl.intent.expires_at)).toISOString() : new Date(Date.now() + 72 * 3600e3).toISOString();
    this.run("INSERT INTO conversations (id, type, relationship_id, initiator_bot, peer_bot, intent, status, max_turns, created_at, updated_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      // max_turns stays in the schema (NOT NULL) but nothing reads it: conversations have no turn limit (owner decision 2026-10-19).
      id, "direct", rel.id, botId, peer.id, JSON.stringify(intent), "open", 0, nowIso(), nowIso(), expires);
    const conversation = {
      conversation_id: id, status: "open", intent,
      limits: { max_turns: null, rate_per_min: LIMITS.ratePerConversationPerMin, expires_at: expires },
      effective_capabilities: this.effectiveCaps(botId, peer.id, allowed, roomId),
    };
    // The conversation row and the event that announces it are one write: a first line the policy layer refuses
    // rolls both back, so the peer is never told about a conversation that does not exist.
    const started = this.appendEvent(peer.id, "conversation.started", { conversation_id: id, from: this.publicBot(this.bot(botId)), trust: "peer_untrusted", untrusted_content: { intent } });
    /** The allow decision, the audit entry and the peer's push, written once the conversation is really stored. */
    const announce = () => {
      this.policyDecision(botId, id, [ownerId, peer.owner_id], "conversation.create", "allow", [roomRel ? "room.context" : "relationship.active", "intent.allowed"]);
      this.audit.append(`bot:${botId}`, "conversation.created", id, [ownerId, peer.owner_id], { peer: peer.id, intent, envelope_id: env.id, sig: env.sig });
      this.webhooks.enqueue(peer.id, started);
    };
    return { conversation, announce };
  }

  private effectiveCaps(me: string, peer: string, allowed: string[], roomId: string | null = null) {
    const meB = this.bot(me), peerB = this.bot(peer);
    // #43: a room conversation runs on that room's grants; the friendship grants (room_id IS NULL) are not it.
    const cap = (grantorOwner: string, granteeBot: string, c: string, grantedBot: string) =>
      roomId ? this.findRoomGrant(grantorOwner, granteeBot, c, grantedBot, roomId) : this.findGrant(grantorOwner, granteeBot, c, grantedBot);
    return {
      me_on_peer: allowed.filter((c) => cap(peerB.owner_id, me, c, peer)),
      peer_on_me: allowed.filter((c) => cap(meB.owner_id, peer, c, me)),
    };
  }

  /** Drafts a Bot has written in the hour ending at `hourAgo + 3600e3`, over both write doors. The budget README
   *  promises is one per Bot, so a chat draft and a face-room draft spend the same hour: the two tables share no row
   *  (delivering a room line updates its `face_room_drafts` row and emits, it never inserts into `messages`), so the
   *  sum is a count of distinct drafts. */
  private draftsInLastHour(botId: string, hourAgo: number) {
    return this.get(`SELECT (SELECT COUNT(*) FROM messages WHERE sender_bot = ? AND created_ms > ?)
      + (SELECT COUNT(*) FROM face_room_drafts WHERE sender_bot = ? AND created_ms > ?) n`, botId, hourAgo, botId, hourAgo).n;
  }

  /** The same budget, read-only for the owner: the count the draft doors enforce, and how long until the oldest draft
   *  leaves the window. `resets_in` is null when the window is empty, otherwise whole seconds in 0–3600. */
  private draftBudget(botId: string) {
    const now = this.nowMs(), hourAgo = now - 3600e3;
    const used = this.draftsInLastHour(botId, hourAgo);
    if (!used) return { used: 0, limit: LIMITS.ratePerBotPerHour, resets_in: null };
    const { m } = this.get(`SELECT MIN(created_ms) m FROM (
      SELECT created_ms FROM messages WHERE sender_bot = ? AND created_ms > ?
      UNION ALL SELECT created_ms FROM face_room_drafts WHERE sender_bot = ? AND created_ms > ?)`, botId, hourAgo, botId, hourAgo);
    return { used, limit: LIMITS.ratePerBotPerHour, resets_in: Math.min(3600, Math.max(0, Math.ceil((m + 3600e3 - now) / 1000))) };
  }

  /** `typedByOwner` is internal: set only by sendAsMember after typedByOwner() authorised it, never from the envelope or text. */
  draftMessage(p: Principal, convId: string, env: Envelope, typedByOwner = false, mentions: string[] = [], roomContext: string | null = null) {
    this.verifyEnvelope(p, env, "message.draft");
    const { botId, ownerId } = this.requireBot(p);
    assert(!env.conversation_id || env.conversation_id === convId, 400, "invalid_envelope", "conversation_id mismatch");
    const { peer } = this.memberConv(botId, convId);
    const peerB = this.bot(peer);
    const owners = [ownerId, peerB.owner_id];
    const roomRel = roomContext ? this.roomReach(botId, peer, roomContext) : null;
    if (!roomRel) this.activeRelationship(botId, peer);
    const c = this.conv(convId);
    this.assertConvActive(c);
    const pl: any = env.payload ?? {};
    assert(typeof pl.text === "string" && pl.text.length > 0 && pl.text.length <= 4000, 400, "invalid_request", "payload.text (1-4000 chars) required");
    // `structured` is the machine-readable half of a line: an object or null, never a string/number/array, and never
    // more than 32 KiB serialized. Checked here, ahead of the DLP scan and the injection detector, so an oversized blob
    // is refused before anything reads it. A refusal writes no row at all and spends none of the Bot's draft budget.
    assert(pl.structured === undefined || pl.structured === null || (typeof pl.structured === "object" && !Array.isArray(pl.structured)), 400, "invalid_request", "payload.structured must be an object or null");
    const structuredOver = structuredOverLimit(pl.structured);
    if (structuredOver) throw structuredTooLarge(structuredOver);
    // `expects_reply` is a boolean the peer's console reads as "this line may need a reply": it is stored in
    // `messages.expects_reply` and rendered to the recipient as `!!m.expects_reply`. The field's contract is
    // `z.boolean().optional()` and the owner's edit door already refuses a non-boolean (`editedPayloadOf`), but this
    // door asked only `!== false`, so "false", 0, {} and [] all became true and the peer read the opposite of what
    // the sender meant. Refused here, ahead of the DLP scan and the row: a refused draft writes no message, no card,
    // no audit line and spends none of the Bot's draft budget. Absent or null still means "not given", so it stays true.
    assert(pl.expects_reply === undefined || pl.expects_reply === null || typeof pl.expects_reply === "boolean", 400, "invalid_request", "expects_reply must be a boolean");
    // Refs live in the signed payload, so the sender's signature covers them.
    const refs = this.checkRefs(botId, pl.attachments);
    const chat = roomRel ? this.findRoomGrant(peerB.owner_id, botId, "chat.public", peerB.id, roomContext!) : this.findGrant(peerB.owner_id, botId, "chat.public", peerB.id);
    if (!chat) {
      this.policyDecision(botId, convId, owners, "message.draft", "deny", ["capability_not_granted:chat.public"]);
      throw new ApiError(403, "capability_not_granted", "peer has not granted chat.public", { suggestion: "request_grant" });
    }
    // #23: a reply-only grant may answer, never start: the peer started this conversation or already wrote in it.
    if (chat.reply_only && c.initiator_bot !== peer && !this.get("SELECT 1 FROM messages WHERE conversation_id = ? AND sender_bot = ? AND status = 'delivered'", convId, peer)) {
      this.refuseUnshared(botId, peerB, c.relationship_id, "message.draft", convId);
    }
    // rate limits
    const minuteAgo = Date.now() - 60e3, hourAgo = Date.now() - 3600e3;
    if (this.get("SELECT COUNT(*) n FROM messages WHERE conversation_id = ? AND sender_bot = ? AND created_ms > ?", convId, botId, minuteAgo).n >= LIMITS.ratePerConversationPerMin)
      throw new ApiError(429, "rate_limited", "per-conversation rate limit (6/min)", { retry_after: 60 });
    if (this.draftsInLastHour(botId, hourAgo) >= LIMITS.ratePerBotPerHour)
      throw new ApiError(429, "rate_limited", "global bot rate limit (60/h)", { retry_after: 3600 });
    // No turn budget (owner decision 2026-10-19 18:05): a conversation never runs out of turns.
    // Loop detection guards Bot-to-Bot exchanges only. A line the owner typed (typed_by_owner, attested
    // by sendAsMember for a trusted host token, never read from the text) is never paused by it: a person
    // saying "Hi" twice is not a loop, and pausing them left the owner unable to send at all.
    const recent = this.all("SELECT payload FROM messages WHERE conversation_id = ? AND status IN ('delivered','pending_approval') ORDER BY created_ms DESC LIMIT 3", convId)
      .reverse().map((m) => { const x = J(m.payload); return { text: x.text ?? "", structured: !!x.structured }; });
    if (!typedByOwner && detectLoop(recent, { text: pl.text, structured: !!pl.structured })) {
      this.pauseConversation(c, "paused_loop", "loop_detected");
      throw new ApiError(409, "conversation_paused", "loop detected (repetitive or content-free exchange); conversation paused");
    }
    // outbound DLP
    const flags = this.dlp(ownerId, pl);
    const blocked = flags.filter((f) => f.action === "block");
    if (blocked.length) {
      this.policyDecision(botId, convId, owners, "message.draft", "deny", ["dlp.blocked"], { categories: blocked.map((b) => b.category) });
      throw new ApiError(422, "dlp_blocked", "outbound DLP blocked this draft", { categories: blocked.map((b) => b.category) });
    }
    const id = newId("msg");
    const reasons = ["mvp.all_outbound_requires_approval", ...flags.map((f) => `dlp.${f.category}`)];
    // #49: one field says why this line is held; a client never has to read `reasons`.
    // The delivery path asks the same question over the same input (text + `structured`); a draft must not answer
    // "nothing found" for content the recipient will receive marked `security.injection_suspected`.
    const injection = detectInjection([pl.text, pl.structured ? JSON.stringify(pl.structured) : ""].join("\n"));
    const injectionSuspected = injection.suspected;
    const holdReason = holdReasonOf({ riskFlags: flags, attachments: refs, injectionSuspected });
    const files = refs.length ? ` [${refs.length} file${refs.length > 1 ? "s" : ""}: ${refs.map((r) => `${r.name} (${humanSize(r.size)})`).join(", ")}]` : "";
    // Only the two ends of this conversation can be mentioned in it.
    const ends = ["@" + String(this.bot(botId).handle).replace(/^@/, "").toLowerCase(), "@" + String(peerB.handle).replace(/^@/, "").toLowerCase()];
    const kept = mentions.filter((h) => ends.includes(h));
    // #139: a line the owner typed themselves does not wait for that same owner again. Four things must hold at
    // once: the owner attestation, a clean DLP scan, no attachments and no suspected injection. Anything else keeps
    // today's card: this narrows `mvp.all_outbound_requires_approval` to Bot-drafted outbound, it never lifts a
    // finding. Room-context sends keep their existing door/auto path (#45/#57), hence `roomContext === null` here.
    if (typedByOwner && roomContext === null && flags.length === 0 && refs.length === 0 && !injectionSuspected) {
      const payload = { kind: pl.kind ?? (pl.structured ? "structured" : "text"), text: pl.text, structured: pl.structured ?? null, expects_reply: pl.expects_reply !== false };
      const row = { id, conversation_id: convId, sender_bot: botId, recipient_bot: peer, envelope: JSON.stringify(env), typed_by_owner: 1, mentions: kept.length ? JSON.stringify(kept) : null };
      const delivered = this.deliveredEvent(row, c, payload, injection);
      this.run("INSERT INTO messages (id, conversation_id, sender_bot, recipient_bot, envelope, payload, delivered_payload, status, risk_flags, injection, expects_reply, approval_id, created_at, created_ms, delivered_at, typed_by_owner, mentions) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        id, convId, botId, peer, row.envelope, JSON.stringify(payload), JSON.stringify(payload), "delivered", "[]", JSON.stringify(injection), payload.expects_reply ? 1 : 0, null, String(delivered.delivered_at), Date.now(), String(delivered.delivered_at), 1, row.mentions);
      this.run("UPDATE conversations SET turn_count = ?, updated_at = ? WHERE id = ?", c.turn_count + 1, nowIso(), convId);
      this.emit(peer, "message.received", delivered);
      this.policyDecision(botId, convId, owners, "message.draft", "allow", ["owner.typed_by_owner", "dlp.clean"], { message_id: id, typed_by_owner: true });
      // The owner's audit page shows why this line needed no approval: the owner wrote it. Actor is the owner, not
      // the Bot (`message.drafted` stays `bot:<id>` for every card).
      this.audit.append(`owner:${ownerId}`, "owner_typed_message_delivered", id, owners, { conversation_id: convId, recipient_bot: peer, dlp_version: POLICY_VERSION, text_length: pl.text.length });
      this.audit.append("platform", "message.delivered", id, owners, { conversation_id: convId, turn: c.turn_count + 1, edited: false, injection_suspected: false, delivered_sha256: payloadDigest(payload), platform_countersig: delivered.platform_countersig, typed_by_owner: true });
      return { message_id: id, status: "delivered", approval_id: undefined, typed_by_owner: true, ...(kept.length ? { mentions: kept } : {}), policy: { decision: "allow", reasons: ["owner.typed_by_owner", "dlp.clean"], risk_flags: [], policy_version: POLICY_VERSION } };
    }
    // A card is a delivery moment: the cards past their deadline settle before it is written, so the announcement and
    // the digest never count one its owner can no longer decide. This sits past every refusal above, so a refused
    // draft opens no delivery moment; the owner-typed line below writes no card and needs none.
    this.expireStale();
    // The card and the row it points at are one write (#516): a refused `messages` insert used to leave the card
    // behind, and nothing in the repository deletes it — one such orphan then took the owner's whole pending list
    // down. The announcement the card queues waits for this commit too (`atomically`), as the action door does.
    const aprId = this.atomically(() => {
      const apr = this.createApproval(ownerId, "outbound_message", id, botId, convId, `To @${peerB.handle}: ${pl.text.slice(0, 80)}${files}`, reasons, flags, J(c.intent).type === "schedule_meeting" ? LIMITS.meetingApprovalTtlMs : LIMITS.approvalTtlMs, undefined, holdReason);
      this.run("INSERT INTO messages (id, conversation_id, sender_bot, recipient_bot, envelope, payload, status, risk_flags, expects_reply, approval_id, created_at, created_ms, typed_by_owner, mentions) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        id, convId, botId, peer, JSON.stringify(env), JSON.stringify({ kind: pl.kind ?? (pl.structured ? "structured" : "text"), text: pl.text, structured: pl.structured ?? null, expects_reply: pl.expects_reply !== false, ...(refs.length ? { attachments: refs } : {}) }),
        "pending_approval", JSON.stringify(flags), pl.expects_reply === false ? 0 : 1, apr, nowIso(), Date.now(), typedByOwner ? 1 : 0, kept.length ? JSON.stringify(kept) : null);
      return apr;
    });
    // While this card waits it holds its files: the sweep skips a bound row until the card is decided
    // (`cleanupAttachments`), so the bytes outlive the upload clock for exactly as long as the owner takes.
    for (const r of refs) this.run("UPDATE attachments SET message_id = ? WHERE id = ? AND message_id IS NULL", id, r.id);
    this.policyDecision(botId, convId, owners, "message.draft", "require_approval", reasons, { message_id: id });
    this.audit.append(`bot:${botId}`, "message.drafted", id, owners, { conversation_id: convId, envelope_id: env.id, payload_sha256: env.payload_sha256, sig: env.sig, risk_flags: flags, approval_id: aprId, ...(typedByOwner ? { typed_by_owner: true } : {}) });
    this.refreshConversationStatus(convId);
    const rel = roomRel ?? this.activeRelationship(botId, peer);
    const autoChat = this.settingsFor(rel.id, ownerId).auto_approve_chat;
    // #45: a line that names a room both Bots were put in by their owners is already consented (the click that
    // added them was the consent), so the blanket outbound rule alone does not stop it. Anything the platform found
    // on its own — a DLP flag, an attachment, suspected injection — is a finding and keeps the card.
    // #57: the room consent is the room reach that was actually resolved, not the room id in the argument. A send
    // that names a room the Bot is no longer in falls back to the friendship door above; it must not auto-deliver as
    // room context, and its stated reason must name the friendship door it really used.
    const byRoom = !!roomRel && refs.length === 0;
    // This gate reads the reason the card already carries. holdReasonOf ranks its findings
    // risk > attachment > policy > blanket_outbound (:40-45); only the last one is the owner's own default hold,
    // the one thing auto-approve may lift. Every finding ranked above it — a DLP flag, an attachment, suspected
    // injection — keeps the card. Do not re-list the findings here: the next one holdReasonOf learns would
    // drift out of this branch again.
    if ((autoChat || byRoom) && holdReason === "blanket_outbound") {
      this.decideApproval({ kind: "owner", ownerId }, aprId, { decision: "approved" }, byRoom ? "policy:room_context" : "policy:auto_approve");
      return { message_id: id, status: "delivered", approval_id: aprId, auto_approved: true, ...(byRoom ? { room_id: roomContext! } : {}), ...(typedByOwner ? { typed_by_owner: true } : {}), ...(kept.length ? { mentions: kept } : {}), policy: { decision: "allow", reasons: [byRoom ? "room.context" : "owner.auto_approve_chat", "dlp.clean"], risk_flags: [], policy_version: POLICY_VERSION } };
    }
    return { message_id: id, status: "pending_approval", approval_id: aprId, ...(typedByOwner ? { typed_by_owner: true } : {}), ...(kept.length ? { mentions: kept } : {}), policy: { decision: "require_approval", reasons, risk_flags: flags, hold_reason: holdReason, policy_version: POLICY_VERSION } };
  }

  private dlp(ownerId: string, pl: any) {
    const o = this.owner(ownerId);
    // #495/#506: the scanned text is cut at DLP_TEXT_MAX_CHARS before any rule sees it. One request body is capped at
    // 256 KiB (server.ts), so the cap is that ceiling and no door reaches it; it stays as a backstop for a caller that
    // sends more. A cut is reported as a finding rather than swallowed, and it fails closed for `block`: the action
    // doors refuse only a finding whose action is `block`, so a cut that stopped at the first 64 KiB used to let a
    // secret past the cut through as a clean card (#506). The block rules read the whole text once more, which keeps a
    // finding that straddles the cut or sits past it; the approve-class findings keep the bounded read.
    const raw = [pl.text ?? "", pl.structured ? JSON.stringify(pl.structured) : ""].join("\n");
    const scanned = dlpText(raw);
    const text = scanned.text;
    const flags = dlpScan(text, J(o.sensitive_terms, []));
    if (scanned.truncated) {
      flags.push({ category: "dlp.truncated", action: "approve", label: "Text over the DLP scan limit" });
      for (const f of dlpScan(raw, J(o.sensitive_terms, []))) if (f.action === "block" && !flags.some((h) => h.category === f.category)) flags.push(f);
    }
    const details = this.all("SELECT title, location FROM calendar_entries WHERE owner_id = ?", ownerId).flatMap((e) => [e.title, e.location]).filter(Boolean);
    if (calendarDetailLeak(text, details)) flags.push({ category: "calendar.details", action: "approve", label: "Calendar details" });
    return flags;
  }

  /**
   * The hold an action draft's own findings make, or `null` when it carries none. The draft door and a connector's
   * decision read the same text through the same rule: a title or a justification that trips the owner's DLP terms or
   * reads as an injection is the owner's to decide. `blanket_outbound` is an outbound line's default hold, not
   * something a card stores, so it is written as none.
   */
  private actionHold(ownerId: string, params: any, justification: string | null): HoldReason | null {
    const text = [params?.title, justification].filter(Boolean).join(" ");
    const hold = holdReasonOf({ riskFlags: this.dlp(ownerId, { text }), injectionSuspected: detectInjection(text).suspected });
    return hold === "blanket_outbound" ? null : hold;
  }

  private pauseConversation(c: any, status: string, reason: string) {
    this.run("UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?", status, nowIso(), c.id);
    const owners = [this.bot(c.initiator_bot).owner_id, this.bot(c.peer_bot).owner_id];
    this.audit.append("platform", "conversation.paused", c.id, owners, { status, reason, turn_count: c.turn_count });
    for (const b of [c.initiator_bot, c.peer_bot]) this.emit(b, "conversation.paused", { conversation_id: c.id, status, reason, trust: "platform" });
  }

  /**
   * FlyBot #442: the recipient's home took a delivered message but its Bot did not receive it, because the home had
   * not yet recorded the grant (for example in the seconds after an invite join). The recipient's owner reports it
   * here, and the sender's Bot gets a platform `message.not_delivered` event, so the sender sees "Not sent" instead
   * of silence. Owner-only (owner MCP at /mcp); `reason` is a fixed code, never free
   * text from the recipient; once per message; nothing is stored or forwarded beyond the event and the audit entry.
   */
  reportNotDelivered(p: Principal, body: { message_id: string; reason?: string }) {
    const ownerId = this.requireOwner(p);
    const m = this.get("SELECT * FROM messages WHERE id = ?", String(body?.message_id ?? ""));
    assert(m && this.bot(m.recipient_bot).owner_id === ownerId, 404, "message_not_found", "no such message delivered to one of your bots");
    assert(m.status === "delivered", 409, "invalid_state", `message is ${m.status}`);
    const reason = body?.reason ?? "not_shared_yet";
    assert(NOT_DELIVERED_REASONS.includes(reason), 400, "invalid_request", `reason must be one of ${NOT_DELIVERED_REASONS.join(", ")}`);
    if (m.not_delivered_reason) return { message_id: m.id, status: "not_delivered", reason: m.not_delivered_reason, already_reported: true };
    this.run("UPDATE messages SET not_delivered_reason = ? WHERE id = ?", reason, m.id);
    const recipient = this.bot(m.recipient_bot);
    const sender = this.bot(m.sender_bot);
    this.audit.append(`owner:${ownerId}`, "message.not_delivered", m.id, [sender.owner_id, recipient.owner_id], { conversation_id: m.conversation_id, reason });
    this.emit(sender.id, "message.not_delivered", { message_id: m.id, conversation_id: m.conversation_id, to: this.publicBot(recipient), reason, trust: "platform" });
    return { message_id: m.id, status: "not_delivered", reason };
  }

  /**
   * The one description of a delivered message. An approved card and an owner-typed direct send (#139) must produce
   * the same recipient event, countersignature included, so the shape lives here and nowhere else.
   */
  private deliveredEvent(m: any, c: any, payload: any, inj: { suspected: boolean; matches: string[] }, edited = false) {
    const sender = this.bot(m.sender_bot);
    const env = J(m.envelope);
    const intent = J(c.intent);
    const delivered: Record<string, unknown> = {
      message_id: m.id, conversation_id: c.id, intent: { type: intent.type, summary: intent.summary },
      from: this.publicBot(sender), trust: "peer_untrusted",
      untrusted_content: { text: payload.text, structured: payload.structured ?? null },
      ...(Array.isArray(payload.attachments) && payload.attachments.length ? { attachments: payload.attachments } : {}),
      expects_reply: payload.expects_reply !== false, approved_by_owner: true, edited_by_owner: !!edited,
      ...(m.typed_by_owner ? { typed_by_owner: true } : {}),
      ...(mentionsOf(m.mentions).length ? { mentions: mentionsOf(m.mentions) } : {}),
      security: { injection_suspected: inj.suspected }, turn: { count: c.turn_count + 1, max: null },
      sender_envelope: { id: env.id, ts: env.ts, nonce: env.nonce, payload_sha256: env.payload_sha256, sig: env.sig },
      platform_kid: this.platformKid, delivered_at: nowIso(),
    };
    delivered.platform_countersig = this.countersign(delivered);
    return delivered;
  }

  private deliverMessage(a: any, body: any) {
    const m = this.get("SELECT * FROM messages WHERE id = ?", a.subject_id);
    const c = this.conv(m.conversation_id);
    const sender = this.bot(m.sender_bot);
    const recipient = this.bot(m.recipient_bot);
    // #43: a conversation opened from a claimed room delivers on that room's grant, and stops once it is gone.
    const cRel = this.pairRelationships(sender.id, recipient.id).find((r) => r.id === c.relationship_id);
    const roomThread = !!cRel && cRel.status === "room";
    if (roomThread) {
      const roomGrant = this.get("SELECT room_id FROM grants WHERE relationship_id = ? AND status = 'active' AND room_id IS NOT NULL LIMIT 1", cRel.id);
      assert(roomGrant && roomGrant.room_id, 403, "no_relationship", "the room grant is gone");
      assert(this.findRoomGrant(recipient.owner_id, sender.id, "chat.public", recipient.id, roomGrant.room_id), 403, "no_relationship", "the room grant is gone");
    } else if (!this.findActiveRelationship(sender.id, recipient.id)) {
      // #67: a conversation opened under a room keeps that room in its record even after the door closes (the claim
      // was ended, the room expired). With no friendship left either, say that instead of `no active relationship
      // between these bots`: the pair was related, by a room, and the step that is missing is the room grant -- a
      // friendship refusal sends the owner looking for the wrong fix. A friendship is checked first, so a room card
      // that outlives its room still settles for a pair that is also friends.
      const convRoom = this.get("SELECT room_id FROM grants WHERE relationship_id = ? AND room_id IS NOT NULL LIMIT 1", c.relationship_id);
      if (convRoom?.room_id) throw new ApiError(403, "no_relationship", "the room grant is gone");
      this.activeRelationship(sender.id, recipient.id);
    }
    // The friendship is not the share: a conversation outlives the grant that let this Bot write into it, so a held
    // line is checked against the same share its draft needed, before anything is written for the peer. A room
    // thread is judged by the room door above, never by a friendship grant the room does not use.
    if (!roomThread) {
      assert(this.findGrant(recipient.owner_id, sender.id, "chat.public", recipient.id), 403, "capability_not_granted",
        "the peer's owner no longer shares this Bot, so this line cannot be delivered");
    }
    // A frozen recipient holds the card: the kill switch must not let a line written before the freeze land
    // inside it. Nothing is written here -- not the message, not the approval -- and the card stays pending,
    // so the owner can still decide it after a resume.
    this.assertReachable(recipient);
    let payload = J(m.payload);
    // The refs were signed into the draft, and an edit cannot touch them (`editedPayloadOf`), so they are checked
    // here, before any write. A file that died while its card waited is refused: the card stays pending, the peer
    // hears nothing, and the owner can reject it and upload the file again.
    this.assertDraftAttachmentsLive(payload);
    const edited = body.decision === "approved_with_edits" && body.edited_payload;
    // Validate the edit before any write: a refused edit must not already have cleared the draft's mention list.
    const patch = edited ? editedPayloadOf(body) : null;
    if (edited) {
      payload = { ...payload, ...patch };
      const blocked = this.dlp(sender.owner_id, payload).filter((f) => f.action === "block");
      assert(!blocked.length, 422, "dlp_blocked", "edited payload blocked by DLP", { categories: blocked.map((b) => b.category) });
      // The list described the text the sender wrote: an edited message carries none, and none is stored, so no view
      // shows it either. Cleared only past every refusal door, so a refused edit leaves the draft exactly as it was.
      if (m.mentions) { this.run("UPDATE messages SET mentions = NULL WHERE id = ?", m.id); m.mentions = null; }
    }
    const inj = detectInjection([payload.text, payload.structured ? JSON.stringify(payload.structured) : ""].join("\n"));
    const turn = c.turn_count + 1;
    const delivered = this.deliveredEvent(m, c, payload, inj, !!edited);
    this.run("UPDATE messages SET status = 'delivered', delivered_payload = ?, injection = ?, delivered_at = ? WHERE id = ?", JSON.stringify(payload), JSON.stringify(inj), nowIso(), m.id);
    this.run("UPDATE conversations SET turn_count = ?, updated_at = ? WHERE id = ?", turn, nowIso(), c.id);
    this.emit(recipient.id, "message.received", delivered);
    this.emit(sender.id, "approval.decided", { approval_id: a.id, kind: "outbound_message", message_id: m.id, decision: body.decision, note_to_bot: body.note_to_bot ?? null, delivered_payload: payload });
    this.audit.append("platform", "message.delivered", m.id, [sender.owner_id, recipient.owner_id], { conversation_id: c.id, turn, edited: !!edited, injection_suspected: inj.suspected, delivered_sha256: payloadDigest(payload), platform_countersig: delivered.platform_countersig });
    return { message_id: m.id, status: "delivered" };
  }

  private rejectMessage(a: any, note?: string) {
    const m = this.get("SELECT * FROM messages WHERE id = ?", a.subject_id);
    this.run("UPDATE messages SET status = 'rejected' WHERE id = ?", m.id);
    // The owner refused the line: nothing was delivered, so the files it held go back to their sender instead of
    // staying bound to a message that will never reach the peer.
    this.freeDraftAttachments(m.id);
    // the peer never sees rejected drafts; only the sender bot is informed
    this.emit(m.sender_bot, "approval.decided", { approval_id: a.id, kind: "outbound_message", message_id: m.id, decision: "rejected", note_to_bot: note ?? null });
    return { message_id: m.id, status: "rejected" };
  }

  /**
   * Resume a paused conversation (loop suspected, emergency-stopped, or a pre-removal paused_limit).
   * The name and `extra_turns` stay for older clients; conversations have no turn limit, so nothing is added.
   */
  extendConversation(p: Principal, convId: string, body: { extra_turns?: number }) {
    const ownerId = this.requireOwner(p);
    const c = this.conv(convId);
    const owners = [this.bot(c.initiator_bot).owner_id, this.bot(c.peer_bot).owner_id];
    assert(owners.includes(ownerId), 403, "forbidden");
    // Extend tells both Bots the pair may talk again under a platform-trusted resume, so the Bot it would revive must
    // still be allowed to talk. A stopped (`frozen`) or removed (`revoked`) Bot cannot use its owner to pull its own
    // paused chat back into service: `resumeBot` is the way back, and the peer never hears a resume that the platform
    // would have to take away again. The door names no Bot, so the speaker is the chat's Bot that belongs to this
    // owner. A self-chat (both Bots this owner's) is let through: with no single speaker there is nothing to gate, and
    // its resume reaches only this owner's own Bots and console. The refused extend writes and announces nothing, so
    // the row stays exactly as the stop left it.
    const speaking = [c.initiator_bot, c.peer_bot].map((id) => this.bot(id)).filter((b) => b.owner_id === ownerId);
    if (speaking.length === 1) this.assertInvitable(speaking[0]);
    // A chat whose clock ran out is closed, whatever the row still says: settle it here (a POST may write) and refuse
    // it before `resumeConversation` can flip it back to open, announce a resume or write an extend to the audit.
    this.materializeExpiry(c);
    assert(c.status !== "closed", 409, "invalid_state", `conversation is closed (${c.outcome})`);
    assert(["paused_limit", "paused_loop", "paused_stop", "open", "awaiting_approval"].includes(c.status), 409, "invalid_state", `conversation is ${c.status}`);
    void body;
    this.resumeConversation(c, `owner:${ownerId}`, { resumed_from: c.status });
    return { conversation_id: convId, status: this.conv(convId).status, max_turns: null };
  }

  private resumeConversation(c: any, actor: string, data: Record<string, unknown>) {
    const owners = [this.bot(c.initiator_bot).owner_id, this.bot(c.peer_bot).owner_id];
    if (!["open", "awaiting_approval"].includes(c.status)) {
      this.run("UPDATE conversations SET status = 'open', updated_at = ? WHERE id = ?", nowIso(), c.id);
      c.status = "open";
    }
    this.refreshConversationStatus(c.id);
    c.status = this.conv(c.id).status;
    this.audit.append(actor, "conversation.extended", c.id, owners, data);
    for (const b of [c.initiator_bot, c.peer_bot]) this.emit(b, "conversation.resumed", { conversation_id: c.id, max_turns: null, trust: "platform" });
  }

  closeConversation(p: Principal, convId: string, body: any) {
    let actor: string, outcome: string, summary: string | null;
    const c = this.conv(convId);
    const owners = [this.bot(c.initiator_bot).owner_id, this.bot(c.peer_bot).owner_id];
    if (p.kind === "bot") {
      const env = this.verifyEnvelope(p, body, "conversation.close");
      this.memberConv(p.botId, convId);
      actor = `bot:${p.botId}`;
      outcome = (env.payload as any)?.outcome ?? "abandoned";
      summary = (env.payload as any)?.summary ?? null;
    } else {
      assert(owners.includes(p.ownerId), 403, "forbidden");
      actor = `owner:${p.ownerId}`;
      outcome = body?.outcome ?? "abandoned";
      summary = body?.summary ?? null;
    }
    // The closing summary is peer text the other side's console and event queue render, so it is stored as a string
    // or not at all. Refusing it here, before `materializeExpiry` can write and before the row, audit line and events,
    // keeps a non-string from reaching SQL as it arrived (500) or from being coerced to "1.0".
    assert(summary === null || typeof summary === "string", 400, "invalid_request", "summary must be a string");
    assert(["agreed", "declined", "abandoned"].includes(outcome), 400, "invalid_request", "outcome must be agreed|declined|abandoned");
    // The closing summary is peer content: it lands in the other side's console and event queue, so a stopped or
    // removed Bot must not write one. This door names no Bot, so the speaker is the chat's Bot that belongs to the
    // closing owner. A self-chat (both Bots this owner's) is let through: its summary can only reach this owner's own
    // Bots and console, and with no single speaker there is nothing to gate. The stopped side keeps its answers from
    // `assertInvitable`: frozen says the Bot can be resumed, revoked says its identity is gone.
    if (p.kind === "owner") {
      const speaking = [c.initiator_bot, c.peer_bot].map((id) => this.bot(id)).filter((b) => b.owner_id === p.ownerId);
      if (speaking.length === 1) this.assertInvitable(speaking[0]);
    }
    // A chat whose own clock ran out is closed by the clock, never as agreed: settle the expiry first, through the one
    // path every other door into a lapsed chat takes, then refuse it as closed. The refused close contributes nothing
    // of its own — no outcome, no summary; the row lands `closed`/`expired` and the cards hanging off it died as
    // `conversation_expired`.
    this.materializeExpiry(c);
    assert(!(c.status === "closed" && c.outcome === "expired"), 409, "invalid_state", "conversation is closed (expired)");
    // A chat closed any other way keeps the answer this door always gave.
    assert(c.status !== "closed", 409, "conversation_closed");
    this.run("UPDATE conversations SET status = 'closed', outcome = ?, summary = ?, updated_at = ? WHERE id = ?", outcome, summary, nowIso(), convId);
    // The invitee's decision about this chat's booking outlives the chat, so that one draft is kept; the subquery is
    // narrowed to this same conversation so an accept drafted in another chat is never exempted. Everything else is
    // cancelled, and each cancellation is announced to the Bot that owned the card.
    this.cancelPendingFor("conversation_id = ?", [convId], "conversation_closed", { keep: this.acceptInviteCardOf(convId), notify: true, actor });
    this.audit.append(actor, "conversation.closed", convId, owners, { outcome, summary });
    // The summary was written by the Bot (or the owner) that closed the chat, so for the other side it is peer
    // content: it travels inside `untrusted_content` under `trust: "peer_untrusted"`, like every other peer text
    // (README "Untrusted markers", AGENT_GUIDE safety rule 1). Never a bare `summary` next to `trust: "platform"`.
    for (const b of [c.initiator_bot, c.peer_bot]) this.emit(b, "conversation.closed", { conversation_id: convId, outcome, trust: "peer_untrusted", untrusted_content: { summary } });
    return { conversation_id: convId, status: "closed", outcome };
  }

  /** A chat reports `awaiting_approval` exactly while one of its cards is pending, and a card past its own clock is
   *  not pending any more: it only waits for the sweep that settles it. The queue and the event feed run that sweep
   *  when they read; the chat read settles the cards its own answer is about, through the same `expireApproval` the
   *  sweep uses, so the page cannot say it waits for a decision the decision door answers 409. This is scoped to
   *  those rows on purpose: a chat read does not also sweep the grants, rooms and relationships it does not report.
   *  The caller passes only chats the reader is a party to, and passes them only after that check: a refused read
   *  must not settle anything in someone else's chat. */
  private settleLapsedCardsInConversations(idsSql: string, args: unknown[]) {
    const now = nowIso();
    for (const a of this.all(`SELECT * FROM approvals WHERE status = 'pending' AND expires_at < ? AND conversation_id IN (${idsSql})`, now, ...args)) {
      this.expireApproval(a);
    }
  }

  listConversations(p: Principal) {
    const scope = p.kind === "owner"
      ? { sql: "SELECT c.id FROM conversations c WHERE c.initiator_bot IN (SELECT id FROM bots WHERE owner_id = ?) OR c.peer_bot IN (SELECT id FROM bots WHERE owner_id = ?)", args: [p.ownerId, p.ownerId] }
      : { sql: "SELECT id FROM conversations WHERE initiator_bot = ? OR peer_bot = ?", args: [p.botId, p.botId] };
    this.settleLapsedCardsInConversations(scope.sql, scope.args);
    const rows = p.kind === "owner"
      ? this.all("SELECT c.* FROM conversations c WHERE c.initiator_bot IN (SELECT id FROM bots WHERE owner_id = ?) OR c.peer_bot IN (SELECT id FROM bots WHERE owner_id = ?) ORDER BY c.created_at DESC", p.ownerId, p.ownerId)
      : this.all("SELECT * FROM conversations WHERE initiator_bot = ? OR peer_bot = ? ORDER BY created_at DESC", p.botId, p.botId);
    return rows.map((c) => ({ conversation_id: c.id, ...this.reportedConvState(c), intent: J(c.intent), initiator: this.publicBot(this.bot(c.initiator_bot)), peer: this.publicBot(this.bot(c.peer_bot)), turn: { count: c.turn_count, max: null }, created_at: c.created_at, updated_at: c.updated_at }));
  }

  /**
   * Console search: find a chat or a face room by its title face — a chat's peer handle and display name (or, for a
   * Bot token, the other Bot of its own thread), a room's note and the handles of the Bots seated in it. Message
   * bodies are never read: no line of a chat, no line said in a room, and a chat's summary is not a title either.
   * The set is the lists' own set: a closed chat, and a room that closed or that this home has left, are not hits,
   * so the console never offers something its pages would not show. `q` is trimmed and must be 2–100 characters;
   * each kind answers at most 20 hits, newest activity first.
   */
  searchConsole(p: Principal, q: unknown) {
    const term = typeof q === "string" ? q.trim() : "";
    assert(term.length >= 2 && term.length <= 100, 400, "invalid_query", "q must be 2-100 characters");
    const needle = term.toLowerCase();
    // Chats: the card's titles are the two handles and display names. A conversation is readable by an owner while
    // either Bot is theirs, and by a Bot token only for its own threads; a closed thread, or one whose clock has run
    // out, is gone from the lists.
    const title = "instr(lower(i.handle), ?) > 0 OR instr(lower(i.display_name), ?) > 0 OR instr(lower(pr.handle), ?) > 0 OR instr(lower(pr.display_name), ?) > 0";
    const chatRows = p.kind === "owner"
      ? this.all(`SELECT c.* FROM conversations c JOIN bots i ON i.id = c.initiator_bot JOIN bots pr ON pr.id = c.peer_bot
          WHERE ${CHAT_LIVE_SQL} AND (i.owner_id = ? OR pr.owner_id = ?) AND (${title})
          ORDER BY c.updated_at DESC LIMIT 20`, nowIso(), p.ownerId, p.ownerId, needle, needle, needle, needle)
      : this.all(`SELECT c.* FROM conversations c JOIN bots i ON i.id = c.initiator_bot JOIN bots pr ON pr.id = c.peer_bot
          WHERE ${CHAT_LIVE_SQL} AND (c.initiator_bot = ? OR c.peer_bot = ?) AND (${title})
          ORDER BY c.updated_at DESC LIMIT 20`, nowIso(), p.botId, p.botId, needle, needle, needle, needle);
    const chats = chatRows.map((c: any) => {
      const initiator = this.bot(c.initiator_bot), peer = this.bot(c.peer_bot);
      // The counterpart is the side that is not mine, exactly as the chat card names it; a thread between two of my
      // own Bots shows the peer side.
      const other = p.kind === "owner" ? (initiator.owner_id === p.ownerId ? peer : initiator) : (c.initiator_bot === p.botId ? peer : initiator);
      // The hit reports the state the chat page reports, not the raw row: a clock between the query and the page
      // cannot make the search call one thread open while its own read calls it closed.
      return { conversation_id: c.id, status: this.reportedConvState(c).status, summary: c.summary ?? null, updated_at: c.updated_at, peer: this.publicBot(other) };
    });
    // Rooms: the same seat rule `listFaceRooms` answers with (my own seat, or a guest this home brought in), closed
    // rooms and seats that were given up left out. The title face is the note plus every seated handle.
    const ownerId = p.ownerId;
    const extra = p.kind === "bot" ? "AND m.bot_id = ?" : "";
    const args: unknown[] = p.kind === "bot" ? [ownerId, ownerId, ownerId, ownerId, p.botId] : [ownerId, ownerId, ownerId, ownerId];
    // The sweep below is not the room's own door and settling a room is not a private act: it voids the number,
    // deletes its code rows and wakes every member. A search therefore settles only the rooms this caller holds a
    // seat in, read with that same seat rule before the sweep runs; a caller seated nowhere settles nothing. The
    // share sweep inside `advanceFaceRooms` still runs, as the other read doors keep it.
    const seatRooms = new Set<string>(this.all(`SELECT DISTINCT m.room_id FROM face_room_members m
      WHERE m.left_at IS NULL AND (m.owner_id = ? OR (m.added_by_owner_id = ? AND (
        NOT EXISTS (SELECT 1 FROM face_room_members gone WHERE gone.room_id = m.room_id AND gone.owner_id = ? AND gone.left_at IS NOT NULL)
        OR EXISTS (SELECT 1 FROM face_room_members seated WHERE seated.room_id = m.room_id AND seated.owner_id = ? AND seated.left_at IS NULL)))) ${extra}`,
      ...args).map((r: any) => r.room_id as string));
    this.advanceFaceRooms(seatRooms);
    const roomRows = this.all(`SELECT r.id, r.status, r.note, r.started_at, r.created_at,
        COALESCE((SELECT MAX(e.created_at) FROM face_room_events e WHERE e.room_id = r.id), r.started_at, r.created_at) activity_at,
        (SELECT COUNT(*) FROM face_room_members c WHERE c.room_id = r.id AND c.left_at IS NULL) member_count
      FROM face_rooms r
      JOIN face_room_members m ON m.room_id = r.id AND m.left_at IS NULL AND (m.owner_id = ? OR (m.added_by_owner_id = ? AND (
        NOT EXISTS (SELECT 1 FROM face_room_members gone WHERE gone.room_id = m.room_id AND gone.owner_id = ? AND gone.left_at IS NOT NULL)
        OR EXISTS (SELECT 1 FROM face_room_members seated WHERE seated.room_id = m.room_id AND seated.owner_id = ? AND seated.left_at IS NULL)))) ${extra}
      WHERE r.status != 'closed' AND (instr(lower(COALESCE(r.note, '')), ?) > 0 OR EXISTS (
        SELECT 1 FROM face_room_members s WHERE s.room_id = r.id AND s.left_at IS NULL AND (instr(lower(s.handle), ?) > 0 OR instr(lower(s.display_name), ?) > 0)))
      GROUP BY r.id ORDER BY activity_at DESC LIMIT 20`, ...args, needle, needle, needle);
    const rooms = roomRows.map((r: any) => ({
      room_id: r.id, status: r.status, note: r.note ?? null, member_count: r.member_count, updated_at: r.activity_at,
      members: this.all("SELECT handle, display_name FROM face_room_members WHERE room_id = ? AND left_at IS NULL ORDER BY join_seq, handle", r.id)
        .map((m: any) => ({ handle: "@" + String(m.handle ?? "").replace(/^@/, ""), display_name: m.display_name })),
    }));
    return { query: term, chats, rooms };
  }

  /** #57: the room a conversation is bound to, when its door is a room relationship; null for a 1:1 conversation. */
  private roomOfConversation(c: any): string | null {
    const rel = this.get("SELECT status FROM relationships WHERE id = ?", c.relationship_id);
    if (!rel || rel.status !== "room") return null;
    const g = this.get("SELECT room_id FROM grants WHERE relationship_id = ? AND room_id IS NOT NULL LIMIT 1", c.relationship_id);
    return g?.room_id ?? null;
  }

  /** Conversation view. Peer messages appear only once delivered, always wrapped as untrusted. */
  getConversation(p: Principal, convId: string) {
    let c = this.conv(convId);
    let viewerBot: string;
    if (p.kind === "bot") { this.memberConv(p.botId, convId); viewerBot = p.botId; }
    else {
      const mine = [c.initiator_bot, c.peer_bot].find((b) => this.bot(b).owner_id === p.ownerId);
      assert(mine, 403, "forbidden");
      viewerBot = mine;
    }
    // Member check first: a read that is refused (403/404) must leave nothing behind, so the settle below runs only
    // once the caller is known to be a party to this chat. It stays ahead of the message rows on purpose — the page
    // must report the settled line, not the one the card's clock already ended.
    this.settleLapsedCardsInConversations("SELECT id FROM conversations WHERE id = ?", [convId]);
    c = this.conv(convId); // the settle can move this chat's row: report what it says now, not what it said before
    const msgs = this.all("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_ms ASC", convId)
      .filter((m) => m.sender_bot === viewerBot || m.status === "delivered")
      .map((m) => {
        const content = J(m.delivered_payload) ?? J(m.payload);
        return m.sender_bot === viewerBot
          ? { message_id: m.id, direction: "outbound", status: m.status, content, ...(m.typed_by_owner ? { typed_by_owner: true } : {}), ...(mentionsOf(m.mentions).length ? { mentions: mentionsOf(m.mentions) } : {}), risk_flags: J(m.risk_flags, []), approval_id: m.status === "pending_approval" ? m.approval_id : undefined, created_at: m.created_at, delivered_at: m.delivered_at }
          : { message_id: m.id, direction: "inbound", status: m.status, expects_reply: !!m.expects_reply, from: this.publicBot(this.bot(m.sender_bot)), trust: "peer_untrusted", ...(m.typed_by_owner ? { typed_by_owner: true } : {}), ...(mentionsOf(m.mentions).length ? { mentions: mentionsOf(m.mentions) } : {}), untrusted_content: { text: content.text, structured: content.structured }, security: { injection_suspected: J(m.injection, {}).suspected ?? false }, delivered_at: m.delivered_at };
      });
    const actions = this.all("SELECT * FROM actions WHERE conversation_id = ? ORDER BY created_at", convId)
      .filter((x) => x.actor_bot === viewerBot || ["executed", "failed"].includes(x.status))
      .map((x) => ({ action_id: x.id, actor_bot: x.actor_bot, action_type: x.action_type, params: J(x.params), status: x.status, result: J(x.result) }));
    // `room_id` is read-only: which room this conversation belongs to (null for 1:1), so a console does not offer a
    // 1:1 send on a room chat — that route resolves `activeRelationship` and would land the line in another thread.
    const roomId = this.roomOfConversation(c);
    return {
      conversation_id: c.id, room_id: roomId, ...this.reportedConvState(c), summary: c.summary, intent: J(c.intent), turn: { count: c.turn_count, max: null },
      initiator: this.publicBot(this.bot(c.initiator_bot)), peer: this.publicBot(this.bot(c.peer_bot)), messages: msgs, actions,
      // #57: a conversation bound to a room reports that room's capabilities, not the friendship's; 1:1 is unchanged.
      effective_capabilities: this.effectiveCaps(viewerBot, viewerBot === c.initiator_bot ? c.peer_bot : c.initiator_bot, J(c.intent).allowed_capabilities, roomId),
    };
  }

  // ================================================================ actions
  draftAction(p: Principal, convId: string, env: Envelope) {
    this.verifyEnvelope(p, env, "action.draft");
    const { botId, ownerId } = this.requireBot(p);
    const { c, peer } = this.memberConv(botId, convId);
    const peerB = this.bot(peer);
    const owners = [ownerId, peerB.owner_id];
    this.activeRelationship(botId, peer);
    const pl: any = env.payload ?? {};
    const def = ACTIONS[pl.action_type];
    const isAccept = pl.action_type === "calendar.accept_invite";
    const intent = J(c.intent);
    // The draft door binds these values into the `actions` row and reads them again when the card is decided, so a
    // value the store cannot bind, or one execution writes where the schema expects text, is refused while it is
    // still a draft: a 400 that writes nothing, instead of a 500 after the card exists. Types only — the window, the
    // attendees and the invite itself keep the checks they already had below.
    assert(pl.justification === undefined || pl.justification === null || typeof pl.justification === "string", 400, "invalid_request", "justification must be a string or null");
    assert(pl.params === undefined || (pl.params !== null && typeof pl.params === "object" && !Array.isArray(pl.params)), 400, "invalid_request", "params must be an object");
    const params = pl.params ?? {};
    if (pl.action_type === "calendar.book") assert(params.title === undefined || typeof params.title === "string", 400, "invalid_request", "params.title must be a string");
    // The invite is looked up by this value before anything is written; an object here reaches SQLite as bind
    // parameters, which answers 500 instead of naming the bad field.
    if (isAccept) assert(typeof params.booking_id === "string", 400, "invalid_request", "params.booking_id must be a string");
    let acceptInvite: any = null;
    if (isAccept) {
      // A booked invitation outlives the chat it was made in: an agreed or expired conversation may still accept it,
      // and the initiator's allowed_capabilities list is not the invitee's veto. The booking is looked up first so a
      // missing invite stays the 404 it always was, and only a paused chat refuses the draft.
      acceptInvite = this.get("SELECT * FROM calendar_entries WHERE booking_id = ? AND owner_id = ? AND status = 'invited'", params.booking_id, ownerId);
      assert(acceptInvite, 404, "invite_not_found", "no pending invite with that booking_id for your owner");
      // The invitation belongs to the chat it was made in: `calendar.book` refuses an attendee that is not this
      // peer, so the accept door must refuse an invite that is not this peer's. Otherwise a Bot that reads the
      // wrong booking id answers another home's invitation here, and execution tells this chat's peer a meeting is
      // on — with the other homes' window in the card and in the peer's queue.
      assert(this.inviteIsWithPeer(acceptInvite, peerB.owner_id), 404, "invite_not_found", "this invite was not made with the peer of this conversation");
      // The invitation expires with its meeting, on the same rule the execute door applies: the two doors must not
      // answer the same card differently, so both read `start <= now`. Drafting an answer to a moment that has passed
      // is refused here, before a card exists.
      assert(Date.parse(acceptInvite.start) > this.nowMs(), 410, "invite_expired", "the invitation expired with its meeting");
      this.materializeExpiry(c);
      this.assertNotPaused(c);
    } else {
      this.assertConvActive(c);
    }
    if (!def || (!isAccept && !intent.allowed_capabilities.includes(def.capability))) {
      this.policyDecision(botId, convId, owners, "action.draft", "deny", ["intent_scope_violation"], { action_type: pl.action_type });
      throw new ApiError(403, "intent_scope_violation", `action ${pl.action_type} not allowed in ${intent.type} conversation`);
    }
    const tz = this.owner(ownerId).timezone;
    let summary: string;
    if (pl.action_type === "calendar.book") {
      const s = ms(params.start), e = ms(params.end);
      assert(e > s, 400, "invalid_request", "end must be after start");
      // Same window rule as the execute door: a booking is for a meeting that has not started. A card for a slot in
      // the past is refused while it is a draft, instead of becoming a card that can only fail later.
      assert(s > this.nowMs(), 400, "invalid_request", "start must be after now: a meeting window that has already started cannot be booked");
      const att: string[] = params.attendees ?? [peer];
      assert(att.length === 1 && att[0] === peer, 400, "invalid_request", "attendees must be exactly the peer bot");
      params.attendees = att;
      summary = `Book ${isoInTz(s, tz).slice(0, 16).replace("T", " ")}–${isoInTz(e, tz).slice(11, 16)} (${tz}) and invite @${peerB.handle}?`;
    } else {
      summary = `Accept @${peerB.handle}'s meeting invite at ${isoInTz(Date.parse(acceptInvite.start), tz).slice(0, 16).replace("T", " ")} (${tz})?`;
    }
    const dlpFlags = this.dlp(ownerId, { text: [params.title, pl.justification].filter(Boolean).join(" ") });
    assert(!dlpFlags.some((f) => f.action === "block"), 422, "dlp_blocked", "DLP blocked this action draft");
    const id = newId("act");
    const reasons = [...def.reasons];
    const hold = this.actionHold(ownerId, params, pl.justification ?? null);
    // This door writes an approval card, so it opens a delivery moment; the queue is settled first, outside the
    // transaction below. A card that lapsed while the owner's batch waited must be settled and its outlet told, not
    // named by the summary that leaves with this card (`requestGrant` carries the full reasoning).
    this.expireStale();
    // The card and the row it points at are one write: a pending card whose action row was never written takes the
    // owner's whole list down (`approvalCard`), so a refusal must leave neither behind. The announcement the card
    // queues waits for this commit too (`atomically`), or a refused insert still pages the owner's Bot about a card
    // that is in no table (#511). The policy line and the audit line describe a change that is already durable, so
    // they stay outside the transaction.
    const aprId = this.atomically(() => {
      const apr = this.createApproval(ownerId, "action", id, botId, convId, summary, reasons, dlpFlags, LIMITS.meetingApprovalTtlMs, undefined, hold);
      this.run("INSERT INTO actions (id, conversation_id, actor_bot, action_type, params, justification, envelope, status, approval_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        id, convId, botId, pl.action_type, JSON.stringify(params), pl.justification ?? null, JSON.stringify(env), "pending_approval", apr, nowIso());
      return apr;
    });
    this.policyDecision(botId, convId, owners, "action.draft", "require_approval", reasons, { action_id: id, action_type: pl.action_type });
    this.audit.append(`bot:${botId}`, "action.drafted", id, owners, { conversation_id: convId, action_type: pl.action_type, params, envelope_id: env.id, sig: env.sig, approval_id: aprId });
    this.refreshConversationStatus(convId);
    return { action_id: id, status: "pending_approval", approval_id: aprId, sensitivity: def.sensitivity, policy: { decision: "require_approval", reasons, policy_version: POLICY_VERSION } };
  }

  private executeAction(a: any, body: any) {
    const x = this.get("SELECT * FROM actions WHERE id = ?", a.subject_id);
    const c = this.conv(x.conversation_id);
    const actor = this.bot(x.actor_bot);
    const peer = this.bot(c.initiator_bot === actor.id ? c.peer_bot : c.initiator_bot);
    this.activeRelationship(actor.id, peer.id);
    const params = { ...J(x.params), ...(body.decision === "approved_with_edits" && body.edited_params ? body.edited_params : {}) };
    // The value execution writes into the calendar's text column: typed here too, because an owner edit can put a
    // title on the card that the draft door never saw, and a row an older build wrote can still carry one. Refused
    // before `fail()` and before any write, so the card stays pending and the same card can be retried with a valid
    // edit.
    assert(params.title === undefined || typeof params.title === "string", 400, "invalid_request", "params.title must be a string");
    // An owner edit amends the bot's draft; it does not create a new unchecked commitment. The invariants the
    // action draft door set (range, attendees, DLP text, and the invite the accept points at) are re-checked here,
    // before any write — before `fail()` and before any calendar/actions/events row — so a refusal leaves the
    // card pending and the same card can be retried with a valid edit. `edited_params: null` is no edit.
    const edit = body.decision === "approved_with_edits" ? body.edited_params : undefined;
    if (edit !== undefined && edit !== null) {
      assert(typeof edit === "object" && !Array.isArray(edit), 400, "invalid_request", "edited_params must be an object");
      if (x.action_type === "calendar.book") {
        const s = ms(params.start), e = ms(params.end);
        assert(e > s, 400, "invalid_request", "end must be after start");
        const att: string[] = params.attendees ?? [peer.id];
        assert(att.length === 1 && att[0] === peer.id, 400, "invalid_request", "attendees must be exactly the peer bot");
        const dlpFlags = this.dlp(actor.owner_id, { text: [params.title, x.justification].filter(Boolean).join(" ") });
        assert(!dlpFlags.some((f) => f.action === "block"), 422, "dlp_blocked", "edited_params blocked by DLP");
      } else if (x.action_type === "calendar.accept_invite") {
        // The invite is bound into a calendar query, so a value SQLite cannot bind fails inside that read: a 500 with
        // the card still pending. An owner edit can put a value on the card the draft door never saw. Typed before the
        // read and before any write, so the refusal is a 400 and the same card can be retried with a valid edit.
        assert(typeof params.booking_id === "string", 400, "invalid_request", "params.booking_id must be a string");
        const inv = this.get("SELECT * FROM calendar_entries WHERE booking_id = ? AND owner_id = ? AND status = 'invited'", params.booking_id, actor.owner_id);
        assert(inv, 404, "invite_not_found", "no pending invite with that booking_id for your owner");
        assert(this.inviteIsWithPeer(inv, peer.owner_id), 404, "invite_not_found", "this invite was not made with the peer of this conversation");
      }
    }
    const owners = [actor.owner_id, peer.owner_id];
    const fail = (reason: string, detail: any = {}) => {
      this.run("UPDATE actions SET status = 'failed', result = ? WHERE id = ?", JSON.stringify({ error: reason, ...detail }), x.id);
      this.audit.append("platform", "action.failed", x.id, owners, { reason, ...detail });
      this.emit(actor.id, "action.failed", { action_id: x.id, conversation_id: c.id, reason, trust: "platform" });
      return { action_id: x.id, status: "failed", reason };
    };
    if (x.action_type === "calendar.book") {
      const s = ms(params.start), e = ms(params.end);
      // A window that already started is not a booking. The card may have waited past the meeting, and executing it
      // would write two calendar rows for a commitment the calendar has already left behind. This is the execute
      // door's check, ahead of the conflict read and of every calendar write, and it settles the card as failed: an
      // edit cannot move a past window into the future once the card is decided.
      if (s <= this.nowMs()) return fail("meeting_in_past", { start: new Date(s).toISOString() });
      if (this.busyOf(actor.owner_id, s, e).length) return fail("calendar_conflict");
      const bookingId = newId("bkg");
      const title = params.title || J(c.intent).summary || "Meeting";
      const ins = "INSERT INTO calendar_entries (id, owner_id, start, end, title, attendees, source, status, organizer_owner, booking_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)";
      this.run(ins, newId("cal"), actor.owner_id, new Date(s).toISOString(), new Date(e).toISOString(), title, JSON.stringify([peer.owner_id]), "botsocial", "confirmed", actor.owner_id, bookingId, nowIso());
      this.run(ins, newId("cal"), peer.owner_id, new Date(s).toISOString(), new Date(e).toISOString(), title, JSON.stringify([actor.owner_id]), "botsocial", "invited", actor.owner_id, bookingId, nowIso());
      const result = { booking_id: bookingId, start: new Date(s).toISOString(), end: new Date(e).toISOString(), title, organizer: actor.id, invitee: peer.id, invitee_status: "invited" };
      this.run("UPDATE actions SET status = 'executed', result = ? WHERE id = ?", JSON.stringify(result), x.id);
      this.audit.append("platform", "action.executed", x.id, owners, { action_type: x.action_type, ...result });
      // `title` is written by the requester's Bot (`params.title`, else its intent summary). The requester's own
      // copy can keep it: it is that Bot's text. The invitee's copy carries it as peer content, inside
      // `untrusted_content`, never as a top-level field next to `trust: "platform"`.
      const { title: bookedTitle, ...bookedFacts } = result;
      this.emit(actor.id, "event.meeting_booked", { conversation_id: c.id, action_id: x.id, trust: "platform", ...result });
      this.emit(peer.id, "event.meeting_booked", { conversation_id: c.id, action_id: x.id, trust: "peer_untrusted", ...bookedFacts, untrusted_content: { title: bookedTitle }, note: "Invite pending. Accepting is a commitment requiring your owner's approval: draft action calendar.accept_invite." });
      return { action_id: x.id, status: "executed", result };
    }
    if (x.action_type === "calendar.accept_invite") {
      const inv = this.get("SELECT * FROM calendar_entries WHERE booking_id = ? AND owner_id = ? AND status = 'invited'", params.booking_id, actor.owner_id);
      // The same binding the draft door asks, before the row flips: an invite that is not this chat's peer's is not
      // an invite this card may answer, whatever its params were edited to.
      if (!inv || !this.inviteIsWithPeer(inv, peer.owner_id)) return fail("invite_not_found");
      // The invitation expires with its meeting: an accept approved after the start would confirm a past meeting and
      // tell both Bots it is on. Checked before the conflict read and before the row flips to confirmed, and the card
      // settles as failed — the answer to an invitation to a moment that has passed.
      if (Date.parse(inv.start) <= this.nowMs()) return fail("invite_expired", { booking_id: params.booking_id });
      if (this.busyOf(actor.owner_id, Date.parse(inv.start), Date.parse(inv.end)).length) return fail("calendar_conflict");
      this.run("UPDATE calendar_entries SET status = 'confirmed' WHERE id = ?", inv.id);
      const result = { booking_id: params.booking_id, invitee_status: "accepted", start: inv.start, end: inv.end };
      this.run("UPDATE actions SET status = 'executed', result = ? WHERE id = ?", JSON.stringify(result), x.id);
      this.audit.append("platform", "action.executed", x.id, owners, { action_type: x.action_type, ...result });
      for (const b of [actor.id, peer.id]) this.emit(b, "event.invite_accepted", { conversation_id: c.id, action_id: x.id, trust: "platform", by: actor.id, ...result });
      return { action_id: x.id, status: "executed", result };
    }
    return fail("unsupported_action");
  }

  private rejectAction(a: any, note?: string) {
    this.run("UPDATE actions SET status = 'rejected' WHERE id = ?", a.subject_id);
    this.emit(a.bot_id, "approval.decided", { approval_id: a.id, kind: "action", action_id: a.subject_id, decision: "rejected", note_to_bot: note ?? null });
    return { action_id: a.subject_id, status: "rejected" };
  }

  // ================================================================ calendar (built-in mock provider)
  private busyOf(ownerId: string, s: number, e: number) {
    return this.all("SELECT * FROM calendar_entries WHERE owner_id = ? AND status = 'confirmed'", ownerId).filter((x) => overlaps(Date.parse(x.start), Date.parse(x.end), s, e));
  }

  addCalendarEntry(p: Principal, body: { start: string; end: string; title?: string; location?: string }) {
    const ownerId = this.requireOwner(p);
    const s = ms(body?.start), e = ms(body?.end);
    assert(e > s, 400, "invalid_request", "end must be after start");
    // title and location are free text, and the INSERT binds them as they arrive: a non-string is refused here, before
    // any row is written.
    assert(body?.title === undefined || body?.title === null || typeof body.title === "string", 400, "invalid_request", "title must be a string");
    assert(body?.location === undefined || body?.location === null || typeof body.location === "string", 400, "invalid_request", "location must be a string");
    const id = newId("cal");
    this.run("INSERT INTO calendar_entries (id, owner_id, start, end, title, location, created_at) VALUES (?,?,?,?,?,?,?)", id, ownerId, new Date(s).toISOString(), new Date(e).toISOString(), body.title ?? null, body.location ?? null, nowIso());
    return { id, start: new Date(s).toISOString(), end: new Date(e).toISOString() };
  }

  listCalendar(p: Principal) {
    const ownerId = this.requireOwner(p);
    return this.all("SELECT * FROM calendar_entries WHERE owner_id = ? ORDER BY start", ownerId).map((e) => ({ ...e, attendees: J(e.attendees, []) }));
  }

  /** Free/busy query (§10.10). Peer subjects need calendar.freebusy.read granted by the peer owner; only intervals are returned. */
  freebusy(p: Principal, env: Envelope) {
    this.verifyEnvelope(p, env, "calendar.freebusy.query");
    const { botId, ownerId } = this.requireBot(p);
    const pl: any = env.payload ?? {};
    const { c } = this.memberConv(botId, pl.conversation_id);
    this.assertConvActive(c);
    const intent = J(c.intent);
    if (!intent.allowed_capabilities.includes("calendar.freebusy.read")) throw new ApiError(403, "intent_scope_violation", "freebusy not allowed in this intent");
    const ws = ms(pl.window?.start ?? intent.params?.window?.start), we = ms(pl.window?.end ?? intent.params?.window?.end);
    assert(we > ws && we - ws <= 31 * 86400e3, 400, "invalid_request", "window must be positive and <= 31 days");
    const subjects: string[] = pl.subjects ?? ["self"];
    const results: Record<string, any> = {};
    const hourRules: { tz: string; hours: [number, number] }[] = [{ tz: this.owner(ownerId).timezone, hours: [9 * 60, 18 * 60] }];
    const busyAll: [number, number][] = [];
    const peerOwners: string[] = [];
    for (const sub of subjects) {
      if (sub === "self" || sub === botId) {
        const busy = this.busyOf(ownerId, ws, we).map((x) => ({ start: x.start, end: x.end }));
        results.self = { busy };
        busy.forEach((b) => busyAll.push([Date.parse(b.start), Date.parse(b.end)]));
        continue;
      }
      assert(sub === c.initiator_bot || sub === c.peer_bot, 403, "intent_scope_violation", "subjects must be self or the conversation peer");
      const peerB = this.bot(sub);
      peerOwners.push(peerB.owner_id);
      this.activeRelationship(botId, sub);
      const g = this.findGrant(peerB.owner_id, botId, "calendar.freebusy.read", peerB.id);
      if (!g) {
        this.policyDecision(botId, c.id, [ownerId, peerB.owner_id], "calendar.freebusy.read", "deny", ["capability_not_granted"]);
        throw new ApiError(403, "capability_not_granted", "peer has not granted calendar.freebusy.read", { suggestion: "request_grant", capability: "calendar.freebusy.read" });
      }
      const s = ws;
      let e = we;
      if (g.scope.window_days) e = Math.min(e, Date.now() + g.scope.window_days * 86400e3);
      const tz = this.owner(peerB.owner_id).timezone;
      const hrs = parseHours(g.scope.hours);
      if (hrs) hourRules.push({ tz, hours: hrs });
      // The grant's `hours` bounds the answer, not only the suggestions: a block wholly outside the window is not
      // shared, and one that crosses a boundary is cut there — dropping a crossing block whole would tell the peer
      // that its inside part is free. `window_days` above narrows the query; this narrows the blocks it returns.
      // Each block is first cut to the queried span, so a block that lasts longer than the query yields one piece
      // per queried day, never one per day of its own lifetime: the answer cannot grow with the entry's length.
      const rows = s < e ? this.busyOf(peerB.owner_id, s, e) : [];
      const busy = hrs
        ? rows.flatMap((x) => clipToDailyHours(Math.max(Date.parse(x.start), s), Math.min(Date.parse(x.end), e), hrs, tz).map(([bs, be]) => ({ start: new Date(bs).toISOString(), end: new Date(be).toISOString() })))
        : rows.map((x) => ({ start: x.start, end: x.end }));
      results[sub] = { busy, grant_id: g.id, window: { start: new Date(s).toISOString(), end: new Date(Math.max(s, e)).toISOString() }, scope: g.scope, redacted: ["title", "location", "attendees"] };
      busy.forEach((b) => busyAll.push([Date.parse(b.start), Date.parse(b.end)]));
      if (e < we) busyAll.push([e, we]); // outside the granted window = unknown, treated as unavailable
      this.policyDecision(botId, c.id, [ownerId, peerB.owner_id], "calendar.freebusy.read", "allow", ["grant.active"], { grant_id: g.id });
    }
    const dur = (Number(intent.params?.duration_minutes) || 30) * 60e3;
    const step = 30 * 60e3;
    const suggestions: { start: string; end: string }[] = [];
    for (let t = Math.max(Math.ceil(ws / step) * step, Math.ceil(Date.now() / step) * step); t + dur <= we && suggestions.length < 5; t += step) {
      const okHours = hourRules.every((r) => {
        const wd = localWeekday(t, r.tz);
        const a = localMinutes(t, r.tz);
        return wd >= 1 && wd <= 5 && a >= r.hours[0] && a + dur / 60e3 <= r.hours[1];
      });
      if (okHours && !busyAll.some(([s, e]) => overlaps(t, t + dur, s, e))) suggestions.push({ start: isoInTz(t, hourRules[0].tz), end: isoInTz(t + dur, hourRules[0].tz) });
    }
    this.audit.append(`bot:${botId}`, "calendar.freebusy.queried", c.id, [ownerId, ...peerOwners], { subjects, envelope_id: env.id });
    return { results, common_free_suggestions: suggestions };
  }

  // ================================================================ events & audit
  listEvents(p: Principal, since = 0, limit = 100) {
    const { botId } = this.requireBot(p);
    // Defense in depth (#177 ③): rotateBotToken no longer mints a token for a revoked identity, but a token row
    // that outlives the revocation must not read the pre-revocation queue either. frozen may still read: the
    // kill switch stops reach, not the owner's own view.
    assert(this.bot(botId).status !== "revoked", 403, "bot_revoked", "this bot identity was revoked");
    this.expireStale();
    const rows = this.all("SELECT * FROM events WHERE bot_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?", botId, since, limit);
    return { events: rows.map((r) => ({ cursor: r.seq, event_id: r.id, event_type: r.type, created_at: r.created_at, ...J(r.data) })), next_cursor: rows.length ? rows[rows.length - 1].seq : since };
  }

  auditEvents(p: Principal, opts: { subject?: string; limit?: number } = {}) {
    const ownerId = this.requireOwner(p);
    // The whole chain is verified on every query, but an owner only sees their own numbers: the server-wide
    // record count and head hash would leak overall activity volume.
    const v = this.audit.verify();
    return { events: this.audit.list({ owner: ownerId, subject: opts.subject, limit: opts.limit }), chain: { ok: v.ok, count: this.audit.countFor(ownerId), ...(v.ok ? {} : { broken_at: v.broken_at }) } };
  }

  // ================================================================ face-to-face rooms
  /** `look` adds the Bot's current avatar/color. Only used for the member list of a room the viewer belongs to;
   *  events (persisted, replayed and delivered as inbox items) never carry the avatar. */
  private faceMemberPublic(m: any, look = false) {
    // The member row holds the names as they were when it joined; a row written before #106 may hold controls,
    // U+2028, a leading @ or more than 60 code points, so clean it on read by the same rule as `publicBot`.
    const display_name = peerDisplayName(m.display_name, "Bot");
    const owner_name = peerDisplayName(m.owner_name, "Owner");
    // The look and the one-line card come from the Bot's live row: a member who edits either shows the new value on
    // the room's next read. A Bot without a card reads null, never an empty line.
    const card = look ? this.get("SELECT avatar, color, avatar_updated_at, description FROM bots WHERE id = ?", m.bot_id) : null;
    return {
      handle: m.handle, display_name, owner_name,
      label: memberLabel(display_name, owner_name), bot_id: m.bot_id,
      ...(look ? { role: m.role ? sanitizePeerName(m.role, "", FACE_ROOM_ROLE_MAX) || null : null } : {}),
      ...(look ? { description: card?.description ?? null, ...lookOf(card ?? {}) } : {}),
    };
  }
  private faceSnapshot(b: any) {
    const o = this.owner(b.owner_id);
    const display_name = peerBotName(b, "Bot");
    const owner_name = peerOwnerName(o, "Owner");
    return {
      bot_id: b.id, handle: "@" + String(b.handle).replace(/^@/, ""), display_name, owner_name,
      label: memberLabel(display_name, owner_name),
    };
  }
  private faceOwnerIds(roomId: string) {
    return this.all("SELECT DISTINCT owner_id FROM face_room_members WHERE room_id = ? AND left_at IS NULL", roomId).map((r: any) => r.owner_id);
  }
  private faceInsertEvent(roomId: string, type: string, actorBot: string | null, data: Record<string, unknown>) {
    const id = newId("fev");
    const created_at = this.ts();
    this.run("INSERT INTO face_room_events (id, room_id, type, actor_bot, data, created_at) VALUES (?,?,?,?,?,?)", id, roomId, type, actorBot, JSON.stringify(data), created_at);
    return { id, seq: this.get("SELECT seq FROM face_room_events WHERE id = ?", id).seq as number, created_at, type };
  }
  private faceEmitMembers(roomId: string, type: string, data: Record<string, unknown>) {
    for (const m of this.all("SELECT bot_id FROM face_room_members WHERE room_id = ? AND left_at IS NULL", roomId)) this.emit(m.bot_id, type, data);
  }
  private faceEventPublic(e: any) {
    return { event_id: e.id, event_cursor: e.seq, type: e.type, created_at: e.created_at, actor_bot: e.actor_bot, ...J(e.data, {}) };
  }
  private faceRecordAttempt(ownerId: string | null, ip: string | null, code: string, outcome: string) {
    this.run("INSERT INTO face_room_attempts (owner_id, ip, code, outcome, created_at) VALUES (?,?,?,?,?)", ownerId, ip, String(code).slice(0, 16), outcome, this.ts());
  }
  private faceSetLockout(key: string, fails: number) {
    this.run(`INSERT INTO face_room_lockouts (key, until, fails, created_at) VALUES (?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET until = excluded.until, fails = excluded.fails`, key, new Date(this.nowMs() + this.faceRoomLimits.lockoutMs).toISOString(), fails, this.ts());
  }
  private faceLockoutUntil(ownerId: string, ip: string | null): string | null {
    const now = this.ts();
    const rows = this.all("SELECT until FROM face_room_lockouts WHERE key IN (?, ?) AND until > ?", `owner:${ownerId}`, ip ? `ip:${ip}` : `owner:${ownerId}`, now);
    return rows.length ? rows.map((r: any) => r.until as string).sort().at(-1)! : null;
  }
  private faceFailOutcomes() { return ["invalid_code", "room_full", "code_void"] as const; }
  private faceMaybeLockout(ownerId: string, ip: string | null): boolean {
    const since = new Date(this.nowMs() - this.faceRoomLimits.attemptWindowMs).toISOString();
    const fails = this.faceFailOutcomes();
    const marks = fails.map(() => "?").join(",");
    let locked = false;
    const acct = this.get(`SELECT COUNT(*) n FROM face_room_attempts WHERE owner_id = ? AND created_at > ? AND outcome IN (${marks})`, ownerId, since, ...fails).n;
    if (acct >= this.faceRoomLimits.failsBeforeLockout) { this.faceSetLockout(`owner:${ownerId}`, acct); locked = true; }
    if (ip) {
      const n = this.get(`SELECT COUNT(*) n FROM face_room_attempts WHERE ip = ? AND created_at > ? AND outcome IN (${marks})`, ip, since, ...fails).n;
      if (n >= this.faceRoomLimits.failsBeforeLockout) { this.faceSetLockout(`ip:${ip}`, n); locked = true; }
    }
    return locked;
  }
  private faceRateFail(message: string, scope: string, windowMs: number) {
    return { ok: false as const, status: 429, code: "rate_limited", message, extra: { retry_after: Math.ceil(windowMs / 1000), scope } };
  }
  /** 6-digit (and invite-join) attempts. A successful invite mint is not one of them: it has its own budget (#69). */
  private faceAttemptRateLimit(ownerId: string, ip: string | null) {
    const since = new Date(this.nowMs() - this.faceRoomLimits.attemptWindowMs).toISOString();
    const marks = FACE_JOIN_OUTCOMES.map(() => "?").join(",");
    if (this.get(`SELECT COUNT(*) n FROM face_room_attempts WHERE owner_id = ? AND created_at > ? AND outcome IN (${marks})`, ownerId, since, ...FACE_JOIN_OUTCOMES).n >= this.faceRoomLimits.attemptsPerAccount)
      return this.faceRateFail("too many code attempts from this account", "account", this.faceRoomLimits.attemptWindowMs);
    // `ended` / `revoked` / `expired` / `invite_not_found` are also preview refusal codes, and a preview row has
    // no owner (`owner_id IS NULL`). Only this owner-bound filter keeps a read out of the per-address join budget.
    if (ip && this.get(`SELECT COUNT(*) n FROM face_room_attempts WHERE ip = ? AND owner_id IS NOT NULL AND created_at > ? AND outcome IN (${marks})`, ip, since, ...FACE_JOIN_OUTCOMES).n >= this.faceRoomLimits.attemptsPerIp)
      return this.faceRateFail("too many code attempts from this address", "ip", this.faceRoomLimits.attemptWindowMs);
    return null;
  }
  /** Invite-link mints (local rooms and face rooms). Counts only `minted` rows, so it cannot starve a code join. */
  private inviteMintRateLimit(ownerId: string, ip: string | null) {
    const since = new Date(this.nowMs() - this.faceRoomLimits.inviteMintWindowMs).toISOString();
    if (this.get("SELECT COUNT(*) n FROM face_room_attempts WHERE owner_id = ? AND created_at > ? AND outcome = 'minted'", ownerId, since).n >= this.faceRoomLimits.invitesPerAccount)
      return this.faceRateFail("too many invite links from this account", "account_invite", this.faceRoomLimits.inviteMintWindowMs);
    if (ip && this.get("SELECT COUNT(*) n FROM face_room_attempts WHERE ip = ? AND created_at > ? AND outcome = 'minted'", ip, since).n >= this.faceRoomLimits.invitesPerIp)
      return this.faceRateFail("too many invite links from this address", "ip_invite", this.faceRoomLimits.inviteMintWindowMs);
    return null;
  }
  private faceCreateRateLimit(ownerId: string, ip: string | null) {
    const since = new Date(this.nowMs() - this.faceRoomLimits.createWindowMs).toISOString();
    if (this.get("SELECT COUNT(*) n FROM face_room_attempts WHERE owner_id = ? AND created_at > ? AND outcome = 'created'", ownerId, since).n >= this.faceRoomLimits.createsPerAccount)
      return this.faceRateFail("too many face rooms created from this account", "account_create", this.faceRoomLimits.createWindowMs);
    if (ip && this.get("SELECT COUNT(*) n FROM face_room_attempts WHERE ip = ? AND created_at > ? AND outcome = 'created'", ip, since).n >= this.faceRoomLimits.createsPerIp)
      return this.faceRateFail("too many face rooms created from this address", "ip_create", this.faceRoomLimits.createWindowMs);
    return null;
  }
  private normalizeBotRefs(body: any): string[] {
    const raw = body?.bots ?? body?.handles ?? body?.bot_ids ?? body?.bot_id ?? body?.bot ?? body?.handle;
    if (raw === undefined || raw === null || raw === "") return [];
    return (Array.isArray(raw) ? raw : [raw]).map((x) => String(x).trim()).filter(Boolean);
  }
  /** The owner's `bots` list is a list of names, not a value to coerce. An empty list, or an element that is not a
   *  non-empty string, used to be read as "no Bot named" and seat the default member instead: the caller
   *  named a Bot, so the door refuses the shape rather than picking one for them. A Bot token is untouched. */
  private assertFaceBotRefs(body: any) {
    const field = (["bots", "handles", "bot_ids", "bot_id", "bot", "handle"] as const).find((k) => body?.[k] !== undefined && body?.[k] !== null);
    if (!field) return;
    const raw = body[field];
    if (typeof raw === "string") return;
    assert(Array.isArray(raw), 400, "invalid_request", `${field} must be an array of strings`);
    assert(raw.length > 0, 400, "invalid_request", `${field} must name at least one Bot`);
    assert(raw.every((x) => typeof x === "string" && x.trim() !== ""), 400, "invalid_request", `${field} must be an array of strings`);
  }
  private faceBotsToBring(p: Principal, body: any): { bot: any; viaGrant?: any }[] {
    const wrap = (bot: any, viaGrant?: any) => ({ bot, viaGrant });
    if (p.kind === "bot") {
      const extra = this.normalizeBotRefs(body);
      if (extra.some((r) => r !== p.botId && handleKey(r) !== handleKey(this.bot(p.botId).handle))) throw new ApiError(403, "forbidden", "a bot token may only bring itself");
      const b = this.bot(p.botId);
      this.assertInvitable(b);
      return [wrap(b)];
    }
    this.assertFaceBotRefs(body);
    const refs = this.normalizeBotRefs(body);
    if (!refs.length) {
      const members = this.all("SELECT * FROM bots WHERE owner_id = ? AND status = 'active' AND integration_type = 'flybot-member' ORDER BY created_at", p.ownerId);
      if (members.length) return [wrap(members[0])];
      const rest = this.all("SELECT * FROM bots WHERE owner_id = ? AND status = 'active' AND integration_type != 'flybot-home' ORDER BY created_at", p.ownerId);
      if (rest.length) return [wrap(rest[0])];
      const any = this.all("SELECT * FROM bots WHERE owner_id = ? AND status = 'active' ORDER BY created_at", p.ownerId);
      assert(any.length, 404, "bot_not_found", "no bot to bring into the room");
      return [wrap(any[0])];
    }
    const out: { bot: any; viaGrant?: any }[] = [];
    const mine = this.all("SELECT id FROM bots WHERE owner_id = ? AND status = 'active'", p.ownerId).map((b: any) => b.id);
    for (const ref of refs) {
      const own = this.get("SELECT * FROM bots WHERE id = ? AND owner_id = ?", ref, p.ownerId) ?? this.botByRef(ref, "owner_id = ?", [p.ownerId]);
      if (own) {
        this.assertInvitable(own);
        if (!out.some((x) => x.bot.id === own.id)) out.push(wrap(own));
        continue;
      }
      const other = this.get("SELECT * FROM bots WHERE id = ?", ref) ?? this.botByRef(ref);
      assert(other && other.status === "active", 404, "bot_not_found", `no bot matching ${ref} on this account`);
      const grant = this.accessGrantTo(p.ownerId, mine, other.id);
      assert(grant, 404, "bot_not_found", `no bot matching ${ref} on this account`);
      // #23: a reply-only grant (from joining an invite) never lets you bring the other owner's Bot into a room.
      if (grant.reply_only_access) this.refuseUnshared(grant.grantee_bot, other, grant.relationship_id, "face_room.join");
      if (!out.some((x) => x.bot.id === other.id)) out.push(wrap(other, grant));
    }
    return out;
  }
  private faceAddMembers(roomId: string, bots: any[], addedByOwnerId: string) {
    const leadBefore = this.faceEffectiveLeadId(roomId);
    const now = this.ts();
    for (const b of bots) {
      const snap = this.faceSnapshot(b);
      const text = joinSystemText(snap.owner_name, snap.display_name);
      const ev = this.faceInsertEvent(roomId, "member.joined", b.id, { text, member: snap, trust: "platform" });
      const existing = this.get("SELECT 1 FROM face_room_members WHERE room_id = ? AND bot_id = ?", roomId, b.id);
      if (existing) {
        this.run("UPDATE face_room_members SET left_at = NULL, joined_at = ?, join_seq = ?, display_name = ?, owner_name = ?, handle = ?, added_by_owner_id = ? WHERE room_id = ? AND bot_id = ?",
          now, ev.seq, snap.display_name, snap.owner_name, snap.handle, addedByOwnerId, roomId, b.id);
      } else {
        this.run("INSERT INTO face_room_members (room_id, bot_id, owner_id, handle, display_name, owner_name, added_by_owner_id, joined_at, join_seq) VALUES (?,?,?,?,?,?,?,?,?)",
          roomId, b.id, b.owner_id, snap.handle, snap.display_name, snap.owner_name, addedByOwnerId, now, ev.seq);
      }
      this.faceEmitMembers(roomId, "face_room.joined", { room_id: roomId, event_id: ev.id, event_cursor: ev.seq, text, member: snap, trust: "platform" });
    }
    this.faceEmitLeadHandover(roomId, leadBefore);
  }
  /** Implicit room-scoped grants between the newcomers and everyone already in the room (other owners).
   *  `actorOwnerId` scopes the rows' owners; `actor` is who writes them (the joining caller, connector tag included). */
  private syncFaceRoomAccess(roomId: string, newcomers: any[], actorOwnerId: string, actor: string, bring: { bot: any; viaGrant?: any }[]) {
    const members = this.all("SELECT * FROM face_room_members WHERE room_id = ? AND left_at IS NULL", roomId);
    for (const nb of newcomers) {
      for (const em of members) {
        if (em.bot_id === nb.id || em.owner_id === nb.owner_id) continue;
        this.ensurePairRoomGrant(roomId, nb, this.bot(em.bot_id), actor);
      }
    }
    for (const x of bring) {
      if (!x.viaGrant) continue;
      // Only the chat share pays for this seat: `accessGrantTo` brought the Bot in on that row, and the calendar or
      // profile rows of the same bundle are not uses of the room. Recording them was what let ending one of them
      // take the seat away (the judgement in `endGrantRooms` still covers the rows that fix left behind).
      const siblings = this.all("SELECT id FROM grants WHERE relationship_id = ? AND grantor_owner = ? AND grantee_bot = ? AND status = 'active' AND room_id IS NULL AND capability = 'chat.public' AND IFNULL(reply_only, 0) = 0",
        x.viaGrant.relationship_id, x.viaGrant.grantor_owner, x.viaGrant.grantee_bot);
      const ids = siblings.length ? siblings.map((s: any) => s.id) : [x.viaGrant.id];
      for (const gid of ids) this.recordGrantRoomUse(gid, roomId, actor, [actorOwnerId, x.bot.owner_id]);
    }
  }
  private ensurePairRoomGrant(roomId: string, a: any, b: any, actor: string) {
    // Layer 2 of #111: the join doors already refuse a blocked pair, so this is the backstop for any path that
    // still arrives here (a seat sync, a claim). A block outlives the room it was made in; never rebuild its door.
    if (this.pairRelationships(a.id, b.id).some((r: any) => r.status === "blocked")) return;
    const hit = this.get(`SELECT g.id FROM grants g JOIN relationships r ON r.id = g.relationship_id
      WHERE g.room_id = ? AND g.status = 'active' AND r.status = 'room'
      AND ((r.requester_bot = ? AND r.target_bot = ?) OR (r.requester_bot = ? AND r.target_bot = ?))`, roomId, a.id, b.id, b.id, a.id);
    if (hit) return;
    const id = newId("rel");
    const now = nowIso();
    this.run(`INSERT INTO relationships (id, requester_bot, target_bot, requester_owner, target_owner, status, message, requested_caps, offered_caps, created_at, updated_at, requester_scope, target_scope)
      VALUES (?,?,?,?,?,'room',?,?,?,?,?,'bot','bot')`, id, a.id, b.id, a.owner_id, b.owner_id, "face room", "[]", "[]", now, now);
    for (const cap of DEFAULT_CAPABILITIES) {
      this.insertGrant(id, a.owner_id, b.id, cap, { kind: "room", room_id: roomId }, undefined, actor, { roomId });
      this.insertGrant(id, b.owner_id, a.id, cap, { kind: "room", room_id: roomId }, undefined, actor, { roomId });
    }
  }
  private removeFaceMember(roomId: string, m: any, reason: FaceRoomCloseReason) {
    if (m.left_at) return;
    const leadBefore = this.faceEffectiveLeadId(roomId);
    const now = this.ts();
    const n = this.run("UPDATE face_room_members SET left_at = ? WHERE room_id = ? AND bot_id = ? AND left_at IS NULL", now, roomId, m.bot_id);
    if (!n.changes) return;
    const text = leaveSystemText(m.owner_name, m.display_name);
    const member = this.faceMemberPublic(m);
    const ev = this.faceInsertEvent(roomId, "member.left", m.bot_id, { text, member, trust: "platform" });
    this.emit(m.bot_id, "face_room.left", { room_id: roomId, event_id: ev.id, event_cursor: ev.seq, text, member, trust: "platform", self: true });
    this.faceEmitMembers(roomId, "face_room.left", { room_id: roomId, event_id: ev.id, event_cursor: ev.seq, text, member, trust: "platform" });
    // The chosen lead left: back to the default lead (FlyBot #476). Its own event already names the Bot that
    // takes over, so this door must not announce the same change twice.
    let announced = false;
    if (this.get("SELECT 1 FROM face_rooms WHERE id = ? AND lead_bot_id = ?", roomId, m.bot_id)) {
      this.faceSetLead(roomId, null, "lead_left", m.bot_id);
      announced = true;
    }
    this.faceCloseIfEmpty(roomId, reason);
    // The seat ends here for every door that takes one (a Bot's own `leave`, an owner taking a guest seat back, a
    // revoked share or home member). A line this Bot left waiting in this room can never be delivered: the
    // delivery door refuses it as `not_a_member`, so the card would sit in its owner's queue for 24 hours and then
    // die unexplained. Settle it the moment the seat goes. Ordered after the empty-room door on purpose: the last
    // member out closes the room, and `faceCloseIfEmpty` already settles every line there as `room_closed`, so a
    // second decision is never written.
    this.settleHeldRoomCards(roomId, m.bot_id);
    this.faceEmitLeadHandover(roomId, leadBefore, announced);
  }
  private endRoomGrantsForBots(roomId: string, botIds: string[]) {
    if (!botIds.length) return;
    const now = nowIso();
    const rows = this.all("SELECT * FROM grants WHERE room_id = ? AND status = 'active'", roomId);
    for (const g of rows) {
      const r = this.get("SELECT * FROM relationships WHERE id = ?", g.relationship_id);
      const granted = this.grantedBotOf(g, r);
      if (!botIds.includes(g.grantee_bot) && !botIds.includes(granted)) continue;
      this.run("UPDATE grants SET status = 'revoked', revoked_at = ? WHERE id = ?", now, g.id);
      this.audit.append("platform", "grant.revoked", g.id, [r?.requester_owner, r?.target_owner], { reason: "room_left", room_id: roomId, grantee_bot: g.grantee_bot });
    }
    if (botIds.length) {
      const marks = botIds.map(() => "?").join(",");
      this.run(`UPDATE grant_rooms SET ended_at = ? WHERE room_id = ? AND ended_at IS NULL AND grant_id IN (
        SELECT g.id FROM grants g JOIN relationships r ON r.id = g.relationship_id
        WHERE g.grantee_bot IN (${marks}) OR r.requester_bot IN (${marks}) OR r.target_bot IN (${marks}))`,
        now, roomId, ...botIds, ...botIds, ...botIds);
    }
    this.run("UPDATE relationships SET status = 'revoked', updated_at = ? WHERE status = 'room' AND id IN (SELECT relationship_id FROM grants WHERE room_id = ?) AND NOT EXISTS (SELECT 1 FROM grants g2 WHERE g2.relationship_id = relationships.id AND g2.status = 'active')", now, roomId);
  }
  /** Why a room ended, as the recap says it: the last seat left on its own, someone took its seat back, or the
   *  share that paid for it lapsed. */
  private faceCloseIfEmpty(roomId: string, reason: FaceRoomCloseReason) {
    if (this.get("SELECT COUNT(*) n FROM face_room_members WHERE room_id = ? AND left_at IS NULL", roomId).n) return;
    const now = this.ts();
    // One closure only: the claim is the UPDATE itself, so a second call (the same door again, or a sweep racing the
    // last seat out) neither re-settles the room nor hands out a second recap.
    const claim = this.run("UPDATE face_rooms SET status = 'closed', closed_at = ?, code = NULL WHERE id = ? AND status != 'closed'", now, roomId);
    if (!claim.changes) return;
    this.run("DELETE FROM face_room_codes WHERE room_id = ?", roomId);
    // A line still waiting here is dropped by the closure, and its Bot must be told: cancelling the rows by hand
    // left it with a card that changed under it and no `approval.decided` to say why. The canceller every other
    // closed door uses settles the same rows, keeps `room_closed` as the decision on the card, and announces it once.
    this.cancelPendingFor(
      `kind = 'face_room_message' AND subject_id IN (SELECT id FROM face_room_drafts WHERE room_id = ? AND status = 'pending_approval')`,
      [roomId], "room_closed", { notify: true });
    for (const g of this.all("SELECT * FROM grants WHERE room_id = ? AND status = 'active'", roomId)) {
      this.run("UPDATE grants SET status = 'revoked', revoked_at = ? WHERE id = ?", now, g.id);
      this.audit.append("platform", "grant.revoked", g.id, [], { reason: "room_closed", room_id: roomId });
    }
    this.run("UPDATE grant_rooms SET ended_at = ? WHERE room_id = ? AND ended_at IS NULL", now, roomId);
    this.run("UPDATE relationships SET status = 'revoked', updated_at = ? WHERE status = 'room' AND id IN (SELECT relationship_id FROM grants WHERE room_id = ?)", now, roomId);
    // The room is gone: it is not listed any more and its transcript is behind the join floor, so the recap is what
    // a member keeps. Written after the cancellations above, so the lines the closure dropped are counted, and handed
    // to every seat the room ever had — one identical payload each, nothing trimmed by arrival and nothing per
    // recipient. A member that was never seated by the room cannot read it.
    const recap = this.faceCloseRecap(this.get("SELECT * FROM face_rooms WHERE id = ?", roomId), reason);
    this.run("UPDATE face_rooms SET recap = ? WHERE id = ?", JSON.stringify(recap), roomId);
    for (const m of this.all("SELECT DISTINCT bot_id FROM face_room_members WHERE room_id = ? ORDER BY bot_id", roomId)) {
      this.emit(m.bot_id, "face_room.recap", recap);
    }
  }
  /** The recap of a closed room: counts and names only. Never a line's text, and never per recipient — the same object
   *  goes to every member, so two members cannot disagree about what the room decided. */
  private faceCloseRecap(room: any, reason: FaceRoomCloseReason) {
    const decisions: Record<string, number> = { approved: 0, rejected: 0, cancelled: 0, expired: 0 };
    for (const row of this.all(`SELECT a.status, COUNT(*) n FROM approvals a
        WHERE a.kind = 'face_room_message' AND a.subject_id IN (SELECT id FROM face_room_drafts WHERE room_id = ?)
        GROUP BY a.status`, room.id)) {
      if (Object.hasOwn(decisions, row.status)) decisions[row.status] = row.n;
    }
    return {
      recap_version: 1,
      room_id: room.id as string,
      reason,
      note: (room.note ?? null) as string | null,
      started_at: (room.started_at ?? null) as string | null,
      closed_at: room.closed_at as string,
      members: this.all("SELECT bot_id, handle, owner_name FROM face_room_members WHERE room_id = ? ORDER BY joined_at, bot_id", room.id)
        .map((m: any) => ({ handle: "@" + String(m.handle).replace(/^@/, ""), owner_name: m.owner_name })),
      decisions,
    };
  }
  /**
   * The matching-window deadline is the candidate's alone: `open` means the number is void, and the room then ends
   * when its last member leaves, not when the window ran out. Rows written before a start was cleared still hold the
   * old time, so an `open` room reports no deadline whatever its row says.
   */
  private faceRoomDeadline(room: { status: string; expires_at: string | null }): string | null {
    if (room.status === "open") return null;
    return room.expires_at || null;
  }
  private faceStartRoom(room: any, reason: "expired" | "start", actor?: { actor: string; botId?: string }) {
    if (room.status !== "candidate") return;
    const now = this.ts();
    // Claim the promotion with one conditional UPDATE, so two doors that both read `candidate` cannot both promote
    // it, and a room started by its owner already cannot be flipped again by a sweep that read the older row.
    // The matching window dies with the number it belonged to: `expires_at` is NOT NULL, so the column's own "no
    // deadline" value is the empty string (the same convention `local_room_invites` uses) and every reader maps it
    // to null.
    const claim = reason === "expired"
      ? this.run("UPDATE face_rooms SET status = 'open', started_at = ?, expires_at = '', code = NULL WHERE id = ? AND status = 'candidate' AND expires_at <= ?", now, room.id, now)
      : this.run("UPDATE face_rooms SET status = 'open', started_at = ?, expires_at = '', code = NULL WHERE id = ? AND status = 'candidate'", now, room.id);
    if (!claim.changes) return;
    this.run("DELETE FROM face_room_codes WHERE room_id = ?", room.id);
    const text = reason === "expired"
      ? "The matching window ended. The room is now open. The number is no longer valid."
      : "The room is now open. The number is no longer valid.";
    const ev = this.faceInsertEvent(room.id, "room.started", actor?.botId ?? null, { text, reason, trust: "platform" });
    this.faceEmitMembers(room.id, "face_room.started", { room_id: room.id, event_id: ev.id, event_cursor: ev.seq, text, reason, trust: "platform" });
    this.audit.append(actor ? actor.actor : "platform", "face_room.started", room.id, this.faceOwnerIds(room.id), { reason });
  }
  /** Promote expired candidate rooms to normal groups and void their numbers. Safe to call often.
   *
   *  `onlyRoomIds` narrows the sweep to the rooms the caller already holds a seat in. Promotion is not a private
   *  act - it voids the number, deletes its code rows and wakes every member - so a door that is not the room's own
   *  must not settle a room it cannot see. A caller with no seat anywhere settles nothing. */
  advanceFaceRooms(onlyRoomIds?: ReadonlySet<string>) {
    // The face-room doors that read or move a seat call this first; the invite and join-by-invite doors settle it
    // through `faceSettledRoom` before they answer.
    this.expireLapsedShares();
    if (onlyRoomIds) {
      const ids = [...onlyRoomIds];
      if (!ids.length) return;
      for (const r of this.all(`SELECT * FROM face_rooms WHERE status = 'candidate' AND expires_at <= ? AND id IN (${ids.map(() => "?").join(",")})`, this.ts(), ...ids)) this.faceStartRoom(r, "expired");
      return;
    }
    // No lapsed window, nothing to promote: read doors (a preview is one) must not turn a read into a table sweep.
    if (!this.get("SELECT 1 FROM face_rooms WHERE status = 'candidate' AND expires_at <= ? LIMIT 1", this.ts())) return;
    for (const r of this.all("SELECT * FROM face_rooms WHERE status = 'candidate' AND expires_at <= ?", this.ts())) this.faceStartRoom(r, "expired");
  }
  /** The rooms this caller already holds a seat in, read with the seat rule the doors themselves answer with.
   *
   *  A sweep is not a private act: it voids the room's number, deletes its code rows, writes a `room.started` event,
   *  wakes every member and appends an audit row. A door that is not the room's own therefore settles only the lapsed
   *  rooms its caller is a member of - the predicate `faceRequireMember` admits (`owner_id`, or a seat this home
   *  brought another home's Bot into and still stands behind), narrowed to its own Bot when the token is a Bot's - and a
   *  caller seated nowhere settles nothing. */
  private faceSeatRooms(p: Principal): ReadonlySet<string> {
    const args: unknown[] = [p.ownerId, p.ownerId, p.ownerId, p.ownerId];
    let sql = `SELECT DISTINCT room_id FROM face_room_members WHERE left_at IS NULL AND (owner_id = ? OR (added_by_owner_id = ? AND (
      NOT EXISTS (SELECT 1 FROM face_room_members gone WHERE gone.room_id = face_room_members.room_id AND gone.owner_id = ? AND gone.left_at IS NOT NULL)
      OR EXISTS (SELECT 1 FROM face_room_members seated WHERE seated.room_id = face_room_members.room_id AND seated.owner_id = ? AND seated.left_at IS NULL))))`;
    if (p.kind === "bot") { sql += " AND bot_id = ?"; args.push(p.botId); }
    return new Set(this.all(sql, ...args).map((r: any) => r.room_id as string));
  }
  /** The room row after any lapsed matching window is settled, so every door answers the same status as a GET. */
  private faceSettledRoom(roomId: string) {
    // A view is the room's own door: it settles that room, never the platform. The join reply and a member's room
    // GET used to promote every lapsed candidate here after already answering, which is the same flaw one layer up.
    this.advanceFaceRooms(new Set([roomId]));
    return this.get("SELECT * FROM face_rooms WHERE id = ?", roomId);
  }
  /**
   * A share that lapsed by TIME ends its room uses exactly like `revokeGrant` / `revokeBotGrant` /
   * `declineBotGrant` do: `grant_rooms` records the face rooms a per-bot share put the shared Bot into, and only
   * those seats are given back. A room both owners entered themselves has no `grant_rooms` row, so it keeps its
   * seats; `endGrantRooms` decides that from the record, not from the pair. Nothing else expires: the room-scoped
   * grants that seat wrote are ended by `endGrantRooms` itself, as on the revoke path.
   */
  private expireLapsedShares() {
    // `expired` is in the row set on purpose: lazy readers (`findGrant`, `grantsFor`, a conversation GET through
    // `effectiveCaps`) flip a lapsed row to `expired` in place and never touch `grant_rooms`, so those rows keep an
    // open usage with nothing to end them; the pre-flipped case is its own test (case 4). The clock is compared in
    // SQL so this stays one indexed-shaped query per face-room door, not a table walk in JS.
    const rows = this.all("SELECT id, status FROM grants WHERE status IN ('active','expired') AND room_id IS NULL AND expires_at IS NOT NULL AND expires_at <= ?", this.ts());
    const ended = new Set<string>();
    for (const g of rows) {
      if (g.status === "active") this.run("UPDATE grants SET status = 'expired' WHERE id = ? AND status = 'active'", g.id);
      // A share can still be holding a seat after the room's own sweep closed its usage row (the seat is kept on
      // purpose when the bringer leaves first), so this gate cannot ask whether the usage is open. It asks the
      // rooms: is a guest seat still there in a room this share brought a Bot into? A share with nothing left to
      // give back answers no and is not handed over again. `endGrantRooms` still decides which seats are this
      // share's — this is a pre-filter, never a policy. When the usage has already ended, only a seat that was
      // already there before it ended can be this share's; a seat that arrived later belongs to the share that let
      // it back in (the same grantor/grantee bot/capability row is swept separately).
      // A renewal writes a new row and leaves the seat on the row it replaced, so the seat this lapse must give back
      // sits on an ancestor: the lineage is asked row by row, with the same window on every row, and an ended ancestor
      // can claim no seat that arrived after it ended.
      // A line that was renewed again after this row lapsed still has a live row: that row carries the share, so this
      // row's lapse is not the line's lapse and no seat is handed over (a seat this row made is the line's, exactly
      // like one an ancestor made). The check is new in this rule: before it, the sweep took the row it saw.
      const self = this.get("SELECT * FROM grants WHERE id = ?", g.id);
      const lineLive = !!self && !!this.get(`SELECT 1 FROM grants WHERE relationship_id = ? AND grantor_owner = ? AND grantee_bot = ?
          AND capability = ? AND IFNULL(room_id,'') = ? AND status = 'active' AND created_at > ? LIMIT 1`,
        self.relationship_id, self.grantor_owner, self.grantee_bot, self.capability, self.room_id ?? "", self.created_at);
      if (lineLive) {
        // This row lapsed and was renewed before any sweep ran: the renewal already told the peer Bot it holds the
        // capability, so announcing this row's old expiry would say the opposite of the truth. Settlement is still
        // written, silently, so a later sweep cannot announce the lapse once the live row it was renewed into ends.
        if (!self.revoked_at) this.run("UPDATE grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", self.expires_at, self.id);
        continue;
      }
      // The cards this share was holding settle with the lapse, as they do on the revoke and decline doors: the
      // owner must not keep a card that can never be approved, and the Bot that drafted it must hear why. The sweep
      // is the lapse's own door, so it writes the lapse's word; a settled card is not pending, so a later sweep
      // settles nothing again.
      this.settleCardsForEndedShare([self], "grant_expired");
      this.announceLapsedShare(self);
      for (const id of this.shareLineage([g.id])) {
        if (this.get(`SELECT 1 FROM grant_rooms u WHERE u.grant_id = ?
            AND (u.ended_at IS NULL OR EXISTS (SELECT 1 FROM face_room_members m
              WHERE m.room_id = u.room_id AND m.left_at IS NULL AND m.added_by_owner_id != m.owner_id
                AND m.joined_at <= u.ended_at))
            LIMIT 1`, id)) ended.add(id);
      }
    }
    if (ended.size) this.endGrantRooms([...ended], "platform", "expired");
  }

  /**
   * A share that lapsed on its own clock is written down exactly once, and this sweep is the only door that does
   * it: lazy readers flip a lapsed row to `expired` in place and must stay silent, because a GET is not a decision.
   * The mark that makes it once is the row's own `revoked_at`, so a second sweep, another door that sweeps, and a
   * row a reader already flipped all end at the same single `grant.expired`. It carries the row's `expires_at`,
   * the moment the access really ended, never the sweep's clock. The peer Bot is told with `grant.changed` /
   * `status: "expired"` so the Bot it lost access to no longer vanishes from its remote list unexplained.
   */
  private announceLapsedShare(g: any) {
    const when = g.expires_at ?? this.ts();
    // One claim, so two sweeps racing on the same row cannot both announce it. A row a reader already settled has
    // no `revoked_at` and is still announced here: settling the status is not settling the record.
    // The claim is also the mark that silences every later sweep, so it cannot be durable before what it marks is:
    // a refusal of the `events` write used to leave the row claimed and the Bot that lost the access silent for
    // good, because each later sweep returns on the claim it finds. One transaction holds the claim and the
    // `grant.changed` event, so a refusal rolls both back and the next sweep can still announce the lapse; the push
    // waits for that commit (`afterCommitPushes`). The `grant.expired` audit row lives in another file: the append is
    // held by `auditFollowsCommit` and written after this commit, so a refusal there is a separate, older boundary
    // this transaction cannot close, while a rollback here still drops the held record unwritten.
    this.atomically(() => {
      const claim = this.run("UPDATE grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", when, g.id);
      if (!claim.changes) return;
      const r = this.get("SELECT * FROM relationships WHERE id = ?", g.relationship_id);
      this.audit.append("platform", "grant.expired", g.id, [r?.requester_owner, r?.target_owner], {
        relationship_id: g.relationship_id, capability: g.capability, grantee_bot: g.grantee_bot, granted_bot: this.grantedBotOf(g, r),
      });
      this.emit(g.grantee_bot, "grant.changed", { relationship_id: g.relationship_id, capability: g.capability, status: "expired" });
    });
  }

  private faceRequireMember(p: Principal, roomId: string, asBot?: string) {
    const room = this.get("SELECT * FROM face_rooms WHERE id = ?", roomId);
    if (!room) throw new ApiError(404, "face_room_not_found", "no such room");
    const ownerId = p.ownerId;
    // A seat of your own is what makes the room yours. A Bot another owner brought in on the share you hold on it
    // is not one: once your last Bot has left, the guest still sitting there must not keep the room open to you.
    // An owner who never took a seat here (they only brought the guest in) is not a leaver and keeps that access.
    let sql = `SELECT * FROM face_room_members WHERE room_id = ? AND left_at IS NULL AND (owner_id = ? OR (added_by_owner_id = ? AND (
      NOT EXISTS (SELECT 1 FROM face_room_members gone WHERE gone.room_id = face_room_members.room_id AND gone.owner_id = ? AND gone.left_at IS NOT NULL)
      OR EXISTS (SELECT 1 FROM face_room_members seated WHERE seated.room_id = face_room_members.room_id AND seated.owner_id = ? AND seated.left_at IS NULL))))`;
    const args: unknown[] = [roomId, ownerId, ownerId, ownerId, ownerId];
    if (p.kind === "bot") { sql += " AND bot_id = ?"; args.push(p.botId); }
    let members = this.all(sql, ...args);
    if (asBot) {
      const raw = handleRef(asBot);
      const exact = members.filter((m: any) => m.bot_id === asBot || String(m.handle ?? "").replace(/^@/, "") === raw);
      members = exact.length ? exact : members.filter((m: any) => handleKey(m.handle) === raw.toLowerCase());
      if (!exact.length && members.length > 1) throw ambiguous(raw, members.length);
    }
    if (!members.length) throw new ApiError(404, "face_room_not_found", "no such room");
    return { ownerId, botIds: members.map((m: any) => m.bot_id as string), members, joinSeq: Math.min(...members.map((m: any) => m.join_seq as number)), room };
  }

  /**
   * #318: a home that only brought a guest in can read the room it put someone into (`faceRequireMember` above),
   * but acting on the room for everyone is for a home with a seat of its own still seated in it. Used by the write
   * door `start`; the reading doors keep the wider predicate.
   */
  private faceRequireOwnSeat(p: Principal, roomId: string) {
    const room = this.get("SELECT * FROM face_rooms WHERE id = ?", roomId);
    if (!room) throw new ApiError(404, "face_room_not_found", "no such room");
    let sql = "SELECT * FROM face_room_members WHERE room_id = ? AND left_at IS NULL AND owner_id = ?";
    const args: unknown[] = [roomId, p.ownerId];
    if (p.kind === "bot") { sql += " AND bot_id = ?"; args.push(p.botId); }
    const members = this.all(sql, ...args);
    if (!members.length) throw new ApiError(404, "face_room_not_found", "no such room");
    return { ownerId: p.ownerId, botIds: members.map((m: any) => m.bot_id as string), members, joinSeq: Math.min(...members.map((m: any) => m.join_seq as number)), room };
  }

  /**
   * The answer a join gives, built from what the join itself proves: the seats this owner already holds, and the
   * seats it just wrote (`seated`). A joiner with neither — a leaver bringing a guest who already sits there — gets
   * the room back with no events, not the history its own read door keeps shut. The seat rule in faceRequireMember
   * decides every later read, so this answer is not a way into a room that rule keeps from the caller.
   */
  private faceJoinViewer(p: Principal, roomId: string, seated: string[]) {
    const rows: any[] = [];
    let ownSql = "SELECT join_seq FROM face_room_members WHERE room_id = ? AND left_at IS NULL AND owner_id = ?";
    const ownArgs: unknown[] = [roomId, p.ownerId];
    if (p.kind === "bot") { ownSql += " AND bot_id = ?"; ownArgs.push(p.botId); }
    rows.push(...this.all(ownSql, ...ownArgs));
    if (seated.length) {
      const marks = seated.map(() => "?").join(",");
      rows.push(...this.all(`SELECT join_seq FROM face_room_members WHERE room_id = ? AND left_at IS NULL AND bot_id IN (${marks})`, roomId, ...seated));
    }
    if (rows.length) return { ownerId: p.ownerId, joinSeq: Math.min(...rows.map((r: any) => r.join_seq as number)) };
    // Nothing this join proves: start after the newest event, so the answer carries the room and no history.
    const top = this.get("SELECT COALESCE(MAX(seq), 0) AS top FROM face_room_events WHERE room_id = ?", roomId)?.top as number;
    return { ownerId: p.ownerId, joinSeq: (top ?? 0) + 1 };
  }

  /**
   * #111: a block is a decision about a Bot pair, so seating the pair in a room again must not hand back the room
   * door the block closed. Asked for the Bots about to take a seat against the ones already in the room.
   */
  private facePairBlocked(newcomers: any[], active: any[]): boolean {
    return newcomers.some((n: any) => active.some((m: any) =>
      m.bot_id !== n.id && this.pairRelationships(n.id, m.bot_id).some((r: any) => r.status === "blocked")));
  }

  /** Who made the room: stored at creation; for a room from before that, the owner whose Bot joined first. */
  private faceCreatorOf(room: any): string | null {
    if (room.created_by_owner_id) return room.created_by_owner_id;
    return this.get("SELECT owner_id FROM face_room_members WHERE room_id = ? ORDER BY join_seq ASC LIMIT 1", room.id)?.owner_id ?? null;
  }
  /**
   * The room lead (FlyBot #476): `set` is the Bot the creator picked (null until picked), `effective` the one
   * every home follows: the set lead, else the first Bot of the creator's home that joined (still in the room),
   * else the first Bot that joined.
   */
  private faceLeadOf(room: any): { set: any | null; effective: any | null } {
    const active = this.all("SELECT * FROM face_room_members WHERE room_id = ? AND left_at IS NULL ORDER BY join_seq ASC", room.id);
    const set = room.lead_bot_id ? active.find((m: any) => m.bot_id === room.lead_bot_id) ?? null : null;
    const creator = this.faceCreatorOf(room);
    return { set, effective: set ?? active.find((m: any) => m.owner_id === creator) ?? active[0] ?? null };
  }
  private faceLeadFields(roomId: string) {
    const lead = this.faceLeadOf(this.get("SELECT * FROM face_rooms WHERE id = ?", roomId));
    return { lead_bot_handle: lead.set?.handle ?? null, effective_lead_bot_handle: lead.effective?.handle ?? null };
  }
  /** The Bot every home follows right now, as an id (null when the room has no members left). */
  private faceEffectiveLeadId(roomId: string): string | null {
    return this.faceLeadOf(this.get("SELECT * FROM face_rooms WHERE id = ?", roomId)).effective?.bot_id ?? null;
  }
  /**
   * A join, a leave or a removal can move the default lead by itself: the creator's first Bot still in the room
   * leads, so another home can inherit the room without the creator picking anyone. Announce that like any other
   * lead change. The one exception is a picked lead's own exit, which the caller passes as `announced`: its
   * `lead_left` event already carries the new `effective_lead_bot_handle`, and a second event would say it twice.
   */
  private faceEmitLeadHandover(roomId: string, before: string | null, announced = false) {
    if (announced || !before) return;
    const lead = this.faceLeadOf(this.get("SELECT * FROM face_rooms WHERE id = ?", roomId));
    const effective = lead.effective;
    if (!effective || effective.bot_id === before) return;
    const data = {
      text: leadSystemText(effective, "handover"),
      reason: "handover",
      lead: lead.set ? this.faceMemberPublic(lead.set) : null,
      lead_bot_handle: lead.set?.handle ?? null,
      effective_lead_bot_handle: effective.handle,
      trust: "platform",
    };
    const ev = this.faceInsertEvent(roomId, "room.lead_changed", null, data);
    this.faceEmitMembers(roomId, "face_room.lead_changed", { room_id: roomId, event_id: ev.id, event_cursor: ev.seq, ...data });
  }
  /** Store the lead (null = default), and tell every member with a platform event. */
  private faceSetLead(roomId: string, botId: string | null, reason: "set" | "cleared" | "lead_left", actorBot: string | null) {
    this.run("UPDATE face_rooms SET lead_bot_id = ? WHERE id = ?", botId, roomId);
    const m = botId ? this.get("SELECT * FROM face_room_members WHERE room_id = ? AND bot_id = ?", roomId, botId) : null;
    const lead = m ? this.faceMemberPublic(m) : null;
    const data = { text: leadSystemText(lead, reason), reason, lead, ...this.faceLeadFields(roomId), trust: "platform" };
    const ev = this.faceInsertEvent(roomId, "room.lead_changed", actorBot, data);
    this.faceEmitMembers(roomId, "face_room.lead_changed", { room_id: roomId, event_id: ev.id, event_cursor: ev.seq, ...data });
  }
  /**
   * The `after` a read may bind: the cursor a previous answer ended on, or `fallback` when the caller named none.
   * It is the one place a cursor enters the query, so a value that is not a non-negative integer is refused here
   * rather than bound to `seq > ?` (a `NaN` reads as "no floor", a fraction half-applies the window).
   */
  private faceCursor(after: unknown, fallback: number): number {
    if (after === undefined || after === null) return fallback;
    assert(Number.isSafeInteger(after) && (after as number) >= 0, 400, "invalid_request", "after must be a non-negative integer");
    return after as number;
  }
  private faceRoomView(roomId: string, viewer: { joinSeq?: number; ownerId?: string }, opts: { after?: number } = {}) {
    // The view is the one place `status` and `started_at` come from, and it reads the settled row, so an entry that
    // answers with a room view cannot answer a room the matching window has already opened.
    const room = this.faceSettledRoom(roomId);
    const creator = this.faceCreatorOf(room);
    const creatorOwner = creator ? this.get("SELECT display_name, username FROM owners WHERE id = ?", creator) : null;
    const members = this.all("SELECT * FROM face_room_members WHERE room_id = ? AND left_at IS NULL ORDER BY joined_at", roomId).map((m: any) => this.faceMemberPublic(m, true));
    const floor = (viewer.joinSeq ?? 1) - 1;
    const after = this.faceCursor(opts.after, floor);
    const events = this.all("SELECT * FROM face_room_events WHERE room_id = ? AND seq > ? ORDER BY seq ASC", roomId, after).map((e: any) => this.faceEventPublic(e));
    return {
      room_id: room.id, status: room.status, expires_at: this.faceRoomDeadline(room), started_at: room.started_at, closed_at: room.closed_at,
      created_by: creatorOwner ? { owner_name: peerOwnerName(creatorOwner, "Owner") } : null,
      created_by_me: Boolean(creator && viewer.ownerId === creator),
      // Room metadata outside the floor rule: a member who joined after the note was written still reads it.
      note: room.note ?? null,
      ...this.faceLeadFields(roomId),
      members, event_cursor: events.length ? events[events.length - 1].event_cursor : after, events,
    };
  }

  /**
   * Enter a 6-digit code: create a candidate room if none exists, otherwise join it.
   * Never returns room contents on failure. Race-safe (BEGIN IMMEDIATE).
   */
  joinFaceRoom(p: Principal, body: any, ctx: { ip?: string } = {}) {
    const ownerId = p.ownerId;
    const actor = this.actorOf(p);
    const ip = String(ctx.ip ?? "").slice(0, 80) || null;
    const bring = this.faceBotsToBring(p, body);
    const bots = bring.map((x) => x.bot);
    const rawCode = body?.code;
    const codeOk = isFaceCode(rawCode);
    const code = codeOk ? String(rawCode).trim() : "";
    // The sweep this door runs settles only the lapsed rooms the request itself already holds a seat in. Promotion
    // voids the number, deletes its rows and wakes every member, so a caller seated nowhere must not start another
    // home's room by knocking - the number is read after this, and a stranger's fabricated one settles nothing.
    const seatRooms = new Set<string>(bots.length
      ? this.all(`SELECT DISTINCT room_id FROM face_room_members WHERE left_at IS NULL AND bot_id IN (${bots.map(() => "?").join(",")})`, ...bots.map((b) => b.id)).map((r: any) => r.room_id as string)
      : []);
    type Fail = { ok: false; status: number; code: string; message: string; extra?: Record<string, unknown>; lockout?: boolean };
    type Ok = { ok: true; created: boolean; roomId: string; seated: string[] };
    const txn = this.db.transaction((): Ok | Fail => {
      this.advanceFaceRooms(seatRooms);
      const locked = this.faceLockoutUntil(ownerId, ip);
      if (locked) {
        this.faceRecordAttempt(ownerId, ip, code || String(rawCode ?? ""), "locked_out");
        return { ok: false, status: 429, code: "locked_out", message: "too many failed code attempts; try again later", extra: { retry_after: Math.max(1, Math.ceil((Date.parse(locked) - this.nowMs()) / 1000)) } };
      }
      const attemptBlock = this.faceAttemptRateLimit(ownerId, ip);
      // Refused for being over budget is not an attempt: it writes no row, or the client's own retries would
      // keep the window full. A lockout hit still writes one: that is a separate, older judgement.
      if (attemptBlock) return { ...attemptBlock };
      if (!codeOk) {
        this.faceRecordAttempt(ownerId, ip, String(rawCode ?? ""), "invalid_code");
        return { ok: false, status: 400, code: "invalid_code", message: "code must be exactly 6 digits", lockout: this.faceMaybeLockout(ownerId, ip) };
      }
      const mapping = this.get("SELECT * FROM face_room_codes WHERE code = ?", code);
      if (!mapping) {
        const createBlock = this.faceCreateRateLimit(ownerId, ip);
        if (createBlock) return { ...createBlock };
        if (bots.length > this.faceRoomLimits.maxMembers) {
          this.faceRecordAttempt(ownerId, ip, code, "room_full");
          return { ok: false, status: 409, code: "room_full", message: `this room is full (max ${this.faceRoomLimits.maxMembers} bots); no second room is opened`, lockout: this.faceMaybeLockout(ownerId, ip) };
        }
        const id = newId("frm");
        const now = this.ts();
        const expires = new Date(this.nowMs() + this.faceRoomLimits.ttlMs).toISOString();
        this.run("INSERT INTO face_rooms (id, code, status, created_at, expires_at, created_by_owner_id) VALUES (?,?,?,?,?,?)", id, code, "candidate", now, expires, ownerId);
        this.run("INSERT INTO face_room_codes (code, room_id, expires_at) VALUES (?,?,?)", code, id, expires);
        this.faceAddMembers(id, bots, ownerId);
        this.syncFaceRoomAccess(id, bots, ownerId, actor, bring);
        this.faceRecordAttempt(ownerId, ip, code, "created");
        return { ok: true, created: true, roomId: id, seated: bots.map((b) => b.id) };
      }
      const room = this.get("SELECT * FROM face_rooms WHERE id = ?", mapping.room_id);
      if (!room || room.status !== "candidate" || Date.parse(room.expires_at) <= this.nowMs()) {
        this.faceRecordAttempt(ownerId, ip, code, "code_void");
        return { ok: false, status: 409, code: "code_void", message: "this number is no longer valid", lockout: this.faceMaybeLockout(ownerId, ip) };
      }
      const active = this.all("SELECT bot_id FROM face_room_members WHERE room_id = ? AND left_at IS NULL", room.id);
      const activeSet = new Set(active.map((m: any) => m.bot_id));
      const newcomers = bots.filter((b) => !activeSet.has(b.id));
      if (active.length + newcomers.length > this.faceRoomLimits.maxMembers) {
        this.faceRecordAttempt(ownerId, ip, code, "room_full");
        return { ok: false, status: 409, code: "room_full", message: `this room is full (max ${this.faceRoomLimits.maxMembers} bots); no second room is opened`, lockout: this.faceMaybeLockout(ownerId, ip) };
      }
      if (newcomers.length && this.facePairBlocked(newcomers, active)) {
        // #111: a block closes this pair's room door, so re-entering the same number must not seat them again.
        // Refused whole, before a seat is written, in the answer this door already gives for a number that has
        // just died: a valid number is not refused this way, so the caller reads it as the room ending, not as a
        // block. The attempt is counted as the same kind of failure, so the lockout bookkeeping is unchanged.
        this.faceRecordAttempt(ownerId, ip, code, "code_void");
        return { ok: false, status: 409, code: "code_void", message: "this number is no longer valid", lockout: this.faceMaybeLockout(ownerId, ip) };
      }
      if (newcomers.length) {
        this.faceAddMembers(room.id, newcomers, ownerId);
        this.syncFaceRoomAccess(room.id, newcomers, ownerId, actor, bring.filter((x) => newcomers.some((n) => n.id === x.bot.id)));
      }
      this.faceRecordAttempt(ownerId, ip, code, newcomers.length ? "joined" : "rejoined");
      return { ok: true, created: false, roomId: room.id, seated: newcomers.map((n: any) => n.id) };
    });
    const out = txn.immediate();
    if (!out.ok) {
      if (out.lockout) this.audit.append(actor, "face_room.lockout", null, [ownerId], { ip, reason: out.code });
      throw new ApiError(out.status, out.code, out.message, out.extra);
    }
    // The row goes to every member, so a join never carries the address: a room-mate would read it.
    // Only the creator's own row (nobody else is in the room yet) keeps it. The row names the seats this
    // request took (`out.seated`), not every Bot it brought: one already in the room sat down again, so it
    // is not a join. A repeat join that seats nobody writes no row; its "rejoined" attempt already records it.
    const joinData = out.created ? { bots: bots.map((b) => b.id), ip } : { bots: out.seated };
    if (out.created) this.audit.append(actor, "face_room.created", out.roomId, this.faceOwnerIds(out.roomId), joinData);
    else if (out.seated.length) this.audit.append(actor, "face_room.joined", out.roomId, this.faceOwnerIds(out.roomId), joinData);
    const viewer = this.faceJoinViewer(p, out.roomId, out.seated);
    return this.faceRoomView(out.roomId, viewer);
  }

  // ---- Room invites (Bot Social #39): a ticket for an established room, joined by link or QR.

  /** The invite row for a ticket, or null when the string is not even ticket-shaped (same answer as unknown). */
  private faceInviteOf(ticketRaw: unknown) {
    const ticket = String(ticketRaw ?? "").trim();
    if (!isInviteTicket(ticket)) return null;
    return this.get("SELECT * FROM face_room_invites WHERE ticket = ?", ticket) ?? null;
  }

  /** One of the refusals that belong to the invite itself; `room_full` / `already_member` come later, at the join. */
  private faceInviteRefusal(invite: any): { status: number; code: string; message: string } | null {
    if (!invite) return { status: 404, code: "invite_not_found", message: "this invite link is not valid" };
    const room = this.get("SELECT * FROM face_rooms WHERE id = ?", invite.room_id);
    if (!room) return { status: 404, code: "invite_not_found", message: "this invite link is not valid" };
    if (room.status === "closed") return { status: 410, code: "ended", message: "this room has ended" };
    if (invite.revoked_at) return { status: 410, code: "revoked", message: "this invite was revoked" };
    if (Date.parse(invite.expires_at) <= this.nowMs()) return { status: 410, code: "expired", message: "this invite has expired" };
    // A ticket a Bot minted is that identity's reach, exactly as `removeHomeMember` treats a revoked member's
    // tickets (#183); a stop is the softer switch, so the ticket stays and the minter's state decides. Checked
    // here, in the one place both the preview and the join read, so a stop closes the link and a resume reopens
    // the very same one. Owner-minted tickets (`created_by_bot IS NULL`) are the owner's reach, not a Bot's.
    if (invite.created_by_bot) {
      const failure = this.invitableFailure(this.bot(invite.created_by_bot));
      if (failure) return failure;
    }
    return null;
  }

  private faceInviteUrl(ticket: string) {
    return `${this.publicBaseUrl.replace(/\/$/, "")}/r/${ticket}`;
  }

  /** Only the room lead acts here: the picked lead, else the creator's first Bot still in the room. */
  private faceRequireLead(p: Principal, roomId: string, what: string) {
    const room = this.get("SELECT * FROM face_rooms WHERE id = ?", roomId);
    if (!room) throw new ApiError(404, "face_room_not_found", "no such room");
    const lead = this.faceLeadOf(room).effective;
    const isLead = Boolean(lead) && (p.kind === "bot" ? p.botId === lead.bot_id : p.ownerId === lead.owner_id);
    if (!isLead) throw new ApiError(403, "not_lead", `only the room lead may ${what}`);
    return room;
  }

  private faceIpRateLimit(ip: string | null, message: string, scope: string) {
    const since = new Date(this.nowMs() - this.faceRoomLimits.attemptWindowMs).toISOString();
    // Previews have their own per-address budget: a read never spends the join budget, so a client browsing
    // its own links cannot lock itself out of joining. The two sides are isolated both ways: `preview` rows are
    // written with no owner, while a join that fails on a ticket records the same refusal codes against its
    // owner (`invite_not_found`, `expired`, `revoked`, `ended`). Counting only owner-less rows here keeps those
    // failed door checks out of the read budget, exactly as the join budget's per-IP query keeps previews out
    // of its own. A mint is the invite-link budget (#69).
    const marks = FACE_PREVIEW_OUTCOMES.map(() => "?").join(",");
    if (ip && this.get(`SELECT COUNT(*) n FROM face_room_attempts WHERE ip = ? AND owner_id IS NULL AND created_at > ? AND outcome IN (${marks})`, ip, since, ...FACE_PREVIEW_OUTCOMES).n >= this.faceRoomLimits.attemptsPerIp)
      return this.faceRateFail(message, scope, this.faceRoomLimits.attemptWindowMs);
    return null;
  }

  /**
   * Mint a ticket for an existing room. The ticket is a bearer credential: it is returned once, the mint is
   * audited, and the ticket itself is never written to the audit log.
   */
  mintFaceRoomInvite(p: Principal, roomId: string, ctx: { ip?: string } = {}) {
    const ip = String(ctx.ip ?? "").slice(0, 80) || null;
    // Settlement follows the authorization: the sweep is the room's own act (it voids the number, deletes its rows,
    // wakes every member and writes the audit row), so it runs only once the caller is this room's lead, and only over
    // this room. It used to open the door, so a caller holding a token but no seat here started another home's room by
    // being refused. A lapsed candidate the lead mints on is still settled, exactly as before.
    const viewer = this.faceRequireMember(p, roomId);
    if (viewer.room.status === "closed") throw new ApiError(410, "ended", "this room has ended");
    this.faceRequireLead(p, roomId, "mint an invite");
    this.advanceFaceRooms(new Set([roomId]));
    const block = this.inviteMintRateLimit(p.ownerId, ip);
    if (block) throw new ApiError(block.status, block.code, block.message, block.extra);
    this.faceRecordAttempt(p.ownerId, ip, "invite", "minted");
    const ticket = newInviteTicket();
    const expiresAt = new Date(this.nowMs() + this.faceRoomLimits.inviteTtlMs).toISOString();
    this.run("INSERT INTO face_room_invites (ticket, room_id, created_by_owner_id, created_by_bot, expires_at, created_at) VALUES (?,?,?,?,?,?)",
      ticket, roomId, p.ownerId, p.kind === "bot" ? p.botId : null, expiresAt, this.ts());
    this.audit.append(this.actorOf(p), "face_room.invite_minted", roomId, this.faceOwnerIds(roomId), { expires_at: expiresAt, ttl_seconds: Math.round(this.faceRoomLimits.inviteTtlMs / 1000) });
    return { room_id: roomId, ticket, url: this.faceInviteUrl(ticket), expires_at: expiresAt };
  }

  /**
   * Revoke a ticket now. A join that starts after this commits re-reads the ticket inside its own transaction,
   * sees `revoked` and is refused whole; a join already inside its transaction holds the write lock, so this
   * revoke lands after it and only later uses are affected.
   */
  revokeFaceRoomInvite(p: Principal, roomId: string, ticketRaw: unknown) {
    // Same order as the mint above: the caller has to be this room's lead before the door settles it. A caller who is
    // not in the room gets its 404 without the sweep opening the number it came to touch.
    this.faceRequireMember(p, roomId);
    this.faceRequireLead(p, roomId, "revoke an invite");
    this.advanceFaceRooms(new Set([roomId]));
    const ticket = String(ticketRaw ?? "").trim();
    const invite = this.get("SELECT * FROM face_room_invites WHERE ticket = ? AND room_id = ?", ticket, roomId);
    if (!invite) throw new ApiError(404, "invite_not_found", "this invite link is not valid");
    const revokedAt = invite.revoked_at ?? this.ts();
    if (!invite.revoked_at) {
      this.run("UPDATE face_room_invites SET revoked_at = ? WHERE ticket = ?", revokedAt, ticket);
      this.audit.append(this.actorOf(p), "face_room.invite_revoked", roomId, this.faceOwnerIds(roomId), {});
    }
    return { room_id: roomId, revoked: true, revoked_at: revokedAt };
  }

  /** What a scanned link can show before joining: the room, its lead, how many are in it, when the ticket dies. */
  previewFaceRoomInvite(ticketRaw: unknown, ctx: { ip?: string } = {}) {
    const ip = String(ctx.ip ?? "").slice(0, 80) || null;
    const block = this.faceIpRateLimit(ip, "too many invite previews from this address", "invite_preview");
    if (block) throw new ApiError(block.status, block.code, block.message, block.extra);
    const invite = this.faceInviteOf(ticketRaw);
    const refusal = this.faceInviteRefusal(invite);
    // Every preview counts against the per-IP window, whether it names a real ticket or not.
    this.faceRecordAttempt(null, ip, "invite", refusal ? refusal.code : "preview");
    if (refusal) throw new ApiError(refusal.status, refusal.code, refusal.message);
    const room = this.faceSettledRoom(invite!.room_id);
    const leadRow = this.faceLeadOf(room).effective;
    // The preview answers with exactly the three keys it has always returned; only the two labels are cleaned,
    // the same way `publicBot` cleans them. A read-side name fix, not a change to the response shape.
    const lead = leadRow ? { ...leadRow, display_name: peerDisplayName(leadRow.display_name, "Bot"), owner_name: peerDisplayName(leadRow.owner_name, "Owner") } : null;
    const memberCount = this.get("SELECT COUNT(*) n FROM face_room_members WHERE room_id = ? AND left_at IS NULL", room.id).n as number;
    return {
      room_id: room.id,
      // Rooms have no name of their own yet; the lead and the count identify this one.
      name: null,
      status: room.status,
      lead: lead ? { handle: lead.handle, display_name: lead.display_name, owner_name: lead.owner_name } : null,
      member_count: memberCount,
      max_members: this.faceRoomLimits.maxMembers,
      expires_at: invite.expires_at,
    };
  }

  /** Whether this home has ever held a seat in the room this ticket names: then its refusals are removals, not guesses. */
  private faceInviteEverSeated(invite: any, ownerId: string) {
    if (!invite) return false;
    return !!this.get(`SELECT 1 FROM face_room_members m JOIN bots b ON b.id = m.bot_id WHERE m.room_id = ? AND b.owner_id = ?`, invite.room_id, ownerId);
  }

  /** Join an established room with a ticket: writes the room grants, then confirms (Bot Social #30/#31). */
  joinFaceRoomByInvite(p: Principal, body: any, ctx: { ip?: string } = {}) {
    const ownerId = p.ownerId;
    const actor = this.actorOf(p);
    const ip = String(ctx.ip ?? "").slice(0, 80) || null;
    const bring = this.faceBotsToBring(p, body);
    const bots = bring.map((x) => x.bot);
    const ticket = String(body?.ticket ?? "").trim();
    // The sweep this door runs settles only the lapsed rooms the request itself already holds a seat in - the same
    // seat rule the 6-digit door adopted (#724). Promotion voids the number, deletes its rows and wakes every member,
    // so a caller seated nowhere must not start another home's room by handing in a ticket it was never given; the
    // ticket is read after this, and its refusal settles nothing.
    const seatRooms = new Set<string>(bots.length
      ? this.all(`SELECT DISTINCT room_id FROM face_room_members WHERE left_at IS NULL AND bot_id IN (${bots.map(() => "?").join(",")})`, ...bots.map((b) => b.id)).map((r: any) => r.room_id as string)
      : []);
    type Fail = { ok: false; status: number; code: string; message: string; extra?: Record<string, unknown>; lockout?: boolean };
    type Ok = { ok: true; roomId: string; seated: string[] };
    const txn = this.db.transaction((): Ok | Fail => {
      this.advanceFaceRooms(seatRooms);
      const locked = this.faceLockoutUntil(ownerId, ip);
      if (locked) {
        this.faceRecordAttempt(ownerId, ip, "invite", "locked_out");
        return { ok: false, status: 429, code: "locked_out", message: "too many failed invite attempts; try again later", extra: { retry_after: Math.max(1, Math.ceil((Date.parse(locked) - this.nowMs()) / 1000)) } };
      }
      const attemptBlock = this.faceAttemptRateLimit(ownerId, ip);
      if (attemptBlock) return { ...attemptBlock } as Fail;
      // BEGIN IMMEDIATE: a revoke that commits first is seen here, so the join is refused whole.
      const invite = this.faceInviteOf(ticket);
      const refusal = this.faceInviteRefusal(invite);
      if (refusal) {
        // A ticket that seated this home is not a guess when it dies: the lead withdrew it, or its clock ran out.
        // Its seat stays (a withdrawn link keeps the seats it made), so its retries are the same removal #336 and
        // #338 exempt on the local-room door. They keep a row under a label of their own, so the refusal is still
        // visible, but they cannot spend the join budget and lock that home out of every other room. A caller the
        // ticket never seated keeps the counted code: `docs/FACE_ROOMS.md:144` needs a guessed or leaked ticket to
        // cost the same as a wrong one.
        const seated = invite && (refusal.code === "revoked" || refusal.code === "expired" || refusal.code === "ended") && this.faceInviteEverSeated(invite, ownerId);
        this.faceRecordAttempt(ownerId, ip, "invite", seated ? `${refusal.code}_after_seat` : refusal.code);
        return { ok: false, ...refusal, lockout: this.faceMaybeLockout(ownerId, ip) };
      }
      const room = this.get("SELECT * FROM face_rooms WHERE id = ?", invite!.room_id);
      const active = this.all("SELECT bot_id FROM face_room_members WHERE room_id = ? AND left_at IS NULL", room.id);
      const activeSet = new Set(active.map((m: any) => m.bot_id));
      const newcomers = bots.filter((b) => !activeSet.has(b.id));
      if (!newcomers.length) {
        this.faceRecordAttempt(ownerId, ip, "invite", "already_member");
        return { ok: false, status: 409, code: "already_member", message: "every Bot you brought is already in this room" };
      }
      if (active.length + newcomers.length > this.faceRoomLimits.maxMembers) {
        this.faceRecordAttempt(ownerId, ip, "invite", "room_full");
        return { ok: false, status: 409, code: "room_full", message: `this room is full (max ${this.faceRoomLimits.maxMembers} bots)`, lockout: this.faceMaybeLockout(ownerId, ip) };
      }
      if (this.facePairBlocked(newcomers, active)) {
        // #111: the same rule as the code door — a block ends this pair's room doors, so the ticket must not be
        // the way back in. This door refuses a ticket that is not there for the caller with a 404, and the block
        // gets exactly that answer, word for word and counted as the same failure.
        this.faceRecordAttempt(ownerId, ip, "invite", "invite_not_found");
        return { ok: false, status: 404, code: "invite_not_found", message: "this invite link is not valid", lockout: this.faceMaybeLockout(ownerId, ip) };
      }
      this.faceAddMembers(room.id, newcomers, ownerId);
      this.syncFaceRoomAccess(room.id, newcomers, ownerId, actor, bring.filter((x) => newcomers.some((n) => n.id === x.bot.id)));
      this.run("UPDATE face_room_invites SET used_count = used_count + 1, last_used_at = ?, last_used_by_owner_id = ? WHERE ticket = ?", this.ts(), ownerId, ticket);
      this.faceRecordAttempt(ownerId, ip, "invite", "invited");
      return { ok: true, roomId: room.id, seated: newcomers.map((n: any) => n.id) };
    });
    const out = txn.immediate();
    if (!out.ok) {
      if (out.lockout) this.audit.append(actor, "face_room.lockout", null, [ownerId], { ip, reason: out.code });
      throw new ApiError(out.status, out.code, out.message, out.extra);
    }
    // Same rule on the ticket path: every member reads this row, so no address on it, and it names only
    // the seats this request took.
    if (out.seated.length) this.audit.append(actor, "face_room.joined", out.roomId, this.faceOwnerIds(out.roomId), { bots: out.seated, invite: true });
    const viewer = this.faceJoinViewer(p, out.roomId, out.seated);
    return this.faceRoomView(out.roomId, viewer);
  }

  // ---- Local room invites (Bot Social #60): a ticket for a room that lives in one FlyBot home.

  private localInviteOf(ticketRaw: unknown) {
    const ticket = String(ticketRaw ?? "").trim();
    if (!isLocalInviteTicket(ticket)) return null;
    return this.get("SELECT * FROM local_room_invites WHERE ticket = ?", ticket) ?? null;
  }
  /** Every home's live claim on a ticket (a link admits anyone it is given to, until withdrawn). */
  private localInviteClaims(invite: any): { owner_id: string; bots: string[]; claimed_at: string }[] {
    if (!invite) return [];
    return this.all("SELECT * FROM local_room_invite_claims WHERE ticket = ? AND released_at IS NULL ORDER BY claimed_at", invite.ticket)
      .map((c: any) => ({ owner_id: c.owner_id, bots: J(c.bots, []) as string[], claimed_at: c.claimed_at }));
  }
  /** A room member named by handle: exact `@handle` first, else the unique case-insensitive match. */
  private faceMemberByHandle(roomId: string, ref: unknown) {
    const raw = handleRef(ref);
    if (!raw) return undefined;
    const rows = this.all("SELECT * FROM face_room_members WHERE room_id = ? AND left_at IS NULL AND LOWER(handle) = ?", roomId, "@" + raw.toLowerCase());
    if (rows.length > 1) throw ambiguous(raw, rows.length);
    return rows[0];
  }

  private localInviteClaimOf(invite: any, ownerId: string | null) {
    if (!invite || ownerId === null) return null;
    return this.localInviteClaims(invite).find((c) => c.owner_id === ownerId) ?? null;
  }
  /** Whether this home ever claimed this ticket, however that claim ended. A refusal on such a ticket is not a guess. */
  private localInviteEverClaimed(invite: any, ownerId: string | null) {
    if (!invite || ownerId === null) return false;
    return !!this.get("SELECT 1 FROM local_room_invite_claims WHERE ticket = ? AND owner_id = ?", invite.ticket, ownerId);
  }
  /** The claim this home once had, however it ended: the live list above leaves released rows out. */
  private localInviteEndedClaim(invite: any, ownerId: string | null) {
    if (!invite || ownerId === null) return null;
    return this.get("SELECT * FROM local_room_invite_claims WHERE ticket = ? AND owner_id = ? AND released_at IS NOT NULL", invite.ticket, ownerId) ?? null;
  }
  private localClaimView(c: { owner_id: string; bots: string[] }) {
    return {
      home: this.homeHandleOf(c.owner_id),
      bots: c.bots.map((id) => "@" + this.bot(id).handle),
      // The names the inviting home shows on each seat; the handles above are the authority.
      members: c.bots.map((id) => { const s = this.faceSnapshot(this.bot(id)); return { handle: s.handle, display_name: s.display_name, owner_name: s.owner_name }; }),
    };
  }
  /** The refusals that belong to the ticket itself, before anyone claims it. */
  private localInviteRefusal(invite: any): { status: number; code: string; message: string } | null {
    if (!invite) return { status: 404, code: "invite_not_found", message: "this invite link is not valid" };
    if (invite.revoked_at) return { status: 410, code: "revoked", message: "this invite was withdrawn" };
    // A link minted since the owner's decision has no deadline (`expires_at` is ''): it lives until it is withdrawn
    // or spent. A ticket minted with a deadline before that keeps it.
    if (invite.expires_at && Date.parse(invite.expires_at) <= this.nowMs()) return { status: 410, code: "expired", message: "this invite has expired" };
    return null;
  }
  private localInviteUrl(handle: string, ticket: string) {
    return `${this.publicBaseUrl.replace(/\/$/, "")}/r/@${String(handle).replace(/^@/, "")}/${ticket}`;
  }
  private homeHandleOf(ownerId: string): string | null {
    const home = this.get("SELECT handle FROM bots WHERE owner_id = ? AND integration_type = 'flybot-home' ORDER BY created_at LIMIT 1", ownerId);
    return home ? "@" + home.handle : null;
  }
  private localInviteView(invite: any, viewerOwnerId: string | null) {
    const inviter = this.bot(invite.inviter_bot);
    const lead = this.faceSnapshot(inviter);
    const minter = viewerOwnerId !== null && viewerOwnerId === invite.created_by_owner_id;
    const own = this.localInviteClaimOf(invite, viewerOwnerId);
    const claims = minter ? this.localInviteClaims(invite) : [];
    return {
      kind: "local_room",
      room_id: invite.room_id,
      name: invite.name || null,
      lead: { handle: lead.handle, display_name: lead.display_name, owner_name: lead.owner_name },
      inviter: { handle: lead.handle, home: this.homeHandleOf(inviter.owner_id) },
      expires_at: invite.expires_at || null,
      // Whether the caller's own home has joined with it. A link admits anyone it is given to, so nobody
      // else's claim closes it; an anonymous caller always reads false.
      claimed: own !== null,
      ...(invite.revoked_at ? { revoked: true } : {}),
      // The minting owner sees every home that joined (`claimers`; `claimer` is the latest, for older readers);
      // a claiming owner sees its own claim; nobody else sees any.
      ...(minter ? { claimers: claims.map((c) => this.localClaimView(c)), claimer: claims.length ? this.localClaimView(claims[claims.length - 1]) : null }
        : own ? { claimer: this.localClaimView(own) } : viewerOwnerId !== null ? { claimer: null } : {}),
    };
  }

  /** Mint a ticket for a room that lives in the caller's FlyBot home. Several may be live for one room at once. */
  mintLocalRoomInvite(p: Principal, body: any, ctx: { ip?: string } = {}) {
    const ownerId = p.ownerId;
    const ip = String(ctx.ip ?? "").slice(0, 80) || null;
    // The room this ticket opens is an id, never a shape. `String(...)` below would turn `["loc-room-2"]` into
    // `loc-room-2`, `true` into `true` and `7` into `7`, minting a ticket for a room id the caller never typed;
    // an object whose `toString` is not a function made the coercion throw and answered 500. Judge the type before
    // the read, and before the attempt record, the ticket row and the mint audit entry. Absent and null still read
    // as "no room id" and keep the characters refusal below, as does a malformed string.
    assert(body?.room_id === undefined || body?.room_id === null || typeof body.room_id === "string", 400, "invalid_request", "room_id must be a string");
    const roomId = String(body?.room_id ?? "").trim();
    assert(isLocalRoomId(roomId), 400, "invalid_request", "room_id: 1-64 chars [A-Za-z0-9._:-]");
    // A face room has its own invitation, and its grants must never be written by someone outside it.
    assert(!this.get("SELECT 1 FROM face_rooms WHERE id = ?", roomId), 409, "face_room", "this room has its own invitation");
    let inviter: any;
    if (p.kind === "bot") inviter = this.bot(p.botId);
    else {
      // A Bot name in this body is a string or nothing. `String(...)` below is what reads it, and an array
      // stringifies to the empty string — which reads as "no Bot named" and mints the ticket for the account's
      // default Bot instead of the one the caller named, with no error. Objects, booleans and numbers were
      // answered 404 `bot_not_found`, naming the wrong problem. Judged here, before the fallback and before the
      // row, the attempt and the audit entry; absent or null still means the default Bot. The three aliases are
      // judged in the order `??` reads them, so a wrong-typed one is refused even when an earlier one would win.
      assert(body?.bot_id === undefined || body?.bot_id === null || typeof body.bot_id === "string", 400, "invalid_request", "bot_id must be a string");
      assert(body?.bot_handle === undefined || body?.bot_handle === null || typeof body.bot_handle === "string", 400, "invalid_request", "bot_handle must be a string");
      assert(body?.handle === undefined || body?.handle === null || typeof body.handle === "string", 400, "invalid_request", "handle must be a string");
      const ref = String(body?.bot_id ?? body?.bot_handle ?? body?.handle ?? "").trim();
      inviter = ref
        ? this.get("SELECT * FROM bots WHERE id = ? AND owner_id = ?", ref, ownerId) ?? this.botByRef(ref, "owner_id = ?", [ownerId])
        : this.get("SELECT * FROM bots WHERE owner_id = ? AND status = 'active' AND integration_type = 'flybot-member' ORDER BY created_at LIMIT 1", ownerId)
          ?? this.get("SELECT * FROM bots WHERE owner_id = ? AND status = 'active' ORDER BY created_at LIMIT 1", ownerId);
    }
    assert(inviter && inviter.owner_id === ownerId, 404, "bot_not_found", "no such bot on this account");
    this.assertInvitable(inviter);
    const block = this.inviteMintRateLimit(ownerId, ip);
    if (block) throw new ApiError(block.status, block.code, block.message, block.extra);
    // The link's name is a string or nothing, and `sanitizePeerName` below starts with `String(value ?? "")`:
    // an object would be stored as "object Object", `[1,2]` as "1,2", `42` as "42", `true` as "true", and `[]`
    // as "no name" — a line a stranger reads that the caller never typed. Judge the type before the read, and
    // before the attempt record, the ticket row and the mint audit entry. Absent and null still mean no name.
    assert(body?.name === undefined || body?.name === null || typeof body.name === "string", 400, "invalid_request", "name must be a string");
    this.faceRecordAttempt(ownerId, ip, "local", "minted");
    const ticket = newLocalInviteTicket();
    // No deadline: the owner withdraws the link, or a stranger spends it. The column is NOT NULL, so '' means none.
    const expiresAt = LOCAL_INVITE_NO_DEADLINE;
    // Shown to a stranger before they join: one line, and none of the characters a card or a fence could misread.
    const name = sanitizePeerName(body?.name, "", FACE_ROOM_NAME_MAX).replace(/[[\]"<>`@]/g, "").replace(/\s+/g, " ").trim() || null;
    this.run("INSERT INTO local_room_invites (ticket, room_id, name, created_by_owner_id, inviter_bot, expires_at, created_at) VALUES (?,?,?,?,?,?,?)",
      ticket, roomId, name, ownerId, inviter.id, expiresAt, this.ts());
    // The ticket is a bearer credential: it is returned once and never written to the audit log.
    this.audit.append(this.actorOf(p), "local_room.invite_minted", roomId, [ownerId], { inviter_bot: inviter.id });
    return { kind: "local_room", ticket, url: this.localInviteUrl(inviter.handle, ticket), room_id: roomId, name, expires_at: null, inviter: { handle: "@" + inviter.handle, home: this.homeHandleOf(ownerId) } };
  }

  /** Public preview; the minting or claiming owner also sees the claimer. */
  previewLocalRoomInvite(p: Principal | null, ticketRaw: unknown, ctx: { ip?: string } = {}) {
    const ip = String(ctx.ip ?? "").slice(0, 80) || null;
    const block = this.faceIpRateLimit(ip, "too many invite previews from this address", "invite_preview");
    if (block) throw new ApiError(block.status, block.code, block.message, block.extra);
    const invite = this.localInviteOf(ticketRaw);
    const viewer = p && p.kind === "owner" ? p.ownerId : p && p.kind === "bot" ? p.ownerId : null;
    // The minter, or a home that joined, re-reads a ticket that had a deadline after it passed, to check a claim
    // that landed in time.
    const party = invite && viewer !== null && (viewer === invite.created_by_owner_id || this.localInviteClaimOf(invite, viewer) !== null);
    const refusal = party && !invite.revoked_at && (viewer !== invite.created_by_owner_id || this.localInviteClaims(invite).length) ? null : this.localInviteRefusal(invite);
    this.faceRecordAttempt(null, ip, "local", refusal ? refusal.code : "preview");
    if (refusal) throw new ApiError(refusal.status, refusal.code, refusal.message);
    return this.localInviteView(invite, viewer);
  }

  /**
   * Claim a ticket for the caller's home and the Bots it brings. Any number of homes may claim one ticket
   * (owner decision 2026-10-24: the link admits anyone it is given to, until withdrawn); each home once. The claim writes one room-scoped grant pair
   * per brought Bot with the inviter's Bot (relationship status 'room'): reach for `send_as_member` naming that
   * room id between exactly those two Bots, nothing else.
   */
  claimLocalRoomInvite(p: Principal, ticketRaw: unknown, body: any, ctx: { ip?: string } = {}) {
    const ownerId = p.ownerId;
    const actor = this.actorOf(p);
    const ip = String(ctx.ip ?? "").slice(0, 80) || null;
    // The list names the Bots to bring; it is not a value to coerce. `normalizeBotRefs` below would read
    // `[["@handle"]]` as the handle it prints as (a claim nobody wrote as a name) and a number, object,
    // boolean or null as the text it prints as, answering `404 bot_not_found` to a shape problem. The
    // face-room join and leave doors judge the same field with `assertFaceBotRefs`; this door is the one
    // that was left out.
    if (p.kind !== "bot") this.assertFaceBotRefs(body);
    const refs = p.kind === "bot" ? [p.botId] : this.normalizeBotRefs(body);
    assert(refs.length >= 1, 400, "invalid_request", "bots: name at least one of your Bots to bring");
    assert(refs.length <= LOCAL_INVITE_MAX_BOTS, 400, "invalid_request", `bots: at most ${LOCAL_INVITE_MAX_BOTS}`);
    const bots: any[] = [];
    for (const ref of refs) {
      const b = this.get("SELECT * FROM bots WHERE id = ? AND owner_id = ?", ref, ownerId) ?? this.botByRef(ref, "owner_id = ?", [ownerId]);
      // A home can only bring Bots it owns: a ticket is not authority over anyone else's identity.
      assert(b, 404, "bot_not_found", `no bot matching ${ref} on this account`);
      this.assertInvitable(b);
      if (!bots.some((x) => x.id === b.id)) bots.push(b);
    }
    const wanted = bots.map((b) => b.id).sort();
    type Fail = { ok: false; status: number; code: string; message: string; extra?: Record<string, unknown>; lockout?: boolean };
    const txn = this.db.transaction((): { ok: true; invite: any; fresh: boolean } | Fail => {
      const locked = this.faceLockoutUntil(ownerId, ip);
      if (locked) {
        this.faceRecordAttempt(ownerId, ip, "local", "locked_out");
        return { ok: false, status: 429, code: "locked_out", message: "too many failed invite attempts; try again later", extra: { retry_after: Math.max(1, Math.ceil((Date.parse(locked) - this.nowMs()) / 1000)) } };
      }
      const attemptBlock = this.faceAttemptRateLimit(ownerId, ip);
      if (attemptBlock) return { ...attemptBlock } as Fail;
      const invite = this.localInviteOf(ticketRaw);
      // #111: a block ends this pair's room doors, so a local-room ticket must not become the way back in — not by
      // claiming it again after a release, and not by re-sending a claim the block already withdrew. Already
      // answered like a link that is not there for this caller; the attempt is counted as that same refusal.
      const inviterBot = invite ? this.get("SELECT * FROM bots WHERE id = ?", invite.inviter_bot) : null;
      if (inviterBot && bots.some((b) => this.pairRelationships(b.id, inviterBot.id).some((r: any) => r.status === "blocked"))) {
        this.faceRecordAttempt(ownerId, ip, "local", "invite_not_found");
        return { ok: false, status: 404, code: "invite_not_found", message: "this invite link is not valid" };
      }
      const mine = this.localInviteClaimOf(invite, ownerId);
      // The same home with the same Bots again is the usual retry (the answer was lost): it succeeds, even past an
      // older ticket's deadline, because the claim landed before it.
      if (invite && !invite.revoked_at && mine && JSON.stringify([...mine.bots].sort()) === JSON.stringify(wanted)) {
        return { ok: true, invite, fresh: false };
      }
      const refusal = this.localInviteRefusal(invite);
      if (refusal) {
        // A home that had already joined with this link is not guessing: the owner withdrew the link, or an older
        // ticket's deadline passed. #336 gave the sibling `claim_ended` refusal exactly this exception for the minting
        // owner's removal; these two are a dead end rather than a removal — the claim survives the link — for a home
        // the link had already seated. Its retries keep a row under a label of their own (`revoked_after_claim` /
        // `expired_after_claim`), so the refusal stays visible, but they cannot spend the join budget and lock that
        // home out of every other room. A caller that never held a claim keeps the counted code:
        // `docs/FACE_ROOMS.md:144` needs a guessed or leaked ticket to cost the same as a wrong one.
        const removed = invite && (refusal.code === "revoked" || refusal.code === "expired") && this.localInviteEverClaimed(invite, ownerId);
        this.faceRecordAttempt(ownerId, ip, "local", removed ? `${refusal.code}_after_claim` : refusal.code);
        return { ok: false, ...refusal, lockout: this.faceMaybeLockout(ownerId, ip) };
      }
      // #90: a live ticket whose inviter is no longer active must not write new reach for it. Checked before the
      // claim row, so a ticket minted before the revocation cannot be claimed during or after it. A withdrawn
      // ticket keeps its own answer above (410): the revocation of the link is the more specific fact.
      // The answer names the state the inviter is in, as every other owner-side door does (#143): a stopped Bot is a
      // `bot_frozen` that can be resumed, a removed one is `bot_revoked`. The attempt keeps the single `bot_revoked`
      // label, which is the one this budget knows, so a stopped inviter cannot be retried for free.
      const inviterFailure = this.invitableFailure(this.bot(invite.inviter_bot));
      if (inviterFailure) {
        this.faceRecordAttempt(ownerId, ip, "local", "bot_revoked");
        return { ok: false, ...inviterFailure };
      }
      // One claim per home: a home that joined brings its Bots once (another set is a second claim it must release first).
      if (mine) {
        this.faceRecordAttempt(ownerId, ip, "local", "already_claimed");
        return { ok: false, status: 409, code: "already_claimed", message: "this invite was already used for other Bots of yours" };
      }
      // A home holding its own link is not guessing: the refusal is recorded under its own label but, like
      // `already_member`, not counted — testing your own ticket must not lock you out of every other room.
      if (invite.created_by_owner_id === ownerId) {
        this.faceRecordAttempt(ownerId, ip, "local", "own_invite");
        return { ok: false, status: 409, code: "own_invite", message: "this is your own invite link" };
      }
      // A claim the minting owner ended removed this home from the room, so the link must not seat it again.
      // A claim this home released itself is the other case, and it may come back (the upsert below clears it).
      const ended = this.localInviteEndedClaim(invite, ownerId);
      if (ended && ended.ended_by_owner_id && ended.ended_by_owner_id !== ownerId) {
        this.faceRecordAttempt(ownerId, ip, "local", "claim_ended");
        return { ok: false, status: 403, code: "claim_ended", message: "the owner of this room ended your claim on it", lockout: this.faceMaybeLockout(ownerId, ip) };
      }
      const now = this.ts();
      // A home that gave its claim back (left) may come back with the same link while it is not withdrawn.
      this.run(`INSERT INTO local_room_invite_claims (ticket, owner_id, bots, claimed_at, released_at, ended_by_owner_id) VALUES (?,?,?,?,NULL,NULL)
        ON CONFLICT (ticket, owner_id) DO UPDATE SET bots = excluded.bots, claimed_at = excluded.claimed_at, released_at = NULL, ended_by_owner_id = NULL`, invite.ticket, ownerId, JSON.stringify(wanted), now);
      const inviter = this.bot(invite.inviter_bot);
      for (const b of bots) this.ensureLocalPairGrant(invite.room_id, inviter, b, actor);
      this.faceRecordAttempt(ownerId, ip, "local", "claimed");
      return { ok: true, invite: this.localInviteOf(invite.ticket), fresh: true };
    });
    const out = txn.immediate();
    if (!out.ok) {
      if (out.lockout) this.audit.append(actor, "face_room.lockout", null, [ownerId], { ip, reason: out.code });
      throw new ApiError(out.status, out.code, out.message, out.extra);
    }
    const invite = out.invite;
    if (out.fresh) this.audit.append(actor, "local_room.invite_claimed", invite.room_id, [ownerId, invite.created_by_owner_id], { inviter_bot: invite.inviter_bot, bots: wanted });
    const inviter = this.bot(invite.inviter_bot);
    return {
      ...this.localInviteView(invite, ownerId),
      claimed: true,
      claimer: this.localClaimView({ owner_id: ownerId, bots: wanted }),
      inviter: { handle: "@" + inviter.handle, home: this.homeHandleOf(inviter.owner_id) },
      bots: wanted.map((id) => "@" + this.bot(id).handle),
    };
  }

  /**
   * The minting owner withdraws the ticket: nobody new can join with it, and the homes that already joined keep
   * their seats (owner decision 2026-10-24) unless `endClaims` (the room is gone) ends every claim's reach too.
   * Ending the claims covers every claim the minting home seated in that room, including one made through a link
   * it had already withdrawn plain, since a withdrawal keeps the seats it made; the live links go with it, while
   * a ticket already withdrawn keeps its own timestamp. A ticket another home minted for the same `room_id` is not
   * the caller's to end. A claiming owner releases its own claim, which ends the reach that claim wrote.
   */
  revokeLocalRoomInvite(p: Principal, ticketRaw: unknown, opts: { endClaims?: boolean } = {}) {
    const ownerId = p.ownerId;
    const invite = this.localInviteOf(ticketRaw);
    if (!invite) throw new ApiError(404, "invite_not_found", "this invite link is not valid");
    const minter = invite.created_by_owner_id === ownerId;
    const own = minter ? null : this.localInviteClaimOf(invite, ownerId);
    if (!minter && !own) throw new ApiError(invite.revoked_at ? 404 : 403, invite.revoked_at ? "invite_not_found" : "forbidden", invite.revoked_at ? "this invite link is not valid" : "only the owner who made this link, or one who used it, can end it");
    if (minter && invite.revoked_at && !opts.endClaims) throw new ApiError(404, "invite_not_found", "this invite link is not valid");
    const now = this.ts();
    const ended = minter ? (opts.endClaims ? this.localInviteClaims(invite) : []) : [own!];
    // `end_claims` means the room itself is gone, so the sweep is by claim: every claim this same home seated in
    // the room ends through the release + grant path below, whether the link that seated it is still live or was
    // withdrawn plain (a plain withdrawal keeps the seats it made). The tickets go with it too, but a ticket
    // already withdrawn keeps its own `revoked_at`. Another home's ticket for the same `room_id` is left alone
    // (`mintLocalRoomInvite` does not check the room's home, so each owner's authority reaches only its own tickets).
    const siblings = minter && opts.endClaims
      ? this.all("SELECT * FROM local_room_invites WHERE room_id = ? AND created_by_owner_id = ? AND ticket <> ?", invite.room_id, ownerId, invite.ticket)
      : [];
    const siblingClaims = siblings.flatMap((s: any) => this.localInviteClaims(s).map((c: any) => ({ invite: s, claim: c })));
    if (minter && !invite.revoked_at) this.run("UPDATE local_room_invites SET revoked_at = ? WHERE ticket = ?", now, invite.ticket);
    for (const s of siblings) if (!s.revoked_at) this.run("UPDATE local_room_invites SET revoked_at = ? WHERE ticket = ?", now, s.ticket);
    for (const c of ended) {
      // The acting owner ends these: the claimer on a self-release (it may come back), the minter on `end_claims`
      // (the room is gone, so nothing can come back to it).
      this.run("UPDATE local_room_invite_claims SET released_at = ?, ended_by_owner_id = ? WHERE ticket = ? AND owner_id = ?", now, ownerId, invite.ticket, c.owner_id);
      this.endLocalPairGrants(invite.room_id, invite.inviter_bot, c.bots);
    }
    for (const { invite: sibling, claim } of siblingClaims) {
      this.run("UPDATE local_room_invite_claims SET released_at = ?, ended_by_owner_id = ? WHERE ticket = ? AND owner_id = ?", now, ownerId, sibling.ticket, claim.owner_id);
      this.endLocalPairGrants(sibling.room_id, sibling.inviter_bot, claim.bots);
    }
    const claimers = [...ended.map((c) => c.owner_id), ...siblingClaims.map(({ claim }) => claim.owner_id)];
    this.audit.append(this.actorOf(p), minter ? "local_room.invite_revoked" : "local_room.invite_released", invite.room_id, [invite.created_by_owner_id, ...claimers], minter ? { ended_claims: claimers.length } : {});
  }

  /** The minting owner ends one home's claim (it removed that guest): that home's reach in the room ends, the link stays. `home` is the home's handle or one of its claimed Bots' handles. */
  endLocalRoomInviteClaim(p: Principal, ticketRaw: unknown, homeRaw: unknown) {
    const invite = this.localInviteOf(ticketRaw);
    if (!invite) throw new ApiError(404, "invite_not_found", "this invite link is not valid");
    if (invite.created_by_owner_id !== p.ownerId) throw new ApiError(403, "forbidden", "only the owner who made this link can end a claim on it");
    // The home's own handle, or the handle of a Bot that home brought: either names whose claim to end.
    const handle = String(homeRaw ?? "").trim().replace(/^@/, "");
    const home = handle ? this.botByRef(handle) ?? null : null;
    const claim = home ? this.localInviteClaimOf(invite, home.owner_id) : null;
    if (!claim) throw new ApiError(404, "claim_not_found", "no home joined with this link under that handle");
    // The minter ends it: recorded, so the same link does not seat that home again.
    this.run("UPDATE local_room_invite_claims SET released_at = ?, ended_by_owner_id = ? WHERE ticket = ? AND owner_id = ?", this.ts(), p.ownerId, invite.ticket, claim.owner_id);
    this.endLocalPairGrants(invite.room_id, invite.inviter_bot, claim.bots);
    this.audit.append(this.actorOf(p), "local_room.claim_ended", invite.room_id, [p.ownerId, claim.owner_id], {});
  }

  private ensureLocalPairGrant(roomId: string, inviter: any, guest: any, actor: string) {
    // Layer 2 of #111, the local-room twin of `ensurePairRoomGrant`: never rebuild a blocked pair's door.
    if (this.pairRelationships(guest.id, inviter.id).some((r: any) => r.status === "blocked")) return;
    const hit = this.get(`SELECT g.id FROM grants g JOIN relationships r ON r.id = g.relationship_id
      WHERE g.room_id = ? AND g.status = 'active' AND r.status = 'room'
      AND ((r.requester_bot = ? AND r.target_bot = ?) OR (r.requester_bot = ? AND r.target_bot = ?))`, roomId, inviter.id, guest.id, guest.id, inviter.id);
    if (hit) return;
    const id = newId("rel");
    const now = nowIso();
    this.run(`INSERT INTO relationships (id, requester_bot, target_bot, requester_owner, target_owner, status, message, requested_caps, offered_caps, created_at, updated_at, requester_scope, target_scope)
      VALUES (?,?,?,?,?,'room',?,?,?,?,?,'bot','bot')`, id, guest.id, inviter.id, guest.owner_id, inviter.owner_id, "local room", "[]", "[]", now, now);
    for (const cap of DEFAULT_CAPABILITIES) {
      this.insertGrant(id, inviter.owner_id, guest.id, cap, { kind: "room", room_id: roomId }, undefined, actor, { roomId });
      this.insertGrant(id, guest.owner_id, inviter.id, cap, { kind: "room", room_id: roomId }, undefined, actor, { roomId });
    }
  }
  private endLocalPairGrants(roomId: string, inviterBot: string, guests: string[]) {
    const now = nowIso();
    for (const guest of guests) {
      const rels = this.all(`SELECT * FROM relationships WHERE status = 'room' AND ((requester_bot = ? AND target_bot = ?) OR (requester_bot = ? AND target_bot = ?))
        AND id IN (SELECT relationship_id FROM grants WHERE room_id = ?)`, guest, inviterBot, inviterBot, guest, roomId);
      for (const r of rels) {
        // Another live claim on the same room may still seat this pair (a second link for the same Bot): keep it.
        if (this.localPairClaim(roomId, inviterBot, guest, r.id)) continue;
        for (const g of this.all("SELECT * FROM grants WHERE relationship_id = ? AND room_id = ? AND status = 'active'", r.id, roomId)) {
          this.run("UPDATE grants SET status = 'revoked', revoked_at = ? WHERE id = ?", now, g.id);
          // The ending of a share belongs to both owners of the pair: the read side filters by owner id.
          this.audit.append("platform", "grant.revoked", g.id, [r?.requester_owner, r?.target_owner], { reason: "local_invite_ended", room_id: roomId });
        }
        this.run("UPDATE relationships SET status = 'revoked', updated_at = ? WHERE id = ?", now, r.id);
      }
    }
  }
  /**
   * A live claim (not released) that seats this pair in this local room. A withdrawn link keeps the seats it
   * already made (owner decision 2026-10-24); ending a claim, or the room, is what ends one.
   */
  private localPairClaim(roomId: string, a: string, b: string, _relId?: string) {
    const rows = this.all(`SELECT i.inviter_bot, c.bots FROM local_room_invites i JOIN local_room_invite_claims c ON c.ticket = i.ticket
      WHERE i.room_id = ? AND c.released_at IS NULL AND i.inviter_bot IN (?, ?)`, roomId, a, b);
    return rows.find((row: any) => {
      const guests = J(row.bots, []) as string[];
      return (row.inviter_bot === a && guests.includes(b)) || (row.inviter_bot === b && guests.includes(a));
    }) ?? null;
  }

  getFaceRoom(p: Principal, roomId: string, opts: { after?: number; as_bot?: string } = {}) {
    // This method used to open with an unscoped `advanceFaceRooms()`, so a home with no seat settled another home's
    // lapsed room (status `open`, number voided, `room.started` written and every member woken) and was answered 404
    // only afterwards. Room promotion is the room's own act and is not run here at all: the answer below comes from
    // `faceRoomView`, whose `faceSettledRoom` settles exactly the room this call read, after the caller was checked —
    // a member's read still starts their own room, a home with no seat starts none. The share half stays and stays
    // first: a share that ran out on its own clock takes the seat it made back with it, so the guest whose share just
    // lapsed is refused by the membership check below, not handed the room one last time.
    this.expireLapsedShares();
    const viewer = this.faceRequireMember(p, roomId, opts.as_bot);
    const floor = viewer.joinSeq - 1;
    const after = Math.max(this.faceCursor(opts.after, floor), floor);
    return this.faceRoomView(roomId, viewer, { after });
  }

  listFaceRooms(p: Principal) {
    const ownerId = p.ownerId;
    const extra = p.kind === "bot" ? "AND m.bot_id = ?" : "";
    const args: unknown[] = p.kind === "bot" ? [ownerId, ownerId, ownerId, ownerId, p.botId] : [ownerId, ownerId, ownerId, ownerId];
    // A room list is not the room's own door: settling a lapsed candidate voids its number, deletes the code rows and
    // wakes every member, so the read settles only the rooms it is about to answer with. That is the seat rule the
    // query below already uses - a seat of this caller, or a guest this home brought in - so the rooms the read talks
    // about and the rooms it writes to are one set. A caller with no seat anywhere settles nothing, and a Bot's own
    // token settles only the rooms that Bot sits in, not the ones its home's other Bots sit in.
    const listed = new Set<string>(this.all(`SELECT DISTINCT r.id FROM face_rooms r
      JOIN face_room_members m ON m.room_id = r.id AND m.left_at IS NULL AND (m.owner_id = ? OR (m.added_by_owner_id = ? AND (
        NOT EXISTS (SELECT 1 FROM face_room_members gone WHERE gone.room_id = m.room_id AND gone.owner_id = ? AND gone.left_at IS NOT NULL)
        OR EXISTS (SELECT 1 FROM face_room_members seated WHERE seated.room_id = m.room_id AND seated.owner_id = ? AND seated.left_at IS NULL)))) ${extra}
      WHERE r.status != 'closed'`, ...args).map((r: any) => r.id as string));
    this.advanceFaceRooms(listed);
    const rows = this.all(`SELECT r.id, r.status, r.expires_at, r.started_at, COUNT(DISTINCT m2.bot_id) member_count
      FROM face_rooms r
      JOIN face_room_members m ON m.room_id = r.id AND m.left_at IS NULL AND (m.owner_id = ? OR (m.added_by_owner_id = ? AND (
        NOT EXISTS (SELECT 1 FROM face_room_members gone WHERE gone.room_id = m.room_id AND gone.owner_id = ? AND gone.left_at IS NOT NULL)
        OR EXISTS (SELECT 1 FROM face_room_members seated WHERE seated.room_id = m.room_id AND seated.owner_id = ? AND seated.left_at IS NULL)))) ${extra}
      LEFT JOIN face_room_members m2 ON m2.room_id = r.id AND m2.left_at IS NULL
      WHERE r.status != 'closed'
      GROUP BY r.id ORDER BY r.created_at DESC`, ...args);
    return {
      rooms: rows.map((r: any) => ({
        room_id: r.id, status: r.status, expires_at: this.faceRoomDeadline(r), started_at: r.started_at, member_count: r.member_count,
        // "My Bot" is the test every write door uses (`owner_id === caller`), so a guest brought in on a share is not
        // one: it is listed under `brought_bots` instead — a seat this home can see and manage, never speak as — and
        // the console reads `my_bots` for whose words are its own (`roomLineHtml`, the "Yours" pill).
        my_bots: this.all(`SELECT m.handle, m.display_name, b.avatar, b.color, b.avatar_updated_at FROM face_room_members m JOIN bots b ON b.id = m.bot_id WHERE m.room_id = ? AND m.left_at IS NULL AND m.owner_id = ? ${extra}`,
          r.id, ownerId, ...(p.kind === "bot" ? [p.botId] : []))
          .map((m: any) => ({ handle: m.handle, display_name: peerDisplayName(m.display_name, "Bot"), ...lookOf(m) })),
        brought_bots: p.kind === "bot" ? [] : this.all(`SELECT m.handle, m.display_name, b.avatar, b.color, b.avatar_updated_at FROM face_room_members m JOIN bots b ON b.id = m.bot_id WHERE m.room_id = ? AND m.left_at IS NULL AND m.added_by_owner_id = ? AND m.owner_id != ? AND (
          NOT EXISTS (SELECT 1 FROM face_room_members gone WHERE gone.room_id = m.room_id AND gone.owner_id = ? AND gone.left_at IS NOT NULL)
          OR EXISTS (SELECT 1 FROM face_room_members seated WHERE seated.room_id = m.room_id AND seated.owner_id = ? AND seated.left_at IS NULL))`,
          r.id, ownerId, ownerId, ownerId, ownerId)
          .map((m: any) => ({ handle: m.handle, display_name: peerDisplayName(m.display_name, "Bot"), ...lookOf(m) })),
      })),
    };
  }

  /**
   * One week of face rooms, read-only: the rooms the caller sat in whose `closed_at` falls in the current UTC week
   * (Monday 00:00 → next Monday 00:00), one line each, all of it taken from the recap the close already wrote
   * (#428). Never the transcript and never an approval row: the recap is counts, names and the room's own note.
   *
   * The caller decides the scope, not the account: an owner sees every room one of their seats sat in, a Bot sees
   * only its own seats, so a recap can never reach a home that was not in the room. Reading writes nothing, so the
   * same week answers the same object every time — an empty week included, as the same shape with zeroes.
   */
  weekDigest(p: Principal) {
    const start = Math.floor((this.nowMs() - 4 * 864e5) / (7 * 864e5)) * 7 * 864e5 + 4 * 864e5;
    const startIso = new Date(start).toISOString();
    const endIso = new Date(start + 7 * 864e5).toISOString();
    const seat = p.kind === "owner"
      ? { sql: "EXISTS (SELECT 1 FROM face_room_members m WHERE m.room_id = r.id AND m.owner_id = ?)", args: [p.ownerId] as unknown[] }
      : { sql: "EXISTS (SELECT 1 FROM face_room_members m WHERE m.room_id = r.id AND m.bot_id = ?)", args: [p.botId] as unknown[] };
    const rows = this.all(`SELECT r.id, r.recap FROM face_rooms r
      WHERE r.status = 'closed' AND r.recap IS NOT NULL AND r.closed_at >= ? AND r.closed_at < ? AND ${seat.sql}
      ORDER BY r.closed_at, r.id`, startIso, endIso, ...seat.args);
    const counts = { rooms: 0, approved: 0, rejected: 0, cancelled: 0, expired: 0 };
    const rooms: any[] = [];
    for (const row of rows) {
      let recap: any;
      try { recap = J(row.recap); } catch { continue; } // a row this build cannot read is left out, never guessed at
      if (!recap) continue;
      const decisions = {
        approved: Number(recap.decisions?.approved ?? 0),
        rejected: Number(recap.decisions?.rejected ?? 0),
        cancelled: Number(recap.decisions?.cancelled ?? 0),
        expired: Number(recap.decisions?.expired ?? 0),
      };
      rooms.push({
        room_id: String(recap.room_id ?? row.id),
        closed_at: recap.closed_at ?? null,
        reason: recap.reason ?? null,
        note: recap.note ?? null,
        decisions,
        members: (Array.isArray(recap.members) ? recap.members : [])
          .map((m: any) => ({ handle: String(m?.handle ?? ""), owner_name: String(m?.owner_name ?? "") })),
      });
      counts.rooms += 1;
      counts.approved += decisions.approved;
      counts.rejected += decisions.rejected;
      counts.cancelled += decisions.cancelled;
      counts.expired += decisions.expired;
    }
    return { digest_version: 1, week: startIso.slice(0, 10), period: { start: startIso, end: endIso }, rooms, counts };
  }

  startFaceRoom(p: Principal, roomId: string) {
    // Lapsed shares settle here as they always have, before this door reads anything.
    this.expireLapsedShares();
    // #318: starting ends the matching window for everyone and voids the number, so the caller needs a seat of its
    // own, not the wider membership that also admits a home which only brought a guest in.
    const viewer = this.faceRequireOwnSeat(p, roomId);
    // Starting is the lead's outbound act for the whole room: it voids the number for everyone, pushes every member,
    // writes a platform-trusted `room.started` line and leaves an audit row. A Bot that was stopped or removed is
    // therefore refused here with the same answers every outbound door gives (#196), before the sweep and before the
    // promotion, so a refused call leaves the room `candidate` with its `expires_at`, its code, its events and its
    // chain untouched (#783). The door signs with `viewer.botIds[0]`, so that seat is the one judged: acting on a
    // different seat of the same home would name a Bot the caller did not ask to act as.
    this.assertInvitable(this.bot(viewer.botIds[0]));
    // The sweep is the room's own act, so it settles the one room this request names. Reading the seat first matters
    // here: `faceSeatRooms` also counts a home that only brought a guest, which `faceRequireOwnSeat` refuses, and
    // that refused caller used to settle the very room it was refused on.
    this.advanceFaceRooms(new Set([roomId]));
    this.db.transaction(() => {
      const room = this.get("SELECT * FROM face_rooms WHERE id = ?", roomId);
      if (room.status === "closed") throw new ApiError(409, "room_closed", "this room is closed");
      if (room.status === "candidate") this.faceStartRoom(room, "start", { actor: this.actorOf(p), botId: viewer.botIds[0] });
    }).immediate();
    return this.faceRoomView(roomId, viewer);
  }

  leaveFaceRoom(p: Principal, roomId: string, body: any = {}) {
    // A leave names one room, so it settles one room, and it does that only after the caller is judged a member of
    // it. The sweep is not a private act: it voids the number, deletes the codes, writes a start event and an audit
    // row, and wakes every member. Settling the caller's whole seat set here therefore opened rooms the request never
    // named (another home's lapsed room the caller sat in went `candidate` -> `open`), and a leave the door then
    // refused had already settled the caller's own lapsed rooms before it answered 404.
    // The lapsed shares still expire before the member gate, in the same place they did: a share's own clock is not
    // the room's business, and moving that half after the gate would turn the lapse a refused leave declares into
    // silence (#739). What moves is only the promotion half: after the gate, over the one room this request names.
    this.expireLapsedShares();
    const viewer = this.faceRequireMember(p, roomId);
    this.advanceFaceRooms(new Set([roomId]));
    // Only the caller's own Bots leave. A brought guest is the other owner's seat even though this owner
    // added it, and the other owner ends it by revoking the grant (or leaving with their own token).
    // The list is judged before it is read: `normalizeBotRefs` answers an explicit empty list (or a list of
    // blanks) with "nothing named", and here "nothing named" means every seat this owner holds — so `{"bots": []}`
    // used to end them all, revoke the room's grants for those seats and send the room's members a leave event,
    // and the last member's leave closes the room. The join door states the rule for the same read (#609): an
    // explicit list names Bots, so an empty list names nobody and is refused, and an element that is not a
    // non-empty string is refused rather than coerced. An absent field and an explicit null keep their meaning:
    // every seat of the caller leaves.
    this.assertFaceBotRefs(body);
    let leaving = viewer.members.filter((m: any) => m.owner_id === p.ownerId);
    const refs = this.normalizeBotRefs(body);
    if (refs.length) {
      for (const r of refs) {
        const raw = handleRef(r);
        if (leaving.some((m: any) => m.bot_id === r)) continue;
        if (leaving.some((m: any) => String(m.handle ?? "").replace(/^@/, "") === raw)) continue;
        const ci = leaving.filter((m: any) => handleKey(m.handle) === raw.toLowerCase());
        if (ci.length > 1) throw ambiguous(raw, ci.length);
      }
      leaving = leaving.filter((m: any) => refs.some((r) => m.bot_id === r || handleKey(m.handle) === handleKey(r)));
      assert(leaving.length, 404, "bot_not_found", "none of your Bots are in this room");
    }
    this.db.transaction(() => {
      for (const m of leaving) this.removeFaceMember(roomId, m, "room_left");
      this.endRoomGrantsForBots(roomId, leaving.map((m: any) => m.bot_id));
    }).immediate();
    // The members still here, plus the one leaving: an owner who left earlier is no longer a member, so later
    // leaves are not theirs to read (joins and messages already stop at the member boundary).
    // A leave that removes nobody writes nothing: it is not a leave, and a row saying it happened would put an
    // owner who never sat in the room into that room's audit trail. The same rule a join that seats nobody
    // follows for `face_room.joined`; the response and the room state are unchanged.
    if (leaving.length) this.audit.append(this.actorOf(p), "face_room.left", roomId, [...this.faceOwnerIds(roomId), viewer.ownerId], { bots: leaving.map((m: any) => m.bot_id) });
    const still = this.get("SELECT 1 FROM face_room_members WHERE room_id = ? AND owner_id = ? AND left_at IS NULL", roomId, viewer.ownerId);
    // `still` asks about the owner, but the read below answers as the caller, and a Bot token is narrowed to its own
    // seat (`faceRequireMember`). A Bot that leaves while another seat of the same owner stays therefore had its seat
    // removed, wrote the audit row and the events, and was then answered 404 `face_room_not_found` for the read-back.
    // A Bot token always gets the summary: its own seat is gone by definition, and a client that reads 404 as "the
    // leave failed" would retry a leave that already happened.
    if (!still || p.kind === "bot") return { room_id: roomId, status: this.get("SELECT status FROM face_rooms WHERE id = ?", roomId).status, left: leaving.map((m: any) => m.handle) };
    return this.faceRoomView(roomId, this.faceRequireMember(p, roomId));
  }

  /**
   * Pick the room lead (FlyBot #476). Only the room creator, with an owner token (a person's UI action, never a
   * Bot token); `bot` must be a Bot in the room now; null / "" goes back to the default lead.
   */
  setFaceRoomLead(p: Principal, roomId: string, body: any = {}) {
    // Lapsed shares settle here as they always have, before this door reads anything.
    this.expireLapsedShares();
    const viewer = this.faceRequireMember(p, roomId);
    // The sweep is the room's own act - it voids the number, deletes its code rows, names the promotion in the
    // transcript and wakes every member - so it settles the one room this request names. A write against another
    // room must not promote a lapsed candidate the caller happens to sit in, and a caller refused at the seat check
    // above settles nothing at all.
    this.advanceFaceRooms(new Set([roomId]));
    assert(p.kind === "owner", 403, "forbidden", "only the room creator picks the lead, from their own app; a Bot token cannot");
    assert(this.faceCreatorOf(viewer.room) === viewer.ownerId, 403, "not_room_creator", "only the person who created this room picks its lead");
    const room = this.get("SELECT * FROM face_rooms WHERE id = ?", roomId);
    if (room.status === "closed") throw new ApiError(409, "room_closed", "this room is closed");
    // A lead is named by id or handle, and "nobody named" is an absent field, an explicit null, or a blank
    // string. `String(...)` below is what reads the value, and `String([])` and `String([""])` are both the empty
    // string, so an array used to read as "nobody named" and clear the room's lead — an UPDATE of
    // `face_rooms.lead_bot_id`, a `face_room.lead_changed` audit row and a room event the caller never asked for.
    // Objects, booleans and numbers took the other old path and were answered 400 `bot_not_in_room`, naming the
    // wrong problem. Refuse a wrong-typed name here, after the room's own refusals above (a closed room still
    // answers 409, a caller who is not the creator still answers 403) and before anything is read or written, so
    // "not given" keeps its meaning exactly. The aliases are read in the order below, so the first wrong one is
    // the one named.
    for (const field of ["bot", "bot_handle", "handle", "bot_id"] as const) {
      const named = body?.[field];
      assert(named === undefined || named === null || typeof named === "string", 400, "invalid_request", `${field} must be a string`);
    }
    const raw = body?.bot ?? body?.bot_handle ?? body?.handle ?? body?.bot_id ?? null;
    let botId: string | null = null;
    if (raw !== null && raw !== undefined && String(raw).trim() !== "") {
      const ref = String(raw).trim();
      const m = this.get("SELECT * FROM face_room_members WHERE room_id = ? AND left_at IS NULL AND (bot_id = ? OR handle = ?)", roomId, ref, "@" + handleRef(ref))
        ?? this.faceMemberByHandle(roomId, ref);
      assert(m, 400, "bot_not_in_room", "that Bot is not in this room now");
      botId = m.bot_id;
    }
    if ((room.lead_bot_id ?? null) !== botId) {
      // The event names the Bot whose lead state actually changed: the pick for a `set`, and the lead being taken
      // away for a `cleared`. The caller's own first seat is a poor stand-in — a creator may seat several Bots and
      // the pick may be the other home's — and every reader of the transcript would be pointed at the wrong Bot.
      const changed = botId ?? (room.lead_bot_id ?? null);
      this.db.transaction(() => this.faceSetLead(roomId, botId, botId ? "set" : "cleared", changed)).immediate();
      this.audit.append(this.actorOf(p), "face_room.lead_changed", roomId, this.faceOwnerIds(roomId), { lead_bot: botId });
    }
    return this.faceRoomView(roomId, viewer);
  }

  /**
   * What the room is for, one sentence its lead writes for everyone: room metadata, not a transcript line, so reading
   * it never depends on when a member joined and writing it never moves a cursor. Trimmed, 1-500 characters.
   */
  setFaceRoomNote(p: Principal, roomId: string, body: any = {}) {
    // Lapsed shares settle here as they always have, before this door reads anything.
    this.expireLapsedShares();
    const viewer = this.faceRequireMember(p, roomId);
    // The sweep is the room's own act - it voids the number, deletes its code rows, names the promotion in the
    // transcript and wakes every member - so it settles the one room this request names. A write against another
    // room must not promote a lapsed candidate the caller happens to sit in, and a caller refused at the seat check
    // above settles nothing at all.
    this.advanceFaceRooms(new Set([roomId]));
    const room = this.faceRequireLead(p, roomId, "set the room note");
    if (room.status === "closed") throw new ApiError(409, "room_closed", "this room is closed");
    // The note speaks for the whole room, so writing it is the lead's outbound act rather than room metadata anyone
    // seated may set: a lead that was stopped or removed is refused with the same answers every outbound door gives
    // (#196), before the row is written. Without this the stop's own owner could still put text in front of every
    // other owner in the room, while the same Bot's lines were refused as `bot_frozen`.
    const lead = this.faceLeadOf(room).effective;
    if (lead) this.assertInvitable(this.bot(lead.bot_id));
    const raw = body?.note;
    const note = typeof raw === "string" ? raw.trim() : "";
    assert(note.length >= 1 && note.length <= 500, 400, "invalid_note", "note must be 1-500 characters");
    this.run("UPDATE face_rooms SET note = ? WHERE id = ?", note, roomId);
    // The note is what every seated owner reads back from the roster, and rewriting it is the lead's outbound act.
    // Every other room mutation already leaves a row (created, joined, left, lead changed, invite minted/revoked,
    // started, a message drafted or delivered); without one here, a room whose note was replaced reads exactly like a
    // room whose note was always that way. The text itself is left out: the row records that the note changed, not
    // the words, so the audit chain never becomes a second copy of what the room was told.
    this.audit.append(this.actorOf(p), "face_room.note_changed", roomId, this.faceOwnerIds(roomId), { chars: note.length });
    return this.faceRoomView(roomId, viewer);
  }

  /**
   * Role labels of your own Bots in a room (FlyBot #476 roster): `{ roles: { "<handle or bot id>": "Writer" | null } }`.
   * Plain text, sanitized like a name and capped at 80; shown to every member as untrusted data. A successful write
   * appends a `room.role_changed` event and tells every member (`face_room.role_changed`), like the lead change it
   * sits next to; a refused one writes nothing and tells nobody.
   */
  setFaceRoomRoles(p: Principal, roomId: string, body: any = {}) {
    // Lapsed shares settle here as they always have, before this door reads anything.
    this.expireLapsedShares();
    const viewer = this.faceRequireMember(p, roomId);
    // The sweep is the room's own act - it voids the number, deletes its code rows, names the promotion in the
    // transcript and wakes every member - so it settles the one room this request names. A write against another
    // room must not promote a lapsed candidate the caller happens to sit in, and a caller refused at the seat check
    // above settles nothing at all.
    this.advanceFaceRooms(new Set([roomId]));
    const roles = body?.roles;
    assert(roles && typeof roles === "object" && !Array.isArray(roles) && Object.keys(roles).length > 0 && Object.keys(roles).length <= this.faceRoomLimits.maxMembers,
      400, "invalid_request", "roles must be an object of your Bots in this room: { \"@handle\": \"role\" | null }");
    const changes: [string, string | null][] = [];
    // Role labels belong to the Bot's owner, even when someone else brought the Bot into the room.
    const ownMembers = viewer.members.filter((m: any) => m.owner_id === p.ownerId);
    for (const [ref, value] of Object.entries(roles)) {
      const m = ownMembers.find((x: any) => x.bot_id === ref) ?? pickByHandle(ownMembers, ref);
      assert(m, 404, "bot_not_found", `${ref} is not one of your Bots in this room`);
      assert(value === null || typeof value === "string", 400, "invalid_request", "a role is a string or null");
      changes.push([m.bot_id, value === null ? null : sanitizePeerName(value, "", FACE_ROOM_ROLE_MAX) || null]);
    }
    // A label is read by every member of the room, so writing one is that Bot's own outbound act rather than room
    // metadata any seated owner may set: a Bot that was stopped or removed is refused with the same answers every
    // outbound door gives (#196), before a row is written. Without this its owner could keep renaming it in every
    // other home's roster while the same Bot could no longer write a line there.
    for (const [botId] of changes) this.assertInvitable(this.bot(botId));
    // A label is read by every member of the room, so relabelling a Bot changes what the other homes' rosters show of
    // it. The lead change next door tells every seat (`room.lead_changed`, then `face_room.lead_changed` on each
    // member Bot); a label change with only an audit row (#675) left a member polling `?after=<cursor>` with nothing
    // to read. One event, in the same write, with the lead event's field set: the label itself is peer text and stays in
    // the view, never in a platform-trusted event or a push. A write that sets the label the Bot already carries
    // changes nothing to announce and stays silent, the way setting the same lead again does; the audit row below
    // still records every write, as #675 wrote it.
    const held = new Map(this.all("SELECT bot_id, role FROM face_room_members WHERE room_id = ? AND left_at IS NULL", roomId).map((m: any) => [m.bot_id as string, (m.role ?? null) as string | null]));
    // A seat can be named more than once in one body, by handle and by bot id: the write ends each seat on the last
    // value its entries give it, so the question "did anything change" is about that value, not about every entry.
    // Comparing entry by entry counted a label that walked away and back as a change and told the room about it.
    const settled = new Map(changes);
    const data = { text: "A role label in this room changed.", trust: "platform" };
    this.db.transaction(() => {
      for (const [botId, role] of settled) this.run("UPDATE face_room_members SET role = ? WHERE room_id = ? AND bot_id = ?", role, roomId, botId);
      const changed = [...settled].filter(([botId, role]) => (held.get(botId) ?? null) !== role);
      if (!changed.length) return;
      // The event credits the Bot whose label changed, not whoever the caller happens to list first: an owner with
      // several seated Bots gets an event that names the one it touched, the way `room.lead_changed` names the lead.
      const ev = this.faceInsertEvent(roomId, "room.role_changed", changed[0][0], data);
      this.faceEmitMembers(roomId, "face_room.role_changed", { room_id: roomId, event_id: ev.id, event_cursor: ev.seq, ...data });
    }).immediate();
    // A label is read by every member of the room, so relabelling a Bot changes what the other owners see of it. The
    // other room mutations are all on the audit chain; this one was not, which left a roster that reads as if the
    // labels it carries now are the labels it always carried. The row names the Bots and their new labels, nothing else:
    // one entry per seat, holding the value the write ends it on, so an entry the same body later replaced never reaches
    // the chain and a seat named twice is still listed once.
    this.audit.append(this.actorOf(p), "face_room.role_changed", roomId, this.faceOwnerIds(roomId), { bots: [...settled].map(([botId, role]) => ({ bot: botId, role })) });
    return this.faceRoomView(roomId, viewer);
  }

  draftFaceRoomMessage(p: Principal, roomId: string, body: { text?: string; bot_id?: string; bot?: string; typed_by_owner?: boolean; mentions?: string[] | null } = {}) {
    const typed = this.typedByOwner(p, body);
    const mentions = this.mentionList(body?.mentions);
    // Lapsed shares settle here as they always have, before this door reads anything.
    this.expireLapsedShares();
    const viewer = this.faceRequireMember(p, roomId, body.bot_id ?? body.bot);
    // The sweep is the room's own act - it voids the number, deletes its code rows, names the promotion in the
    // transcript and wakes every member - so it settles the one room this request names. A draft for another room
    // must not promote a lapsed candidate the caller happens to sit in, and a caller refused at the seat check above
    // settles nothing at all.
    this.advanceFaceRooms(new Set([roomId]));
    const room = this.get("SELECT * FROM face_rooms WHERE id = ?", roomId);
    if (room.status === "closed") throw new ApiError(409, "room_closed", "this room is closed");
    // The line is stored, shown and announced as text, so the field must be a string. `String(body?.text ?? "")`
    // turned an object into "[object Object]" and an array into "1,2", which the room then read as a real line, and
    // with auto_approve_face_rooms on nobody had to approve it. Refused here, after the room_closed 409 so a closed
    // room keeps its own answer; absent, null and "" still fall through to the length sentence below.
    assert(body?.text === undefined || body?.text === null || typeof body.text === "string", 400, "invalid_request", "text must be a string");
    const text = String(body?.text ?? "");
    assert(text.length > 0 && text.length <= 4000, 400, "invalid_request", "text (1-4000 chars) required");
    // A room can contain a Bot another owner brought with a grant (added_by_owner_id = this owner). That
    // lets the bringer see and manage the seat, never speak as that Bot: only its own owner may send.
    const own = viewer.members.filter((m: any) => m.owner_id === p.ownerId);
    assert(own.length, 403, "forbidden", "you can only send as your own Bot");
    const sender = this.bot(own[0].bot_id);
    // The kill switch stops this Bot's outbound side here too: a stopped Bot's owner typing in its name is the
    // same act as the home page's send-as-member (#196), and it must name the stop, not queue a card that the
    // approval door will later kill as "revoked".
    this.assertInvitable(sender);
    const flags = this.dlp(sender.owner_id, { text });
    const blocked = flags.filter((f) => f.action === "block");
    if (blocked.length) throw new ApiError(422, "dlp_blocked", "outbound DLP blocked this draft", { categories: blocked.map((b) => b.category) });
    const minuteAgo = this.nowMs() - 60e3, hourAgo = this.nowMs() - 3600e3;
    if (this.get("SELECT COUNT(*) n FROM face_room_drafts WHERE room_id = ? AND sender_bot = ? AND created_ms > ?", roomId, sender.id, minuteAgo).n >= LIMITS.ratePerConversationPerMin)
      throw new ApiError(429, "rate_limited", "per-room rate limit (6/min)", { retry_after: 60 });
    if (this.draftsInLastHour(sender.id, hourAgo) >= LIMITS.ratePerBotPerHour)
      throw new ApiError(429, "rate_limited", "global bot rate limit (60/h)", { retry_after: 3600 });
    const id = newId("fmd");
    // Only people in the room can be mentioned in it; handles that are not (or no longer) members are dropped.
    // Checked again when the line is delivered, since a member can leave while it waits for approval.
    const kept = this.roomMentions(roomId, mentions);
    const reasons = ["mvp.all_outbound_requires_approval", ...flags.map((f) => `dlp.${f.category}`)];
    // #49: face-room drafts carry no attachments, so the field is risk, policy or the room's own switch.
    // Nothing else holding the line means `auto_approve_face_rooms` is off, and that card is the owner's:
    // name it apart from the blanket hold a connector may decide.
    const injectionSuspected = detectInjection(text).suspected;
    const found = holdReasonOf({ riskFlags: flags, injectionSuspected });
    const holdReason: HoldReason = found === "blanket_outbound" ? "face_room_auto_send_off" : found;
    const snap = this.faceSnapshot(sender);
    // A room draft writes an approval card, so it opens a delivery moment; settle the queue first, outside the
    // transaction below, so a card that lapsed while the owner's batch waited is not named as still waiting
    // (`requestGrant` carries the full reasoning).
    this.expireStale();
    // One write, as the message and action doors do (#516): a refused `face_room_drafts` insert used to leave the
    // card behind, and the card named a draft that was never written.
    const aprId = this.atomically(() => {
      const apr = this.createApproval(sender.owner_id, "face_room_message", id, sender.id, null, `To face room: ${text.slice(0, 80)}`, reasons, flags, LIMITS.approvalTtlMs, { room_id: roomId }, holdReason);
      this.run("INSERT INTO face_room_drafts (id, room_id, sender_bot, payload, status, approval_id, created_at, created_ms, typed_by_owner, mentions) VALUES (?,?,?,?,?,?,?,?,?,?)",
        id, roomId, sender.id, JSON.stringify({ text }), "pending_approval", apr, this.ts(), this.nowMs(), typed ? 1 : 0, kept.length ? JSON.stringify(kept) : null);
      return apr;
    });
    this.audit.append(`bot:${sender.id}`, "face_room.message_drafted", id, this.faceOwnerIds(roomId), { room_id: roomId, approval_id: aprId });
    const o = this.owner(sender.owner_id);
    if (o.auto_approve_face_rooms && flags.length === 0 && !injectionSuspected) {
      this.decideApproval({ kind: "owner", ownerId: sender.owner_id }, aprId, { decision: "approved" }, "policy:auto_approve");
      const d = this.get("SELECT * FROM face_room_drafts WHERE id = ?", id);
      return { message_id: id, status: "delivered", approval_id: aprId, event_cursor: d.event_seq, auto_approved: true, ...(typed ? { typed_by_owner: true } : {}), ...(kept.length ? { mentions: kept } : {}), from: snap };
    }
    return { message_id: id, status: "pending_approval", approval_id: aprId, hold_reason: holdReason, ...(typed ? { typed_by_owner: true } : {}), ...(kept.length ? { mentions: kept } : {}), from: snap };
  }

  /** What an owner's edit may set on a held face-room line: its text, parsed and bounded before anything is written. */
  private static faceRoomEdit(ep: any): { text: string } {
    assert(ep && typeof ep === "object" && !Array.isArray(ep), 400, "invalid_request", "edited_payload must be an object");
    assert(typeof ep.text === "string" && ep.text.length >= 1 && ep.text.length <= 4000, 400, "invalid_request", "edited_payload.text (1-4000 chars) required");
    return { text: ep.text };
  }

  private deliverFaceRoomMessage(a: any, body: any) {
    const d = this.get("SELECT * FROM face_room_drafts WHERE id = ?", a.subject_id);
    const room = this.get("SELECT * FROM face_rooms WHERE id = ?", d.room_id);
    assert(room && room.status !== "closed", 409, "room_closed", "this room is closed");
    let payload = J(d.payload);
    if (body.decision === "approved_with_edits" && body.edited_payload) {
      // A draft's payload is `{ text }`: an edit replaces it, it is never folded in. Spreading the request let a
      // non-string or a 5000-character line reach `untrusted_content.text`, and a bare string spread into "0","1",…
      // The draft door already holds this window (1-4000); the edit door must not widen it.
      payload = Platform.faceRoomEdit(body.edited_payload);
      const blocked = this.dlp(this.bot(d.sender_bot).owner_id, payload).filter((f) => f.action === "block");
      assert(!blocked.length, 422, "dlp_blocked", "edited payload blocked by DLP", { categories: blocked.map((b) => b.category) });
    }
    const edited = body.decision === "approved_with_edits" && !!body.edited_payload; // the list described the typed text; an edited line carries none
    // Membership is re-checked before any write: a line whose sender left the room is refused, and the draft keeps the list it had.
    const still = this.get("SELECT * FROM face_room_members WHERE room_id = ? AND bot_id = ? AND left_at IS NULL", d.room_id, d.sender_bot);
    assert(still, 409, "not_a_member", "sender is no longer in the room");
    // A mentioned Bot that left while the line waited is dropped. What is stored is what is delivered.
    const listed = edited ? [] : this.roomMentions(d.room_id, mentionsOf(d.mentions));
    if (d.mentions) this.run("UPDATE face_room_drafts SET mentions = ? WHERE id = ?", listed.length ? JSON.stringify(listed) : null, d.id);
    const snap = this.faceMemberPublic(still);
    const inj = detectInjection(String(payload.text ?? ""));
    const ev = this.faceInsertEvent(d.room_id, "room.message", d.sender_bot, {
      from: snap, trust: "peer_untrusted", untrusted_content: { text: payload.text },
      security: { injection_suspected: inj.suspected }, edited_by_owner: edited,
      ...(d.typed_by_owner ? { typed_by_owner: true } : {}),
      ...(listed.length ? { mentions: listed } : {}),
    });
    this.run("UPDATE face_room_drafts SET status = 'delivered', event_seq = ? WHERE id = ?", ev.seq, d.id);
    this.faceEmitMembers(d.room_id, "face_room.message", {
      room_id: d.room_id, event_id: ev.id, event_cursor: ev.seq, message_id: d.id,
      from: snap, trust: "peer_untrusted", untrusted_content: { text: payload.text },
      security: { injection_suspected: inj.suspected },
      ...(d.typed_by_owner ? { typed_by_owner: true } : {}),
      ...(listed.length ? { mentions: listed } : {}),
    });
    this.emit(d.sender_bot, "approval.decided", { approval_id: a.id, kind: "face_room_message", message_id: d.id, room_id: d.room_id, decision: body.decision, note_to_bot: body.note_to_bot ?? null });
    this.audit.append("platform", "face_room.message_delivered", d.id, this.faceOwnerIds(d.room_id), { room_id: d.room_id, event_seq: ev.seq, edited });
    return { message_id: d.id, status: "delivered", event_cursor: ev.seq };
  }
  private rejectFaceRoomMessage(a: any, note?: string) {
    const d = this.get("SELECT * FROM face_room_drafts WHERE id = ?", a.subject_id);
    this.run("UPDATE face_room_drafts SET status = 'rejected' WHERE id = ?", d.id);
    this.emit(d.sender_bot, "approval.decided", { approval_id: a.id, kind: "face_room_message", message_id: d.id, room_id: d.room_id, decision: "rejected", note_to_bot: note ?? null });
    return { message_id: d.id, status: "rejected" };
  }

  // ================================================================ presence ("thinking")
  /** The Bot a presence call acts as: an owner names one of theirs (or has one), a Bot token is only itself. */
  private presenceBot(p: Principal, ref?: unknown) {
    // An owner names one of their Bots with a string, or names none at all. `want` below is what reads the value,
    // and `String([])` / `String([""])` are the empty string, so an array used to read as "nobody named": the call
    // quietly acted as the account's home Bot — a "thinking" line published, or cleared, in another Bot's name,
    // with nothing in the answer to say which Bot it was. Objects, booleans and numbers took the other old path
    // and were answered 404 `bot_not_found`, naming the wrong problem. An object whose `toString` is not a
    // function made that read throw before any gate, so the caller was answered 500 `internal_error`. Judge the
    // type before the value is read at all. In the owner branch only: a Bot token speaks for itself alone, and its
    // own 403 for a name that is not itself must stay a 403 rather than become a 400 about the field.
    if (p.kind !== "bot") assert(ref === undefined || ref === null || typeof ref === "string", 400, "invalid_request", "bot_id must be a string");
    // A Bot token speaks for itself alone, so a ref it cannot read is the same refusal as naming another Bot: a 403,
    // not a 400 about the field. Judged before the value is read, so an object whose `toString` is not a function is
    // answered here instead of throwing 500, and `String([])` can no longer read as "nobody named".
    if (p.kind === "bot") assert(ref === undefined || ref === null || typeof ref === "string", 403, "forbidden", "a bot token can only act as itself");
    const want = String(ref ?? "").replace(/^@/, "");
    let b: any;
    if (p.kind === "bot") {
      b = this.bot(p.botId);
      assert(!want || want === b.id || want.toLowerCase() === String(b.handle).replace(/^@/, "").toLowerCase(), 403, "forbidden", "a bot token can only act as itself");
    } else {
      const ownerId = this.requireOwner(p);
      b = want
        ? this.get("SELECT * FROM bots WHERE id = ?", want) ?? this.botByRef(want)
        : this.get("SELECT * FROM bots WHERE owner_id = ? AND status = 'active' ORDER BY created_at LIMIT 1", ownerId);
      assert(b, 404, "bot_not_found", "no such bot");
      assert(b.owner_id === ownerId, 403, "forbidden", "not your bot");
    }
    assert(b.status === "active", 403, b.status === "frozen" ? "bot_frozen" : "bot_revoked",
      b.status === "frozen" ? "bot is frozen (emergency stop)" : "this bot identity was revoked");
    return b;
  }

  /**
   * Say that one of my Bots is thinking toward a peer Bot (`to`) or a face room (`room_id`), or that it stopped.
   * Ephemeral and content-free. Allowed only where the Bot could already send: an active relationship, or an open room it is in.
   */
  setPresence(p: Principal, body: { bot_id?: string; state?: string; to?: string; room_id?: string; ttl_seconds?: number } = {}) {
    const state = body?.state;
    assert(state === "thinking" || state === "idle", 400, "invalid_request", "state must be \"thinking\" or \"idle\"");
    // Judge the type before the value is read. `String()` rewrites what the caller wrote - an array wrapping a real
    // handle or room id becomes that string, so the call used to land a line, and `{}` became a name nobody sent - and
    // an object whose `toString` is not a function made the read throw a 500. A value that is neither absent nor a
    // string is the bad field it is, refused here before any read, entry, rate-limit spend, row or room sweep.
    assert(body?.to === undefined || body?.to === null || typeof body?.to === "string", 400, "invalid_request", "to must be a string");
    const to = body?.to === undefined || body?.to === null ? "" : String(body.to);
    assert(body?.room_id === undefined || body?.room_id === null || typeof body?.room_id === "string", 400, "invalid_request", "room_id must be a string");
    const roomId = body?.room_id === undefined || body?.room_id === null ? "" : String(body.room_id);
    assert(!!to !== !!roomId, 400, "invalid_request", "exactly one of to (a Bot handle) or room_id is required");
    let ttl = PRESENCE_DEFAULT_TTL_S;
    if (body?.ttl_seconds !== undefined && body?.ttl_seconds !== null) {
      assert(typeof body.ttl_seconds === "number" && Number.isFinite(body.ttl_seconds), 400, "invalid_request", "ttl_seconds must be a number");
      ttl = Math.min(PRESENCE_MAX_TTL_S, Math.max(PRESENCE_MIN_TTL_S, Math.round(body.ttl_seconds)));
    }
    const me = this.presenceBot(p, body?.bot_id);
    let target: { toBot?: string; roomId?: string };
    if (to) {
      const peer = this.get("SELECT * FROM bots WHERE id = ? AND status = 'active'", to) ?? this.botByRef(to, "status = 'active'");
      assert(peer, 404, "bot_not_found", "no such remote bot");
      // Same gate as sending, but a refused signal is not an audit event: it is not content and can repeat.
      assert(this.findActiveRelationship(me.id, peer.id), 403, "no_relationship", "no active relationship between these bots");
      // The door a line needs, not just the friendship: a share that was revoked or declined leaves the pair
      // friends, so a removed share must stop a new "thinking" here instead of only hiding it on the read side.
      assert(this.findGrant(peer.owner_id, me.id, "chat.public", peer.id), 403, "capability_not_granted", "peer has not granted chat.public", { suggestion: "request_grant" });
      target = { toBot: peer.id };
    } else {
      // The seat is checked before anything is settled. Starting a lapsed candidate voids its number, deletes its
      // code rows and wakes every member, so a write that names a room the caller cannot see must not run the
      // sweep and then answer 404 - it settles nothing. The sweep also covers only the caller's own seats, the
      // same rule the room list and the presence read use; a caller seated nowhere settles nothing.
      const room = this.get("SELECT * FROM face_rooms WHERE id = ?", roomId);
      const member = room && this.get("SELECT 1 FROM face_room_members WHERE room_id = ? AND bot_id = ? AND left_at IS NULL", roomId, me.id);
      assert(room && member, 404, "face_room_not_found", "no such room");
      const seatRooms = new Set<string>(this.all("SELECT DISTINCT room_id FROM face_room_members WHERE left_at IS NULL AND bot_id = ?", me.id).map((r: any) => r.room_id as string));
      this.advanceFaceRooms(seatRooms);
      // Read the status after the sweep: a lapsed candidate the caller sits in starts here exactly as it did when
      // the sweep ran first, and answers 200 rather than `room_not_started`.
      const settled = this.get("SELECT * FROM face_rooms WHERE id = ?", roomId);
      assert(settled.status === "open", 409, settled.status === "closed" ? "room_closed" : "room_not_started", `room is ${settled.status}`);
      target = { roomId };
    }
    assert(this.presence.allow(me.id, this.nowMs()), 429, "rate_limited", `presence rate limit (${PRESENCE_WRITES_PER_MIN}/min per bot)`, { retry_after: 10 });
    if (state === "idle") { this.presence.clear({ botId: me.id, ...target }); return { ok: true, state: "idle" }; }
    const expires = this.presence.set({ botId: me.id, ...target, state: "thinking" }, ttl * 1000, this.nowMs());
    return { ok: true, state: "thinking", expires_at: new Date(expires).toISOString() };
  }

  /**
   * Who is thinking toward me: other people's Bots that are thinking toward one of my Bots (direct) or in a face room I am in.
   * Never my own Bots, never anyone I could not already hear from; relationship and membership are checked now, not when it was set.
   */
  listPresence(p: Principal, opts: { bot_id?: string; room_id?: string } = {}) {
    const viewerOwner = p.ownerId;
    const mine: any[] = p.kind === "bot"
      ? [this.presenceBot(p, opts?.bot_id)]
      : opts?.bot_id ? [this.presenceBot(p, opts.bot_id)] : this.all("SELECT * FROM bots WHERE owner_id = ? AND status = 'active'", viewerOwner);
    const mineIds = new Set(mine.map((b) => b.id as string));
    const handle = (h: string) => "@" + String(h).replace(/^@/, "");
    const out: any[] = [];
    const now = this.nowMs();
    // A presence read is not a room door: it settles the candidate rooms this caller's own Bots are already seated
    // in, and nothing else. Settling a room voids its number and wakes its members, so a read from someone with no
    // seat there must not do it.
    const seatRooms = new Set<string>(mine.length
      ? this.all(`SELECT DISTINCT room_id FROM face_room_members WHERE left_at IS NULL AND bot_id IN (${mine.map(() => "?").join(",")})`, ...mine.map((b: any) => b.id)).map((r: any) => r.room_id as string)
      : []);
    this.advanceFaceRooms(seatRooms);
    for (const e of this.presence.live(now)) {
      const writer = this.get("SELECT * FROM bots WHERE id = ?", e.botId);
      if (!writer || writer.status !== "active" || writer.owner_id === viewerOwner) continue;
      if (e.toBot) {
        if (opts?.room_id || !mineIds.has(e.toBot) || !this.findActiveRelationship(e.botId, e.toBot)) continue;
        const peer = this.bot(e.toBot);
        // The gate is the share the entry was written under, not only the friendship: revoking or declining it
        // drops the entry at once, as the README promises for reading a "thinking" line.
        if (!this.findGrant(peer.owner_id, e.botId, "chat.public", e.toBot)) continue;
        out.push({ scope: "direct", bot: { handle: handle(writer.handle), display_name: sanitizePeerName(writer.display_name, "Bot") }, to: handle(peer.handle), state: e.state, expires_at: new Date(e.expiresMs).toISOString() });
      } else if (e.roomId) {
        if (opts?.room_id && opts.room_id !== e.roomId) continue;
        const room = this.get("SELECT status FROM face_rooms WHERE id = ?", e.roomId);
        const member = room?.status === "open" && this.get("SELECT * FROM face_room_members WHERE room_id = ? AND bot_id = ? AND left_at IS NULL", e.roomId, e.botId);
        if (!member) continue;
        // Same seat rule as the room itself: a guest brought on your share stops counting for you once you left.
        const sees = this.all(`SELECT bot_id FROM face_room_members WHERE room_id = ? AND left_at IS NULL AND (owner_id = ? OR (added_by_owner_id = ? AND (
          NOT EXISTS (SELECT 1 FROM face_room_members gone WHERE gone.room_id = face_room_members.room_id AND gone.owner_id = ? AND gone.left_at IS NOT NULL)
          OR EXISTS (SELECT 1 FROM face_room_members seated WHERE seated.room_id = face_room_members.room_id AND seated.owner_id = ? AND seated.left_at IS NULL))))`,
          e.roomId, viewerOwner, viewerOwner, viewerOwner, viewerOwner)
          .some((m: any) => p.kind !== "bot" || m.bot_id === p.botId);
        if (!sees) continue;
        out.push({ scope: "face_room", room_id: e.roomId, bot: { handle: handle(member.handle), display_name: sanitizePeerName(member.display_name, "Bot") }, state: e.state, expires_at: new Date(e.expiresMs).toISOString() });
      }
    }
    return { presence: out, server_time: this.ts() };
  }

  platformInfo() {
    return { name: "Bot Social", version: "0.1.0", policy_version: POLICY_VERSION, platform_key: { alg: "Ed25519", kid: this.platformKid, public_key: this.platformKey.publicKey }, capabilities: CAPABILITIES, intents: INTENTS, features: ["typed_by_owner", "mentions", "presence", "reply_only_grants", "grants_before_join", "report_not_delivered", "room_lead", "member_roles", "face_room_invites", "local_room_invites"] };
  }
}
