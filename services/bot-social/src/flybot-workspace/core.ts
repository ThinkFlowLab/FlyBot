// FlyBot shared social state on Bot Social (phase C of docs/DSBOT_PLUGIN_ARCHITECTURE.md).
// FlyBot-authored (MIT, see ../../FLYBOT_WORKSPACE.md). Each user's own DS-Bot plugin
// (@flybot-workspace/web) calls these routes with that home's connector token; Bot Social only
// relays and stores the state that is shared between users (teams, membership, invites,
// member conversations, discover listings, follows). Private data never comes here.
import type Database from "better-sqlite3";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import { ApiError, assert } from "../errors.js";
import { newId } from "../ids.js";
import type { Platform } from "../platform.js";
import { MEETING_RECIPIENT_FROM, MEETING_RECIPIENT_VISIBLE } from "./meeting-receipt-access.js";

export const CORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS ot_profiles (
  owner_id TEXT PRIMARY KEY REFERENCES owners(id), handle TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '', platform_user_id TEXT UNIQUE,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ot_notifications (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, owner_id TEXT NOT NULL, kind TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, read_at INTEGER
);
CREATE INDEX IF NOT EXISTS ot_notifications_owner ON ot_notifications(owner_id, seq);
`;

export type Me = { ownerId: string; handle: string; displayName: string };

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export function text(value: unknown, name: string, { min = 0, max = 200, multiline = false } = {}): string {
  assert(typeof value === "string", 400, "invalid_request", `${name} must be a string`);
  const v = multiline ? value : value.replace(/\s+/g, " ").trim();
  assert(v.length >= min && v.length <= max, 400, "invalid_request", `${name} must be ${min}-${max} characters`);
  assert(!CONTROL.test(v) && !(!multiline && /[\r\n\t]/.test(v)), 400, "invalid_request", `${name} has control characters`);
  return v;
}

export function optText(value: unknown, name: string, opts: { min?: number; max?: number; multiline?: boolean } = {}) {
  return value === undefined || value === null ? undefined : text(value, name, opts);
}

export const handleKey = (ref: unknown) => String(ref ?? "").trim().replace(/^@/, "").toLowerCase();
export const hashCode = (code: string) => createHash("sha256").update(code).digest("hex");
export const secretCode = () => randomBytes(24).toString("base64url");

export class OtContext {
  constructor(readonly platform: Platform) {}
  get db(): Database.Database { return this.platform.db; }
  now() { return this.platform.nowMs(); }
  get<T = any>(sql: string, ...args: unknown[]): T | undefined { return this.db.prepare(sql).get(...args) as T | undefined; }
  all<T = any>(sql: string, ...args: unknown[]): T[] { return this.db.prepare(sql).all(...args) as T[]; }
  run(sql: string, ...args: unknown[]) { return this.db.prepare(sql).run(...args); }
  tx<T>(fn: () => T): T { return this.db.transaction(fn)(); }

  /** Owner (login or connector token) behind the request, with its FlyBot profile ensured. */
  me(req: FastifyRequest): Me {
    const h = req.headers.authorization;
    const p = this.platform.authenticate(h?.startsWith("Bearer ") ? h.slice(7) : undefined);
    if (p.kind !== "owner") throw new ApiError(403, "owner_only", "owner or connector token required");
    let row = this.get<any>("SELECT * FROM ot_profiles WHERE owner_id = ?", p.ownerId);
    if (!row) {
      const home = this.get<any>("SELECT handle, display_name FROM bots WHERE owner_id = ? AND integration_type = 'flybot-home' AND status != 'deleted' ORDER BY created_at LIMIT 1", p.ownerId);
      const owner = this.get<any>("SELECT username, display_name FROM owners WHERE id = ?", p.ownerId);
      assert(owner, 404, "owner_not_found", "no such owner");
      const handle = handleKey(home?.handle ?? owner.username);
      const now = this.now();
      this.run("INSERT OR IGNORE INTO ot_profiles(owner_id, handle, display_name, created_at, updated_at) VALUES (?,?,?,?,?)",
        p.ownerId, handle, String(home?.display_name ?? owner.display_name ?? handle).slice(0, 60), now, now);
      row = this.get<any>("SELECT * FROM ot_profiles WHERE owner_id = ?", p.ownerId);
    }
    return { ownerId: row.owner_id, handle: row.handle, displayName: row.display_name };
  }

  /** Resolve another member by handle, owner id, or bound platform user id. */
  ownerByHandle(ref: unknown): string {
    const raw = String(ref ?? "").trim();
    const key = handleKey(ref);
    const row = this.get<any>("SELECT owner_id FROM ot_profiles WHERE handle = ?", key)
      ?? this.get<any>("SELECT owner_id FROM ot_profiles WHERE handle = ?", key + ".home")
      ?? (/^[0-9a-f]{32}$/.test(key) ? this.get<any>("SELECT owner_id FROM ot_profiles WHERE platform_user_id = ?", key) : undefined)
      ?? this.get<any>("SELECT owner_id FROM ot_profiles WHERE owner_id = ?", raw);
    assert(row, 404, "member_not_found", "no FlyBot member with that handle");
    return row.owner_id;
  }

  profileView(ownerId: string) {
    const row = this.get<any>("SELECT owner_id, handle, display_name, bio, platform_user_id FROM ot_profiles WHERE owner_id = ?", ownerId);
    return row
      ? { owner_id: row.owner_id, handle: row.handle, display_name: row.display_name, bio: row.bio, platform_user_id: row.platform_user_id ?? null }
      : { owner_id: ownerId, handle: null, display_name: "(left)", bio: "", platform_user_id: null };
  }

  notify(ownerId: string, kind: string, data: Record<string, unknown>) {
    this.run("INSERT INTO ot_notifications(id, owner_id, kind, data, created_at) VALUES (?,?,?,?,?)",
      newId("otn"), ownerId, kind, JSON.stringify(data), this.now());
  }
}

export const body = (req: FastifyRequest) => (req.body ?? {}) as any;
export const params = (req: FastifyRequest) => req.params as Record<string, string>;
export const query = (req: FastifyRequest) => (req.query ?? {}) as Record<string, unknown>;
export const one = (raw: unknown, name: string): string | undefined => {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string") return raw;
  throw new ApiError(400, "invalid_request", `${name} must be sent once`);
};
export const intParam = (raw: unknown, name: string, fallback: number, max = 1_000_000_000) => {
  const s = one(raw, name);
  if (s === undefined || s.trim() === "") return fallback;
  const n = Number(s);
  assert(Number.isSafeInteger(n) && n >= 0, 400, "invalid_request", `${name} must be a non-negative integer`);
  return Math.min(n, max);
};

function ensureProfileColumns(ot: OtContext) {
  const cols = new Set(ot.all<any>("PRAGMA table_info(ot_profiles)").map((c) => c.name));
  if (!cols.has("platform_user_id")) ot.run("ALTER TABLE ot_profiles ADD COLUMN platform_user_id TEXT");
  ot.run("CREATE UNIQUE INDEX IF NOT EXISTS ot_profiles_platform_user ON ot_profiles(platform_user_id) WHERE platform_user_id IS NOT NULL");
}

const ACTIVE_NOTIFICATION_LISTING = `FROM ot_listings listing
  WHERE listing.id=json_extract(ot_notifications.data,'$.listing_id') AND listing.listed=1`;
const VISIBLE_ARTIFACT_NOTICE = `SELECT 1 FROM ot_messages message
  JOIN ot_message_attachments attachment ON attachment.message_id=message.id
  JOIN ot_conversations conversation ON conversation.id=message.conversation_id
  JOIN ot_conversation_members viewer ON viewer.conversation_id=conversation.id
    AND viewer.owner_id=ot_notifications.owner_id
  WHERE message.id=json_extract(ot_notifications.data,'$.message_id')
    AND conversation.id=json_extract(ot_notifications.data,'$.conversation_id')
    AND message.retracted=0 AND attachment.resource IS NOT NULL
    AND COALESCE(conversation.dm_key,'') NOT LIKE 'agent:%'
    AND NOT EXISTS (SELECT 1 FROM ot_hidden_messages hidden
      WHERE hidden.message_id=message.id AND hidden.owner_id=viewer.owner_id)
    AND (
      EXISTS (SELECT 1 FROM ot_team_members member
        WHERE member.team_id=conversation.team_id AND member.owner_id=viewer.owner_id AND member.suspended=0)
      OR (conversation.team_id IS NULL AND (conversation.account_group=1 OR (conversation.kind='dm' AND (
        EXISTS (SELECT 1 FROM ot_contacts contact
          WHERE contact.owner_a=MIN(viewer.owner_id,message.author_id)
            AND contact.owner_b=MAX(viewer.owner_id,message.author_id) AND contact.status='accepted')
        OR EXISTS (SELECT 1 FROM ot_team_members viewer_team
          JOIN ot_team_members sender_team ON sender_team.team_id=viewer_team.team_id
          WHERE viewer_team.owner_id=viewer.owner_id AND viewer_team.suspended=0
            AND sender_team.owner_id=message.author_id AND sender_team.suspended=0)
      ))))
    )`;
const MUTABLE_NOTIFICATION_KINDS = new Set(['messenger.mention', 'artifact.shared', 'artifact']);
const WORK_NOTIFICATION = `(kind='artifact.shared' OR (kind='discover.published' AND EXISTS (
  SELECT 1 ${ACTIVE_NOTIFICATION_LISTING} AND listing.kind='work')))`;
const NOTIFICATION_DATA = `CASE WHEN kind='discover.published' THEN (
  SELECT json_set(ot_notifications.data,'$.slug',listing.slug,'$.kind',listing.kind,
    '$.listing_kind',listing.kind,'$.title',listing.title) ${ACTIVE_NOTIFICATION_LISTING}
) ELSE data END AS data`;

function notificationVisibility(workspace: string | null | undefined, otherEvents = "1", args: string[] = []) {
  return {
    sql: ` AND CASE WHEN kind='meeting.shared' THEN EXISTS (SELECT 1 ${MEETING_RECIPIENT_FROM}
      WHERE addressed.recipient_id=ot_notifications.owner_id AND s.id=json_extract(ot_notifications.data,'$.share_id')
      AND s.workspace_id IS json_extract(ot_notifications.data,'$.workspace_id')
      ${workspace === undefined ? "" : "AND s.workspace_id IS ?"} AND ${MEETING_RECIPIENT_VISIBLE})
      ELSE (${otherEvents}) AND (kind<>'discover.published' OR EXISTS (
        SELECT 1 ${ACTIVE_NOTIFICATION_LISTING}))
        AND (kind<>'artifact.shared' OR EXISTS (${VISIBLE_ARTIFACT_NOTICE})) END
      AND NOT EXISTS (
        SELECT 1 FROM ot_conversation_members muted_member
        WHERE muted_member.conversation_id=json_extract(ot_notifications.data,'$.conversation_id')
          AND muted_member.owner_id=ot_notifications.owner_id AND muted_member.muted=1)`,
    args: workspace === undefined ? args : [workspace, ...args],
  };
}

export function registerCore(app: FastifyInstance, ot: OtContext) {
  ensureProfileColumns(ot);
  app.get("/v1/ot/me", async (req) => {
    const me = ot.me(req);
    return { owner_id: me.ownerId, ...ot.profileView(me.ownerId) };
  });
  app.put("/v1/ot/profile", async (req) => {
    const me = ot.me(req);
    const b = body(req);
    const name = optText(b.display_name, "display_name", { min: 1, max: 60 });
    const bio = optText(b.bio, "bio", { max: 280, multiline: true });
    let platformUserId: string | null | undefined;
    if (b.platform_user_id !== undefined) {
      assert(typeof b.platform_user_id === "string" && /^[0-9a-f]{32}$/.test(b.platform_user_id), 400, "invalid_request", "platform_user_id must be a 32-character hex id");
      const taken = ot.get<any>("SELECT owner_id FROM ot_profiles WHERE platform_user_id = ?", b.platform_user_id);
      assert(taken?.owner_id === me.ownerId, 409, "identity_migration_required", "platform identity binding requires verified migration");
      platformUserId = b.platform_user_id;
    }
    ot.run("UPDATE ot_profiles SET display_name = COALESCE(?, display_name), bio = COALESCE(?, bio), platform_user_id = COALESCE(?, platform_user_id), updated_at = ? WHERE owner_id = ?",
      name ?? null, bio ?? null, platformUserId ?? null, ot.now(), me.ownerId);
    return ot.profileView(me.ownerId);
  });
  app.get("/v1/ot/profiles/:handle", async (req) => {
    ot.me(req);
    return ot.profileView(ot.ownerByHandle(params(req).handle));
  });
  // Notifications are account-owned. A workspace view includes team-scoped and
  // account-wide events, never another team's private conversation events.
  const notificationScope = (owner: string, source: Record<string, unknown>) => {
    const wid = source.workspace_id;
    if (source.personal === true || source.personal === "1") {
      assert(wid === undefined, 400, "invalid_request", "Choose one notification scope");
      return notificationVisibility(null, `
        json_extract(data,'$.conversation_id') IN (
          SELECT c.id FROM ot_conversations c JOIN ot_conversation_members m ON m.conversation_id=c.id
          WHERE m.owner_id=? AND c.team_id IS NULL)
        OR (json_extract(data,'$.workspace_id') IS NULL AND json_extract(data,'$.team_id') IS NULL
          AND json_extract(data,'$.conversation_id') IS NULL)`, [owner]);
    }
    if (wid === undefined) return notificationVisibility(undefined);
    assert(typeof wid === "string" && /^[0-9a-f]{32}$/.test(wid), 400, "invalid_request", "invalid workspace");
    const team = ot.get<{id: string}>("SELECT t.id FROM ot_teams t JOIN ot_team_members m ON m.team_id=t.id WHERE t.workspace_id=? AND m.owner_id=? AND m.suspended=0", wid, owner);
    assert(team, 404, "not_found", "workspace not found");
    return notificationVisibility(wid, `json_extract(data,'$.workspace_id') = ? OR json_extract(data,'$.team_id') = ?
      OR json_extract(data,'$.conversation_id') IN (SELECT id FROM ot_conversations WHERE team_id=?)
      OR (json_extract(data,'$.workspace_id') IS NULL AND json_extract(data,'$.team_id') IS NULL AND json_extract(data,'$.conversation_id') IS NULL)`,
    [wid, team.id, team.id]);
  };
  const scopedNotifications = (owner: string, source: Record<string, unknown>) => {
    assert(source.kind === undefined || source.kind === "work", 400, "invalid_request", "invalid notification kind");
    const scope = notificationScope(owner, source);
    const exclude = one(source.exclude, "exclude");
    const excluded = exclude === undefined ? [] : exclude.split(",");
    assert(excluded.length <= MUTABLE_NOTIFICATION_KINDS.size && new Set(excluded).size === excluded.length
      && excluded.every(kind => MUTABLE_NOTIFICATION_KINDS.has(kind)), 400, "invalid_request", "invalid notification exclusions");
    const work = source.kind === "work" ? ` AND ${WORK_NOTIFICATION}` : "";
    const muted = excluded.length ? ` AND kind NOT IN (${excluded.map(() => "?").join(",")})` : "";
    return {sql: scope.sql + work + muted, args: [...scope.args, ...excluded], exclude};
  };
  app.get("/v1/ot/notifications", async (req, reply) => {
    reply.header("cache-control", "private, no-store");
    const me = ot.me(req), q = query(req);
    const after = intParam(q.after, "after", 0);
    const limit = intParam(q.limit, "limit", 50, 200);
    const latest = one(q.latest, "latest");
    assert(latest === undefined || latest === "1", 400, "invalid_request", "latest must be 1");
    const order = latest ? "DESC" : "ASC";
    const scope = scopedNotifications(me.ownerId, q);
    const rows = ot.all<any>(`SELECT id,seq,kind,created_at,read_at,${NOTIFICATION_DATA}
      FROM ot_notifications WHERE owner_id = ? AND seq > ?` + scope.sql
      + (q.unread === "1" ? " AND read_at IS NULL" : "") + ` ORDER BY seq ${order} LIMIT ?`, me.ownerId, after, ...scope.args, limit);
    const unread = ot.get<any>("SELECT COUNT(*) AS n FROM ot_notifications WHERE owner_id = ? AND read_at IS NULL" + scope.sql, me.ownerId, ...scope.args).n;
    return { unread, notifications: rows.map((r) => ({ seq: r.seq, id: r.id, kind: r.kind, data: JSON.parse(r.data), created_at: r.created_at, read: r.read_at !== null })),
      ...(scope.exclude === undefined ? {} : {exclude: scope.exclude}) };
  });
  app.post("/v1/ot/notifications/read", async (req, reply) => {
    reply.header("cache-control", "private, no-store");
    const me = ot.me(req), b = body(req), scope = scopedNotifications(me.ownerId, b);
    let suffix = "", args: any[] = [];
    if (b.all === true && b.notification_id === undefined) { /* all visible */ }
    else if (typeof b.notification_id === "string" && b.all === undefined) {
      const row = ot.get<any>("SELECT id FROM ot_notifications WHERE owner_id=? AND id=?" + scope.sql, me.ownerId, b.notification_id, ...scope.args);
      assert(row, 404, "not_found", "notification not found"); suffix = " AND id=?"; args = [b.notification_id];
    } else {
      const upTo = Number(b.up_to);
      assert(Number.isSafeInteger(upTo) && upTo >= 0, 400, "invalid_request", "provide notification_id, all or up_to");
      suffix = " AND seq<=?"; args = [upTo];
    }
    const r = ot.run("UPDATE ot_notifications SET read_at=? WHERE owner_id=? AND read_at IS NULL" + scope.sql + suffix, ot.now(), me.ownerId, ...scope.args, ...args);
    const unread = ot.get<any>("SELECT COUNT(*) AS n FROM ot_notifications WHERE owner_id=? AND read_at IS NULL" + scope.sql, me.ownerId, ...scope.args).n;
    return { marked: r.changes, unread, ...(scope.exclude === undefined ? {} : {exclude: scope.exclude}) };
  });
}
