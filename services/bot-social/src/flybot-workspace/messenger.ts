// FlyBot member messenger on Bot Social: DMs and named groups between members, unread/read
// cursors, reactions, edit/retract, pins, @mentions, and group agents. Ported from the legacy
// social.py. A group agent lives in its owner's own DS-Bot: Bot Social only lists the agent and
// hands its owner's DS-Bot the messages it should answer (agent inbox); the reply is generated in
// that DS-Bot and posted back here. Automatic (un-@'d) group replies are capped at 3 per hour per
// conversation (#346). FlyBot semantics; not Teamily parity.
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { assert } from "../errors.js";
import { newId } from "../ids.js";
import { body, handleKey, intParam, one, OtContext, optText, params, query, text } from "./core.js";
import { shareTeam, requireMember } from "./teams.js";
import { acceptedContact } from "./contacts.js";

import {
  CHAT_FILE_BODY_LIMIT, CHAT_FILES_SCHEMA, attachmentView, chatFileView, decodeChatFile, migrateChatFiles, readAttachment,
  saveAttachment, type ChatFileMetadata,
} from "./chat-files.js";
import {
  GROUP_MANAGEMENT_SCHEMA, refreshAutomaticGroupLead, changeGroup, groupManagementRequest, groupManagementView, groupOwner, groupReplyPolicyForRoster, managedGroup, readGroupReplyPolicy,
  registerGroupManagement, type Group,
} from "./group-management.js";

import { GROUP_INVITES_SCHEMA, registerGroupInvites } from "./group-invites.js";
import { agentInboxWake } from "./agent-inbox-wake.js";

const AGENT_INBOX_MAX_WAIT_MS = 10_000;
const NATIVE_GROUP_PROGRESS_MS = 6_000;
const NATIVE_GROUP_TURN_TIMEOUT_MS = 240_000;
const NATIVE_GROUP_TURN_LIMIT = 64;
const SHARED_GROUP_ID = /^otc_[0-9A-HJKMNP-TV-Z]{26}$/;
const SHARED_GROUP_PAGE = 30;

export const MESSENGER_SCHEMA = `
CREATE TABLE IF NOT EXISTS ot_group_announcements (
  conversation_id TEXT PRIMARY KEY, body TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ot_conversations (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('dm','group')), title TEXT NOT NULL DEFAULT '',
  team_id TEXT, dm_key TEXT UNIQUE, created_by TEXT NOT NULL, last_seq INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, account_group INTEGER NOT NULL DEFAULT 0,
  activity_revision INTEGER NOT NULL DEFAULT 0, group_owner_id TEXT, group_revision INTEGER NOT NULL DEFAULT 0,
  group_archived_at INTEGER, group_auto_lead INTEGER NOT NULL DEFAULT 0
);
${GROUP_MANAGEMENT_SCHEMA}
${GROUP_INVITES_SCHEMA}
CREATE TABLE IF NOT EXISTS ot_group_requests (
  owner_id TEXT NOT NULL, request_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES ot_conversations(id) ON DELETE CASCADE,
  PRIMARY KEY (owner_id, request_key)
);
CREATE TABLE IF NOT EXISTS ot_conversation_members (
  conversation_id TEXT NOT NULL REFERENCES ot_conversations(id) ON DELETE CASCADE, owner_id TEXT NOT NULL,
  read_seq INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0, muted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, PRIMARY KEY (conversation_id, owner_id)
);
CREATE INDEX IF NOT EXISTS ot_conversation_members_owner ON ot_conversation_members(owner_id);
CREATE TABLE IF NOT EXISTS ot_conversation_agents (
  conversation_id TEXT NOT NULL REFERENCES ot_conversations(id) ON DELETE CASCADE, agent_ref TEXT NOT NULL,
  owner_id TEXT NOT NULL, name TEXT NOT NULL, auto_reply INTEGER NOT NULL DEFAULT 0,
  auto_reply_after_seq INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, direct_grant_id TEXT,
  PRIMARY KEY (conversation_id, agent_ref, owner_id)
);
CREATE TABLE IF NOT EXISTS ot_messages (
  rowseq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL REFERENCES ot_conversations(id) ON DELETE CASCADE, seq INTEGER NOT NULL,
  author_id TEXT NOT NULL, author_kind TEXT NOT NULL CHECK (author_kind IN ('member','agent')), agent_ref TEXT, agent_name TEXT,
  body TEXT NOT NULL, mentions TEXT NOT NULL DEFAULT '[]', reply_to TEXT, reply_mode TEXT, client_key TEXT,
  created_at INTEGER NOT NULL, edited_at INTEGER, retracted INTEGER NOT NULL DEFAULT 0, pinned_by TEXT, forwarded_author TEXT,
  UNIQUE (conversation_id, seq), UNIQUE (conversation_id, author_id, client_key)
);
CREATE TABLE IF NOT EXISTS ot_native_group_rounds (
  message_id TEXT PRIMARY KEY REFERENCES ot_messages(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES ot_conversations(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL, body TEXT NOT NULL, agent_mentions TEXT NOT NULL, text_only INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','finished'))
);
CREATE INDEX IF NOT EXISTS ot_native_group_rounds_owner ON ot_native_group_rounds(owner_id,state,conversation_id);
CREATE INDEX IF NOT EXISTS ot_native_group_rounds_conversation ON ot_native_group_rounds(conversation_id,state,owner_id);
CREATE TABLE IF NOT EXISTS ot_native_group_turns (
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES ot_native_group_rounds(message_id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL, agent_ref TEXT NOT NULL, call_key TEXT NOT NULL, prompt TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','finished')),
  outcome TEXT CHECK (outcome IN ('message','pass','failed')), result_text TEXT,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, published_message_id TEXT REFERENCES ot_messages(id) ON DELETE SET NULL,
  UNIQUE(message_id,call_key)
);
CREATE INDEX IF NOT EXISTS ot_native_group_turns_inbox ON ot_native_group_turns(owner_id,state,expires_at);
CREATE TABLE IF NOT EXISTS ot_group_memories (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES ot_conversations(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL, client_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
  title TEXT NOT NULL, body TEXT NOT NULL, source_message_id TEXT NOT NULL REFERENCES ot_messages(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL, removed INTEGER NOT NULL DEFAULT 0,
  UNIQUE(conversation_id,author_id,client_key)
);
CREATE INDEX IF NOT EXISTS ot_group_memories_room ON ot_group_memories(conversation_id,removed,created_at DESC);
CREATE TABLE IF NOT EXISTS ot_group_memory_sources (
  memory_id TEXT NOT NULL REFERENCES ot_group_memories(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL, revision INTEGER NOT NULL,
  PRIMARY KEY(memory_id,message_id)
);
CREATE TABLE IF NOT EXISTS ot_group_memory_references (
  message_id TEXT NOT NULL REFERENCES ot_messages(id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL REFERENCES ot_group_memories(id) ON DELETE CASCADE,
  PRIMARY KEY(message_id,memory_id)
);
CREATE TABLE IF NOT EXISTS ot_forward_requests (
  owner_id TEXT NOT NULL, request_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES ot_conversations(id) ON DELETE CASCADE, forwarded INTEGER NOT NULL,
  PRIMARY KEY (owner_id, request_key)
);
CREATE TABLE IF NOT EXISTS ot_hidden_messages (
  owner_id TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES ot_conversations(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES ot_messages(id) ON DELETE CASCADE, seq INTEGER NOT NULL,
  PRIMARY KEY (owner_id, message_id)
);
CREATE INDEX IF NOT EXISTS ot_hidden_messages_room ON ot_hidden_messages(owner_id, conversation_id, seq);
CREATE INDEX IF NOT EXISTS ot_messages_pinned ON ot_messages(conversation_id,seq DESC)
  WHERE pinned_by IS NOT NULL AND retracted=0;
CREATE INDEX IF NOT EXISTS ot_messages_agent_replies ON ot_messages(conversation_id,reply_to,seq DESC)
  WHERE author_kind='agent' AND reply_mode='mention' AND retracted=0;
CREATE TABLE IF NOT EXISTS ot_agent_reply_jobs (
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES ot_messages(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL, agent_ref TEXT NOT NULL, agent_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','failed','replied')),
  attempt INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL, source_revision INTEGER,
  progress_revision INTEGER NOT NULL DEFAULT 0, claim_id TEXT, direct_grant_id TEXT, lease_expires_at INTEGER,
  discretionary INTEGER NOT NULL DEFAULT 0, passed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (message_id, owner_id, agent_ref)
);
CREATE INDEX IF NOT EXISTS ot_agent_reply_jobs_queue ON ot_agent_reply_jobs(owner_id, status, updated_at);
CREATE TABLE IF NOT EXISTS ot_group_agent_message_requests (
  message_id TEXT PRIMARY KEY REFERENCES ot_messages(id) ON DELETE CASCADE,
  request_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ot_group_reply_suppressions (
  message_id TEXT PRIMARY KEY REFERENCES ot_messages(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS ot_direct_agent_message_requests (
  message_id TEXT PRIMARY KEY REFERENCES ot_messages(id) ON DELETE CASCADE,
  request_hash TEXT NOT NULL, quote_revision INTEGER
);
-- Keep the pin when a revision is removed so a reply cannot silently lose its reference.
CREATE TABLE IF NOT EXISTS ot_studio_message_references (
  message_id TEXT PRIMARY KEY REFERENCES ot_messages(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision>0), request_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ot_voice_messages (
  message_id TEXT PRIMARY KEY REFERENCES ot_messages(id) ON DELETE CASCADE,
  mime TEXT NOT NULL, data BLOB NOT NULL
);
${CHAT_FILES_SCHEMA}
CREATE TABLE IF NOT EXISTS ot_reactions (
  message_id TEXT NOT NULL REFERENCES ot_messages(id) ON DELETE CASCADE, owner_id TEXT NOT NULL, emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL, PRIMARY KEY (message_id, owner_id, emoji)
);
`;

export const REACTIONS = ["👍", "❤️", "😄", "🎉", "👀", "✅"];
const BODY_MAX = 4000;
const REPLY_JOB_LEASE_MS = 180_000;
const REPLY_JOB_QUEUE_MS = 600_000;
const REPLY_JOB_ATTEMPTS = 3;
const DISCRETIONARY_HEAD_START_MS = 2_500;
const REPLY_PROGRESS_CAPACITY = 512;
const REPLY_PROGRESS_PAGE = 50;
const STUDIO_EXCERPT_LIMIT = 2400;

type ReplyAgent = {owner_id: string; agent_ref: string; name: string};
type ConversationAgent = ReplyAgent & {auto_reply: number; direct_grant_id: string | null};
type StudioReference = {document_id: string; revision: number};
type ReplyJob = {
  id: string; message_id: string; owner_id: string; agent_ref: string; agent_name: string;
  conversation_id: string; quoted_message_id: string | null;
  status: "queued" | "running" | "failed" | "replied"; attempt: number; updated_at: number;
  lease_expires_at: number | null;
  available: number; source_revision: number | null; current_revision: number; progress_revision: number;
  claim_id: string | null; direct_grant_id: string | null;
  discretionary: number; passed: number;
  group_text_only: number; agent_owner_name: string;
  studio_document_id: string | null; studio_revision: number | null; studio_available: number;
};

// Ordinary direct conversations use the canonical sorted pair and have no team id.
const directKey = (a: string, b: string) => `(MIN(${a},${b}) || ':' || MAX(${a},${b}))`;
const directRelationship = (a: string, b: string) => `(
  EXISTS (SELECT 1 FROM ot_contacts contact WHERE contact.owner_a=MIN(${a},${b})
    AND contact.owner_b=MAX(${a},${b}) AND contact.status='accepted')
  OR EXISTS (SELECT 1 FROM ot_team_members access_a JOIN ot_team_members access_b ON access_b.team_id=access_a.team_id
    WHERE access_a.owner_id=${a} AND access_b.owner_id=${b} AND access_a.suspended=0 AND access_b.suspended=0)
)`;

const REPLY_JOB_SOURCE = `SELECT j.*, src.conversation_id, src.reply_to AS quoted_message_id, src.retracted, src.seq, src.revision AS current_revision,
  c.title AS conversation_title, (j.direct_grant_id IS NULL AND (src.author_id<>j.owner_id
    OR EXISTS (SELECT 1 FROM ot_message_attachments caption WHERE caption.message_id=src.id))) AS group_text_only,
  COALESCE(NULLIF(owner.display_name,''),owner.handle,'') AS agent_owner_name,
  (src.retracted=0 AND c.group_archived_at IS NULL AND COALESCE(c.dm_key,'') NOT LIKE 'agent:%'
    AND member.owner_id IS NOT NULL AND requester.owner_id IS NOT NULL AND agent.owner_id IS NOT NULL
    AND ((c.kind='group' AND j.direct_grant_id IS NULL
      AND (c.team_id IS NULL OR (team.owner_id IS NOT NULL AND requester_team.owner_id IS NOT NULL)))
    OR (c.kind='dm' AND c.team_id IS NULL AND agent.direct_grant_id=j.direct_grant_id
      AND EXISTS (SELECT 1 FROM ot_conversation_members peer
        WHERE peer.conversation_id=c.id AND peer.owner_id<>src.author_id
          AND c.dm_key=${directKey("src.author_id", "peer.owner_id")}
          AND (j.owner_id=src.author_id OR j.owner_id=peer.owner_id)
          AND NOT EXISTS (SELECT 1 FROM ot_conversation_members third WHERE third.conversation_id=c.id
            AND third.owner_id NOT IN (src.author_id,peer.owner_id))
          AND ${directRelationship("src.author_id", "peer.owner_id")})))
    AND NOT EXISTS (SELECT 1 FROM ot_hidden_messages h WHERE h.owner_id=j.owner_id AND h.message_id=src.id)) AS available,
  ref.document_id AS studio_document_id, ref.revision AS studio_revision,
  CASE WHEN ref.message_id IS NULL THEN 1 ELSE EXISTS (
    SELECT 1 FROM ot_teams named_team
    JOIN ot_team_members author ON author.team_id=named_team.id AND author.owner_id=src.author_id AND author.suspended=0
    JOIN ot_conversation_members seat ON seat.conversation_id=c.id AND seat.owner_id=src.author_id
    JOIN ot_studio_documents doc ON doc.team_id=named_team.id AND doc.id=ref.document_id AND doc.deleted_at IS NULL
    JOIN ot_studio_revisions saved ON saved.document_id=doc.id AND saved.revision=ref.revision
    WHERE named_team.id=c.team_id AND named_team.slug IS NOT NULL AND named_team.workspace_id IS NOT NULL
  ) END AS studio_available
  FROM ot_agent_reply_jobs j JOIN ot_messages src ON src.id=j.message_id
  JOIN ot_conversations c ON c.id=src.conversation_id
  LEFT JOIN ot_studio_message_references ref ON ref.message_id=src.id
  LEFT JOIN ot_conversation_members member ON member.conversation_id=c.id AND member.owner_id=j.owner_id
  LEFT JOIN ot_conversation_members requester ON requester.conversation_id=c.id AND requester.owner_id=src.author_id
  LEFT JOIN ot_conversation_agents agent ON agent.conversation_id=c.id AND agent.owner_id=j.owner_id AND agent.agent_ref=j.agent_ref
  LEFT JOIN ot_profiles owner ON owner.owner_id=j.owner_id
  LEFT JOIN ot_team_members team ON team.team_id=c.team_id AND team.owner_id=j.owner_id AND team.suspended=0
  LEFT JOIN ot_team_members requester_team ON requester_team.team_id=c.team_id
    AND requester_team.owner_id=src.author_id AND requester_team.suspended=0`;

// Only a claimed turn for this same message can give another owner a reason to
// wait. The oldest valid claim sets the limit, even if it is still running.
// Queued jobs, old revisions, and lost membership never hold up a round.
const runningReplyExpirySql = (alias: string) => `COALESCE(${alias}.lease_expires_at,${alias}.updated_at+${REPLY_JOB_LEASE_MS})`;
const discretionaryReadyAt = (now: string) => `CASE WHEN j.discretionary=1 THEN COALESCE((
  SELECT MIN(active.updated_at)+${DISCRETIONARY_HEAD_START_MS} FROM (${REPLY_JOB_SOURCE}) active
  WHERE active.message_id=j.message_id AND active.owner_id<>j.owner_id AND active.discretionary=1
    AND active.status='running' AND active.claim_id IS NOT NULL AND active.source_revision=active.current_revision
    AND active.available AND active.studio_available AND ${runningReplyExpirySql("active")}>${now}
),0) ELSE 0 END`;

function runningReplyExpiry(job: ReplyJob) {
  return job.lease_expires_at ?? job.updated_at + REPLY_JOB_LEASE_MS;
}

function replyJobExpired(job: ReplyJob, now: number) {
  return job.status === "queued" ? job.updated_at + REPLY_JOB_QUEUE_MS <= now
    : job.status === "running" && runningReplyExpiry(job) <= now;
}

function replyJobState(job: ReplyJob, now: number) {
  if ((job.status === "queued" || job.status === "running")
      && (!job.available || replyJobExpired(job, now)
        || (job.source_revision !== null && job.source_revision !== job.current_revision))) return "failed";
  return job.status === "replied" && job.passed ? "passed" : job.status;
}

function currentRunningClaim(job: ReplyJob, claim: string | null) {
  return job.status === "running" && claim !== null && job.claim_id === claim && job.available && job.studio_available
    && job.source_revision === job.current_revision;
}

function replyClaimId(value: unknown) {
  if (value === undefined) return null;
  assert(typeof value === "string" && value.length === 36
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
  400, "invalid_request", "Invalid reply job claim");
  return value;
}

function replyJobViews(ot: OtContext, message: any, viewer?: string) {
  if (message.retracted || message.author_kind !== "member" || message.forwarded_author ||
      !ot.get("SELECT 1 FROM ot_agent_reply_jobs WHERE message_id=? LIMIT 1", message.id)) return [];
  const now = ot.now();
  return ot.all<ReplyJob>(REPLY_JOB_SOURCE + " WHERE j.message_id=? ORDER BY j.rowid", message.id).map(job => {
    const status = !job.studio_available && job.status !== "replied" ? "failed" : replyJobState(job, now);
    const errorCode = status !== "failed" ? null : !job.available
      ? (job.direct_grant_id ? "direct_agent_unavailable" : "group_agent_unavailable")
      : job.studio_available && (job.source_revision === null || job.source_revision === job.current_revision) && replyJobExpired(job, now)
        ? "reply_timeout" : null;
    return {id: job.id, agent_name: job.agent_name, agent_id: job.agent_ref,
      agent_owner_id: job.owner_id, agent_owner_name: job.agent_owner_name, status, attempt: job.attempt,
      ...(errorCode ? {error_code:errorCode} : {}),
      can_retry: Boolean(viewer === message.author_id && job.available && job.studio_available
        && status === "failed" && job.attempt < REPLY_JOB_ATTEMPTS)};
  });
}
const VOICE_MAX_BYTES = 128 * 1024;

function voiceData(value: any) {
  const mime = value?.mime;
  const encoded = value?.data;
  assert(typeof encoded === "string" && encoded.length <= Math.ceil(VOICE_MAX_BYTES / 3) * 4,
    400, "invalid_voice", "Voice messages can contain up to 128 KiB");
  const data = Buffer.from(encoded, "base64");
  assert(data.length >= 12 && data.length <= VOICE_MAX_BYTES && data.toString("base64") === encoded,
    400, "invalid_voice", "Invalid voice message data");
  const webm = mime === "audio/webm" && data.readUInt32BE(0) === 0x1a45dfa3;
  const ogg = mime === "audio/ogg" && data.toString("ascii", 0, 4) === "OggS";
  const mp4 = mime === "audio/mp4" && data.toString("ascii", 4, 8) === "ftyp";
  assert(webm || ogg || mp4, 400, "invalid_voice", "Use a WebM, Ogg, or MP4 audio recording");
  return {mime, data};
}

const AUTO_PER_HOUR = 3;
const MENTION_PER_HOUR = 30;
const HOUR = 3_600_000;
const AGENT_REF = /^[A-Za-z0-9._:-]{1,80}$/;

function publicListing(ot: OtContext, conversation: {dm_key?: string | null}) {
  const key = conversation.dm_key;
  if (!key?.startsWith("agent:")) return null;
  return ot.get<{
    ref: string; owner_id: string; slug: string; title: string; summary: string; snapshot: string | null;
    listed: number; chat_enabled: number; chat_from: number;
  }>("SELECT ref, owner_id, slug, title, summary, snapshot, listed, chat_enabled, chat_from FROM ot_listings WHERE id=? AND kind='agent'", key.split(":")[1]) ?? null;
}

export function fixedPublicThread(conv: {dm_key?: string | null}) {
  return !!conv.dm_key?.startsWith("agent:");
}

export function ordinaryDirect(conv: {kind: string; team_id?: string | null; dm_key?: string | null}) {
  return conv.kind === "dm" && !conv.team_id && !fixedPublicThread(conv);
}

function directReachable(ot: OtContext, owner: string, peer: string) {
  return acceptedContact(ot, owner, peer) || shareTeam(ot, owner, peer);
}

export function requireDirectReach(ot: OtContext, conv: {id: string; kind: string; team_id?: string | null; dm_key?: string | null}, owner: string) {
  if (!ordinaryDirect(conv)) return;
  const peer = ot.get<{owner_id: string}>("SELECT owner_id FROM ot_conversation_members WHERE conversation_id=? AND owner_id<>?", conv.id, owner);
  assert(peer && directReachable(ot, owner, peer.owner_id), 403, "not_reachable", "请先建立联系人关系。");
}

function directAgentPeer(ot: OtContext, conv: {id: string; kind: string; team_id?: string | null; dm_key?: string | null}, owner: string) {
  if (!ordinaryDirect(conv)) return;
  const seats = ot.all<{owner_id: string}>("SELECT owner_id FROM ot_conversation_members WHERE conversation_id=? LIMIT 3", conv.id);
  const peer = seats.find(seat => seat.owner_id !== owner)?.owner_id;
  if (seats.length === 2 && peer && seats.some(seat => seat.owner_id === owner)
    && conv.dm_key === [owner, peer].sort().join(":")) return peer;
}

// Called inside the transaction that checks reachability and creates the DM.
function getOrCreateDirectConversation(ot: OtContext, owner: string, peer: string) {
  const key = [owner,peer].sort().join(":");
  const existing = ot.get<any>("SELECT * FROM ot_conversations WHERE dm_key=?",key);
  if (existing) return {conversation:existing,created:false};
  const id = newId("otc");
  const now = ot.now();
  ot.run(`INSERT INTO ot_conversations(id,kind,dm_key,created_by,created_at,updated_at) VALUES (?,'dm',?,?,?,?)`,id,key,owner,now,now);
  for (const member of [owner,peer]) {
    ot.run("INSERT INTO ot_conversation_members(conversation_id,owner_id,created_at) VALUES (?,?,?)",id,member,now);
  }
  return {conversation:ot.get<any>("SELECT * FROM ot_conversations WHERE id=?",id),created:true};
}

function grantDirectAgent(ot: OtContext, conversationId: string, owner: string, ref: string, name: string) {
  const prior = ot.get<{created_at: number; direct_grant_id: string | null}>(`SELECT created_at,direct_grant_id FROM ot_conversation_agents
    WHERE conversation_id=? AND agent_ref=? AND owner_id=?`,conversationId,ref,owner);
  const created = !prior?.direct_grant_id;
  const at = prior?.direct_grant_id ? prior.created_at : ot.now();
  ot.run(`INSERT INTO ot_conversation_agents(conversation_id,agent_ref,owner_id,name,created_at,direct_grant_id) VALUES (?,?,?,?,?,?)
    ON CONFLICT(conversation_id,agent_ref,owner_id) DO UPDATE SET name=excluded.name,auto_reply=0,
      created_at=excluded.created_at,direct_grant_id=excluded.direct_grant_id
    WHERE ot_conversation_agents.name<>excluded.name OR ot_conversation_agents.auto_reply<>0
      OR ot_conversation_agents.direct_grant_id IS NULL`,conversationId,ref,owner,name,at,prior?.direct_grant_id ?? newId("otdag"));
  return {created,created_at:at};
}

function removeDirectAgent(ot: OtContext, conversationId: string, owner: string, ref: string) {
  return ot.run(`DELETE FROM ot_conversation_agents WHERE conversation_id=? AND agent_ref=? AND owner_id=?
    AND direct_grant_id IS NOT NULL`,conversationId,ref,owner).changes;
}

