import Database from "better-sqlite3";
import { FACE_ROOM_SCHEMA } from "./face-rooms.js";
import { LOCAL_ROOM_INVITE_SCHEMA } from "./local-room-invites.js";
import { OAUTH_SCHEMA } from "./oauth.js";

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  // additive migrations for existing databases
  const cols = (db.prepare("PRAGMA table_info(bots)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("webhook_headers")) db.exec("ALTER TABLE bots ADD COLUMN webhook_headers TEXT NOT NULL DEFAULT '[]'");
  if (!cols.includes("webhook_updated_at")) db.exec("ALTER TABLE bots ADD COLUMN webhook_updated_at TEXT");
  // FlyBot homes: a sub-identity bot names its home bot. Access is always per-bot (default deny);
  // a home or Chief bot is not a wildcard for its members.
  if (!cols.includes("home_bot_id")) db.exec("ALTER TABLE bots ADD COLUMN home_bot_id TEXT");
  // Legacy `published` flag: keep the column so existing databases are not rewritten, but the
  // server no longer reads or writes it. There is no global "publish all my Bots".
  if (!cols.includes("published")) {
    db.exec("ALTER TABLE bots ADD COLUMN published INTEGER NOT NULL DEFAULT 1");
  }
  // Optional owner-chosen look of a Bot (avatar preset/emoji/small image data URL, color), synced to peers who may see the Bot.
  if (!cols.includes("avatar")) db.exec("ALTER TABLE bots ADD COLUMN avatar TEXT");
  if (!cols.includes("color")) db.exec("ALTER TABLE bots ADD COLUMN color TEXT");
  if (!cols.includes("avatar_updated_at")) db.exec("ALTER TABLE bots ADD COLUMN avatar_updated_at TEXT");
  // The owner's one-line card: what this Bot is for, shown among friends and to whoever opens its invite link before they connect.
  if (!cols.includes("description")) db.exec("ALTER TABLE bots ADD COLUMN description TEXT");
  const ocols = (db.prepare("PRAGMA table_info(owners)").all() as { name: string }[]).map((c) => c.name);
  if (!ocols.includes("auto_approve_face_rooms")) db.exec("ALTER TABLE owners ADD COLUMN auto_approve_face_rooms INTEGER NOT NULL DEFAULT 0");
  // #139 ② C: the owner's chosen Bot that hears about a waiting card through its own webhook. Null = tell nobody.
  if (!ocols.includes("notify_bot_id")) db.exec("ALTER TABLE owners ADD COLUMN notify_bot_id TEXT");
  // The owner's local quiet hours (`HH:MM` in their own zone): a card created inside the window is announced once
  // when it ends instead of waking the Bot during it. Both null = no quiet window.
  if (!ocols.includes("quiet_start")) db.exec("ALTER TABLE owners ADD COLUMN quiet_start TEXT");
  if (!ocols.includes("quiet_end")) db.exec("ALTER TABLE owners ADD COLUMN quiet_end TEXT");
  // Rows written before this column existed were announced one by one, so they are delivered already; only a card
  // held through a quiet window stays undelivered for the summary.
  const ancols = (db.prepare("PRAGMA table_info(approval_notifications)").all() as { name: string }[]).map((c) => c.name);
  if (!ancols.includes("delivered_at")) {
    db.exec("ALTER TABLE approval_notifications ADD COLUMN delivered_at TEXT");
    db.exec("UPDATE approval_notifications SET delivered_at = created_at");
  }
  db.exec(FACE_ROOM_SCHEMA);
  // The recap a closed room leaves its members: counts and names, written once by the close door. Rows written
  // before the column existed stay null, and an open room never has one.
  const frcols = (db.prepare("PRAGMA table_info(face_rooms)").all() as { name: string }[]).map((c) => c.name);
  if (!frcols.includes("recap")) db.exec("ALTER TABLE face_rooms ADD COLUMN recap TEXT");
  db.exec(LOCAL_ROOM_INVITE_SCHEMA);
  // GitHub OAuth (#76): four additive tables and their indexes. Empty and inert until the feature is configured.
  db.exec(OAUTH_SCHEMA);
  // Who ended a local-room claim: the minting owner ending it (removing that guest) must outlast the release,
  // so the same link does not seat that home again. Rows written before the column existed stay null.
  const lrcols = (db.prepare("PRAGMA table_info(local_room_invite_claims)").all() as { name: string }[]).map((c) => c.name);
  if (!lrcols.includes("ended_by_owner_id")) db.exec("ALTER TABLE local_room_invite_claims ADD COLUMN ended_by_owner_id TEXT");
  const tcols = (db.prepare("PRAGMA table_info(tokens)").all() as { name: string }[]).map((c) => c.name);
  if (!tcols.includes("id")) db.exec("ALTER TABLE tokens ADD COLUMN id TEXT");
  if (!tcols.includes("label")) db.exec("ALTER TABLE tokens ADD COLUMN label TEXT");
  if (!tcols.includes("scope")) db.exec("ALTER TABLE tokens ADD COLUMN scope TEXT");
  if (!tcols.includes("last_used_at")) db.exec("ALTER TABLE tokens ADD COLUMN last_used_at TEXT");
  // How a session was obtained: 'password' (every row that predates this column) or 'oauth:github'. A constant
  // default does not rewrite the table; unbind revokes `via='oauth:github'` sessions only.
  if (!tcols.includes("via")) db.exec("ALTER TABLE tokens ADD COLUMN via TEXT NOT NULL DEFAULT 'password'");
  // typed_by_owner attestation: only tokens held by a trusted owner host (login, or a connector token minted for FlyBot) may stamp it.
  if (!tcols.includes("attest_typed")) {
    db.exec("ALTER TABLE tokens ADD COLUMN attest_typed INTEGER NOT NULL DEFAULT 0");
    db.exec("UPDATE tokens SET attest_typed = 1 WHERE kind = 'owner' AND scope = 'connector' AND label = 'FlyBot'");
  }
  const mcols = (db.prepare("PRAGMA table_info(messages)").all() as { name: string }[]).map((c) => c.name);
  if (!mcols.includes("typed_by_owner")) db.exec("ALTER TABLE messages ADD COLUMN typed_by_owner INTEGER NOT NULL DEFAULT 0");
  const dcols = (db.prepare("PRAGMA table_info(face_room_drafts)").all() as { name: string }[]).map((c) => c.name);
  if (!dcols.includes("typed_by_owner")) db.exec("ALTER TABLE face_room_drafts ADD COLUMN typed_by_owner INTEGER NOT NULL DEFAULT 0");
  // Optional sender-declared mention list (JSON array of Bot handles), null when absent.
  if (!mcols.includes("mentions")) db.exec("ALTER TABLE messages ADD COLUMN mentions TEXT");
  // FlyBot #442: set once when the recipient's home reports it could not hand the message to its Bot.
  if (!mcols.includes("not_delivered_reason")) db.exec("ALTER TABLE messages ADD COLUMN not_delivered_reason TEXT");
  if (!dcols.includes("mentions")) db.exec("ALTER TABLE face_room_drafts ADD COLUMN mentions TEXT");
  // #49: why a held send waits, so a client does not have to read `reasons`. Rows held before the column
  // exists stay null and are never guessed at.
  const acols = (db.prepare("PRAGMA table_info(approvals)").all() as { name: string }[]).map((c) => c.name);
  if (!acols.includes("hold_reason")) db.exec("ALTER TABLE approvals ADD COLUMN hold_reason TEXT");
  // #54: between #51 (461e04e2) and #53 (31431c97) every face-room card was written as `blanket_outbound`. #53 split
  // that value out (`face_room_auto_send_off`), but the rows written in that window can hang for up to 24 hours, and a
  // client that reads the field literally may clear the card and bypass the room's Auto-send switch. Rewrite them on
  // every open: after the first run nothing matches, so no one-shot flag is needed, and the statement is guarded by
  // the column existing (added just above). A `risk` / `attachment` / `policy` finding is never touched.
  db.exec("UPDATE approvals SET hold_reason = 'face_room_auto_send_off' WHERE kind = 'face_room_message' AND hold_reason = 'blanket_outbound'");
  // Friendship scope columns are kept for existing rows. Access is always the two endpoint bots
  // (default deny); a legacy 'home' value is ignored and never covers members.
  const rcols = (db.prepare("PRAGMA table_info(relationships)").all() as { name: string }[]).map((c) => c.name);
  if (!rcols.includes("requester_scope")) db.exec("ALTER TABLE relationships ADD COLUMN requester_scope TEXT");
  if (!rcols.includes("target_scope")) db.exec("ALTER TABLE relationships ADD COLUMN target_scope TEXT");
  const icols = (db.prepare("PRAGMA table_info(invites)").all() as { name: string }[]).map((c) => c.name);
  if (!icols.includes("scope")) db.exec("ALTER TABLE invites ADD COLUMN scope TEXT");
  migrateFriendshipScopes(db);
  // Per-bot access: record which rooms a grant is used in (owner can see and revoke).
  db.exec(`CREATE TABLE IF NOT EXISTS grant_rooms (
    grant_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    ended_at TEXT,
    PRIMARY KEY (grant_id, room_id)
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS grant_rooms_room ON grant_rooms (room_id, ended_at)");
  const gcols = (db.prepare("PRAGMA table_info(grants)").all() as { name: string }[]).map((c) => c.name);
  if (!gcols.includes("room_id")) db.exec("ALTER TABLE grants ADD COLUMN room_id TEXT");
  // Reply-only grants (#23): the grant a joiner's owner gives the inviter's Bot when joining an invite lets that
  // Bot answer in a conversation the joiner's Bot started, never start one. Added once; see markJoinGrantsReplyOnly.
  if (!gcols.includes("reply_only")) {
    db.exec("ALTER TABLE grants ADD COLUMN reply_only INTEGER NOT NULL DEFAULT 0");
    markJoinGrantsReplyOnly(db);
  }
  const fm = (db.prepare("PRAGMA table_info(face_room_members)").all() as { name: string }[]).map((c) => c.name);
  if (!fm.includes("added_by_owner_id")) db.exec("ALTER TABLE face_room_members ADD COLUMN added_by_owner_id TEXT");
  // FlyBot #476: a member Bot's role label, and the room's creator and chosen lead (null = default lead).
  if (!fm.includes("role")) db.exec("ALTER TABLE face_room_members ADD COLUMN role TEXT");
  const fr = (db.prepare("PRAGMA table_info(face_rooms)").all() as { name: string }[]).map((c) => c.name);
  if (!fr.includes("created_by_owner_id")) db.exec("ALTER TABLE face_rooms ADD COLUMN created_by_owner_id TEXT");
  if (!fr.includes("lead_bot_id")) db.exec("ALTER TABLE face_rooms ADD COLUMN lead_bot_id TEXT");
  // What the room is for, written by its lead; room metadata, so it survives the floor rule that hides older lines.
  if (!fr.includes("note")) db.exec("ALTER TABLE face_rooms ADD COLUMN note TEXT");
  return db;
}

/** One-time backfill for existing databases (#23). Marks as reply-only the active grants a joiner's owner gave the
 *  inviter's Bot when an invite-born friendship was activated. Invite-born means the relationship was created by
 *  joining an invite for its target Bot (the link names that Bot and the invite predates the relationship; a later
 *  re-share link on a plain friend request does not count). On such a relationship the joiner is the requester, and
 *  activation writes the grants of both directions in one transaction, so a joiner-side grant created within two
 *  seconds of the relationship's first grant is a join-time grant. Grants from an approved grant.request and grants
 *  added later (an owner adding a capability, a re-share) keep full access. Only ever narrows access. */
export function markJoinGrantsReplyOnly(db: Database.Database): number {
  return db.prepare(`UPDATE grants SET reply_only = 1
    WHERE status = 'active' AND room_id IS NULL AND reply_only = 0 AND id IN (
      SELECT g.id FROM grants g
      JOIN relationships r ON r.id = g.relationship_id
      JOIN relationship_invites ri ON ri.relationship_id = r.id
      JOIN invites i ON i.id = ri.invite_id
      WHERE i.bot_id = r.target_bot AND i.created_at <= r.created_at
        AND g.grantor_owner = r.requester_owner AND g.grantee_bot = r.target_bot AND g.room_id IS NULL
        AND julianday(g.created_at) <= julianday((SELECT MIN(created_at) FROM grants WHERE relationship_id = r.id)) + 2.0 / 86400
        AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.kind = 'grant_request' AND a.status = 'approved' AND a.subject_id = r.id
          AND json_extract(a.note, '$.capability') = g.capability AND json_extract(a.note, '$.grantee_bot') = g.grantee_bot))`).run().changes;
}

/** Pins the scope of invite-born friendships to the invite's target. Idempotent; only fills NULLs.
 *  The inviter side gets the invite's target exactly (a member invite exposes that member only;
 *  a home invite keeps exposing the home). The joiner side is left NULL: unchanged behavior. */
export function migrateFriendshipScopes(db: Database.Database): number {
  const r = db.prepare(`UPDATE relationships SET target_scope = (
      SELECT CASE WHEN b.integration_type = 'flybot-home' THEN 'home' ELSE 'bot' END
      FROM relationship_invites ri JOIN invites i ON i.id = ri.invite_id JOIN bots b ON b.id = i.bot_id
      WHERE ri.relationship_id = relationships.id AND i.bot_id = relationships.target_bot)
    WHERE target_scope IS NULL AND id IN (
      SELECT ri.relationship_id FROM relationship_invites ri JOIN invites i ON i.id = ri.invite_id WHERE i.bot_id = relationships.target_bot)`).run();
  db.exec("UPDATE invites SET scope = CASE WHEN (SELECT integration_type FROM bots WHERE id = invites.bot_id) = 'flybot-home' THEN 'home' ELSE 'bot' END WHERE scope IS NULL");
  return r.changes;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bot_custody (
  bot_id TEXT PRIMARY KEY REFERENCES bots(id), kid TEXT NOT NULL, sealed_key TEXT NOT NULL,
  events_cursor INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 0, event_types TEXT NOT NULL DEFAULT '{}', url_redacted TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, response_status INTEGER, error TEXT,
  created_at TEXT NOT NULL, sent_at TEXT, finished_at TEXT
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_bot ON webhook_deliveries (bot_id, created_at);
CREATE TABLE IF NOT EXISTS owners (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL, timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  sensitive_terms TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('owner','bot')), subject_id TEXT NOT NULL,
  created_at TEXT NOT NULL, revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners(id), handle TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL, integration_type TEXT NOT NULL, webhook_url TEXT, webhook_secret TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_keys (
  bot_id TEXT NOT NULL REFERENCES bots(id), kid TEXT NOT NULL, alg TEXT NOT NULL, public_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, expires_at TEXT, PRIMARY KEY (bot_id, kid)
);
CREATE TABLE IF NOT EXISTS nonces (bot_id TEXT NOT NULL, nonce TEXT NOT NULL, seen_at INTEGER NOT NULL, PRIMARY KEY (bot_id, nonce));
CREATE TABLE IF NOT EXISTS relationships (
  id TEXT PRIMARY KEY, requester_bot TEXT NOT NULL, target_bot TEXT NOT NULL,
  requester_owner TEXT NOT NULL, target_owner TEXT NOT NULL,
  status TEXT NOT NULL, message TEXT, requested_caps TEXT NOT NULL, offered_caps TEXT NOT NULL,
  blocked_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT
);
CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY, relationship_id TEXT NOT NULL REFERENCES relationships(id),
  grantor_owner TEXT NOT NULL, grantee_bot TEXT NOT NULL, capability TEXT NOT NULL, scope TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, expires_at TEXT, revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, relationship_id TEXT NOT NULL, initiator_bot TEXT NOT NULL, peer_bot TEXT NOT NULL,
  intent TEXT NOT NULL, status TEXT NOT NULL, outcome TEXT, summary TEXT, max_turns INTEGER NOT NULL, turn_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), sender_bot TEXT NOT NULL, recipient_bot TEXT NOT NULL,
  envelope TEXT NOT NULL, payload TEXT NOT NULL, delivered_payload TEXT, status TEXT NOT NULL,
  risk_flags TEXT NOT NULL DEFAULT '[]', injection TEXT NOT NULL DEFAULT '{}', expects_reply INTEGER NOT NULL DEFAULT 1,
  approval_id TEXT, created_at TEXT NOT NULL, created_ms INTEGER NOT NULL, delivered_at TEXT
);
CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, actor_bot TEXT NOT NULL, action_type TEXT NOT NULL,
  params TEXT NOT NULL, justification TEXT, envelope TEXT NOT NULL, status TEXT NOT NULL, result TEXT,
  approval_id TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, kind TEXT NOT NULL, subject_id TEXT NOT NULL, bot_id TEXT,
  conversation_id TEXT, summary TEXT NOT NULL, reasons TEXT NOT NULL DEFAULT '[]', risk_flags TEXT NOT NULL DEFAULT '[]',
  hold_reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending', decision TEXT, note TEXT, created_at TEXT NOT NULL, expires_at TEXT, decided_at TEXT
);
-- #139 ② C: one row per card the owner has already been told about, so a replayed announcement is a no-op.
-- delivered_at is when the Bot was actually told: a card created inside the owner's quiet hours is recorded at
-- once with no delivery and joins the one summary announced when the window ends.
CREATE TABLE IF NOT EXISTS approval_notifications (
  approval_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, bot_id TEXT NOT NULL, created_at TEXT NOT NULL, delivered_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, bot_id TEXT NOT NULL, type TEXT NOT NULL,
  data TEXT NOT NULL, created_at TEXT NOT NULL, webhook_status TEXT
);
CREATE TABLE IF NOT EXISTS calendar_entries (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL,
  title TEXT, location TEXT, attendees TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'confirmed', organizer_owner TEXT, booking_id TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, bot_id TEXT NOT NULL, owner_id TEXT NOT NULL, created_by TEXT NOT NULL,
  offered_caps TEXT NOT NULL, requested_caps TEXT NOT NULL, message TEXT, auto_accept INTEGER NOT NULL DEFAULT 1,
  max_uses INTEGER NOT NULL DEFAULT 1, uses INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active',
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS relationship_settings (
  relationship_id TEXT NOT NULL, owner_id TEXT NOT NULL, auto_approve_chat INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
  PRIMARY KEY (relationship_id, owner_id)
);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, bot_id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
  sha256 TEXT NOT NULL, sealed BLOB NOT NULL, message_id TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS attachments_expiry ON attachments (expires_at);
CREATE TABLE IF NOT EXISTS relationship_invites (relationship_id TEXT PRIMARY KEY, invite_id TEXT NOT NULL);
-- #47: a caller's idempotency key and the answer it first got. Scoped to the calling owner (home) and the
-- tool, so two homes may use the same string; kept 24 hours and swept as new keys are written.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  owner_id TEXT NOT NULL, tool TEXT NOT NULL, key TEXT NOT NULL,
  request_hash TEXT NOT NULL, response TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, tool, key)
);
CREATE INDEX IF NOT EXISTS idempotency_age ON idempotency_keys (created_at);
CREATE INDEX IF NOT EXISTS idx_events_bot ON events(bot_id, seq);
CREATE INDEX IF NOT EXISTS idx_msgs_conv ON messages(conversation_id, created_ms);
`;