export function accountConversation(ot: OtContext, id: string, owner: string) {
  const conv = memberOf(ot, id, owner);
  assert(ordinaryDirect(conv) || conv.account_group === 1, 404, "conversation_not_found", "no such personal conversation");
  return conv;
}

function publicParticipant(ot: OtContext, conv: any, owner: string) {
  return !fixedPublicThread(conv) || conv.created_by === owner || publicListing(ot, conv)?.owner_id === owner;
}

function requireOrdinaryGroup(conv: any) {
  assert(!fixedPublicThread(conv), 409, "public_chat_fixed", "公开智能体会话使用固定成员。");
}

function memberOf(ot: OtContext, convId: string, ownerId: string) {
  const conv = ot.get<any>(`SELECT c.* FROM ot_conversations c JOIN ot_conversation_members m ON m.conversation_id=c.id
    WHERE c.id=? AND m.owner_id=? AND c.group_archived_at IS NULL
      AND (c.team_id IS NULL OR EXISTS (SELECT 1 FROM ot_team_members active
        WHERE active.team_id=c.team_id AND active.owner_id=m.owner_id AND active.suspended=0))`, convId, ownerId);
  assert(conv && publicParticipant(ot, conv, ownerId), 404, "conversation_not_found", "no such conversation");
  return conv;
}

function requireMemoryGroup(ot: OtContext, cid: string, viewer: string) {
  const conv = memberOf(ot, cid, viewer);
  assert(conv.kind === "group" && !fixedPublicThread(conv), 404, "not_found", "该会话没有群记忆。");
  if (conv.team_id) requireMember(ot, conv.team_id, viewer);
  return conv;
}

const ACTIVE_MEMORIES = `g.removed=0 AND NOT EXISTS (
  SELECT 1 FROM ot_group_memory_sources s LEFT JOIN ot_messages m ON m.id=s.message_id
  WHERE s.memory_id=g.id AND (m.id IS NULL OR m.retracted=1 OR m.revision<>s.revision))`;

function activeMemories(ot: OtContext, cid: string) {
  return ot.all<any>(`SELECT g.* FROM ot_group_memories g WHERE g.conversation_id=? AND ${ACTIVE_MEMORIES}
    ORDER BY g.created_at DESC,g.id DESC LIMIT 40`,cid);
}

function groupMemoryView(ot: OtContext, row: any, group: any, viewer: string) {
  return {id:row.id,title:row.title,body:row.body,source_message_id:row.source_message_id,
    author:ot.profileView(row.author_id).display_name,created_at:row.created_at,
    can_remove:row.author_id===viewer || groupOwner(group)===viewer};
}

function messageMemories(ot: OtContext, m: any) {
  return ot.all<{id:string;title:string}>(`SELECT g.id,g.title FROM ot_group_memory_references r
    JOIN ot_group_memories g ON g.id=r.memory_id WHERE r.message_id=? AND g.conversation_id=? AND ${ACTIVE_MEMORIES}`,m.id,m.conversation_id);
}

export function workspaceTeam(ot: OtContext, workspace: string, ownerId: string) {
  assert(/^[0-9a-f]{32}$/.test(workspace), 400, "invalid_request", "Invalid workspace");
  const match = ot.get<{id: string}>("SELECT id FROM ot_teams WHERE workspace_id=?", workspace);
  assert(match, 404, "team_not_found", "Workspace not found");
  return requireMember(ot, match.id, ownerId).team;
}

export function workspaceConversation(ot: OtContext, workspace: string, id: string, ownerId: string) {
  const team = workspaceTeam(ot, workspace, ownerId);
  const conv = memberOf(ot, id, ownerId);
  let directPeer: string | undefined;
  if (conv.kind === "dm" && conv.team_id === null) {
    const peer = ot.get<{owner_id: string}>(`SELECT teammate.owner_id FROM ot_conversation_members member
      JOIN ot_team_members teammate ON teammate.owner_id=member.owner_id AND teammate.team_id=? AND teammate.suspended=0
      WHERE member.conversation_id=? AND member.owner_id<>?`, team.id, conv.id, ownerId);
    assert(peer, 404, "conversation_not_found", "no such conversation in this workspace");
    directPeer = peer.owner_id;
  } else {
    assert(conv.team_id === team.id, 404, "conversation_not_found", "no such conversation in this workspace");
  }
  return {conv, directPeer};
}

const VISIBLE_MESSAGE = "NOT EXISTS (SELECT 1 FROM ot_hidden_messages hidden WHERE hidden.message_id=m.id AND hidden.owner_id=?)";

function replyOriginal(ot: OtContext, conversationId: string, messageId: string, viewer: string) {
  return ot.get<{body: string; author_kind: string; author_id: string; agent_ref: string | null; agent_name: string | null; revision: number}>(`
    SELECT m.body,m.author_kind,m.author_id,m.agent_ref,m.agent_name,m.revision FROM ot_messages m
    WHERE m.id=? AND m.conversation_id=? AND m.retracted=0 AND ${VISIBLE_MESSAGE}`, messageId, conversationId, viewer);
}

function replyPreview(ot: OtContext, message: any, viewer: string) {
  const original = replyOriginal(ot, message.conversation_id, message.reply_to, viewer);
  if (!original) return {message_id: message.reply_to, available: false};
  const author = original.author_kind === "agent" ? original.agent_name : ot.profileView(original.author_id).display_name;
  return {message_id: message.reply_to, available: true, author: author || "成员",
    excerpt: original.body.replace(/\s+/g, " ").trim().slice(0, 120)};
}

function replyClaimReceipt(ot: OtContext, job: ReplyJob) {
  const original = job.quoted_message_id && replyOriginal(ot, job.conversation_id, job.quoted_message_id, job.owner_id);
  if (job.direct_grant_id) {
    const source = ot.get<{body: string; quote_revision: number | null}>(`SELECT m.body,r.quote_revision
      FROM ot_messages m JOIN ot_direct_agent_message_requests r ON r.message_id=m.id WHERE m.id=?`, job.message_id);
    assert(source, 409, "reply_job_unavailable", "这次私聊智能体请求已不可用。");
    const receipt = {ok: true, direct_text_only: true, direct_prompt: source.body};
    if (!original || original.revision !== source.quote_revision) return receipt;
    const author = original.author_kind === "agent" ? original.agent_name : ot.profileView(original.author_id).display_name;
    return {...receipt, quoted_message: {author: author || "成员", text: original.body.slice(0, 1500).replace(/[\uD800-\uDBFF]$/, "")}};
  }
  const pinned = job.studio_document_id && ot.get<{title: string; excerpt: string}>(`
    SELECT title,substr(body,1,?) AS excerpt FROM ot_studio_revisions
    WHERE document_id=? AND revision=?`, STUDIO_EXCERPT_LIMIT + 1, job.studio_document_id, job.studio_revision);
  if (job.studio_document_id && !pinned) return {ok: true, studio_reference_unavailable: true};
  const chars = pinned ? Array.from(pinned.excerpt) : [];
  const studio = pinned ? {studio_reference: {document_id: job.studio_document_id, revision: job.studio_revision,
    title: pinned.title, excerpt: chars.slice(0, STUDIO_EXCERPT_LIMIT).join(""), truncated: chars.length > STUDIO_EXCERPT_LIMIT}} : {};
  const prior = job.discretionary ? {discretionary: true, prior_replies: ot.all<{name: string; text: string}>(`
    SELECT name,text FROM (
      SELECT m.seq,m.agent_name AS name,substr(m.body,1,800) AS text FROM ot_messages m
      WHERE m.conversation_id=? AND m.reply_to=? AND m.author_kind='agent' AND m.reply_mode='mention'
        AND m.retracted=0 AND ${VISIBLE_MESSAGE}
        AND EXISTS (SELECT 1 FROM ot_agent_reply_jobs delivered WHERE delivered.message_id=m.reply_to
          AND delivered.owner_id=m.author_id AND delivered.agent_ref=m.agent_ref
          AND m.client_key='job:'||delivered.id AND delivered.status='replied' AND delivered.passed=0)
      ORDER BY m.seq DESC LIMIT 7
    ) ORDER BY seq`, job.conversation_id, job.message_id, job.owner_id)} : {};
  const receipt = {ok: true, ...(job.group_text_only ? {group_text_only: true} : {}), ...studio, ...prior};
  if (!original) return receipt;
  const author = original.author_kind === "agent" ? original.agent_name : ot.profileView(original.author_id).display_name;
  return {...receipt, quoted_message: {author: author || "成员", text: original.body.slice(0, 1500).replace(/[\uD800-\uDBFF]$/, "")}};
}

function messageStudioReference(ot: OtContext, messageId: string, conversationId: string) {
  return ot.get<StudioReference>(`SELECT ref.document_id,ref.revision FROM ot_studio_message_references ref
    JOIN ot_messages source ON source.id=ref.message_id
    WHERE ref.message_id=? AND source.conversation_id=?`, messageId, conversationId);
}

function deliveredReplyJobId(ot: OtContext, message: any) {
  if (message.author_kind !== "agent" || message.reply_mode !== "mention") return;
  const match = /^job:(otj_[0-9A-HJKMNP-TV-Z]{26})$/.exec(message.client_key ?? "");
  if (!match) return;
  return ot.get<{id: string}>(`SELECT id FROM ot_agent_reply_jobs
    WHERE id=? AND message_id=? AND owner_id=? AND agent_ref=? AND status='replied'`,
    match[1], message.reply_to, message.author_id, message.agent_ref)?.id;
}

const messageView = (ot: OtContext, m: any, viewer?: string) => ({
  id: m.id, conversation_id: m.conversation_id, seq: m.seq,
  author: m.author_kind === "agent" ? { kind: "agent", agent_ref: m.agent_ref, name: m.agent_name, owner: ot.profileView(m.author_id) } : { kind: "member", ...ot.profileView(m.author_id) },
  mine: viewer ? m.author_id === viewer && m.author_kind === "member" : undefined,
  ...(viewer === m.author_id && m.author_kind === "member" && m.client_key ? {client_key: m.client_key} : {}),
  ...(viewer && m.author_kind === "agent" ? {reply_job_id: deliveredReplyJobId(ot, m)} : {}),
  body: m.retracted ? "" : m.body, revision: m.revision, retracted: !!m.retracted, edited_at: m.edited_at, created_at: m.created_at,
  mentions: JSON.parse(m.mentions), ...(viewer ? {reply_jobs: replyJobViews(ot, m, viewer)} : {}), reply_to: m.reply_to, pinned: !!m.pinned_by,
  ...(viewer && m.reply_to && !m.retracted ? {reply_preview: replyPreview(ot, m, viewer)} : {}),
  ...(viewer && !m.retracted && m.mentions.includes('"/agent/')
    ? {studio_reference: messageStudioReference(ot, m.id, m.conversation_id)} : {}),
  ...(m.forwarded_author && !m.retracted ? {forwarded_from: {author: m.forwarded_author}} : {}),
  ...(m.author_kind === "agent" && !m.retracted ? {group_memory_refs:messageMemories(ot,m)} : {}),
  attachment: m.retracted ? undefined : attachmentView(ot, m.id),
  voice: m.retracted ? undefined : ot.get<{mime: string}>("SELECT mime FROM ot_voice_messages WHERE message_id=?", m.id),
  reactions: ot.all<any>("SELECT emoji, COUNT(*) AS n, SUM(owner_id = ?) AS me FROM ot_reactions WHERE message_id = ? GROUP BY emoji", viewer ?? "", m.id).map((r) => ({ emoji: r.emoji, count: r.n, mine: !!r.me })),
});

function requireVisibleMessage(ot: OtContext, id: string, owner: string) {
  assert(!ot.get("SELECT 1 FROM ot_hidden_messages WHERE owner_id=? AND message_id=?", owner, id),
    404, "message_not_found", "本账号已删除该消息。");
}

function hiddenCount(ot: OtContext, conversation: string, viewer: string, after = 0) {
  return ot.get<{n: number}>("SELECT COUNT(*) AS n FROM ot_hidden_messages WHERE owner_id=? AND conversation_id=? AND seq>?",
    viewer, conversation, after)!.n;
}

function unreadMessages(ot: OtContext, conversation: {id: string; last_seq: number}, viewer: string, read: number) {
  return Math.max(0, conversation.last_seq - read - hiddenCount(ot, conversation.id, viewer, read));
}

function pinnedMessages(ot: OtContext, conversation: string, viewer: string) {
  return ot.all<any>(`SELECT m.id, m.body, m.pinned_by FROM ot_messages m
    WHERE m.conversation_id=? AND m.pinned_by IS NOT NULL AND m.retracted=0 AND ${VISIBLE_MESSAGE}
    ORDER BY m.seq DESC LIMIT 100`, conversation, viewer)
    .map(m => ({message_id: m.id, excerpt: m.body.replace(/\s+/g, " ").slice(0, 100),
      pinned_by_username: ot.profileView(m.pinned_by).display_name}));
}

function contentVersion(c: {last_seq: number; activity_revision: number}, open: boolean, hidden: number) {
  return `${c.last_seq}.${c.activity_revision}.${Number(open)}.${hidden}`;
}

function registerActivityTriggers(ot: OtContext) {
  const message = (row: string) => `(SELECT conversation_id FROM ot_messages WHERE id=${row}.message_id)`;
  const changes = [
    {table: "ot_conversations", events: ["UPDATE OF title"], room: (row: string) => row + ".id"},
    {table: "ot_conversation_members", events: ["INSERT", "DELETE"]},
    {table: "ot_conversation_agents", events: ["INSERT", "UPDATE", "DELETE"]},
    {table: "ot_messages", events: ["UPDATE"]},
    {table: "ot_reactions", events: ["INSERT", "DELETE"], room: message},
    {table: "ot_agent_reply_jobs", events: ["INSERT", "UPDATE OF status,attempt,updated_at"], room: message},
    {table: "ot_group_announcements", events: ["INSERT", "UPDATE"]},
  ];
  for (const {table, events, room} of changes) for (const event of events) {
    const row = event === "DELETE" ? "old" : "new";
    ot.run(`CREATE TRIGGER IF NOT EXISTS ${table}_activity_${event.split(" ")[0].toLowerCase()}
      AFTER ${event} ON ${table} BEGIN
        UPDATE ot_conversations SET activity_revision=activity_revision+1 WHERE id=${room?.(row) ?? row + ".conversation_id"};
      END`);
  }
}

function registerReplyJobInvalidation(ot: OtContext) {
  // Removing access ends the attempt, even if access is restored before the worker polls.
  const roomSource = `SELECT 1 FROM ot_messages WHERE id=ot_agent_reply_jobs.message_id
      AND conversation_id=OLD.conversation_id`;
  const teamSource = `SELECT 1 FROM ot_messages m JOIN ot_conversations c ON c.id=m.conversation_id
      WHERE m.id=ot_agent_reply_jobs.message_id AND c.team_id=OLD.team_id`;
  const changes = [
    {name: "room_member", event: "DELETE ON ot_conversation_members", source: roomSource, agent: ""},
    {name: "room_agent", event: "DELETE ON ot_conversation_agents", source: roomSource, agent: "AND agent_ref=OLD.agent_ref"},
    {name: "team_member", event: "DELETE ON ot_team_members", source: teamSource, agent: ""},
    {name: "team_suspension", event: "UPDATE OF suspended ON ot_team_members WHEN NEW.suspended=1 AND OLD.suspended=0",
      source: teamSource, agent: ""},
  ];
  for (const change of changes) {
    ot.run(`CREATE TRIGGER IF NOT EXISTS ot_agent_reply_jobs_after_${change.name}
      AFTER ${change.event} BEGIN
        UPDATE ot_agent_reply_jobs SET status='failed'
        WHERE owner_id=OLD.owner_id AND status IN ('queued','running') AND EXISTS (${change.source}) ${change.agent};
      END`);
  }
  // Revoking the requester also invalidates a teammate's running attempt.
  const requesterSource = `SELECT source.id FROM ot_messages source
    JOIN ot_conversations room ON room.id=source.conversation_id
    WHERE source.author_id=OLD.owner_id`;
  for (const change of changes.filter(change => change.name !== "room_agent")) {
    const scope = change.name === "room_member" ? "room.id=OLD.conversation_id" : "room.team_id=OLD.team_id";
    ot.run(`DROP TRIGGER IF EXISTS ot_studio_reply_jobs_after_${change.name}`);
    ot.run(`CREATE TRIGGER IF NOT EXISTS ot_agent_reply_jobs_after_requester_${change.name}
      AFTER ${change.event} BEGIN
        UPDATE ot_agent_reply_jobs SET status='failed' WHERE status IN ('queued','running') AND owner_id<>OLD.owner_id
          AND message_id IN (${requesterSource} AND ${scope});
      END`);
  }
}

function registerDirectAgentRevocation(ot: OtContext) {
  // Closing the last relationship also removes the grants, so reconnecting
  // two accounts cannot revive a reply from before the closure.
  const events = [
    {name:"contact_changed", event:"UPDATE OF status ON ot_contacts WHEN OLD.status='accepted' AND NEW.status<>'accepted'",
      pair:"first.owner_id=OLD.owner_a AND second.owner_id=OLD.owner_b"},
    {name:"contact_deleted", event:"DELETE ON ot_contacts WHEN OLD.status='accepted'",
      pair:"first.owner_id=OLD.owner_a AND second.owner_id=OLD.owner_b"},
    {name:"team_member_suspended", event:"UPDATE OF suspended ON ot_team_members WHEN OLD.suspended=0 AND NEW.suspended=1",
      pair:"OLD.owner_id IN (first.owner_id,second.owner_id)"},
    {name:"team_member_deleted", event:"DELETE ON ot_team_members WHEN OLD.suspended=0",
      pair:"OLD.owner_id IN (first.owner_id,second.owner_id)"},
  ];
  for (const {name,event,pair} of events) {
    ot.run(`CREATE TRIGGER IF NOT EXISTS ot_direct_agent_grants_after_${name} AFTER ${event} BEGIN
      DELETE FROM ot_conversation_agents WHERE direct_grant_id IS NOT NULL AND conversation_id IN (
        SELECT room.id FROM ot_conversations room
        JOIN ot_conversation_members first ON first.conversation_id=room.id
        JOIN ot_conversation_members second ON second.conversation_id=room.id AND first.owner_id<second.owner_id
        WHERE room.kind='dm' AND room.team_id IS NULL AND room.dm_key=${directKey("first.owner_id", "second.owner_id")}
          AND ${pair} AND NOT ${directRelationship("first.owner_id", "second.owner_id")});
    END`);
  }
  ot.run(`CREATE TRIGGER IF NOT EXISTS ot_direct_agent_grants_after_room_member
    AFTER DELETE ON ot_conversation_members BEGIN
      DELETE FROM ot_conversation_agents WHERE direct_grant_id IS NOT NULL AND conversation_id=OLD.conversation_id;
    END`);
}

function conversationView(ot: OtContext, c: any, viewer: string, includeManagement = false) {
  const published = publicListing(ot, c);
  const members = ot.all<any>("SELECT owner_id, read_seq, pinned, muted FROM ot_conversation_members WHERE conversation_id = ? ORDER BY created_at", c.id).filter(m => publicParticipant(ot, c, m.owner_id));
  const mine = members.find((m) => m.owner_id === viewer);
  const last = ot.get<any>(`SELECT m.* FROM ot_messages m WHERE m.conversation_id=? AND ${VISIBLE_MESSAGE} ORDER BY m.seq DESC LIMIT 1`, c.id, viewer);
  const peer = c.kind === "dm" ? members.find((m) => m.owner_id !== viewer) : undefined;
  const open = !!(published?.listed && published.chat_enabled);
  const directOpen = Boolean(peer && ordinaryDirect(c) && directReachable(ot, viewer, peer.owner_id));
  const directAgents = directOpen && members.length === 2 && c.dm_key === [viewer, peer.owner_id].sort().join(":");
  const agents = ordinaryDirect(c) && !directAgents ? [] : conversationAgents(ot, c.id);
  const routing = ordinaryAgentGroup(c) && (agents.length || managedGroup(c)) ? groupAgentRouting(ot, c, viewer, agents) : null;
  const management = includeManagement ? groupManagementView(ot, c, viewer) : undefined;
  const pending = open && !!ot.get(`SELECT 1 FROM ot_messages m
    WHERE m.conversation_id=? AND m.rowseq>? AND m.author_id=? AND m.author_kind='member' AND m.retracted=0
      AND m.created_at>? AND NOT EXISTS (
        SELECT 1 FROM ot_messages answer WHERE answer.conversation_id=m.conversation_id AND answer.reply_to=m.id
          AND answer.author_id=? AND answer.agent_ref=? AND answer.author_kind='agent')
    LIMIT 1`, c.id, published.chat_from, c.created_by, ot.now() - 180_000, published.owner_id, published.ref);
  return {
    ...(fixedPublicThread(c) ? {public_agent: {open, pending, publisher: published ? ot.profileView(published.owner_id).display_name : ""}} : {}),
    ...(c.kind === "group" && !fixedPublicThread(c) ? {group_agent_requests: true} : {}),
    ...(routing ? {group_agent_routing: routing} : {}),
    ...(ordinaryDirect(c) ? {direct: {open: directOpen}} : {}),
    ...(directAgents ? {direct_agent_requests: true} : {}),
    ...(c.account_group === 1 ? {account_group: true} : {}),
    ...(management ? {group_management:management} : {}),
    id: c.id, kind: c.kind, title: c.kind === "dm" ? (peer ? ot.profileView(peer.owner_id).display_name : c.title) : c.title,
    team_id: c.team_id, members: members.map((m) => ot.profileView(m.owner_id)),
    agents: agents.map(a => ({ agent_ref: a.agent_ref, name: a.name,
      auto_reply: !!a.auto_reply, owner: ot.profileView(a.owner_id), mine: a.owner_id === viewer })),
    activity_version: contentVersion(c, open || directOpen, hiddenCount(ot, c.id, viewer)),
    last_seq: c.last_seq, read_seq: mine?.read_seq ?? 0, unread: unreadMessages(ot, c, viewer, mine?.read_seq ?? 0),
    pinned: !!mine?.pinned, muted: !!mine?.muted, last_message: last ? messageView(ot, last, viewer) : null, updated_at: c.updated_at,
  };
}

/** Everyone a member may start a conversation with: someone sharing an active team. */
function assertReachable(ot: OtContext, from: string, to: string, teamId?: string | null, accountGroup = false) {
  if (teamId) {
    const r = ot.get<any>("SELECT 1 FROM ot_team_members WHERE team_id = ? AND owner_id = ? AND suspended = 0", teamId, to);
    assert(r, 403, "not_in_team", "that member is not in this team");
  } else if (accountGroup) {
    assert(acceptedContact(ot, from, to), 403, "not_reachable", "请选择已确认的联系人。");
  } else {
    assert(shareTeam(ot, from, to), 403, "not_reachable", "you can message members of your teams");
  }
}

function insertMessage(ot: OtContext, conv: any, row: { author: string; kind: "member" | "agent"; agentRef?: string; agentName?: string; body: string; mentions: string[]; replyTo?: string | null; replyMode?: string | null; clientKey?: string | null; forwardedAuthor?: string }) {
  if (row.clientKey) {
    const dup = ot.get<any>("SELECT * FROM ot_messages WHERE conversation_id = ? AND author_id = ? AND client_key = ?", conv.id, row.author, row.clientKey);
    if (dup) return dup;
  }
  const seq = conv.last_seq + 1;
  const now = ot.now();
  const id = newId("otm");
  ot.run("INSERT INTO ot_messages(id, conversation_id, seq, author_id, author_kind, agent_ref, agent_name, body, mentions, reply_to, reply_mode, client_key, created_at, forwarded_author) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    id, conv.id, seq, row.author, row.kind, row.agentRef ?? null, row.agentName ?? null, row.body, JSON.stringify(row.mentions), row.replyTo ?? null, row.replyMode ?? null, row.clientKey ?? null, now, row.forwardedAuthor ?? null);
  ot.run("UPDATE ot_conversations SET last_seq = ?, updated_at = ? WHERE id = ?", seq, now, conv.id);
  if (row.kind === "member") ot.run("UPDATE ot_conversation_members SET read_seq = ? WHERE conversation_id = ? AND owner_id = ?", seq, conv.id, row.author);
  return ot.get<any>("SELECT * FROM ot_messages WHERE id = ?", id);
}

const agentMentionKey = (ownerId: string, ref: string) => `/agent/${ownerId}/${ref}`;

function conversationAgents(ot: OtContext, conversationId: string) {
  return ot.all<ConversationAgent>(`
    SELECT a.agent_ref, a.owner_id, a.name, a.auto_reply, a.direct_grant_id FROM ot_conversation_agents a
    JOIN ot_conversations c ON c.id=a.conversation_id
    JOIN ot_conversation_members member ON member.conversation_id=c.id AND member.owner_id=a.owner_id
    WHERE c.id=? AND (c.kind='group' OR a.direct_grant_id IS NOT NULL)
      AND (c.team_id IS NULL OR EXISTS (SELECT 1 FROM ot_team_members tm
      WHERE tm.team_id=c.team_id AND tm.owner_id=a.owner_id AND tm.suspended=0))
    ORDER BY a.created_at,a.rowid`, conversationId);
}

const MAX_INFERRED_AGENTS = 20;
const TYPED_ADDRESS = /(?:^|[\s(（\[，。！？、,:：;；])[＠@][\p{L}\p{N}_]/u;
const MENTION_START = /(?:^|[\s(（\[，。！？、,:：;；])[＠@]/gu;
const MENTION_HANDLE = /^[\p{L}\p{N}._-]{1,40}/u;
const NAME_CONTINUES = /^(?:[\p{L}\p{N}\p{M}_/\\-]|\.[\p{L}\p{N}\p{M}_-])/u;
const ALL_PEOPLE_ADDRESS = /(?:^|[\s(（\[，。！？、,:：;；])[＠@](?:all|everyone|所有人|全体)(?=$|[\s)）\]，。！？、,:：;；!?]|\.(?=$|\s))/iu;
const ALL_AGENT_ADDRESS = /(?:^|[\s(（\[，。！？、,:：;；])[＠@]所有智能体(?=$|[\s)）\]，。！？、,:：;；!?]|\.(?=$|\s))/u;

function mentionText(body: string) {
  // Skip the DS-Bot composer's literal forms without joining pieces of a name across them.
  return body.replace(/```[\s\S]*?(?:```|$)|`[^`\n]*`|\[[^\]\n]*\]\([^\s)]*(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\)/g, "\0");
}

function ordinaryAgentGroup(conv: {kind: string; dm_key?: string | null; group_archived_at?: unknown}) {
  return conv.kind === "group" && !conv.group_archived_at && !fixedPublicThread(conv);
}

function nativeGroupHost(ot: OtContext, conv: Group, roster = conversationAgents(ot, conv.id)) {
  const owner = groupOwner(conv);
  // Each Bot runs under its own owner. The active group owner coordinates the native room.
  if (ordinaryAgentGroup(conv) && managedGroup(conv) && readGroupReplyPolicy(conv).mode !== "mentions" &&
      roster.length >= 2 && roster.length <= 12 && roster.every(agent => !agent.direct_grant_id) &&
      (roster.some(agent => agent.owner_id === owner) || ot.get(`SELECT 1 FROM ot_conversation_members host
        WHERE host.conversation_id=? AND host.owner_id=? AND (? IS NULL OR EXISTS (
          SELECT 1 FROM ot_team_members active WHERE active.team_id=? AND active.owner_id=host.owner_id AND active.suspended=0))`,
      conv.id, owner, conv.team_id, conv.team_id))) {
    return owner;
  }
}

const ORIGINAL_NATIVE_SOURCE = (message: string, room: string) => `${message}.author_kind='member'
  AND ${message}.retracted=0 AND ${message}.revision=1 AND EXISTS (
    SELECT 1 FROM ot_conversation_members source_member
    WHERE source_member.conversation_id=${room}.id AND source_member.owner_id=${message}.author_id
      AND source_member.created_at<=${message}.created_at AND (${room}.team_id IS NULL OR EXISTS (
        SELECT 1 FROM ot_team_members source_team WHERE source_team.team_id=${room}.team_id
          AND source_team.owner_id=source_member.owner_id AND source_team.suspended=0 AND source_team.created_at<=${message}.created_at)))`;
const REQUIRES_NATIVE_TEXT_ONLY = (round: string, room: string) => `(${round}.text_only=1 OR ${room}.team_id IS NOT NULL OR EXISTS (
  SELECT 1 FROM ot_conversation_members native_peer
  WHERE native_peer.conversation_id=${room}.id AND native_peer.owner_id<>${round}.owner_id))`;
const ACTIVE_NATIVE_TURN_SEAT = (turn: string, room: string) => `EXISTS (
  SELECT 1 FROM ot_conversation_agents native_seat
  JOIN ot_conversation_members native_guest ON native_guest.conversation_id=native_seat.conversation_id AND native_guest.owner_id=native_seat.owner_id
  WHERE native_seat.conversation_id=${room}.id AND native_seat.owner_id=${turn}.owner_id AND native_seat.agent_ref=${turn}.agent_ref
    AND native_seat.created_at<=${turn}.created_at AND native_guest.created_at<=${turn}.created_at
    AND (${room}.team_id IS NULL OR EXISTS (SELECT 1 FROM ot_team_members native_team
      WHERE native_team.team_id=${room}.team_id AND native_team.owner_id=native_guest.owner_id
        AND native_team.suspended=0 AND native_team.created_at<=${turn}.created_at)))`;

function selectedLead(policy: ReturnType<typeof readGroupReplyPolicy>, agents: ConversationAgent[]) {
  return policy.mode === "lead"
    ? agents.find(agent => agent.owner_id === policy.lead.owner_id && agent.agent_ref === policy.lead.agent_id)
    : undefined;
}

function nativeRoomOpeningOrder(agents: ConversationAgent[], policy: ReturnType<typeof readGroupReplyPolicy>) {
  const admin = selectedLead(policy, agents);
  return admin ? [admin, ...agents.filter(agent => agent !== admin)] : agents;
}

function groupHasOtherMember(ot: OtContext, conv: Group, viewer: string) {
  return Boolean(ot.get(`SELECT 1 FROM ot_conversation_members member
    WHERE member.conversation_id=? AND member.owner_id<>? AND (? IS NULL OR EXISTS (
      SELECT 1 FROM ot_team_members team WHERE team.team_id=? AND team.owner_id=member.owner_id AND team.suspended=0)) LIMIT 1`,
  conv.id, viewer, conv.team_id, conv.team_id));
}

function nativeGroupImages(ot: OtContext, conv: Group, owner: string, agents: ConversationAgent[]) {
  return conv.account_group === 1 && !conv.team_id && agents.every(agent => agent.owner_id === owner) &&
    !groupHasOtherMember(ot, conv, owner);
}

function groupAgentRouting(ot: OtContext, conv: Group, viewer: string, agents: ConversationAgent[]) {
  const policy = groupReplyPolicyForRoster(conv, agents);
  const current = policy.mode === "lead" && !selectedLead(policy, agents) ? {...policy, lead_unavailable: true} : policy;
  const host = nativeGroupHost(ot, conv, agents);
  const access = {policy: current, can_edit: managedGroup(conv) && groupOwner(conv) === viewer,
    ...(host ? {native_group_host:host,...(host === viewer ? {native_group_coordinator:true} : {}),
      ...(host === viewer && nativeGroupImages(ot, conv, host, agents) ? {native_group_images:true} : {})} : {})};
  if (groupHasOtherMember(ot, conv, viewer)) return {mode: "shared" as const, ...access};
  return {mode: "personal" as const, default: agents.some(agent => agent.auto_reply) ? "auto" as const : "all" as const, ...access};
}

function unaddressedGroupTurn(agents: ConversationAgent[], quote: ReturnType<typeof replyOriginal>,
  policy: ReturnType<typeof readGroupReplyPolicy>) {
  if (policy.mode === "mentions" || !agents.length) return {agents: [], discretionary: false};
  if (quote?.author_kind === "agent") {
    return {agents: agents.filter(agent => agent.owner_id === quote.author_id && agent.agent_ref === quote.agent_ref), discretionary: false};
  }
  const admin = selectedLead(policy, agents);
  if (admin) return {agents: [admin], discretionary: true};
  // Keep the existing opt-in auto inbox and its rate limit. With no opt-ins,
  // the DS-Bot workers decide whether the ordinary message warrants a reply.
  if (policy.mode === "default" && agents.some(agent => agent.auto_reply)) return undefined;
  return {agents: agents.slice(0, MAX_INFERRED_AGENTS), discretionary: true};
}

function explicitAgentKey(target: any) {
  assert(target && typeof target.owner_id === "string" && !target.owner_id.includes("/")
    && typeof target.agent_id === "string" && AGENT_REF.test(target.agent_id),
  400, "invalid_request", "An agent mention requires an owner and agent ID");
  return agentMentionKey(target.owner_id, target.agent_id);
}

function agentMessageRequest(b: any, clientKey: string | null, replyTo: string | null, scope: "group" | "direct") {
  const flag = scope === "direct" ? "direct_agent_request" : "group_agent_request";
  if (b[flag] === undefined) return null;
  const extra = scope === "direct" ? ["workspace"] : ["workspace", "studio_reference", "native_round"];
  assert(b[flag] === true && clientKey && (scope === "direct" ? b.direct === true : b.direct === undefined || typeof b.direct === "boolean")
    && Array.isArray(b.agent_mentions) && b.agent_mentions.length >= 1 && b.agent_mentions.length <= 5
    && Object.keys(b).every(key => ["body","direct","agent_mentions","client_key","reply_to",flag,...extra].includes(key)),
  400, "invalid_request", "Choose 1 to 5 conversation agents and provide a request key");
  if (scope === "direct") assert(b.agent_mentions.every((target: any) => target && typeof target.owner_id === "string"
    && AGENT_REF.test(target.owner_id) && Object.keys(target).length === 2), 400, "invalid_request", "Invalid direct agent target");
  const agents: string[] = b.agent_mentions.map(explicitAgentKey);
  assert(new Set(agents).size === agents.length, 400, "invalid_request", "Choose each conversation agent once");
  const prompt = text(b.body, "body", {min: 1, max: BODY_MAX, multiline: true});
  return createHash("sha256").update(JSON.stringify([prompt, replyTo, agents.sort()])).digest("hex");
}

function studioMessageRequest(b: any, clientKey: string | null, replyTo: string | null) {
  if (b.studio_reference === undefined) return null;
  const reference = b.studio_reference;
  assert(reference && typeof reference.document_id === "string" && /^[0-9a-f]{32}$/.test(reference.document_id)
    && Number.isSafeInteger(reference.revision) && reference.revision >= 1
    && Object.keys(reference).length === 2, 400, "invalid_request", "Invalid Studio document version");
  assert(clientKey && (b.direct === undefined || b.direct === false) && Array.isArray(b.agent_mentions)
    && b.agent_mentions.length >= 1 && b.agent_mentions.length <= 20
    && Object.keys(b).every(key => ["body","workspace","direct","agent_mentions","client_key","studio_reference","reply_to","group_agent_request"].includes(key)),
  400, "invalid_request", "A Studio reference requires a text message and explicitly selected group agents");
  const prompt = text(b.body, "body", {min: 1, max: BODY_MAX, multiline: true});
  const {document_id, revision}: StudioReference = reference;
  const agents: string[] = b.agent_mentions.map(explicitAgentKey);
  if (b.group_agent_request) agents.sort();
  const fingerprint = createHash("sha256").update(JSON.stringify([
    document_id, revision, prompt, replyTo, agents,
  ])).digest("hex");
  return {document_id, revision, fingerprint};
}

function requireStudioMessageScope(ot: OtContext, conv: any, reference: StudioReference, agents: ReplyAgent[]) {
  assert(conv.kind === "group" && conv.team_id && !conv.account_group && !fixedPublicThread(conv),
    404, "studio_reference_unavailable", "该群聊不在文档所属的团队工作区。");
  const document = ot.get<{revision: number}>(`
    SELECT doc.revision FROM ot_studio_documents doc JOIN ot_teams team ON team.id=doc.team_id
    JOIN ot_studio_revisions saved ON saved.document_id=doc.id AND saved.revision=doc.revision
    WHERE doc.team_id=? AND doc.id=? AND doc.deleted_at IS NULL AND team.slug IS NOT NULL AND team.workspace_id IS NOT NULL`,
  conv.team_id, reference.document_id);
  assert(document, 404, "studio_reference_unavailable", "团队文档已不可用。");
  assert(document.revision === reference.revision, 409, "studio_reference_changed", "团队文档已更新，请重新预览后发送。");
  for (const agent of agents) {
    const active = ot.get(`SELECT 1 FROM ot_conversation_members seat JOIN ot_team_members teammate
      ON teammate.team_id=? AND teammate.owner_id=seat.owner_id AND teammate.suspended=0
      WHERE seat.conversation_id=? AND seat.owner_id=?`, conv.team_id, conv.id, agent.owner_id);
    assert(active, 404, "studio_reference_unavailable", "所选智能体已无法读取团队文档。");
  }
}

function agentMentioned(mentions: string[], agent: ReplyAgent) {
  return mentions.some(mention => mention.startsWith("/agent/"))
    ? mentions.includes(agentMentionKey(agent.owner_id, agent.agent_ref))
    : mentions.includes(agent.agent_ref.toLowerCase()) || mentions.includes(agent.name.toLowerCase());
}

function groupNameMentions(addressText: string, handles: Set<string>, members: Set<string>, agents: ConversationAgent[]) {
  const byRef = new Map<string, string | null>();
  const byName = new Map<string, string | null>();
  for (const agent of agents) {
    const key = agentMentionKey(agent.owner_id, agent.agent_ref);
    const ref = agent.agent_ref.toLowerCase(), name = agent.name.toLowerCase();
    byRef.set(ref, byRef.has(ref) ? null : key);
    byName.set(name, byName.has(name) ? null : key);
  }
  const aliases = new Map([...byRef, ...byName]);
  const names = [...aliases.keys()].sort((a, b) => b.length - a.length);
  const mentions = new Set<string>();
  for (const handle of handles) {
    const key = members.has(handle) ? handle : aliases.get(handle);
    if (key) mentions.add(key);
  }
  let named = false;
  let consumed = 0;
  const plain = addressText.toLowerCase();
  for (const match of plain.matchAll(MENTION_START)) {
    const start = match.index + match[0].length;
    if (start <= consumed) continue;
    const alias = names.find(name => plain.startsWith(name, start));
    const handle = MENTION_HANDLE.exec(plain.slice(start))?.[0] ?? "";
    if (members.has(handle) && (!alias || handle.length >= alias.length)) {
      mentions.add(handle);
    } else if (alias) {
      consumed = start + alias.length;
      named = true;
      const key = aliases.get(alias);
      if (key && !NAME_CONTINUES.test(plain.slice(consumed))) mentions.add(key);
    }
  }
  return {mentions:[...mentions], named};
}

function parseMentions(ot: OtContext, conv: Group, raw: unknown, bodyText: string, addressText: string, selectedAgents: unknown,
  agents: ConversationAgent[], scope?: "group" | "direct", studio = false) {
  const handles = new Set<string>();
  if (Array.isArray(raw)) for (const h of raw.slice(0, 20)) handles.add(handleKey(h));
  const members = new Set(ot.all<{handle:string}>("SELECT p.handle FROM ot_conversation_members m JOIN ot_profiles p ON p.owner_id = m.owner_id WHERE m.conversation_id = ?", conv.id).map(r => r.handle));
  if (selectedAgents === undefined && ordinaryAgentGroup(conv) && agents.length && (handles.size || /[@＠]/u.test(addressText))) {
    const {mentions, named} = groupNameMentions(addressText, handles, members, agents);
    return {mentions, named, body:bodyText, agents:agents.filter(agent => mentions.includes(agentMentionKey(agent.owner_id, agent.agent_ref)))};
  }
  for (const m of addressText.matchAll(/(?:^|[\s(（\[，。！？、,:：;；])[＠@]([\p{L}\p{N}._-]{1,40})/gu)) handles.add(handleKey(m[1]));
  if (selectedAgents === undefined) {
    const legacy = new Set(agents.flatMap(agent => [agent.agent_ref.toLowerCase(), agent.name.toLowerCase()]));
    const mentions = [...handles].filter(h => members.has(h) || legacy.has(h));
    return { mentions, body: bodyText, agents: agents.filter(agent => agentMentioned(mentions, agent)) };
  }

  assert(Array.isArray(selectedAgents) && selectedAgents.length <= 20, 400, "invalid_request", "Choose at most 20 group agents");
  const available = new Map(agents.map(agent => [agentMentionKey(agent.owner_id, agent.agent_ref), agent]));
  const targets = new Map<string, string>();
  for (const target of selectedAgents) {
    const key = explicitAgentKey(target);
    const agent = available.get(key);
    assert(agent, scope ? 409 : studio ? 404 : 400,
      scope === "direct" ? "direct_agent_unavailable" : scope === "group" ? "group_agent_unavailable"
        : studio ? "studio_reference_unavailable" : "invalid_request",
      "A mentioned agent is no longer available in this conversation");
    targets.set(key, agent.name);
  }
  const prefix = [...targets.values()].map(name => "@" + name).join(" ");
  return {
    mentions: [...handles].filter(handle => members.has(handle)).concat([...targets.keys()]),
    agents: agents.filter(agent => targets.has(agentMentionKey(agent.owner_id, agent.agent_ref))),
    body: prefix ? text(prefix + " " + bodyText, "body", { min: 1, max: BODY_MAX, multiline: true }) : bodyText,
  };
}

function replyContext(ot: OtContext, conversationId: string, seq: number, viewer: string) {
  return ot.all<any>(`SELECT * FROM (SELECT m.* FROM ot_messages m
    WHERE m.conversation_id=? AND m.seq<=? AND m.retracted=0 AND ${VISIBLE_MESSAGE}
    ORDER BY m.seq DESC LIMIT 12) ORDER BY seq`, conversationId, seq, viewer).map(m => messageView(ot, m));
}

function registerAgentAccess(app: FastifyInstance, ot: OtContext) {
  const root = "/v1/ot/agent-access";
  const agentId = /^[a-f0-9]{32}$/;
  const socialId = /^[A-Za-z0-9._-]{1,80}$/;
  type Peer = {owner_id: string; handle: string; display_name: string};
  type AccessRow = Peer & {conversation_id: string; created_at: number};

  app.get(root, async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const {ownerId} = ot.me(req);
    const q = query(req);
    const ref = one(q.agent_id,"agent_id");
    const after = one(q.after,"after") ?? "";
    assert(ref && agentId.test(ref) && (!after || socialId.test(after))
      && Object.keys(q).every(key => ["agent_id","limit","after"].includes(key)),400,"invalid_request","Invalid agent access filters");
    const limit = Math.max(1,intParam(q.limit,"limit",50,100));
    const rows = ot.all<AccessRow>(`SELECT a.conversation_id,a.created_at,p.owner_id,p.handle,p.display_name FROM ot_conversation_agents a
      JOIN ot_conversations room ON room.id=a.conversation_id
      JOIN ot_conversation_members sender ON sender.conversation_id=room.id AND sender.owner_id=a.owner_id
      JOIN ot_conversation_members peer ON peer.conversation_id=room.id AND peer.owner_id<>sender.owner_id
      JOIN ot_profiles p ON p.owner_id=peer.owner_id
      WHERE a.owner_id=? AND a.agent_ref=? AND a.direct_grant_id IS NOT NULL AND a.conversation_id>?
        AND room.kind='dm' AND room.team_id IS NULL AND room.group_archived_at IS NULL
        AND room.dm_key=${directKey("sender.owner_id","peer.owner_id")} AND room.dm_key NOT LIKE 'agent:%'
        AND NOT EXISTS (SELECT 1 FROM ot_conversation_members other WHERE other.conversation_id=room.id
          AND other.owner_id NOT IN (sender.owner_id,peer.owner_id)) AND ${directRelationship("sender.owner_id","peer.owner_id")}
      ORDER BY a.conversation_id LIMIT ?`,ownerId,ref,after,limit+1);
    return {items:rows.slice(0,limit).map(({conversation_id,created_at,owner_id,handle,display_name})=>({
      conversation_id,agent_id:ref,owner_id:ownerId,recipient:{owner_id,handle,display_name},created_at,
    })),next_cursor:rows.length>limit ? rows[limit-1].conversation_id : null};
  });

  app.post(root, {bodyLimit:2048}, async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const {ownerId} = ot.me(req);
    const b = body(req);
    assert(Object.keys(query(req)).length === 0 && Object.keys(b).every(key => ["agent_id","name","recipient_owner_id"].includes(key))
      && typeof b.agent_id === "string" && agentId.test(b.agent_id) && typeof b.recipient_owner_id === "string"
      && /^[A-Za-z0-9._:-]{1,80}$/.test(b.recipient_owner_id) && b.recipient_owner_id !== ownerId,
    400,"invalid_request","Choose another person and an agent to share");
    const name = text(b.name,"name",{min:1,max:40});
    const ref = b.agent_id;
    const result = ot.db.transaction(() => {
      const recipient = ot.get<Peer>("SELECT owner_id,handle,display_name FROM ot_profiles WHERE owner_id=?",b.recipient_owner_id);
      assert(recipient && directReachable(ot,ownerId,recipient.owner_id),
        409,"agent_access_recipient_unavailable","这位联系人或队友已不可用。");
      const {conversation} = getOrCreateDirectConversation(ot,ownerId,recipient.owner_id);
      assert(conversation.group_archived_at === null && directAgentPeer(ot,conversation,ownerId) === recipient.owner_id,
        409,"direct_conversation_unavailable","此私聊暂不可用。");
      const {created,created_at} = grantDirectAgent(ot,conversation.id,ownerId,ref,name);
      return {created,access:{conversation_id:conversation.id,agent_id:ref,owner_id:ownerId,recipient,created_at}};
    }).immediate();
    return reply.status(result.created ? 201 : 200).send(result);
  });

  app.delete(root+"/:conversation_id/:agent_id", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const {ownerId} = ot.me(req);
    const {conversation_id,agent_id} = params(req);
    assert(socialId.test(conversation_id) && agentId.test(agent_id) && Object.keys(query(req)).length === 0
      && Object.keys(body(req)).length === 0,400,"invalid_request","Invalid agent access removal");
    return ot.db.transaction(() => {
      const conversation = memberOf(ot,conversation_id,ownerId);
      assert(directAgentPeer(ot,conversation,ownerId) && removeDirectAgent(ot,conversation_id,ownerId,agent_id) === 1,
        404,"agent_access_not_found","找不到这条智能体访问授权。");
      return {revoked:true};
    }).immediate();
  });
}

export function registerMessenger(app: FastifyInstance, ot: OtContext) {
  migrateChatFiles(ot);
  // SQLite lower() folds ASCII only. Filenames can contain Unicode letters.
  ot.db.function("ot_attachment_title_matches", {deterministic: true}, (title: string, term: string) =>
    Number(title.toLowerCase().includes(term)));
  const conversationCols = new Set(ot.all<{name: string}>("PRAGMA table_info(ot_conversations)").map(col => col.name));
  if (!conversationCols.has("account_group")) ot.run("ALTER TABLE ot_conversations ADD COLUMN account_group INTEGER NOT NULL DEFAULT 0");
  if (!conversationCols.has("activity_revision")) ot.run("ALTER TABLE ot_conversations ADD COLUMN activity_revision INTEGER NOT NULL DEFAULT 0");
  registerGroupManagement(ot, conversationCols);
  registerGroupInvites(app, ot);
  const messageCols = new Set(ot.all<any>("PRAGMA table_info(ot_messages)").map(c => c.name));
  if (!messageCols.has("revision")) ot.run("ALTER TABLE ot_messages ADD COLUMN revision INTEGER NOT NULL DEFAULT 1");
  if (!messageCols.has("forwarded_author")) ot.run("ALTER TABLE ot_messages ADD COLUMN forwarded_author TEXT");
  const nativeRoundCols = new Set(ot.all<{name:string}>("PRAGMA table_info(ot_native_group_rounds)").map(col => col.name));
  if (!nativeRoundCols.has("text_only")) ot.run("ALTER TABLE ot_native_group_rounds ADD COLUMN text_only INTEGER NOT NULL DEFAULT 0");
  const jobCols = new Set(ot.all<{name: string}>("PRAGMA table_info(ot_agent_reply_jobs)").map(c => c.name));
  if (!jobCols.has("direct_grant_id")) ot.run("ALTER TABLE ot_agent_reply_jobs ADD COLUMN direct_grant_id TEXT");
  if (!jobCols.has("source_revision")) ot.run("ALTER TABLE ot_agent_reply_jobs ADD COLUMN source_revision INTEGER");
  if (!jobCols.has("claim_id")) ot.run("ALTER TABLE ot_agent_reply_jobs ADD COLUMN claim_id TEXT");
  if (!jobCols.has("lease_expires_at")) ot.run("ALTER TABLE ot_agent_reply_jobs ADD COLUMN lease_expires_at INTEGER");
  if (!jobCols.has("discretionary")) ot.run("ALTER TABLE ot_agent_reply_jobs ADD COLUMN discretionary INTEGER NOT NULL DEFAULT 0");
  if (!jobCols.has("passed")) ot.run("ALTER TABLE ot_agent_reply_jobs ADD COLUMN passed INTEGER NOT NULL DEFAULT 0");
  if (!jobCols.has("progress_revision")) {
    ot.tx(() => {
      ot.run("ALTER TABLE ot_agent_reply_jobs ADD COLUMN progress_revision INTEGER NOT NULL DEFAULT 0");
      ot.run("DROP TRIGGER IF EXISTS ot_agent_reply_jobs_activity_update");
    });
  }
  const agentCols = new Set(ot.all<any>("PRAGMA table_info(ot_conversation_agents)").map(c => c.name));
  if (!agentCols.has("direct_grant_id")) ot.run("ALTER TABLE ot_conversation_agents ADD COLUMN direct_grant_id TEXT");
  ot.run(`CREATE INDEX IF NOT EXISTS ot_conversation_agents_direct_owner
    ON ot_conversation_agents(owner_id,agent_ref,conversation_id) WHERE direct_grant_id IS NOT NULL`);
  if (!agentCols.has("auto_reply_after_seq")) {
    ot.run("ALTER TABLE ot_conversation_agents ADD COLUMN auto_reply_after_seq INTEGER NOT NULL DEFAULT 0");
  }
  registerActivityTriggers(ot);
  registerReplyJobInvalidation(ot);
  registerDirectAgentRevocation(ot);
  registerAgentAccess(app,ot);
  const replyProgress = new Map<string, {attempt: number; text: string; expires: number}>();
  const nativeGroupProgress = new Map<string, {messageId:string; ownerId:string; refs:string[]; expires:number}>();
  const inboxWake = agentInboxWake();
  app.addHook("preClose", async () => inboxWake.close());

  function wakeDiscretionaryPeers(messageId: string, ownerId: string) {
    if (!inboxWake.hasWaiters()) return;
    const peers = ot.all<{owner_id: string}>(`SELECT DISTINCT owner_id FROM (${REPLY_JOB_SOURCE}) queued
      WHERE message_id=? AND owner_id<>? AND discretionary=1 AND status='queued' AND available AND updated_at>?`,
      messageId, ownerId, ot.now() - REPLY_JOB_QUEUE_MS);
    for (const peer of peers) inboxWake.notify(peer.owner_id);
  }

  function legacyWakeOwners(conv: any, seq: number) {
    if (!inboxWake.hasWaiters() || conv.kind !== "group") return [];
    return ot.all<{owner_id: string}>(`SELECT DISTINCT a.owner_id FROM ot_conversation_agents a
      JOIN ot_conversation_members m ON m.conversation_id=a.conversation_id AND m.owner_id=a.owner_id
      WHERE a.conversation_id=? AND (? OR (a.auto_reply=1 AND a.auto_reply_after_seq<?))
        AND (? IS NULL OR EXISTS (SELECT 1 FROM ot_team_members tm
          WHERE tm.team_id=? AND tm.owner_id=a.owner_id AND tm.suspended=0))`,
    conv.id, Number(fixedPublicThread(conv)), seq, conv.team_id, conv.team_id);
  }
  app.post("/v1/ot/conversations", async (req, reply) => {
    const me = ot.me(req);
    const b = body(req);
    if (b.kind === "dm") {
      const peer = ot.ownerByHandle(b.peer);
      assert(peer !== me.ownerId, 400, "invalid_request", "pick another member");
      const {conversation,created} = ot.db.transaction(() => {
        assert(directReachable(ot,me.ownerId,peer),403,"not_reachable","请先建立联系人关系。");
        return getOrCreateDirectConversation(ot,me.ownerId,peer);
      }).immediate();
      return reply.status(created ? 201 : 200).send(conversationView(ot,conversation,me.ownerId));
    }
    assert(b.kind === "group", 400, "invalid_request", "kind must be dm or group");
    const title = text(b.title ?? "新群聊", "title", { min: 1, max: 80 });
    const teamId = b.team_id ? String(b.team_id) : null;
    const accountGroup = b.account_group === true;
    assert(!accountGroup || !teamId, 400, "invalid_request", "A personal group has no team");
    if (teamId) requireMember(ot, teamId, me.ownerId);
    assert(Array.isArray(b.members ?? []) && (b.members ?? []).length <= 50, 400, "invalid_request", "members must be a list of at most 50 handles");
    const others = [...new Set((b.members ?? []).map((h: unknown) => ot.ownerByHandle(h)))].filter((o) => o !== me.ownerId) as string[];
    const selected = b.agents ?? [];
    assert(Array.isArray(selected) && selected.length <= 10, 400, "invalid_request", "Select at most 10 agents");
    const agents = new Map<string,string>();
    for (const agent of selected) {
      const ref = text(agent?.agent_ref, "agent_ref", {min:1, max:80});
      assert(AGENT_REF.test(ref), 400, "invalid_request", "Invalid agent identifier");
      agents.set(ref, text(agent?.name, "name", {min:1, max:40}));
    }
    assert(!accountGroup || (others.length < 50 && others.length + agents.size > 0), 400, "invalid_request", "请选择联系人或智能体。");
    const key = optText(b.idempotency_key, "idempotency_key", {min:16,max:80});
    const fingerprint = JSON.stringify([title, teamId, accountGroup, others.slice().sort(), [...agents].sort()]);
    const result = ot.tx(() => {
      const prior = key && ot.get<{conversation_id:string; fingerprint:string}>(
        "SELECT conversation_id,fingerprint FROM ot_group_requests WHERE owner_id=? AND request_key=?", me.ownerId, key);
      if (prior) {
        assert(prior.fingerprint === fingerprint, 409, "conflict", "Idempotency key reused");
        return {conv:memberOf(ot, prior.conversation_id, me.ownerId), created:false};
      }
      for (const o of others) assertReachable(ot, me.ownerId, o, teamId, accountGroup);
      const id = newId("otc"); const now = ot.now();
      const chooseLead = accountGroup || Boolean(teamId);
      ot.run(`INSERT INTO ot_conversations(id,kind,title,team_id,created_by,created_at,updated_at,account_group,group_auto_lead)
        VALUES (?,'group',?,?,?,?,?,?,?)`, id,title,teamId,me.ownerId,now,now,Number(accountGroup),Number(chooseLead));
      for (const o of [me.ownerId, ...others]) ot.run("INSERT INTO ot_conversation_members(conversation_id, owner_id, created_at) VALUES (?,?,?)", id, o, now);
      for (const [ref, name] of agents) ot.run("INSERT INTO ot_conversation_agents(conversation_id,agent_ref,owner_id,name,created_at) VALUES (?,?,?,?,?)", id, ref, me.ownerId, name, now);
      if (chooseLead && agents.size) refreshAutomaticGroupLead(ot,memberOf(ot,id,me.ownerId),conversationAgents(ot,id));
      for (const o of others) ot.notify(o, "messenger.added", {conversation_id:id, title, by:ot.profileView(me.ownerId), ...(teamId ? {team_id:teamId} : {})});
      if (key) ot.run("INSERT INTO ot_group_requests VALUES (?,?,?,?)", me.ownerId, key, fingerprint, id);
      return {conv:memberOf(ot, id, me.ownerId), created:true};
    });
    return reply.status(result.created ? 201 : 200).send(conversationView(ot, result.conv, me.ownerId, true));
  });

  app.get("/v1/ot/conversations", async (req) => {
    const me = ot.me(req);
    const {scope, team_id, view, since} = query(req);
    assert(scope === undefined || scope === "public" || scope === "member" || scope === "personal", 400, "invalid_request", "Invalid conversation scope");
    let filter = scope === "public" ? " AND c.dm_key LIKE 'agent:%'"
      : scope === "personal" ? " AND (c.dm_key LIKE 'agent:%' OR (c.kind='dm' AND c.team_id IS NULL) OR c.account_group=1)"
      : scope === "member" ? " AND (c.dm_key IS NULL OR c.dm_key NOT LIKE 'agent:%')" : "";
    const args = [me.ownerId];
    if (team_id !== undefined) {
      assert(scope === "member" && typeof team_id === "string", 400, "invalid_request", "Invalid team scope");
      requireMember(ot, team_id, me.ownerId);
      filter += ` AND (c.team_id=? OR (c.kind='dm' AND c.team_id IS NULL AND EXISTS (
        SELECT 1 FROM ot_conversation_members peer JOIN ot_team_members teammate
          ON teammate.owner_id=peer.owner_id AND teammate.team_id=? AND teammate.suspended=0
        WHERE peer.conversation_id=c.id AND peer.owner_id<>?)))`;
      args.push(team_id, team_id, me.ownerId);
    }
    const rows = ot.all<any>(`SELECT c.*, m.read_seq, m.pinned, m.muted FROM ot_conversations c
      JOIN ot_conversation_members m ON m.conversation_id=c.id
      WHERE m.owner_id=? AND c.group_archived_at IS NULL
        AND (c.team_id IS NULL OR EXISTS (SELECT 1 FROM ot_team_members active
          WHERE active.team_id=c.team_id AND active.owner_id=m.owner_id AND active.suspended=0))
        ${filter} ORDER BY m.pinned DESC,c.updated_at DESC,c.id LIMIT 200`, ...args)
      .filter(c => publicParticipant(ot, c, me.ownerId));
    if (view === "activity") {
      const items = rows.map(c => {
        const published = publicListing(ot, c);
        const peer = ordinaryDirect(c) && ot.get<{owner_id: string}>(
          "SELECT owner_id FROM ot_conversation_members WHERE conversation_id=? AND owner_id<>?", c.id, me.ownerId);
        const open = Boolean(published?.listed && published.chat_enabled || peer && directReachable(ot, me.ownerId, peer.owner_id));
        return {id: c.id, activity_version: contentVersion(c, open, hiddenCount(ot, c.id, me.ownerId)), last_seq: c.last_seq,
          unread_count: unreadMessages(ot, c, me.ownerId, c.read_seq), pinned: c.pinned === 1, muted: c.muted === 1};
      });
      const version = createHash("sha256").update(JSON.stringify(items)).digest("hex");
      return since === version ? {version} : {version, items};
    }
    const list = rows.map(c => conversationView(ot, c, me.ownerId));
    return { conversations: list, unread: list.reduce((n, c) => n + (c.muted ? 0 : c.unread), 0) };
  });
  // Native discovery is a read-only membership directory. Reading a page does
  // not open rooms, load their chat logs or materialize native Sessions.
  app.get("/v1/ot/group-directory", async (req, reply) => {
    reply.header("cache-control", "private, no-store");
    const {ownerId} = ot.me(req);
    const input = query(req);
    const cursor = one(input.cursor, "cursor");
    assert(Object.keys(input).every(key => key === "cursor") && (cursor === undefined || SHARED_GROUP_ID.test(cursor)),
      400, "invalid_request", "Invalid shared group directory cursor");
    const rows = ot.all<{conversation_id:string; title:string; kind:"personal"|"team"; workspace_id:string|null; workspace_name:string|null}>(`
      SELECT c.id AS conversation_id,c.title,
        CASE WHEN c.team_id IS NULL THEN 'personal' ELSE 'team' END AS kind,
        team.workspace_id,team.name AS workspace_name
      FROM ot_conversation_members seat JOIN ot_conversations c ON c.id=seat.conversation_id
      LEFT JOIN ot_teams team ON team.id=c.team_id
      LEFT JOIN ot_team_members active ON active.team_id=team.id AND active.owner_id=seat.owner_id AND active.suspended=0
      WHERE seat.owner_id=? AND c.kind='group' AND c.dm_key IS NULL AND c.group_archived_at IS NULL
        AND ((c.team_id IS NULL AND c.account_group=1) OR active.owner_id IS NOT NULL)
        ${cursor ? "AND seat.conversation_id<?" : ""}
      ORDER BY seat.conversation_id DESC LIMIT ?`, ownerId, ...(cursor ? [cursor] : []), SHARED_GROUP_PAGE + 1);
    const items = rows.slice(0, SHARED_GROUP_PAGE);
    return {items, next_cursor: rows.length > SHARED_GROUP_PAGE ? items[items.length - 1].conversation_id : null};
  });
  app.get("/v1/ot/group-directory/:id", async (req, reply) => {
    reply.header("cache-control", "private, no-store");
    const {ownerId} = ot.me(req);
    const {id} = params(req);
    assert(SHARED_GROUP_ID.test(id) && Object.keys(query(req)).length === 0, 400, "invalid_request", "Invalid shared group request");
    const group = memberOf(ot, id, ownerId);
    assert(managedGroup(group), 404, "conversation_not_found", "no such conversation");
    return conversationView(ot, group, ownerId, true);
  });
  app.get("/v1/ot/conversations/:id", async (req) => {
    const me = ot.me(req);
    return conversationView(ot, memberOf(ot, params(req).id, me.ownerId), me.ownerId, true);
  });
  app.post("/v1/ot/conversations/:id/management", {bodyLimit: 2048}, async (req) => {
    const me = ot.me(req);
    const {id} = params(req);
    const {change,revision,workspace,fingerprint} = groupManagementRequest(body(req));
    return ot.tx(() => {
      const team = workspace ? workspaceTeam(ot,workspace,me.ownerId) : null;
      const group = ot.get<Group>("SELECT * FROM ot_conversations WHERE id=?",id);
      assert(group && managedGroup(group) && (team ? group.team_id === team.id : !group.team_id && group.account_group === 1),
        404,"conversation_not_found","no such conversation");
      const previous = ot.get<{fingerprint: string}>(`SELECT fingerprint FROM ot_group_management_receipts
        WHERE conversation_id=? AND owner_id=? AND revision=?`,id,me.ownerId,revision);
      if (previous?.fingerprint === fingerprint && change.action === "leave") return {left:true,conversation_id:id};

      const accessible = memberOf(ot,id,me.ownerId);
      if (previous) {
        assert(previous.fingerprint === fingerprint, 409,"group_management_conflict","群聊设置已更新，请刷新后再试。");
        return {conversation:conversationView(ot, accessible, me.ownerId, true)};
      }
      assert(accessible.group_revision === revision, 409,"group_management_conflict","群聊设置已更新，请刷新后再试。");
      if (changeGroup(ot,accessible,me.ownerId,change)) {
        ot.run("INSERT INTO ot_group_management_receipts VALUES (?,?,?,?)",id,me.ownerId,revision,fingerprint);
      }
      if (change.action === "leave") return {left:true,conversation_id:id};
      return {conversation:conversationView(ot, memberOf(ot,id,me.ownerId), me.ownerId, true)};
    });
  });
  app.patch("/v1/ot/conversations/:id", async (req) => {
    const me = ot.me(req);
    const b = body(req);
    return ot.tx(() => {
      const conv = memberOf(ot, params(req).id, me.ownerId);
      if (b.title !== undefined) {
        requireOrdinaryGroup(conv);
        assert(conv.kind === "group", 400, "invalid_request", "only groups have a title");
        changeGroup(ot,conv,me.ownerId,{action:"rename",title:text(b.title,"title",{min:1,max:80})});
      }
      for (const k of ["pinned", "muted"]) if (b[k] !== undefined) {
        assert(typeof b[k] === "boolean", 400, "invalid_request", `${k} must be true or false`);
        ot.run(`UPDATE ot_conversation_members SET ${k} = ? WHERE conversation_id = ? AND owner_id = ?`, b[k] ? 1 : 0, conv.id, me.ownerId);
      }
      return conversationView(ot, memberOf(ot,conv.id,me.ownerId), me.ownerId, true);
    });
  });
  app.post("/v1/ot/conversations/:id/members", async (req) => {
    const me = ot.me(req);
    const conv = memberOf(ot, params(req).id, me.ownerId);
    requireOrdinaryGroup(conv);
    assert(conv.kind === "group", 400, "invalid_request", "members are added to groups only");
    const input = body(req);
    const teamId = input.team_id ?? conv.team_id;
    if (input.team_id !== undefined) {
      assert(!conv.account_group && typeof teamId === "string" && (!conv.team_id || conv.team_id === teamId),
        404, "not_found", "conversation not found in this team");
      requireMember(ot, teamId, me.ownerId);
    }
    const handles = input.handles === undefined ? [input.handle] : input.handles;
    assert(Array.isArray(handles) && handles.length >= 1 && handles.length <= 50
      && handles.every(handle => typeof handle === "string" && handle.trim().length > 0 && handle.length <= 80),
      400, "invalid_request", "Provide 1–50 member handles");
    const owners = new Set<string>(handles.map(handle => ot.ownerByHandle(handle)));
    const invitedBy = ot.profileView(me.ownerId);
    ot.tx(() => {
      const count = ot.get<{n:number}>("SELECT COUNT(*) AS n FROM ot_conversation_members WHERE conversation_id=?", conv.id)?.n ?? 0;
      let added = 0;
      for (const owner of owners) {
        if (ot.get("SELECT 1 FROM ot_conversation_members WHERE conversation_id = ? AND owner_id = ?", conv.id, owner)) continue;
        assert(!conv.account_group || count + added < 50, 409, "quota", "群成员已达上限。");
        assertReachable(ot, me.ownerId, owner, teamId, conv.account_group === 1);
        ot.run("INSERT INTO ot_conversation_members(conversation_id, owner_id, read_seq, created_at) VALUES (?,?,?,?)", conv.id, owner, conv.last_seq, ot.now());
        added++;
        ot.notify(owner, "messenger.added", { conversation_id: conv.id, title: conv.title, by: invitedBy,
          ...(teamId ? { team_id: teamId } : {}) });
      }
    });
    return conversationView(ot, memberOf(ot,conv.id,me.ownerId), me.ownerId, true);
  });
  app.delete("/v1/ot/conversations/:id/members/:handle", async (req) => {
    const me = ot.me(req);
    ot.tx(() => {
      const conv = memberOf(ot, params(req).id, me.ownerId);
      requireOrdinaryGroup(conv);
      assert(conv.kind === "group", 400, "invalid_request", "a direct message has no members to remove");
      const target = ot.ownerByHandle(params(req).handle);
      changeGroup(ot,conv,me.ownerId,target === me.ownerId ? {action:"leave"} : {action:"remove",member_id:target});
    });
    return { removed: true };
  });

  const announcement = (cid: string) => ot.get<any>("SELECT * FROM ot_group_announcements WHERE conversation_id=?", cid) ?? { body: "", revision: 0 };
  const announcementView = (cid: string) => {
    const saved = announcement(cid);
    return saved.body ? {...saved, author_name: ot.profileView(saved.updated_by).display_name} : saved;
  };
  const canAnnounce = (conv: any, owner: string) => conv.account_group === 1 ? groupOwner(conv) === owner
    : !!conv.team_id && !!ot.get("SELECT 1 FROM ot_team_members WHERE team_id=? AND owner_id=? AND role IN ('owner','admin') AND suspended=0", conv.team_id, owner);
  app.get("/v1/ot/conversations/:id/announcement", async req => {
    const me = ot.me(req), conv = memberOf(ot, params(req).id, me.ownerId);
    assert(conv.kind === "group", 400, "invalid_request", "announcements require a group");
    return { announcement: announcementView(conv.id), can_edit: canAnnounce(conv, me.ownerId) };
  });
  app.post("/v1/ot/conversations/:id/announcement", async req => {
    const me = ot.me(req), conv = memberOf(ot, params(req).id, me.ownerId), b = body(req);
    assert(conv.kind === "group", 400, "invalid_request", "announcements require a group");
    assert(canAnnounce(conv, me.ownerId), 403, "forbidden", "only team owners and admins may publish");
    const content = text(b.body, "body", { max: 2000, multiline: true });
    ot.tx(() => {
      const current = announcement(conv.id);
      assert(Number.isInteger(b.revision) && b.revision === current.revision, 409, "conflict", "announcement changed; reload");
      ot.run("INSERT INTO ot_group_announcements VALUES(?,?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET body=excluded.body,revision=excluded.revision,updated_at=excluded.updated_at,updated_by=excluded.updated_by", conv.id, content, current.revision + 1, ot.now(), me.ownerId);
    });
    return { announcement: announcementView(conv.id), can_edit: true };
  });

  // ---- messages
  const searchMessages = async (req: FastifyRequest) => {
    const me = ot.me(req);
    const {workspace} = params(req);
    const team = workspace ? workspaceTeam(ot, workspace, me.ownerId) : null;

    const q = query(req);
    const term = text(q.q, "q", { min: 1, max: 80 });
    const limit = Math.max(1, intParam(q.limit, "limit", 20, 51));
    assert(q.before === undefined || (typeof q.before === "string" && /^[0-9]{1,16}:[0-9]{1,16}$/.test(q.before)),
      400, "invalid_request", "Invalid search cursor");
    const [beforeTime, beforeRow] = typeof q.before === "string" ? q.before.split(":").map(Number) : [0, 0];
    assert(Number.isSafeInteger(beforeTime) && Number.isSafeInteger(beforeRow), 400, "invalid_request", "Invalid search cursor");
    assert(q.conversation_id === undefined || (typeof q.conversation_id === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(q.conversation_id)),
      400, "invalid_request", "Invalid conversation");
    const conversation = q.conversation_id ?? null;
    const scope = team
      ? `(c.team_id=? OR (c.kind='dm' AND c.team_id IS NULL AND EXISTS (
          SELECT 1 FROM ot_conversation_members peer
          JOIN ot_team_members teammate ON teammate.owner_id=peer.owner_id AND teammate.team_id=? AND teammate.suspended=0
          WHERE peer.conversation_id=c.id AND peer.owner_id<>?)))`
      : "(c.account_group=1 OR (c.kind='dm' AND c.team_id IS NULL))";
    const scopeArgs = team ? [team.id, team.id, me.ownerId] : [];
    const rows = ot.all<any>(`SELECT m.id, m.conversation_id, m.rowseq, m.body, m.created_at,
      CASE WHEN c.kind='dm' THEN (
        SELECT p.display_name FROM ot_conversation_members peer JOIN ot_profiles p ON p.owner_id=peer.owner_id
        WHERE peer.conversation_id=c.id AND peer.owner_id<>? LIMIT 1)
      ELSE c.title END AS title
      FROM ot_messages m
      JOIN ot_conversations c ON c.id=m.conversation_id
      JOIN ot_conversation_members mine ON mine.conversation_id=c.id AND mine.owner_id=?
      WHERE m.retracted=0 AND ${VISIBLE_MESSAGE} AND (? IS NULL OR c.id=?)
        AND ${scope}
        AND (?=0 OR m.created_at<? OR (m.created_at=? AND m.rowseq<?))
        AND instr(lower(m.body),lower(?))>0
      ORDER BY m.created_at DESC, m.rowseq DESC LIMIT ?`,
    me.ownerId, me.ownerId, me.ownerId, conversation, conversation, ...scopeArgs,
    beforeRow, beforeTime, beforeTime, beforeRow, term, limit + 1);
    const items = rows.slice(0, limit).map(row => ({
      conversation_id: row.conversation_id, message_id: row.id, title: row.title || "会话",
      body: row.body, created_ms: row.created_at, cursor: `${row.created_at}:${row.rowseq}`,
    }));
    return { items, more: rows.length > limit };
  };
  app.get("/v1/ot/workspaces/:workspace/messages/search", searchMessages);
  app.get("/v1/ot/messages/personal-search", searchMessages);
  const translationSources = async (req: FastifyRequest) => {
    const me = ot.me(req);
    const {workspace, id} = params(req);
    const conv = workspace ? workspaceConversation(ot, workspace, id, me.ownerId).conv
      : accountConversation(ot, id, me.ownerId);
    const input = body(req).items;
    assert(Array.isArray(input) && input.length <= 6, 400, "invalid_request", "Provide at most six message revisions");
    const sources = [];
    const seen = new Set();
    for (const item of input) {
      assert(typeof item?.id === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(item.id)
        && Number.isSafeInteger(item.revision) && item.revision > 0, 400, "invalid_request", "Invalid message revision");
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      const source = ot.get<{id: string; revision: number; body: string}>(`SELECT m.id, m.revision, m.body
        FROM ot_messages m WHERE m.conversation_id=? AND m.id=? AND m.revision=? AND m.retracted=0
        AND ${VISIBLE_MESSAGE} AND (m.author_kind='agent' OR m.author_id<>?)
        AND NOT EXISTS (SELECT 1 FROM ot_voice_messages v WHERE v.message_id=m.id)
        AND NOT EXISTS (SELECT 1 FROM ot_message_attachments a WHERE a.message_id=m.id)`,
      conv.id, item.id, item.revision, me.ownerId, me.ownerId);
      if (source?.body.trim()) sources.push(source);
    }
    return {sources};
  };
  app.post("/v1/ot/workspaces/:workspace/conversations/:id/translation-sources", translationSources);
  app.post("/v1/ot/conversations/:id/translation-sources", translationSources);
  app.get("/v1/ot/workspaces/:workspace/conversations/:id/messages/:message", async req => {
    const me = ot.me(req);
    const {workspace, id, message} = params(req);
    const {conv, directPeer} = workspaceConversation(ot, workspace, id, me.ownerId);
    const title = directPeer ? ot.profileView(directPeer).display_name : conv.title;
    requireVisibleMessage(ot, message, me.ownerId);
    const row = ot.get<{body: string; revision: number; retracted: number}>(`SELECT body, revision, retracted
      FROM ot_messages WHERE id=? AND conversation_id=?`, message, id);
    assert(row, 404, "message_not_found", "Message not found in this conversation");
    assert(!row.retracted && row.body.trim() && !attachmentView(ot, message)
      && !ot.get("SELECT 1 FROM ot_voice_messages WHERE message_id=?", message),
      409, "conflict", "Only available text messages can be saved");
    return { body: row.body, revision: row.revision, title };
  });
  app.get("/v1/ot/conversations/:id/messages", async (req) => {
    const me = ot.me(req);
    const q = query(req);
    const id = params(req).id;
    const conv = q.workspace_id === undefined
      ? memberOf(ot, id, me.ownerId)
      : workspaceConversation(ot, text(q.workspace_id, "workspace_id", {min: 32, max: 32}), id, me.ownerId).conv;
    const limit = Math.max(1, intParam(q.limit, "limit", 50, 200));
    const before = intParam(q.before, "before", 0);
    const after = intParam(q.after, "after", 0);
    const around = q.around;
    const unread = q.unread === "1";
    const term = q.q === undefined ? "" : text(q.q, "q", { min: 1, max: 80 });
    assert(!term || (around === undefined && !after), 400, "invalid_request", "Search supports only an older cursor");
    assert(q.unread === undefined || (unread && !term), 400, "invalid_request", "Invalid unread cursor");
    assert(Number(Boolean(before)) + Number(Boolean(after)) + Number(around !== undefined) + Number(unread) <= 1,
      400, "invalid_request", "Choose one message cursor");
    const visible = `FROM ot_messages m WHERE m.conversation_id=? AND ${VISIBLE_MESSAGE}`;
    const scoped = [conv.id, me.ownerId];
    let rows;
    if (term) {
      const matches = ot.all<any>(`SELECT m.* ${visible} AND m.retracted=0
        AND (?=0 OR m.seq<?) AND instr(lower(m.body),lower(?))>0 ORDER BY m.seq DESC LIMIT ?`,
      ...scoped, before, before, term, limit + 1);
      const cursor = matches.length > limit ? matches[limit - 1].seq : null;
      return { messages: matches.slice(0, limit).map(m => messageView(ot, m, me.ownerId)), next_before: cursor };
    }
    const mine = ot.get<{read_seq: number}>("SELECT read_seq FROM ot_conversation_members WHERE conversation_id=? AND owner_id=?", ...scoped)!;
    const firstUnread = unread && ot.get<{id: string; seq: number}>(`SELECT m.id,m.seq ${visible} AND m.seq>?
      ORDER BY m.seq LIMIT 1`, ...scoped, mine.read_seq);
    if (firstUnread) {
      const preceding = ot.all<any>(`SELECT m.* ${visible} AND m.seq<? ORDER BY m.seq DESC LIMIT ?`,
        ...scoped, firstUnread.seq, Math.min(6, Math.floor((limit - 1) / 2)));
      const following = ot.all<any>(`SELECT m.* ${visible} AND m.seq>=? ORDER BY m.seq LIMIT ?`,
        ...scoped, firstUnread.seq, limit - preceding.length);
      rows = [...preceding.reverse(), ...following];
    } else if (around !== undefined) {
      assert(typeof around === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(around), 400, "invalid_request", "Invalid message ID");
      const anchor = ot.get<{seq: number}>(`SELECT m.seq ${visible} AND m.id=?`, ...scoped, around);
      assert(anchor, 404, "message_not_found", "Message not found in this conversation");
      const preceding = ot.all<any>(`SELECT m.* ${visible} AND m.seq<? ORDER BY m.seq DESC LIMIT ?`,
        ...scoped, anchor.seq, Math.floor((limit - 1) / 2));
      const following = ot.all<any>(`SELECT m.* ${visible} AND m.seq>=? ORDER BY m.seq LIMIT ?`,
        ...scoped, anchor.seq, limit - preceding.length);
      rows = [...preceding.reverse(), ...following];
    } else if (before) {
      rows = ot.all<any>(`SELECT m.* ${visible} AND m.seq<? ORDER BY m.seq DESC LIMIT ?`, ...scoped, before, limit).reverse();
    } else if (after) {
      rows = ot.all<any>(`SELECT m.* ${visible} AND m.seq>? ORDER BY m.seq LIMIT ?`, ...scoped, after, limit);
    } else {
      rows = ot.all<any>(`SELECT m.* ${visible} ORDER BY m.seq DESC LIMIT ?`, ...scoped, limit).reverse();
    }
    const first = rows[0]?.seq;
    const hasOlder = first > 1 && ot.get(`SELECT 1 ${visible} AND m.seq<? LIMIT 1`, ...scoped, first);
    const newest = rows.at(-1)?.seq ?? after;
    const hasNewer = newest < conv.last_seq && Boolean(ot.get(`SELECT 1 ${visible} AND m.seq>? LIMIT 1`, ...scoped, newest));
    return {
      messages: rows.map(m => messageView(ot, m, me.ownerId)), read_seq: mine.read_seq, last_seq: conv.last_seq,
      next_before: hasOlder ? first : null, has_newer: hasNewer,
      ...(unread ? {first_unread: firstUnread || null} : {}),
      ...(q.pins === "1" ? {pinned_messages: pinnedMessages(ot, conv.id, me.ownerId)} : {}),
    };
  });
  app.post("/v1/ot/conversations/:id/messages", {bodyLimit: CHAT_FILE_BODY_LIMIT}, async (req, reply) => {
    const me = ot.me(req);
    const b = body(req);
    if (b.sticker_replay !== undefined) {
      assert(b.sticker_replay === true &&
        Object.keys(b).every(key => ["sticker_replay", "client_key", "direct", "workspace"].includes(key)) &&
        (b.direct === undefined || typeof b.direct === "boolean"), 400, "invalid_request", "Invalid sticker replay");
      const clientKey = text(b.client_key, "client_key", {min: 1, max: 80});
      const {id} = params(req);
      const conv = b.direct === true ? accountConversation(ot, id, me.ownerId)
        : workspaceConversation(ot, text(b.workspace, "workspace", {min: 32, max: 32}), id, me.ownerId).conv;
      const previous = ot.get<any>(`SELECT m.* FROM ot_messages m
        JOIN ot_message_attachments a ON a.message_id=m.id AND a.sticker=1
        WHERE m.conversation_id=? AND m.author_id=? AND m.author_kind='member'
          AND m.client_key=? AND m.retracted=0 AND ${VISIBLE_MESSAGE}`, conv.id, me.ownerId, clientKey, me.ownerId);
      assert(previous, 404, "message_not_found", "Sticker message not found");
      return reply.status(200).send(messageView(ot, previous, me.ownerId));
    }
    const sourceConversation = b.attachment_from === undefined ? null : text(b.attachment_from?.conversation_id, "conversation_id", {min: 1, max: 80});
    const sourceMessage = sourceConversation ? text(b.attachment_from?.message_id, "message_id", {min: 1, max: 80}) : null;
    assert(Number(b.voice !== undefined) + Number(b.attachment !== undefined) + Number(Boolean(sourceMessage)) <= 1,
      400, "invalid_request", "Send a single file per message");
    const clientKey = optText(b.client_key, "client_key", { min: 1, max: 80 }) ?? null;
    const replyTo = optText(b.reply_to, "reply_to", {min: 1, max: 80}) ?? null;
    const nativeRound = b.native_round === true;
    const groupRequest = agentMessageRequest(b, clientKey, replyTo, "group");
    const directRequest = agentMessageRequest(b, clientKey, replyTo, "direct");
    const studio = studioMessageRequest(b, clientKey, replyTo);
    if (nativeRound) assert(clientKey && !replyTo && !sourceConversation && b.voice === undefined &&
      !studio && !directRequest && typeof b.body === "string" && b.body.trim().length > 0,
    400, "invalid_request", "A native group round requires text and a request key");
    const wakeOwners = new Set<string>();
    const msg = ot.tx(() => {
      const direct = b.direct === true;
      const workspace = !direct && (sourceConversation || b.attachment !== undefined || studio || groupRequest)
        ? text(b.workspace, "workspace", {min: 32, max: 32}) : "";
      const conv = direct ? accountConversation(ot, params(req).id, me.ownerId)
        : workspace ? workspaceConversation(ot, workspace, params(req).id, me.ownerId).conv
          : memberOf(ot, params(req).id, me.ownerId);
      if (groupRequest) {
        assert(conv.kind === "group" && !fixedPublicThread(conv), 404, "conversation_not_found", "no such group conversation");
      }
      const ordinaryDm = ordinaryDirect(conv);
      if (directRequest) {
        if (b.workspace !== undefined) workspaceConversation(ot, b.workspace, conv.id, me.ownerId);
        assert(directAgentPeer(ot, conv, me.ownerId), 404, "conversation_not_found", "no such direct conversation");
        requireDirectReach(ot, conv, me.ownerId);
      }
      if (clientKey) {
        const previous = ot.get<any>(
          "SELECT * FROM ot_messages WHERE conversation_id=? AND author_id=? AND client_key=?", conv.id, me.ownerId, clientKey,
        );
        if (previous) {
          if (ordinaryDm) {
            const requested = ot.get<{request_hash: string}>("SELECT request_hash FROM ot_direct_agent_message_requests WHERE message_id=?", previous.id);
            assert((requested?.request_hash ?? null) === directRequest, 409,
              "direct_agent_request_conflict", "这次发送已用于不同的私聊智能体请求。");
          }
          const requested = ot.get<{request_hash: string}>("SELECT request_hash FROM ot_group_agent_message_requests WHERE message_id=?", previous.id);
          assert((requested?.request_hash ?? null) === groupRequest, 409,
            "group_agent_request_conflict", "这次发送已用于不同的智能体请求。");
          const prior = ot.get<{request_hash: string}>("SELECT request_hash FROM ot_studio_message_references WHERE message_id=?", previous.id);
          assert(prior?.request_hash === studio?.fingerprint, 409, "studio_reference_changed", "这次发送已用于不同的消息。");
          if (nativeRound) assert(ot.get("SELECT 1 FROM ot_native_group_rounds WHERE message_id=?", previous.id),
            409, "native_round_conflict", "This message was sent through a different reply route");
          return previous;
        }
      }
      if (fixedPublicThread(conv)) {
        const listing = publicListing(ot, conv);
        assert(listing?.listed && listing.chat_enabled, 409, "public_chat_closed", "公开智能体已关闭访客聊天。");
        assert(!sourceConversation && b.attachment === undefined && b.voice === undefined,
          400, "invalid_request", "访客聊天支持文字消息。");
        if (me.ownerId === conv.created_by) {
          const sent = ot.get<{n: number}>(`SELECT COUNT(*) AS n FROM ot_messages
            WHERE conversation_id=? AND author_id=? AND author_kind='member' AND created_at>?`, conv.id, me.ownerId, ot.now() - HOUR)!.n;
          assert(sent < MENTION_PER_HOUR, 429, "agent_reply_limit", "本会话发送频率已达上限，请稍后重试。");
        }
      }
      if (!directRequest) requireDirectReach(ot, conv, me.ownerId);
      const voice = b.voice === undefined ? null : voiceData(b.voice);
      let file = b.attachment === undefined ? null : decodeChatFile(b.attachment);
      if (sourceConversation && sourceMessage) {
        if (direct) accountConversation(ot, sourceConversation, me.ownerId);
        else workspaceConversation(ot, workspace, sourceConversation, me.ownerId);
        requireVisibleMessage(ot, sourceMessage, me.ownerId);
        file = readAttachment(ot, sourceConversation, sourceMessage);
      }
      const bodyText = text(b.body || file?.title || (voice ? "语音消息" : b.body), "body", {min: 1, max: BODY_MAX, multiline: true});
      const quote = replyTo ? replyOriginal(ot, conv.id, replyTo, me.ownerId) : undefined;
      if (replyTo) assert(quote, 409, "reply_unavailable", "原消息已不可回复，请取消引用。");
      const scope = directRequest ? "direct" : groupRequest ? "group" : undefined;
      const roster = ordinaryDm && scope !== "direct" ? [] : conversationAgents(ot, conv.id);
      const selected = Array.isArray(b.agent_mentions) && b.agent_mentions.length === 0 ? undefined : b.agent_mentions;
      const group = ordinaryAgentGroup(conv);
      const hasCaption = typeof b.body === "string" && b.body.trim().length > 0;
      const captionCanMentionAgents = Boolean(group && file && !file.resource && !file.sticker && !sourceConversation && hasCaption);
      if (file && selected !== undefined) {
        assert(captionCanMentionAgents, 400, "invalid_request", "An attachment can request group agents only through its caption");
      }
      const addressText = conv.kind === "group" ? mentionText(file && !hasCaption ? "" : bodyText) : bodyText;
      const parsed = parseMentions(ot, conv, b.mentions, bodyText, addressText, selected, roster, scope, Boolean(studio));
      const nativeHost = nativeRound ? nativeGroupHost(ot, conv, roster) : undefined;
      assert(!nativeRound || nativeHost, 409, "native_round_unavailable", "This conversation is unavailable for a native group round");
      if (nativeHost && file) assert(captionCanMentionAgents && file.mime.startsWith("image/") &&
        nativeGroupImages(ot, conv, nativeHost, roster),
        409, "native_round_unavailable", "This group does not support native image rounds");
      const canQueueGroup = group && !voice && !sourceConversation && (!file || captionCanMentionAgents);
      const allPeople = group && !sourceConversation && ALL_PEOPLE_ADDRESS.test(addressText);
      const policy = groupReplyPolicyForRoster(conv, roster);
      const addressed = selected !== undefined || parsed.agents.length > 0 ||
        parsed.mentions.length > 0 || parsed.named || TYPED_ADDRESS.test(addressText);
      const explicitlyAll = canQueueGroup && !studio && (allPeople || ALL_AGENT_ADDRESS.test(addressText));
      const unaddressed = canQueueGroup && !file && !studio && !addressed && !explicitlyAll
        ? unaddressedGroupTurn(roster, quote, policy) : undefined;
      const targets = explicitlyAll ? nativeRoomOpeningOrder(roster, policy) : unaddressed?.agents ?? parsed.agents;
      const suppressed = canQueueGroup && !file && targets.length === 0 &&
        (parsed.named || policy.mode !== "default" || quote?.author_kind === "agent");
      if (studio) requireStudioMessageScope(ot, conv, studio, parsed.agents);
      const mentions = parsed.mentions;
      const m = insertMessage(ot, conv, { author: me.ownerId, kind: "member", body: parsed.body, mentions, replyTo, clientKey });
      if (nativeHost) {
        const picked = selected === undefined ? [] : parsed.agents.map(agent => ({owner_id:agent.owner_id, agent_id:agent.agent_ref}));
        const restricted = Boolean(conv.team_id) || groupHasOtherMember(ot, conv, nativeHost);
        ot.run("INSERT INTO ot_native_group_rounds(message_id,conversation_id,owner_id,body,agent_mentions,text_only) VALUES(?,?,?,?,?,?)",
          m.id, conv.id, nativeHost, bodyText, JSON.stringify(picked), Number(restricted));
        wakeOwners.add(nativeHost);
      }
      if (groupRequest) ot.run("INSERT INTO ot_group_agent_message_requests VALUES (?,?)", m.id, groupRequest);
      if (directRequest) ot.run("INSERT INTO ot_direct_agent_message_requests VALUES (?,?,?)", m.id, directRequest, quote?.revision ?? null);
      if (suppressed || nativeRound) ot.run("INSERT INTO ot_group_reply_suppressions(message_id) VALUES (?)", m.id);
      if (studio) ot.run("INSERT INTO ot_studio_message_references VALUES (?,?,?,?)",
        m.id, studio.document_id, studio.revision, studio.fingerprint);
      if (voice) ot.run("INSERT INTO ot_voice_messages VALUES (?,?,?)", m.id, voice.mime, voice.data);
      if (file) {
        saveAttachment(ot, m.id, me.ownerId, file);
        if (file.resource && !sourceConversation) {
          const recipients = ot.all<{owner_id: string}>(`SELECT recipient.owner_id FROM ot_conversation_members recipient
            WHERE recipient.conversation_id=? AND recipient.owner_id<>? AND (? IS NULL OR EXISTS (
              SELECT 1 FROM ot_team_members teammate WHERE teammate.team_id=?
                AND teammate.owner_id=recipient.owner_id AND teammate.suspended=0))`, conv.id, me.ownerId, conv.team_id, conv.team_id);
          const notice = {conversation_id: conv.id, message_id: m.id, title: file.resource.title,
            actor_username: me.displayName, ...(conv.team_id ? {team_id: conv.team_id} : {})};
          for (const recipient of recipients) ot.notify(recipient.owner_id, "artifact.shared", notice);
        }
      }
      if (!nativeRound && (directRequest || canQueueGroup)) {
        for (const agent of targets) {
          ot.run(`INSERT INTO ot_agent_reply_jobs(id,message_id,owner_id,agent_ref,agent_name,status,updated_at,direct_grant_id,discretionary)
            VALUES (?,?,?,?,?,'queued',?,?,?)`, newId("otj"), m.id, agent.owner_id, agent.agent_ref, agent.name, ot.now(), agent.direct_grant_id,
          Number(unaddressed?.discretionary === true));
          wakeOwners.add(agent.owner_id);
        }
      }
      if (!nativeRound && !voice && !file && !groupRequest && !studio && !suppressed &&
          (fixedPublicThread(conv) || (!addressed && targets.length === 0))) {
        for (const {owner_id} of legacyWakeOwners(conv, m.seq)) wakeOwners.add(owner_id);
      }
      if (allPeople || mentions.length) {
        const handles = new Set(mentions);
        const recipients = ot.all<{owner_id: string; handle: string}>(`SELECT seat.owner_id,profile.handle FROM ot_conversation_members seat
          JOIN ot_profiles profile ON profile.owner_id=seat.owner_id WHERE seat.conversation_id=? AND seat.owner_id<>?
          AND (? IS NULL OR EXISTS (SELECT 1 FROM ot_team_members team WHERE team.team_id=?
            AND team.owner_id=seat.owner_id AND team.suspended=0))`, conv.id, me.ownerId, conv.team_id, conv.team_id);
        const by = ot.profileView(me.ownerId);
        for (const recipient of recipients) if (allPeople || handles.has(recipient.handle)) {
          ot.notify(recipient.owner_id, "messenger.mention", {conversation_id: conv.id, message_id: m.id, by});
        }
      }
      return m;
    });
    for (const owner of wakeOwners) inboxWake.notify(owner);
    return reply.status(201).send(messageView(ot, msg, me.ownerId));
  });
  app.post("/v1/ot/conversations/:id/forward", async (req, reply) => {
    const me = ot.me(req);
    const input = body(req);
    const sourceId = params(req).id;
    const targetId = text(input.target_conversation_id, "target_conversation_id", {min: 1, max: 80});
    const workspace = optText(input.workspace, "workspace", {min: 32, max: 32});
    const key = optText(input.request_key, "request_key", {min: 1, max: 80});
    assert(sourceId !== targetId, 400, "invalid_request", "请选择另一个会话。");
    assert(Array.isArray(input.message_ids) && input.message_ids.length > 0 && input.message_ids.length <= 20,
      400, "invalid_request", "请选择 1–20 条消息。");
    const ids = Array.from(new Set<string>(input.message_ids.map((id: unknown) => text(id, "message_id", {min: 1, max: 80})))).sort();
    const fingerprint = createHash("sha256").update(JSON.stringify([sourceId, targetId, workspace, ids])).digest("hex");
    const result = ot.tx(() => {
      const scoped = (id: string) => workspace ? workspaceConversation(ot, workspace, id, me.ownerId).conv
        : accountConversation(ot, id, me.ownerId);
      const source = scoped(sourceId), target = scoped(targetId);
      requireOrdinaryGroup(source);
      requireOrdinaryGroup(target);
      const prior = key && ot.get<{fingerprint: string; forwarded: number}>(
        "SELECT fingerprint,forwarded FROM ot_forward_requests WHERE owner_id=? AND request_key=?", me.ownerId, key);
      if (prior) {
        assert(prior.fingerprint === fingerprint, 409, "conflict", "此转发请求已用于另一批消息。");
        return {forwarded: prior.forwarded, target_conversation_id: target.id};
      }
      requireDirectReach(ot, target, me.ownerId);
      const originals = ot.all<any>(`SELECT m.* FROM ot_messages m WHERE m.conversation_id=? AND m.retracted=0
        AND ${VISIBLE_MESSAGE} AND m.id IN (${ids.map(() => "?").join(",")}) ORDER BY m.seq`, source.id, me.ownerId, ...ids);
      assert(originals.length === ids.length, 409, "forward_unavailable", "所选消息中有内容已不可转发，请重新选择。");
      for (const original of originals) {
        const author = original.forwarded_author || (original.author_kind === "agent"
          ? original.agent_name : ot.profileView(original.author_id).display_name);
        const copied = insertMessage(ot, target, {author: me.ownerId, kind: "member", body: original.body,
          mentions: [], forwardedAuthor: author || "成员"});
        target.last_seq = copied.seq;
        ot.run("INSERT INTO ot_voice_messages SELECT ?,mime,data FROM ot_voice_messages WHERE message_id=?", copied.id, original.id);
        if (attachmentView(ot, original.id)) {
          saveAttachment(ot, copied.id, me.ownerId, readAttachment(ot, source.id, original.id));
        }
      }
      if (key) ot.run("INSERT INTO ot_forward_requests VALUES (?,?,?,?,?)", me.ownerId, key, fingerprint, target.id, originals.length);
      return {forwarded: originals.length, target_conversation_id: target.id};
    });
    return reply.status(201).send(result);
  });
  const listAttachments = async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header("cache-control", "private, no-store");
    const me = ot.me(req);
    const {workspace, id} = params(req);
    const conv = workspace ? workspaceConversation(ot, workspace, id, me.ownerId).conv : memberOf(ot, id, me.ownerId);
    const q = query(req);
    assert(Object.keys(q).every(key => ["kind", "q", "cursor", "limit"].includes(key)),
      400, "invalid_request", "Unknown attachment search parameter");
    assert(q.kind === "photo" || q.kind === "file" || q.kind === "resource",
      400, "invalid_request", "Choose photo, file or resource attachments");
    const term = q.q === undefined ? "" : text(q.q, "q", {max: 80, multiline: true}).trim().toLowerCase();
    const rawLimit = q.limit ?? "20";
    const limit = Number(rawLimit);
    assert(typeof rawLimit === "string" && /^[0-9]{1,2}$/.test(rawLimit) && limit >= 1 && limit <= 50,
      400, "invalid_request", "Attachment search limit must be 1–50");
    const before = q.cursor === undefined ? Number.MAX_SAFE_INTEGER : Number(q.cursor);
    assert(q.cursor === undefined || (typeof q.cursor === "string" && /^[1-9][0-9]{0,15}$/.test(q.cursor) && Number.isSafeInteger(before)),
      400, "invalid_request", "Invalid attachment cursor");
    if (fixedPublicThread(conv)) {
      assert(!workspace, 404, "conversation_not_found", "no such conversation in this workspace");
      // Published agent conversations support text only.
      return {items: [], next_cursor: null};
    }
    assert(workspace || ordinaryDirect(conv) || conv.account_group === 1,
      404, "conversation_not_found", "no such personal conversation");
    const typeFilter = q.kind === "resource" ? "a.resource IS NOT NULL"
      : q.kind === "photo" ? "a.mime LIKE 'image/%'" : "a.mime NOT LIKE 'image/%'";
    const title = q.kind === "resource" ? "json_extract(a.resource, '$.title')" : "a.title";
    const rows = ot.all<ChatFileMetadata & {message_id: string; created_at: number; seq: number}>(`
      SELECT m.id AS message_id, m.created_at, m.seq, a.title, a.mime, a.bytes, a.resource, a.sticker
      FROM ot_messages m JOIN ot_message_attachments a ON a.message_id=m.id
      WHERE m.conversation_id=? AND m.seq<? AND m.retracted=0 AND ${VISIBLE_MESSAGE}
        AND ${typeFilter} AND (?='' OR ot_attachment_title_matches(${title}, ?))
      ORDER BY m.seq DESC LIMIT ?`, conv.id, before, me.ownerId, term, term, limit + 1);
    return {
      items: rows.slice(0, limit).map(row => ({
        message_id: row.message_id, created_at: row.created_at, attachment: chatFileView(row),
      })),
      next_cursor: rows.length > limit ? String(rows[limit - 1].seq) : null,
    };
  };
  app.get("/v1/ot/workspaces/:workspace/conversations/:id/attachments", listAttachments);
  app.get("/v1/ot/conversations/:id/attachments", listAttachments);
  app.get("/v1/ot/workspaces/:workspace/conversations/:id/messages/:message/file", async req => {
    const me = ot.me(req);
    const {workspace, id, message} = params(req);
    const {conv} = workspaceConversation(ot, workspace, id, me.ownerId);
    requireVisibleMessage(ot, message, me.ownerId);
    const file = readAttachment(ot, conv.id, message);
    return {title: file.title, mime: file.mime, data: file.data.toString("base64")};
  });
  app.get("/v1/ot/conversations/:id/messages/:message/file", async req => {
    const me = ot.me(req);
    const {id, message} = params(req);
    const conv = accountConversation(ot, id, me.ownerId);
    requireVisibleMessage(ot, message, me.ownerId);
    const file = readAttachment(ot, conv.id, message);
    return {title: file.title, mime: file.mime, data: file.data.toString("base64")};
  });
  app.get("/v1/ot/conversations/:id/messages/:message/voice", async req => {
    const me = ot.me(req);
    const conv = memberOf(ot, params(req).id, me.ownerId);
    requireVisibleMessage(ot, params(req).message, me.ownerId);
    const voice = ot.get<{mime: string; data: Buffer}>(`SELECT v.mime,v.data FROM ot_voice_messages v
      JOIN ot_messages m ON m.id=v.message_id WHERE m.id=? AND m.conversation_id=? AND m.retracted=0`,
    params(req).message, conv.id);
    assert(voice, 404, "message_not_found", "Voice message not found");
    return {mime: voice.mime, data: voice.data.toString("base64")};
  });
  app.post("/v1/ot/conversations/:id/read", async (req) => {
    const me = ot.me(req);
    const conv = memberOf(ot, params(req).id, me.ownerId);
    const seq = body(req).seq === undefined ? conv.last_seq : Number(body(req).seq);
    assert(Number.isSafeInteger(seq) && seq >= 0, 400, "invalid_request", "seq must be a sequence number");
    ot.run("UPDATE ot_conversation_members SET read_seq = MAX(read_seq, ?) WHERE conversation_id = ? AND owner_id = ?", Math.min(seq, conv.last_seq), conv.id, me.ownerId);
    const readSeq = ot.get<any>("SELECT read_seq FROM ot_conversation_members WHERE conversation_id = ? AND owner_id = ?", conv.id, me.ownerId).read_seq;
    return { read_seq: readSeq, unread: unreadMessages(ot, conv, me.ownerId, readSeq) };
  });
  const ownMessage = (id: string, ownerId: string, includeHidden = false) => {
    const m = ot.get<any>("SELECT * FROM ot_messages WHERE id = ?", id);
    assert(m, 404, "message_not_found", "no such message");
    memberOf(ot, m.conversation_id, ownerId);
    if (!includeHidden) requireVisibleMessage(ot, id, ownerId);
    return m;
  };
  const hideMessageFor = (owner: string, conversation: string, message: {id: string; seq: number}) =>
    ot.run("INSERT OR IGNORE INTO ot_hidden_messages(owner_id,conversation_id,message_id,seq) VALUES (?,?,?,?)",
      owner, conversation, message.id, message.seq);
  app.post("/v1/ot/messages/:id/hide", async req => {
    const me = ot.me(req);
    const m = ownMessage(params(req).id, me.ownerId, true);
    assert(body(req).conversation_id === m.conversation_id, 404, "message_not_found", "Message not in this conversation");
    hideMessageFor(me.ownerId, m.conversation_id, m);
    return {hidden: true};
  });
  app.post("/v1/ot/conversations/:id/messages/hide", async req => {
    const me = ot.me(req);
    const {id} = params(req);
    const input = body(req);
    const ids = input.message_ids;
    assert(Array.isArray(ids) && ids.length > 0 && ids.length <= 20 && new Set(ids).size === ids.length &&
      ids.every(value => typeof value === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(value)),
    400, "invalid_request", "请选择 1–20 条有效消息。");
    return ot.tx(() => {
      const conv = input.direct === true ? accountConversation(ot, id, me.ownerId)
        : workspaceConversation(ot, text(input.workspace, "workspace", {min: 32, max: 32}), id, me.ownerId).conv;
      assert(!fixedPublicThread(conv), 404, "conversation_not_found", "No such conversation");
      const rows = ot.all<{id: string; seq: number}>(`SELECT id,seq FROM ot_messages WHERE conversation_id=?
        AND id IN (${ids.map(() => "?").join(",")})`, conv.id, ...ids);
      assert(rows.length === ids.length, 404, "message_not_found", "部分消息不在此会话中。");
      for (const row of rows) hideMessageFor(me.ownerId, conv.id, row);
      return {hidden_message_ids: ids};
    });
  });
  app.get("/v1/ot/messages/:id", async req => {
    const me=ot.me(req), m=ownMessage(params(req).id,me.ownerId), cid=query(req).conversation_id;
    assert(cid === undefined || cid === m.conversation_id,404,"message_not_found","message not in conversation");
    return messageView(ot,m,me.ownerId);
  });
  app.patch("/v1/ot/messages/:id", async (req) => {
    const me = ot.me(req);
    const m = ownMessage(params(req).id, me.ownerId);
    assert(m.author_id === me.ownerId && m.author_kind === "member" && !m.retracted, 403, "forbidden", "you can edit your own messages only");
    ot.run("UPDATE ot_messages SET body = ?, revision = revision + 1, edited_at = ? WHERE id = ?", text(body(req).body, "body", { min: 1, max: BODY_MAX, multiline: true }), ot.now(), m.id);
    return messageView(ot, ot.get("SELECT * FROM ot_messages WHERE id = ?", m.id), me.ownerId);
  });
  app.delete("/v1/ot/messages/:id", async (req) => {
    const me = ot.me(req);
    const m = ownMessage(params(req).id, me.ownerId);
    assert(m.author_id === me.ownerId, 403, "forbidden", "you can retract your own messages (or your agents') only");
    ot.tx(() => {
      ot.run("UPDATE ot_messages SET retracted = 1, revision = revision + 1, body = '', edited_at = ? WHERE id = ?", ot.now(), m.id);
      ot.run("DELETE FROM ot_message_attachments WHERE message_id=?", m.id);
    });
    return { retracted: true };
  });
  app.post("/v1/ot/messages/:id/reactions", async (req) => {
    const me = ot.me(req);
    const m = ownMessage(params(req).id, me.ownerId);
    const b = body(req);
    assert(REACTIONS.includes(b.emoji), 400, "invalid_request", `emoji must be one of ${REACTIONS.join(" ")}`);
    if (b.on === false) ot.run("DELETE FROM ot_reactions WHERE message_id = ? AND owner_id = ? AND emoji = ?", m.id, me.ownerId, b.emoji);
    else ot.run("INSERT OR IGNORE INTO ot_reactions(message_id, owner_id, emoji, created_at) VALUES (?,?,?,?)", m.id, me.ownerId, b.emoji, ot.now());
    return messageView(ot, m, me.ownerId);
  });
  app.post("/v1/ot/messages/:id/pin", async (req) => {
    const me = ot.me(req);
    const m = ownMessage(params(req).id, me.ownerId);
    ot.run("UPDATE ot_messages SET pinned_by = ? WHERE id = ?", body(req).on === false ? null : me.ownerId, m.id);
    const updated = ot.get("SELECT * FROM ot_messages WHERE id = ?", m.id);
    return { ...messageView(ot, updated, me.ownerId), pinned_messages: pinnedMessages(ot, m.conversation_id, me.ownerId) };
  });

  // ---- conversation agents (executed in their owner's DS-Bot)
  app.put("/v1/ot/conversations/:id/agents/:agent", async (req) => {
    const me = ot.me(req);
    const conv = memberOf(ot, params(req).id, me.ownerId);
    requireOrdinaryGroup(conv);
    const ref = params(req).agent;
    assert(AGENT_REF.test(ref), 400, "invalid_request", "agent id is invalid");
    const b = body(req);
    const name = text(b.name, "name", { min: 1, max: 40 });
    if (ordinaryDirect(conv)) {
      assert(Object.keys(b).every(key => ["name", "auto_reply", "workspace"].includes(key))
        && (b.auto_reply === undefined || b.auto_reply === false), 400, "invalid_request", "私聊智能体只响应明确请求。");
      return ot.tx(() => {
        if (b.workspace !== undefined) workspaceConversation(ot, b.workspace, conv.id, me.ownerId);
        assert(directAgentPeer(ot, conv, me.ownerId), 404, "conversation_not_found", "no such direct conversation");
        requireDirectReach(ot, conv, me.ownerId);
        grantDirectAgent(ot,conv.id,me.ownerId,ref,name);
        return conversationView(ot, memberOf(ot,conv.id,me.ownerId), me.ownerId);
      });
    }
    assert(conv.kind === "group", 400, "invalid_request", "agents join groups only");
    return ot.tx(() => {
      ot.run(`INSERT INTO ot_conversation_agents(conversation_id, agent_ref, owner_id, name, auto_reply, auto_reply_after_seq, created_at)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(conversation_id, agent_ref, owner_id) DO UPDATE SET
          name=excluded.name, auto_reply=excluded.auto_reply,
          auto_reply_after_seq=CASE WHEN ot_conversation_agents.auto_reply=0 AND excluded.auto_reply=1
            THEN excluded.auto_reply_after_seq ELSE ot_conversation_agents.auto_reply_after_seq END`,
      conv.id, ref, me.ownerId, name, b.auto_reply === true ? 1 : 0, conv.last_seq, ot.now());
      if (conv.group_auto_lead === 1) refreshAutomaticGroupLead(ot,conv,conversationAgents(ot,conv.id));
      return conversationView(ot, memberOf(ot,conv.id,me.ownerId), me.ownerId);
    });
  });
  app.patch("/v1/ot/conversations/:id/agents/:agent", async (req) => {
    const me = ot.me(req);
    const conv = memberOf(ot, params(req).id, me.ownerId);
    requireOrdinaryGroup(conv);
    assert(conv.kind === "group", 400, "invalid_request", "agents join groups only");
    const enabled = body(req).auto_reply;
    assert(typeof enabled === "boolean", 400, "invalid_request", "auto_reply must be a boolean");
    const result = ot.run(`UPDATE ot_conversation_agents SET
      auto_reply_after_seq=CASE WHEN auto_reply=0 AND ?=1 THEN ? ELSE auto_reply_after_seq END,
      auto_reply=? WHERE conversation_id=? AND agent_ref=? AND owner_id=?`,
    Number(enabled), conv.last_seq, Number(enabled), conv.id, params(req).agent, me.ownerId);
    assert(result.changes === 1, 404, "agent_not_found", "that agent of yours is not in this group");
    return { auto_reply: enabled };
  });
  app.delete("/v1/ot/conversations/:id/agents/:agent", async (req) => {
    const me = ot.me(req);
    const conv = memberOf(ot, params(req).id, me.ownerId);
    requireOrdinaryGroup(conv);
    if (ordinaryDirect(conv)) {
      const peer = directAgentPeer(ot, conv, me.ownerId);
      assert(peer, 404, "conversation_not_found", "no such direct conversation");
      const input = query(req);
      assert(Object.keys(input).every(key => ["owner_id", "workspace"].includes(key)), 400, "invalid_request", "Invalid agent removal");
      const owner = input.owner_id ?? me.ownerId;
      assert(owner === me.ownerId || owner === peer, 404, "agent_not_found", "找不到这个私聊智能体。");
      return ot.tx(() => {
        if (input.workspace !== undefined) workspaceConversation(ot, text(input.workspace,"workspace",{min:32,max:32}), conv.id, me.ownerId);
        removeDirectAgent(ot,conv.id,owner,params(req).agent);
        return conversationView(ot, memberOf(ot,conv.id,me.ownerId), me.ownerId);
      });
    }
    return ot.tx(() => {
      ot.run("DELETE FROM ot_conversation_agents WHERE conversation_id = ? AND agent_ref = ? AND owner_id = ?", conv.id, params(req).agent, me.ownerId);
      if (conv.group_auto_lead === 1) refreshAutomaticGroupLead(ot,conv,conversationAgents(ot,conv.id));
      return conversationView(ot, memberOf(ot,conv.id,me.ownerId), me.ownerId);
    });
  });
  app.post("/v1/ot/conversations/:id/messages/:message/agent-retry", async req => {
    const me = ot.me(req);
    const {id, message} = params(req);
    const b = body(req);
    const jobId = text(b.job_id, "job_id", {min: 1, max: 80});
    const attempt = b.attempt;
    assert(attempt === undefined || (Number.isSafeInteger(attempt) && attempt > 0),
      400, "invalid_request", "Invalid reply job attempt");
    const {result, owner} = ot.tx(() => {
      const conv = b.workspace === undefined ? memberOf(ot, id, me.ownerId)
        : workspaceConversation(ot, b.workspace, id, me.ownerId).conv;
      if (conv.team_id) requireMember(ot, conv.team_id, me.ownerId);
      const original = ot.get<any>(`SELECT * FROM ot_messages WHERE id=? AND conversation_id=? AND author_id=?
        AND author_kind='member' AND retracted=0`, message, id, me.ownerId);
      assert(original, 404, "message_not_found", "原消息已不可回复。");
      const job = ot.get<ReplyJob>(REPLY_JOB_SOURCE + " WHERE j.id=? AND j.message_id=?", jobId, message);
      assert(job, 404, "reply_job_not_found", "找不到这次回复。");
      assert(job.studio_available, 409, "studio_reference_unavailable", "原团队文档版本已不可用，请重新选择后发送。");
      const now = ot.now();
      assert((attempt === undefined || job.attempt === attempt) && job.available
        && replyJobState(job, now) === "failed" && job.attempt < REPLY_JOB_ATTEMPTS,
        409, "reply_job_unavailable", "当前无法重试这次回复。");
      ot.run(`UPDATE ot_agent_reply_jobs SET status='queued',attempt=attempt+1,updated_at=?,source_revision=NULL,
        progress_revision=0,claim_id=NULL,lease_expires_at=NULL WHERE id=?`, now, job.id);
      replyProgress.delete(job.id);
      return {result: {reply_jobs: replyJobViews(ot, original, me.ownerId)}, owner: job.owner_id};
    });
    inboxWake.notify(owner);
    return result;
  });

  app.post("/v1/ot/agent-reply-jobs/:id", async (req, reply) => {
    reply.header("cache-control", "private, no-store");
    const me = ot.me(req);
    const b = body(req);
    assert(b.action === "start" || b.action === "fail" || b.action === "pass" || b.action === "keepalive",
      400, "invalid_request", "Invalid reply job action");
    if (b.action === "pass") {
      assert(Object.keys(b).every(key => ["action", "attempt", "claim_id"].includes(key)),
        400, "invalid_request", "Unexpected fields on a silent completion");
    }
    if (b.action === "keepalive") {
      assert(Object.keys(b).every(key => ["action", "attempt", "claim_token"].includes(key))
        && Number.isSafeInteger(b.attempt) && b.attempt > 0 && typeof b.claim_token === "string",
      400, "invalid_request", "Invalid reply job keepalive");
    }
    const claim = replyClaimId(b.action === "keepalive" ? b.claim_token : b.claim_id);
    let releasedMessage: string | undefined;
    const receipt = ot.tx(() => {
      const job = ot.get<ReplyJob>(REPLY_JOB_SOURCE + " WHERE j.id=? AND j.owner_id=?", params(req).id, me.ownerId);
      assert(job, 404, "reply_job_not_found", "找不到这次回复。");
      assert(job.attempt === b.attempt, 409, "reply_job_unavailable", "这次回复的状态已更新。");
      const now = ot.now(), state = replyJobState(job, now);
      if (b.action === "keepalive") {
        assert(state === "running" && currentRunningClaim(job, claim),
          409, "reply_job_unavailable", "这次回复的状态已更新。");
        const expires = Math.max(runningReplyExpiry(job), now + REPLY_JOB_LEASE_MS);
        ot.run("UPDATE ot_agent_reply_jobs SET lease_expires_at=? WHERE id=?", expires, job.id);
        const snapshot = replyProgress.get(job.id);
        if (snapshot?.attempt === job.attempt) snapshot.expires = expires;
        return {ok: true};
      }
      if (b.action === "start") {
        assert(b.source_revision === undefined || b.source_revision === job.current_revision,
          409, "reply_job_unavailable", "原消息已更新。");
        if (job.discretionary) {
          assert(b.accept_discretionary_reply === true && claim !== null && b.source_revision === job.current_revision,
            409, "reply_job_unavailable", "当前智能体暂时无法判断是否回复群聊消息。");
        }
        if (job.group_text_only) {
          assert(b.accept_group_text_turn === true && claim !== null && b.source_revision === job.current_revision,
            409, "reply_job_unavailable", "当前智能体暂时无法安全处理队友请求。");
        }
        if (job.direct_grant_id) {
          assert(b.accept_direct_text_turn === true && claim !== null && b.source_revision === job.current_revision,
            409, "reply_job_unavailable", "当前智能体暂时无法安全处理私聊请求。");
        }
        if (job.studio_document_id) {
          assert(b.accept_studio_reference === true && claim !== null,
            409, "reply_job_unavailable", "当前智能体暂时无法读取团队文档引用。");
          if (!job.studio_available && (state === "queued" || (job.claim_id === claim && job.status !== "replied"))) {
            if (job.status !== "failed") {
              ot.run("UPDATE ot_agent_reply_jobs SET status='failed',updated_at=?,claim_id=?,lease_expires_at=NULL WHERE id=?",
                now, claim, job.id);
            }
            replyProgress.delete(job.id);
            return {ok: true, studio_reference_unavailable: true};
          }
        }
        if (state === "running" && claim !== null && job.claim_id === claim) return replyClaimReceipt(ot, job);
        assert(state === "queued", 409, "reply_job_unavailable", "这次回复的状态已更新。");
        if (job.discretionary) {
          const ready = ot.get<{ready_at: number}>(`SELECT ${discretionaryReadyAt("?")} AS ready_at
            FROM ot_agent_reply_jobs j WHERE j.id=?`, now, job.id);
          assert(ready && ready.ready_at <= now, 409, "reply_job_unavailable", "请等候同一条消息的上一位智能体。");
        }
        ot.run(`UPDATE ot_agent_reply_jobs SET status='running',updated_at=?,source_revision=?,claim_id=?,lease_expires_at=?
          WHERE id=?`, now, job.current_revision, claim, now + REPLY_JOB_LEASE_MS, job.id);
      } else if (b.action === "pass") {
        const alreadyPassed = state === "passed" && job.available && claim !== null && job.claim_id === claim
          && job.source_revision === job.current_revision;
        assert(!job.direct_grant_id && !job.studio_document_id && (currentRunningClaim(job, claim) || alreadyPassed),
        409, "reply_job_unavailable", "这次回复的状态已更新。");
        if (state === "passed") return {ok: true};
        ot.run("UPDATE ot_agent_reply_jobs SET status='replied',passed=1,updated_at=?,lease_expires_at=NULL WHERE id=?", now, job.id);
      } else {
        // The native turn can end while delivery is offline. Allow that exact
        // claim to settle after expiry unless the sender has already retried.
        const sameFailure = job.status === "failed" && claim !== null && job.claim_id === claim
          && job.available && job.studio_available && job.source_revision === job.current_revision;
        assert(sameFailure || currentRunningClaim(job, claim) || (state === "running" && job.claim_id === claim),
          409, "reply_job_unavailable", "这次回复的状态已更新。");
        if (sameFailure) return {ok: true};
        ot.run("UPDATE ot_agent_reply_jobs SET status='failed',updated_at=?,lease_expires_at=NULL WHERE id=?", now, job.id);
      }
      replyProgress.delete(job.id);
      if (job.discretionary && b.action !== "start") releasedMessage = job.message_id;
      return b.action === "start" ? replyClaimReceipt(ot, job) : {ok: true};
    });
    if (releasedMessage) wakeDiscretionaryPeers(releasedMessage, me.ownerId);
    return receipt;
  });

  app.post("/v1/ot/agent-reply-jobs/:id/progress", {bodyLimit: 32 * 1024}, async (req, reply) => {
    reply.header("cache-control", "private, no-store");
    const me = ot.me(req);
    const b = body(req);
    assert(Number.isSafeInteger(b.attempt) && b.attempt > 0 && Number.isSafeInteger(b.revision) && b.revision > 0
      && typeof b.text === "string" && b.text.length <= BODY_MAX,
      400, "invalid_request", "Invalid reply progress snapshot");
    const claim = replyClaimId(b.claim_id);
    const job = ot.get<ReplyJob>(REPLY_JOB_SOURCE + " WHERE j.id=? AND j.owner_id=?", params(req).id, me.ownerId);
    assert(job, 404, "reply_job_not_found", "找不到这次回复。");
    const now = ot.now();
    assert(job.attempt === b.attempt && job.claim_id === claim && job.studio_available
      && job.source_revision === job.current_revision && replyJobState(job, now) === "running",
      409, "reply_job_unavailable", "这次回复的状态已更新。");
    const previous = replyProgress.get(job.id);
    assert(b.revision > job.progress_revision, 409, "reply_progress_stale", "这次回复的进度已更新。");
    if (!previous && replyProgress.size >= REPLY_PROGRESS_CAPACITY) {
      for (const [id, snapshot] of replyProgress) {
        if (snapshot.expires <= now) replyProgress.delete(id);
      }
      assert(replyProgress.size < REPLY_PROGRESS_CAPACITY, 429, "reply_progress_busy", "正在显示的回复进度过多。");
    }
    // Keep ordering across Bot Social restarts. Only the revision counter is durable.
    const accepted = ot.run(`UPDATE ot_agent_reply_jobs SET progress_revision=? WHERE id=?
      AND status='running' AND attempt=? AND claim_id IS ? AND progress_revision<?`,
    b.revision, job.id, job.attempt, claim, b.revision);
    assert(accepted.changes === 1, 409, "reply_job_unavailable", "这次回复的状态已更新。");
    replyProgress.set(job.id, {attempt: job.attempt, text: b.text, expires: runningReplyExpiry(job)});
    return {ok: true};
  });

  const listReplyProgress = async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header("cache-control", "private, no-store");
    const me = ot.me(req);
    const {workspace, id} = params(req);
    const conv = workspace ? workspaceConversation(ot, workspace, id, me.ownerId).conv : memberOf(ot, id, me.ownerId);
    const direct = directAgentPeer(ot, conv, me.ownerId);
    const nativeTeam = !workspace && conv.team_id && nativeGroupHost(ot, conv);
    assert(direct || (conv.kind === "group" && !fixedPublicThread(conv) && (workspace || conv.account_group === 1 || nativeTeam)),
      404, "conversation_not_found", "no such group conversation");
    assert(Object.keys(query(req)).length === 0, 400, "invalid_request", "Unexpected reply progress query");
    const now = ot.now();
    const jobs = ot.all<ReplyJob>(REPLY_JOB_SOURCE + ` WHERE src.conversation_id=? AND available AND studio_available
      AND ((j.status='queued' AND j.updated_at>?) OR (j.status='running' AND ${runningReplyExpirySql("j")}>?))
      AND (j.source_revision IS NULL OR j.source_revision=src.revision)
      AND NOT EXISTS (SELECT 1 FROM ot_hidden_messages h WHERE h.owner_id=? AND h.message_id=src.id)
      ORDER BY src.seq DESC,j.rowid DESC LIMIT ?`, conv.id, now - REPLY_JOB_QUEUE_MS, now, me.ownerId, REPLY_PROGRESS_PAGE);
    const native = nativeGroupProgress.get(conv.id);
    if (native && native.expires <= now) nativeGroupProgress.delete(conv.id);
    const remote = ordinaryAgentGroup(conv) ? ot.all<{owner_id:string;agent_ref:string;host_id:string}>(`SELECT t.owner_id,t.agent_ref,r.owner_id AS host_id
      FROM ot_native_group_turns t JOIN ot_native_group_rounds r ON r.message_id=t.message_id
      JOIN ot_messages m ON m.id=r.message_id JOIN ot_conversations c ON c.id=r.conversation_id
      WHERE c.id=? AND r.text_only=1 AND r.state='running' AND t.state='running' AND t.expires_at>?
        AND r.owner_id=COALESCE(c.group_owner_id,c.created_by) AND ${ORIGINAL_NATIVE_SOURCE("m", "c")}
        AND ${ACTIVE_NATIVE_TURN_SEAT("t", "c")} AND NOT EXISTS (SELECT 1 FROM ot_hidden_messages h WHERE h.owner_id=? AND h.message_id=m.id)`, conv.id, now, me.ownerId) : [];
    let working: {id:string; name:string}[] = [];
    let host: string | undefined;
    if ((native && native.expires > now) || remote.length) {
      const roster = conversationAgents(ot, conv.id);
      host = nativeGroupHost(ot, conv, roster);
      const localRefs = native && native.expires > now && native.ownerId === host && ot.get(`SELECT 1 FROM ot_native_group_rounds r
        JOIN ot_messages m ON m.id=r.message_id JOIN ot_conversations c ON c.id=r.conversation_id
        WHERE r.message_id=? AND r.owner_id=? AND c.id=? AND r.state='running' AND ${ORIGINAL_NATIVE_SOURCE("m", "c")}
          AND (r.text_only=1 OR NOT ${REQUIRES_NATIVE_TEXT_ONLY("r", "c")}) AND NOT EXISTS (SELECT 1 FROM ot_hidden_messages h WHERE h.owner_id=? AND h.message_id=m.id)`,
      native.messageId, native.ownerId, conv.id, me.ownerId) ? new Set(native.refs) : new Set<string>();
      const remoteKeys = new Set(remote.filter(turn => turn.host_id === host).map(turn => agentMentionKey(turn.owner_id,turn.agent_ref)));
      working = roster.flatMap(agent => {
        if (agent.owner_id === host) return localRefs.has(agent.agent_ref) ? [{id:agent.agent_ref,name:agent.name}] : [];
        return remoteKeys.has(agentMentionKey(agent.owner_id,agent.agent_ref))
          ? [{id:agent.owner_id + "/" + agent.agent_ref,name:agent.name}] : [];
      });
    }
    return {...(working.length && host ? {working_bots:working, native_group_host:host} : {}), items: jobs.map(job => {
      const snapshot = replyProgress.get(job.id);
      return {id: job.id, message_id: job.message_id, attempt: job.attempt, status: job.status,
        text: job.status === "running" && snapshot?.attempt === job.attempt && snapshot.expires > now ? snapshot.text : ""};
    })};
  };
  app.get("/v1/ot/workspaces/:workspace/conversations/:id/reply-progress", listReplyProgress);
  app.get("/v1/ot/conversations/:id/reply-progress", listReplyProgress);

  app.post("/v1/ot/conversations/:id/memory-sources", async req => {
    const viewer = ot.me(req).ownerId;
    const conv = requireMemoryGroup(ot,params(req).id,viewer);
    const input = body(req);
    if (input.workspace_id === undefined) {
      assert(conv.account_group === 1,404,"not_found","该群聊不在个人工作区。");
    } else {
      const workspace = text(input.workspace_id,"workspace_id",{min:32,max:32});
      assert(workspaceTeam(ot,workspace,viewer).id === conv.team_id,404,"not_found","该群聊不在当前工作区。");
    }
    const membership = ot.get<{since:number}>(`SELECT MAX(member.created_at,COALESCE(team_member.created_at,0)) AS since
      FROM ot_conversation_members member LEFT JOIN ot_team_members team_member ON team_member.team_id=? AND team_member.owner_id=member.owner_id
      WHERE member.conversation_id=? AND member.owner_id=?`,conv.team_id,conv.id,viewer)!.since;
    const readable = `FROM ot_messages m WHERE m.conversation_id=? AND ${VISIBLE_MESSAGE}
      AND m.author_kind='member' AND m.retracted=0 AND trim(m.body)<>''
      AND NOT EXISTS (SELECT 1 FROM ot_message_attachments a WHERE a.message_id=m.id)
      AND NOT EXISTS (SELECT 1 FROM ot_voice_messages v WHERE v.message_id=m.id)`;
    const select = `SELECT m.id,m.seq,m.body,m.revision,m.author_id ${readable}`;
    let rows: {id:string;seq:number;body:string;revision:number;author_id:string}[];
    let cursor = conv.last_seq;
    if (input.after !== undefined) {
      assert(input.message_ids === undefined && Number.isSafeInteger(input.after) && input.after >= 0,
        400,"invalid_request","无效的群记忆游标。");
      rows = ot.all(`${select} AND m.seq>? AND m.created_at>=? ORDER BY m.seq LIMIT 13`,conv.id,viewer,input.after,membership);
      if (rows.length > 12) {
        rows.pop();
        cursor = rows[rows.length - 1].seq;
      }
    } else {
      const ids = input.message_ids;
      assert(Array.isArray(ids) && ids.length<=12 && new Set(ids).size===ids.length &&
        ids.every(id=>typeof id==="string" && /^[A-Za-z0-9._-]{1,80}$/.test(id)),400,"invalid_request","请选择有效的群聊消息。");
      rows = ids.length ? ot.all(`${select} AND m.id IN (${ids.map(()=>"?").join(",")}) ORDER BY m.seq`,conv.id,viewer,...ids) : [];
    }
    return {cursor,membership,items:rows.map(row=>({
      id:row.id,revision:row.revision,title:conv.title,author:ot.profileView(row.author_id).display_name || "群成员",text:row.body,
    }))};
  });

  app.get("/v1/ot/conversations/:id/memories", async req => {
    const viewer = ot.me(req).ownerId;
    const conv = requireMemoryGroup(ot,params(req).id,viewer);
    return {items:activeMemories(ot,conv.id).map(row => groupMemoryView(ot,row,conv,viewer))};
  });
  app.post("/v1/ot/conversations/:id/memories", async (req,reply) => {
    const viewer = ot.me(req).ownerId;
    const draft = body(req);
    const title = text(draft.title,"title",{min:1,max:80});
    const content = text(draft.body,"body",{min:1,max:8000,multiline:true});
    const key = text(draft.client_key,"client_key",{min:16,max:80});
    const primary = text(draft.source_message_id,"source_message_id",{min:1,max:80});
    assert(Array.isArray(draft.sources) && draft.sources.length >= 1 && draft.sources.length <= 12,400,"invalid_request","请选择群聊来源。");
    const keys = new Map<string,number>();
    for (const source of draft.sources) {
      const id = text(source?.id,"source_id",{min:1,max:80});
      assert(Number.isSafeInteger(source?.revision) && source.revision > 0 && !keys.has(id),400,"invalid_request","无效的来源版本。");
      keys.set(id,source.revision);
    }
    assert(keys.has(primary),400,"invalid_request","请提供主来源消息。");
    const fingerprint = createHash("sha256").update(JSON.stringify([title,content,primary,[...keys].sort()])).digest("hex");
    const result = ot.tx(() => {
      const conv = requireMemoryGroup(ot,params(req).id,viewer);
      const prior = ot.get<any>("SELECT * FROM ot_group_memories WHERE conversation_id=? AND author_id=? AND client_key=?",conv.id,viewer,key);
      if (prior) {
        assert(prior.fingerprint === fingerprint && ot.get(
          `SELECT 1 FROM ot_group_memories g WHERE g.id=? AND ${ACTIVE_MEMORIES}`, prior.id),
          409,"conflict","这个版本已移除或原消息已更新。");
        return {status:200,item:groupMemoryView(ot,prior,conv,viewer)};
      }
      for (const [id,revision] of keys) {
        const row = ot.get<any>("SELECT revision,author_kind,retracted FROM ot_messages WHERE id=? AND conversation_id=?",id,conv.id);
        requireVisibleMessage(ot,id,viewer);
        assert(row && row.revision===revision && row.author_kind==="member" && !row.retracted,409,"conflict","原消息已更新，请重新提炼。");
      }
      assert(activeMemories(ot,conv.id).length < 40,429,"quota","群记忆已满，请先移除一条旧记忆。");
      const id = newId("otgm");
      ot.run("INSERT INTO ot_group_memories VALUES(?,?,?,?,?,?,?,?,?,0)",id,conv.id,viewer,key,fingerprint,title,content,primary,ot.now());
      for (const [source,revision] of keys) ot.run("INSERT INTO ot_group_memory_sources VALUES(?,?,?)",id,source,revision);
      return {status:201,item:groupMemoryView(ot,ot.get("SELECT * FROM ot_group_memories WHERE id=?",id),conv,viewer)};
    });
    return reply.status(result.status).send({item:result.item});
  });
  app.delete("/v1/ot/conversations/:id/memories/:memory", async req => {
    const viewer = ot.me(req).ownerId;
    const conv = requireMemoryGroup(ot,params(req).id,viewer);
    const row = ot.get<any>("SELECT * FROM ot_group_memories WHERE conversation_id=? AND id=?",conv.id,params(req).memory);
    assert(row && (row.author_id===viewer || groupOwner(conv)===viewer),404,"not_found","无法移除这条群记忆。");
    ot.run("UPDATE ot_group_memories SET removed=1 WHERE id=?",row.id);
    return {removed:true};
  });

  function readAgentInbox(ownerId: string, after: number, limit: number, managed: boolean) {
    const rows = ot.all<any>(`WITH pending AS (
      SELECT m.* FROM ot_messages m JOIN ot_conversations room ON room.id=m.conversation_id
      WHERE m.rowseq > ? AND m.author_kind = 'member' AND m.retracted = 0 AND m.forwarded_author IS NULL AND room.kind='group'
        AND NOT EXISTS (SELECT 1 FROM ot_voice_messages v WHERE v.message_id=m.id)
        AND NOT EXISTS (SELECT 1 FROM ot_message_attachments a WHERE a.message_id=m.id)
        AND NOT EXISTS (SELECT 1 FROM ot_studio_message_references r WHERE r.message_id=m.id)
        AND NOT EXISTS (SELECT 1 FROM ot_group_agent_message_requests r WHERE r.message_id=m.id)
        AND NOT EXISTS (SELECT 1 FROM ot_native_group_rounds r WHERE r.message_id=m.id)
        AND NOT EXISTS (SELECT 1 FROM ot_group_reply_suppressions s WHERE s.message_id=m.id)
        AND EXISTS (SELECT 1 FROM ot_conversation_members cm WHERE cm.conversation_id=m.conversation_id AND cm.owner_id=?)
        AND EXISTS (SELECT 1 FROM ot_conversation_agents ca WHERE ca.conversation_id=m.conversation_id AND ca.owner_id=?)
        AND (room.team_id IS NULL OR EXISTS (SELECT 1 FROM ot_team_members tm
          WHERE tm.team_id=room.team_id AND tm.owner_id=? AND tm.suspended=0))
      ORDER BY m.rowseq LIMIT ?
    )
    SELECT m.*, a.agent_ref AS my_agent, a.name AS my_agent_name, a.auto_reply AS my_auto, a.auto_reply_after_seq AS auto_after_seq,
      EXISTS (SELECT 1 FROM ot_agent_reply_jobs routed WHERE routed.message_id=m.id) AS routed
    FROM pending m JOIN ot_conversation_agents a ON a.conversation_id=m.conversation_id AND a.owner_id=?
    ORDER BY m.rowseq, a.agent_ref`, after, ownerId, ownerId, ownerId, limit * 4, ownerId);
    const roomNotes = new Map<string, {id:string;title:string;body:string}[]>();
    const memories = (cid:string) => {
      if (!roomNotes.has(cid)) {
        let list: {id:string;title:string;body:string}[] = [];
        try {
          requireMemoryGroup(ot,cid,ownerId);
          list = activeMemories(ot,cid).map(({id,title,body})=>({id,title,body:body.slice(0,1500)}));
        } catch { /* Membership may have changed since the agent inbox was assembled. */ }
        roomNotes.set(cid,list);
      }
      return roomNotes.get(cid);
    };
    const now = ot.now();
    const jobs = managed ? ot.all<ReplyJob & {conversation_id: string; conversation_title: string; seq: number}>(
      REPLY_JOB_SOURCE + ` WHERE j.owner_id=? AND j.status='queued' AND j.updated_at>?
        AND available AND ${discretionaryReadyAt("?")}<=? ORDER BY j.updated_at,j.rowid LIMIT ?`,
      ownerId, now - REPLY_JOB_QUEUE_MS, now, now, Math.min(8, limit),
    ).map(job => {
      if (job.direct_grant_id) {
        return {job_id:job.id, attempt:job.attempt, conversation_id:job.conversation_id,
          agent_ref:job.agent_ref, agent_name:job.agent_name, mode:"mention", direct_text_only:true,
          message:{id:job.message_id, revision:job.current_revision}};
      }
      const message = ot.get<any>("SELECT * FROM ot_messages WHERE id=?", job.message_id);
      return {job_id: job.id, attempt: job.attempt, conversation_id: job.conversation_id,
        conversation_title: job.conversation_title, agent_ref: job.agent_ref, agent_name: job.agent_name,
        mode: "mention", ...(job.group_text_only ? {group_text_only: true} : {}),
        ...(job.discretionary ? {discretionary: true} : {}),
        message: {...messageView(ot, message), ...(job.studio_document_id ? {
          studio_reference: {document_id: job.studio_document_id, revision: job.studio_revision},
        } : {})}, context: replyContext(ot, job.conversation_id, job.seq, ownerId), group_memories:memories(job.conversation_id)};
    }) : [];
    let cursor = after;
    const items: any[] = [];
    for (const m of rows) {
      // A cursor acknowledges the entire message, including its other recipients.
      if (items.length >= limit && m.rowseq > cursor) break;
      cursor = Math.max(cursor, m.rowseq);
      const mentions: string[] = JSON.parse(m.mentions);
      const conv = ot.get<any>("SELECT dm_key,title,created_by FROM ot_conversations WHERE id=?", m.conversation_id);
      if (fixedPublicThread(conv)) {
        const listing = publicListing(ot, conv);
        if (!listing?.listed || !listing.chat_enabled || listing.owner_id !== ownerId
          || listing.ref !== m.my_agent || conv.created_by !== m.author_id || m.rowseq <= listing.chat_from
          || m.created_at <= ot.now() - 180_000
          || ot.get(`SELECT 1 FROM ot_messages WHERE conversation_id=? AND reply_to=? AND author_id=? AND agent_ref=?`,
            m.conversation_id, m.id, ownerId, m.my_agent)) continue;
        const context = ot.all<any>(`SELECT * FROM (SELECT * FROM ot_messages WHERE conversation_id=? AND seq<=?
          AND retracted=0 AND author_id IN (?,?) ORDER BY seq DESC LIMIT 12) ORDER BY seq`,
        m.conversation_id, m.seq, conv.created_by, listing.owner_id);
        items.push({ conversation_id: m.conversation_id, conversation_title: listing.title, agent_ref: listing.ref,
          agent_name: listing.title, mode: "public", message: messageView(ot, m), context: context.map(c => messageView(ot, c)),
          published: {title: listing.title, summary: listing.summary, snapshot: listing.snapshot} });
        continue;
      }
      const tracked = ot.get("SELECT 1 FROM ot_agent_reply_jobs WHERE message_id=? AND owner_id=? AND agent_ref=?",
        m.id, ownerId, m.my_agent);
      if (tracked && (managed || m.author_id !== ownerId)) continue;
      const mentioned = agentMentioned(mentions, {owner_id: ownerId, agent_ref: m.my_agent, name: m.my_agent_name});
      if (!mentioned && (!m.my_auto || m.seq <= m.auto_after_seq || m.routed || mentions.length > 0 || TYPED_ADDRESS.test(mentionText(m.body)))) continue;
      items.push({ conversation_id: m.conversation_id, conversation_title: conv.title, agent_ref: m.my_agent, agent_name: m.my_agent_name,
        mode: mentioned ? "mention" : "auto", message: messageView(ot, m), context: replyContext(ot, m.conversation_id, m.seq, ownerId), group_memories:memories(m.conversation_id) });
    }
    return managed ? { cursor, items, jobs } : { cursor, items };
  }

  function nextDiscretionaryWait(ownerId: string, maxWait: number) {
    const now = ot.now();
    const next = ot.get<{ready_at: number | null}>(`SELECT MIN(ready_at) AS ready_at FROM (
      SELECT ${discretionaryReadyAt("?")} AS ready_at FROM (${REPLY_JOB_SOURCE}) j
      WHERE j.owner_id=? AND j.status='queued' AND j.discretionary=1 AND j.updated_at>? AND j.available
    ) ready`, now, ownerId, now - REPLY_JOB_QUEUE_MS)?.ready_at;
    // The deadline can pass between the initial inbox read and this lookup.
    return next == null ? maxWait : Math.max(1, Math.min(maxWait, next - now));
  }

  /** `after` acknowledges legacy messages. Managed jobs are polled by queue state, independent of that cursor. */
  app.get("/v1/ot/agent-inbox", async (req, reply) => {
    reply.header("cache-control", "private, no-store");
    const {ownerId} = ot.me(req);
    const input = query(req);
    const after = intParam(input.after, "after", 0);
    const limit = Math.max(1, intParam(input.limit, "limit", 20, 50));
    const managed = input.managed === "1";
    const wait = one(input.wait_ms, "wait_ms");
    const waitMs = wait === undefined ? 0 : Number(wait);
    assert(wait === undefined || (managed && /^[0-9]{1,5}$/.test(wait) && waitMs <= AGENT_INBOX_MAX_WAIT_MS),
      400, "invalid_request", "Managed agent inbox wait_ms must be 0–10000");
    const current = readAgentInbox(ownerId, after, limit, managed);
    if (!waitMs) return current;
    if (current.items.length || current.jobs?.length || current.cursor > after) {
      return {...current, wake_supported: true};
    }
    // The read and waiter registration are synchronous, so a local transaction
    // cannot commit in between. Re-read SQLite after any signal or timer.
    const waiting = inboxWake.wait(ownerId, nextDiscretionaryWait(ownerId, waitMs), reply.raw);
    if (!waiting) return current;
    await waiting;
    if (reply.raw.destroyed) return current;
    const me = ot.me(req);
    return {...readAgentInbox(me.ownerId, after, limit, managed), wake_supported: true};
  });
  type NativeRound = {message_id:string; conversation_id:string; body:string; seq:number; author_id:string;
    state:"queued"|"running"|"finished"; agent_mentions:string; source_valid:number; text_only:number; requires_text_only:number};
  type NativeTurnOutcome = "message" | "pass" | "failed";
  type NativeTurn = {id:string; message_id:string; owner_id:string; agent_ref:string; call_key:string; prompt:string;
    state:"queued"|"running"|"finished"; outcome:NativeTurnOutcome|null; result_text:string|null; expires_at:number;
    published_message_id:string|null};
  type NativeTurnInbox = NativeTurn & {conversation_id:string; host_id:string};
  const nativeTurnId = /^otnt_[0-9A-HJKMNP-TV-Z]{26}$/;
  const expiredNativeTurn = (row: NativeTurn) => row.state !== "finished" && row.expires_at <= ot.now();
  function nativeTurnView(row: NativeTurn, seatActive = true) {
    const ended = expiredNativeTurn(row) || (row.state !== "finished" && !seatActive);
    const outcome = ended ? "failed" : row.outcome;
    return {id:row.id,owner_id:row.owner_id,agent_ref:row.agent_ref,call_key:row.call_key,
      state:ended ? "finished" as const : row.state,
      ...(outcome ? {result:{outcome,...(outcome === "message" ? {text:row.result_text} : {})}} : {})};
  }
  function findNativeRound(conv: Group, messageId: string, ownerId: string) {
    const round = ot.get<NativeRound>(`SELECT r.*,m.seq,m.author_id,(${ORIGINAL_NATIVE_SOURCE("m", "c")}) AS source_valid,
      ${REQUIRES_NATIVE_TEXT_ONLY("r", "c")} AS requires_text_only FROM ot_native_group_rounds r JOIN ot_messages m ON m.id=r.message_id JOIN ot_conversations c ON c.id=r.conversation_id
      WHERE r.message_id=? AND r.conversation_id=? AND r.owner_id=? AND m.retracted=0`, messageId, conv.id, ownerId);
    assert(groupOwner(conv) === ownerId && round, 404, "native_round_not_found", "Native group round was not found");
    return round;
  }
  function requireNativeRound(conv: Group, round: NativeRound, host: string, roster?: ConversationAgent[]) {
    assert(round.source_valid === 1 && nativeGroupHost(ot, conv, roster) === host &&
      !(round.state === "running" && round.requires_text_only === 1 && round.text_only !== 1),
    409, "native_round_unavailable", "This conversation is unavailable for a native group round");
  }
  function activeNativeTurnSeat(turnId: string, roomId: string) {
    return ot.get(`SELECT 1 FROM ot_native_group_turns t JOIN ot_conversations c ON c.id=?
      WHERE t.id=? AND ${ACTIVE_NATIVE_TURN_SEAT("t", "c")}`, roomId,turnId);
  }
  function readNativeGroupTurns(ownerId: string) {
    const current = (state: "running" | "queued") => ot.all<NativeTurnInbox>(`SELECT t.*,c.id AS conversation_id,r.owner_id AS host_id
      FROM ot_native_group_turns t JOIN ot_native_group_rounds r ON r.message_id=t.message_id
      JOIN ot_messages m ON m.id=r.message_id JOIN ot_conversations c ON c.id=r.conversation_id
      WHERE t.owner_id=? AND t.state=? AND t.expires_at>? AND r.state='running' AND r.text_only=1
        AND c.group_archived_at IS NULL AND r.owner_id=COALESCE(c.group_owner_id,c.created_by) AND ${ORIGINAL_NATIVE_SOURCE("m", "c")}
        AND ${ACTIVE_NATIVE_TURN_SEAT("t", "c")}
      ORDER BY t.rowid ${state === "queued" ? "LIMIT 24" : ""}`, ownerId, state, ot.now());
    const hostForRoom = new Map<string, string | undefined>();
    return [...current("running"), ...current("queued")].flatMap(turn => {
      if (!hostForRoom.has(turn.conversation_id)) {
        const room = ot.get<Group>("SELECT * FROM ot_conversations WHERE id=?", turn.conversation_id);
        hostForRoom.set(turn.conversation_id, room && nativeGroupHost(ot, room));
      }
      if (hostForRoom.get(turn.conversation_id) !== turn.host_id) return [];
      const {id,owner_id,agent_ref,call_key,state,conversation_id,message_id,prompt} = turn;
      return [{id,owner_id,agent_ref,call_key,state,conversation_id,message_id,prompt}];
    });
  }
  function readNativeGroupInbox(ownerId: string) {
    const pending = (state:"running"|"queued") => ot.all<Omit<NativeRound,"source_valid"> & {has_image:number}>(`SELECT r.*,m.seq,m.author_id,
      EXISTS (SELECT 1 FROM ot_message_attachments attachment WHERE attachment.message_id=r.message_id
        AND attachment.mime LIKE 'image/%' AND attachment.resource IS NULL AND attachment.sticker=0) AS has_image,
      ${REQUIRES_NATIVE_TEXT_ONLY("r", "c")} AS requires_text_only FROM ot_native_group_rounds r
      JOIN ot_messages m ON m.id=r.message_id JOIN ot_conversations c ON c.id=r.conversation_id
      JOIN ot_conversation_members member ON member.conversation_id=c.id AND member.owner_id=r.owner_id
      WHERE r.owner_id=? AND r.state=? AND ${ORIGINAL_NATIVE_SOURCE("m", "c")}
        AND c.kind='group' AND c.dm_key IS NULL AND (c.account_group=1 OR c.team_id IS NOT NULL) AND c.group_archived_at IS NULL
        AND COALESCE(c.group_owner_id,c.created_by)=r.owner_id AND (c.team_id IS NULL OR EXISTS (
          SELECT 1 FROM ot_team_members active WHERE active.team_id=c.team_id AND active.owner_id=r.owner_id AND active.suspended=0))
      ORDER BY m.rowseq ${state === "queued" ? "LIMIT 60" : ""}`, ownerId, state);
    return {turns:readNativeGroupTurns(ownerId),items:[...pending("running"), ...pending("queued")].map(({message_id,conversation_id,body,state,seq,agent_mentions,author_id,requires_text_only,has_image}) => {
      const {display_name} = ot.profileView(author_id);
      const address = mentionText(body);
      const all = ALL_PEOPLE_ADDRESS.test(address) || ALL_AGENT_ADDRESS.test(address);
      return {message_id,conversation_id,body,state,seq,agent_mentions:JSON.parse(agent_mentions),
        author:{owner_id:author_id,display_name},text_only:requires_text_only === 1,
        ...(has_image === 1 ? {has_image:true} : {}), ...(all ? {all:true} : {})};
    })};
  }

  app.get("/v1/ot/native-group-inbox", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const {ownerId} = ot.me(req);
    const input = query(req);
    const wait = one(input.wait_ms, "wait_ms");
    const waitMs = wait === undefined ? 0 : Number(wait);
    assert(Object.keys(input).every(key => key === "wait_ms") &&
      (wait === undefined || (/^[0-9]{1,5}$/.test(wait) && waitMs <= AGENT_INBOX_MAX_WAIT_MS)),
    400, "invalid_request", "Native agent inbox wait_ms must be 0–10000");
    const current = readNativeGroupInbox(ownerId);
    if (!waitMs || current.items.length || current.turns.length) return current;
    // The queue is durable. The signal shortens an idle poll after a different
    // member sends a message to this host while no room turn is running.
    const waiting = inboxWake.wait(ownerId, waitMs, reply.raw);
    if (!waiting) return current;
    await waiting;
    return reply.raw.destroyed ? current : readNativeGroupInbox(ot.me(req).ownerId);
  });

  app.post("/v1/ot/conversations/:id/native-rounds/:messageId", {bodyLimit:1024}, async req => {
    const {ownerId} = ot.me(req);
    const {id,messageId} = params(req);
    const data = body(req);
    const start = data.action === "start" && Object.keys(data).every(key => key === "action" || key === "text_only") &&
      (data.text_only === undefined || data.text_only === true);
    const finish = data.action === "finish" && Object.keys(data).length === 1;
    assert(start || finish, 400, "invalid_request", "Invalid native group action");
    return ot.tx(() => {
      const conv = memberOf(ot, id, ownerId);
      const round = findNativeRound(conv, messageId, ownerId);
      if (finish) {
        if (round.state !== "finished") ot.run("UPDATE ot_native_group_rounds SET state='finished' WHERE message_id=?", round.message_id);
        if (nativeGroupProgress.get(id)?.messageId === messageId) nativeGroupProgress.delete(id);
        return {state:"finished"};
      }
      requireNativeRound(conv, round, ownerId);
      if (round.state === "finished") return {started:false,state:"finished"};
      assert(round.requires_text_only !== 1 || data.text_only === true,
        409, "native_round_text_only", "This native group round requires text-only execution");
      const restricted = data.text_only === true;
      if (round.state === "running") return {started:false,state:"running",...(round.text_only === 1 ? {text_only:true} : {})};
      assert(!ot.get(`SELECT 1 FROM ot_native_group_rounds older JOIN ot_messages source ON source.id=older.message_id
        JOIN ot_messages current ON current.id=? JOIN ot_conversations c ON c.id=older.conversation_id
        WHERE older.conversation_id=? AND older.owner_id=? AND older.state<>'finished' AND source.seq<current.seq
          AND ${ORIGINAL_NATIVE_SOURCE("source", "c")}`, round.message_id, conv.id, ownerId),
      409, "native_round_busy", "A previous native group round is still active");
      ot.run("UPDATE ot_native_group_rounds SET state='running',text_only=? WHERE message_id=?", Number(restricted), round.message_id);
      return {started:true,state:"running",...(restricted ? {text_only:true} : {})};
    });
  });

  app.post("/v1/ot/conversations/:id/native-rounds/:messageId/progress", {bodyLimit:2048}, async req => {
    const {ownerId} = ot.me(req);
    const {id,messageId} = params(req);
    const data = body(req);
    const requested: unknown = data.working_agent_refs;
    assert(Object.keys(data).length === 1 && Array.isArray(requested) && requested.length <= 12 &&
        requested.every(ref => typeof ref === "string" && AGENT_REF.test(ref)), 400, "invalid_request", "Invalid native group activity");
    const conv = memberOf(ot, id, ownerId);
    const round = findNativeRound(conv, messageId, ownerId);
    assert(round.state === "running", 409, "native_round_unavailable", "The native group round is no longer active");
    const roster = conversationAgents(ot, id);
    requireNativeRound(conv, round, ownerId, roster);
    const refs = [...new Set<string>(requested)];
    const seats = new Set(roster.filter(agent => agent.owner_id === ownerId).map(agent => agent.agent_ref));
    assert(refs.every(ref => seats.has(ref)), 404, "agent_not_found", "This Bot is no longer in the native group");
    if (refs.length) {
      const now = ot.now();
      if (!nativeGroupProgress.has(id) && nativeGroupProgress.size >= REPLY_PROGRESS_CAPACITY) {
        for (const [room, state] of nativeGroupProgress) if (state.expires <= now) nativeGroupProgress.delete(room);
        assert(nativeGroupProgress.size < REPLY_PROGRESS_CAPACITY, 429, "reply_progress_busy", "Native group activity is busy");
      }
      nativeGroupProgress.set(id, {messageId,ownerId,refs,expires:now + NATIVE_GROUP_PROGRESS_MS});
    } else if (nativeGroupProgress.get(id)?.messageId === messageId) nativeGroupProgress.delete(id);
    return {ok:true};
  });

  const nativeTurnsPath = "/v1/ot/conversations/:id/native-rounds/:messageId/turns";
  app.post(nativeTurnsPath, {bodyLimit:393216}, async req => {
    const {ownerId} = ot.me(req);
    const {id,messageId} = params(req);
    const data = body(req);
    assert(Object.keys(data).length === 4 && ["owner_id","agent_ref","call_key","prompt"].every(key => Object.hasOwn(data,key)),
      400, "invalid_request", "Invalid native group turn");
    const target = text(data.owner_id, "owner_id", {min:1,max:80});
    const agentRef = text(data.agent_ref, "agent_ref", {min:1,max:80});
    const callKey = text(data.call_key, "call_key", {min:1,max:160});
    const prompt = text(data.prompt, "prompt", {min:1,max:64000,multiline:true});
    assert(target !== ownerId, 400, "invalid_request", "Local Bots run in the native room directly");
    const turn = ot.tx(() => {
      const conv = memberOf(ot, id, ownerId);
      const round = findNativeRound(conv, messageId, ownerId);
      const roster = conversationAgents(ot, conv.id);
      requireNativeRound(conv, round, ownerId, roster);
      assert(round.state === "running" && round.text_only === 1, 409, "native_round_unavailable", "This round cannot ask a remote Bot");
      assert(roster.some(agent => agent.owner_id === target && agent.agent_ref === agentRef),
        404, "agent_not_found", "This Bot is no longer in the native group");
      const prior = ot.get<NativeTurn>("SELECT * FROM ot_native_group_turns WHERE message_id=? AND call_key=?", messageId, callKey);
      if (prior) {
        assert(prior.owner_id === target && prior.agent_ref === agentRef && prior.prompt === prompt,
          409, "native_turn_conflict", "This native turn key was already used");
        return prior;
      }
      const count = ot.get<{total:number}>("SELECT COUNT(*) AS total FROM ot_native_group_turns WHERE message_id=?", messageId)!.total;
      assert(count < NATIVE_GROUP_TURN_LIMIT, 429, "native_turn_limit", "This native group round reached its Bot turn limit");
      const turnId = newId("otnt");
      const now = ot.now();
      ot.run("INSERT INTO ot_native_group_turns(id,message_id,owner_id,agent_ref,call_key,prompt,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)",
        turnId,messageId,target,agentRef,callKey,prompt,now,now + NATIVE_GROUP_TURN_TIMEOUT_MS);
      return ot.get<NativeTurn>("SELECT * FROM ot_native_group_turns WHERE id=?", turnId)!;
    });
    const active = Boolean(activeNativeTurnSeat(turn.id,id));
    if (active && turn.state === "queued") inboxWake.notify(target);
    return nativeTurnView(turn,active);
  });
  app.get(nativeTurnsPath, async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const {ownerId} = ot.me(req);
    const {id,messageId} = params(req);
    const conv = memberOf(ot, id, ownerId);
    const round = findNativeRound(conv, messageId, ownerId);
    requireNativeRound(conv, round, ownerId);
    const turns = ot.all<NativeTurn & {seat_active:number}>(`SELECT t.*,(${ACTIVE_NATIVE_TURN_SEAT("t", "c")}) AS seat_active
      FROM ot_native_group_turns t JOIN ot_conversations c ON c.id=? WHERE t.message_id=? ORDER BY t.rowid`,id,messageId);
    return {items:turns.map(turn => nativeTurnView(turn,turn.seat_active === 1))};
  });

  app.post("/v1/ot/native-group-turns/:turnId", {bodyLimit:32768}, async req => {
    const {ownerId} = ot.me(req);
    const {turnId} = params(req);
    const data = body(req);
    const start = data.action === "start" && Object.keys(data).length === 1;
    const finish = data.action === "finish" && Object.keys(data).every(key => ["action","outcome","text"].includes(key)) &&
      (data.outcome === "message" || ((data.outcome === "pass" || data.outcome === "failed") && data.text === undefined));
    assert(nativeTurnId.test(turnId) && (start || finish),400,"invalid_request","Invalid native group turn action");
    const outcome = finish ? data.outcome as NativeTurnOutcome : null;
    const resultText = outcome === "message" ? text(data.text,"text",{min:1,max:BODY_MAX,multiline:true}) : null;
    return ot.tx(() => {
      const turn = ot.get<NativeTurnInbox>(`SELECT t.*,r.conversation_id,r.owner_id AS host_id
        FROM ot_native_group_turns t JOIN ot_native_group_rounds r ON r.message_id=t.message_id
        WHERE t.id=? AND t.owner_id=?`,turnId,ownerId);
      assert(turn, 404, "native_turn_not_found", "Native group turn was not found");
      const conv = memberOf(ot, turn.conversation_id, ownerId);
      const round = findNativeRound(conv, turn.message_id, turn.host_id);
      const roster = conversationAgents(ot, conv.id);
      requireNativeRound(conv, round, turn.host_id, roster);
      assert(activeNativeTurnSeat(turn.id, conv.id), 404, "agent_not_found", "This Bot is no longer in the native group");
      if (turn.state === "finished" || expiredNativeTurn(turn)) {
        if (finish && turn.state === "finished") assert(turn.outcome === outcome && turn.result_text === resultText,
          409, "native_turn_conflict", "This native group turn already finished");
        return {state:"finished",...(start ? {started:false} : {}),result:nativeTurnView(turn).result};
      }
      assert(round.state === "running" && round.text_only === 1, 409, "native_round_unavailable", "The native group round is no longer active");
      if (start) {
        const changed = ot.run("UPDATE ot_native_group_turns SET state='running' WHERE id=? AND state='queued'", turnId).changes === 1;
        return {state:"running",started:changed};
      }
      assert(turn.state === "running", 409, "native_turn_unavailable", "Start the native group turn first");
      ot.run("UPDATE ot_native_group_turns SET state='finished',outcome=?,result_text=? WHERE id=?", outcome,resultText,turnId);
      return {state:"finished",result:{outcome,...(resultText === null ? {} : {text:resultText})}};
    });
  });

  app.post("/v1/ot/conversations/:id/native-rounds/:messageId/lines", {bodyLimit:32768}, async (req, reply) => {
    const {ownerId} = ot.me(req);
    const {id,messageId} = params(req);
    const data = body(req);
    assert(Object.keys(data).every(key => ["agent_ref","body","client_key","agent_owner_id","turn_id","late"].includes(key)) &&
      ["agent_ref","body","client_key"].every(key => Object.hasOwn(data,key)), 400, "invalid_request", "Invalid native group line");
    const agentRef = text(data.agent_ref, "agent_ref", {min:1,max:80});
    const author = data.agent_owner_id === undefined ? ownerId : text(data.agent_owner_id, "agent_owner_id", {min:1,max:80});
    const guest = author !== ownerId;
    const late = data.late === true;
    assert(data.late === undefined || (late && !guest), 400, "invalid_request", "Only a local Bot line may be published late");
    const turnId = data.turn_id;
    assert(guest ? typeof turnId === "string" && nativeTurnId.test(turnId) : turnId === undefined,
      400, "invalid_request", "Remote Bot lines require a native turn receipt");
    const localText = text(data.body, "body", {min:1,max:BODY_MAX,multiline:true});
    const key = text(data.client_key, "client_key", {min:1,max:80});
    const clientKey = guest ? null : "native:" + createHash("sha256").update(key).digest("hex");
    const result = ot.tx(() => {
      const conv = memberOf(ot, id, ownerId);
      const round = findNativeRound(conv, messageId, ownerId);
      let output = localText;
      let prior;
      if (guest) {
        const receipt = ot.get<NativeTurn>(`SELECT * FROM ot_native_group_turns WHERE id=? AND message_id=? AND owner_id=?
          AND agent_ref=? AND state='finished' AND outcome='message'`, turnId, round.message_id, author, agentRef);
        assert(receipt?.result_text, 404, "native_turn_not_found", "This remote Bot has no completed native reply");
        output = receipt.result_text;
        assert(activeNativeTurnSeat(receipt.id, conv.id), 404, "agent_not_found", "This Bot is no longer in the native group");
        if (receipt.published_message_id) prior = ot.get("SELECT * FROM ot_messages WHERE id=? AND conversation_id=?", receipt.published_message_id, conv.id);
      } else {
        prior = ot.get("SELECT * FROM ot_messages WHERE conversation_id=? AND author_id=? AND client_key=?", conv.id, author, clientKey);
      }
      if (!prior || late) {
        assert(round.state === (late ? "finished" : "running"), 409, "native_round_unavailable",
          late ? "A late Bot line requires a finished native group round" : "The native group round is no longer active");
        const roster = conversationAgents(ot, conv.id);
        requireNativeRound(conv, round, ownerId, roster);
        assert(!late || (round.requires_text_only === 0 && nativeGroupImages(ot, conv, ownerId, roster)),
          409, "native_round_unavailable", "Only a private native group can receive a late Bot line");
        const agent = roster.find(item => item.agent_ref === agentRef && item.owner_id === author);
        assert(agent, 404, "agent_not_found", "This Bot is no longer in the native group");
        if (!prior) {
          const posted = insertMessage(ot, conv, {author,kind:"agent",agentRef,agentName:agent.name,
            body:output,mentions:[],replyTo:late ? null : round.message_id,clientKey});
          if (guest) ot.run("UPDATE ot_native_group_turns SET published_message_id=? WHERE id=?", posted.id,turnId);
          return posted;
        }
      }
      // Detached native output belongs in the room without guessing which prompt it answers.
      const sameSource = prior.reply_to === round.message_id || (!guest && (late || prior.reply_to === null));
      assert(prior.author_kind === "agent" && prior.agent_ref === agentRef && sameSource && prior.body === output,
        409, "native_line_conflict", "This native line key was already used");
      return prior;
    });
    return reply.status(201).send(messageView(ot, result, ownerId));
  });

  app.post("/v1/ot/conversations/:id/agent-messages", async (req, reply) => {
    const me = ot.me(req);
    const b = body(req);
    const ref = String(b.agent_ref ?? "");
    const bodyText = text(b.body, "body", { min: 1, max: BODY_MAX, multiline: true });
    const mode = b.mode === "auto" ? "auto" : b.mode === "public" ? "public" : "mention";
    const claim = replyClaimId(b.claim_id);
    assert(claim === null || mode === "mention", 400, "invalid_request", "Invalid reply job claim");
    let releasedMessage: string | undefined;
    const msg = ot.tx(() => {
      const conv = memberOf(ot, params(req).id, me.ownerId);
      if (conv.team_id) requireMember(ot, conv.team_id, me.ownerId);
      const ordinaryDm = ordinaryDirect(conv);
      const agent = ot.get<any>("SELECT * FROM ot_conversation_agents WHERE conversation_id = ? AND agent_ref = ? AND owner_id = ?", conv.id, ref, me.ownerId);
      assert(agent, ordinaryDm ? 409 : 404, ordinaryDm ? "reply_job_unavailable" : "agent_not_found", "that agent of yours is not in this conversation");
      if (fixedPublicThread(conv)) {
        const listing = publicListing(ot, conv);
        assert(mode === "public" && listing?.listed && listing.chat_enabled && listing.owner_id === me.ownerId
          && listing.ref === ref, 409, "public_chat_closed", "公开智能体已关闭访客聊天。");
        const original = ot.get<any>(`SELECT * FROM ot_messages WHERE id=? AND conversation_id=? AND author_id=?
          AND author_kind='member' AND retracted=0`, String(b.reply_to ?? ""), conv.id, conv.created_by);
        assert(original && original.rowseq > listing.chat_from, 409, "public_chat_closed", "原消息已不可回复。");
        const answered = ot.get<any>(`SELECT * FROM ot_messages WHERE conversation_id=? AND reply_to=? AND author_id=?
          AND agent_ref=? AND author_kind='agent'`, conv.id, original.id, me.ownerId, ref);
        if (answered) return answered;
      } else {
        assert(mode !== "public", 400, "invalid_request", "Public mode requires a public agent thread");
      }
      const originalId = b.reply_to ? String(b.reply_to) : null;
      const job = originalId && mode !== "public" ? ot.get<ReplyJob>(REPLY_JOB_SOURCE
        + ` WHERE j.message_id=? AND j.owner_id=? AND j.agent_ref=? AND src.conversation_id=?
          AND (?='mention' OR j.claim_id IS NOT NULL OR src.author_id<>j.owner_id OR j.direct_grant_id IS NOT NULL)`,
      originalId, me.ownerId, ref, conv.id, mode) : undefined;
      if (ordinaryDm) {
        assert(Object.keys(b).every(key => ["agent_ref","body","reply_to","mode","client_key","job_id","attempt","claim_id"].includes(key)),
          400, "invalid_request", "私聊智能体只可回复文字。");
        assert((b.mode === undefined || b.mode === "mention") && job?.direct_grant_id && job.available && claim !== null,
          409, "reply_job_unavailable", "私聊智能体只可回复已领取的指定任务。");
      }
      if (job?.studio_document_id || (!job && originalId && messageStudioReference(ot, originalId, conv.id))) {
        assert(mode === "mention" && job?.studio_document_id && claim !== null,
          409, "reply_job_unavailable", "团队文档只可用于已领取的指定智能体回复。");
      }
      const explicitRequest = !job && originalId && ot.get(`SELECT 1 FROM ot_messages source
        WHERE source.id=? AND source.conversation_id=? AND (EXISTS (
          SELECT 1 FROM ot_group_agent_message_requests req WHERE req.message_id=source.id
        ) OR EXISTS (SELECT 1 FROM ot_agent_reply_jobs routed WHERE routed.message_id=source.id)
          OR EXISTS (SELECT 1 FROM ot_group_reply_suppressions s WHERE s.message_id=source.id))`, originalId, conv.id);
      if (job?.group_text_only || job?.discretionary || explicitRequest) {
        assert(mode === "mention" && job && claim !== null,
          409, "reply_job_unavailable", "队友请求只可由已领取任务的指定智能体回复。");
      }
      if (job) {
        assert(!job.passed && (!job.discretionary || (job.available && job.source_revision === job.current_revision)),
          409, "reply_job_unavailable", "这次回复的状态已更新。");
      }
      if (b.job_id !== undefined || claim !== null || job?.claim_id != null) {
        // Expiry makes the job retryable. Only the same, still-running claim may
        // finish late, and a retry or invalidation wins if it happened first.
        assert(mode === "mention" && job && job.id === b.job_id && job.attempt === b.attempt
          && job.claim_id === claim && (currentRunningClaim(job, claim) || job.status === "replied"
            || (claim === null && replyJobState(job, ot.now()) === "running")),
        409, "reply_job_unavailable", "这次回复的状态已更新。");
      } else if (job) {
        // Older inbox clients can finish a first attempt while containers update.
        assert(job.available && job.attempt === 1 && replyJobState(job, ot.now()) !== "failed",
          409, "reply_job_unavailable", "这次回复的状态已更新。");
      }
      if (job?.status === "replied") {
        return ot.get<any>(`SELECT * FROM ot_messages WHERE conversation_id=? AND reply_to=? AND author_id=?
          AND agent_ref=? AND author_kind='agent' AND reply_mode='mention' ORDER BY seq LIMIT 1`, conv.id, originalId, me.ownerId, ref);
      }
      assert(!job || job.studio_available, 409, "reply_job_unavailable", "原团队文档版本已不可用。");
      if (mode === "auto") {
        assert(agent.auto_reply, 409, "auto_reply_disabled", "automatic replies are disabled for this agent");
        if (b.reply_to) {
          const trigger = ot.get<any>(`SELECT seq,body,mentions,author_kind,forwarded_author
            FROM ot_messages WHERE id=? AND conversation_id=?`, String(b.reply_to), conv.id);
          assert(trigger && trigger.seq > agent.auto_reply_after_seq && trigger.author_kind === "member" &&
            !trigger.forwarded_author && trigger.mentions === "[]" && !TYPED_ADDRESS.test(mentionText(trigger.body)),
          409, "auto_reply_disabled", "This message is unavailable for automatic replies");
        }
      }
      const since = ot.now() - HOUR;
      const used = ot.get<any>("SELECT COUNT(*) AS n FROM ot_messages WHERE conversation_id = ? AND author_kind = 'agent' AND reply_mode = ? AND created_at > ?", conv.id, mode, since).n;
      assert(used < (mode === "auto" ? AUTO_PER_HOUR : MENTION_PER_HOUR), 429, "agent_reply_limit", mode === "auto" ? "automatic agent replies are limited to 3 per hour in a group" : "agent reply limit reached");
      if (b.reply_to) assert(ot.get("SELECT 1 FROM ot_messages WHERE id = ? AND conversation_id = ?", String(b.reply_to), conv.id), 400, "invalid_request", "reply_to is not in this conversation");
      const clientKey = job ? `job:${job.id}` : b.client_key ? text(b.client_key, "client_key", { min: 1, max: 80 }) : null;
      const prior = clientKey && ot.get<any>("SELECT * FROM ot_messages WHERE conversation_id=? AND author_id=? AND client_key=?",conv.id,me.ownerId,clientKey);
      if (ordinaryDm) assert(!prior, 409, "reply_job_unavailable", "私聊智能体回复记录冲突。");
      if (prior) return prior;
      const refs = b.group_memory_ids ?? [];
      assert(Array.isArray(refs) && refs.length<=3 && refs.every(id=>typeof id==="string") && new Set(refs).size===refs.length,
        400,"invalid_request","无效的群记忆引用。");
      if (refs.length) {
        requireMemoryGroup(ot,conv.id,me.ownerId);
        const allowed = new Set(activeMemories(ot,conv.id).map(item=>item.id));
        assert(refs.every(id=>allowed.has(id)),409,"group_memory_changed","群记忆已更新，请重新生成回复。");
      }
      const response = insertMessage(ot, conv, { author: me.ownerId, kind: "agent", agentRef: agent.agent_ref,
        agentName: agent.name, body: bodyText, mentions: [], replyTo: originalId, replyMode: mode,
        clientKey });
      for (const id of refs) ot.run("INSERT OR IGNORE INTO ot_group_memory_references VALUES(?,?)",response.id,id);
      if (job) {
        ot.run("UPDATE ot_agent_reply_jobs SET status='replied',updated_at=?,lease_expires_at=NULL WHERE id=?", ot.now(), job.id);
        replyProgress.delete(job.id);
        if (job.discretionary) releasedMessage = job.message_id;
      }
      return response;
    });
    if (releasedMessage) wakeDiscretionaryPeers(releasedMessage, me.ownerId);
    return reply.status(201).send(messageView(ot, msg, me.ownerId));
  });
}
