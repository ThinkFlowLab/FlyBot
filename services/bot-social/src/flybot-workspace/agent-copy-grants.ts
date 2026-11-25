import type { FastifyInstance, FastifyRequest } from "fastify";
import { assert } from "../errors.js";
import { newId } from "../ids.js";
import { body, hashCode, intParam, one, params, query, text, type OtContext } from "./core.js";
import { CATEGORIES } from "./discover.js";

export const AGENT_COPY_GRANTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS ot_agent_copy_grants (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
  sender_id TEXT NOT NULL REFERENCES ot_profiles(owner_id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL REFERENCES ot_profiles(owner_id) ON DELETE CASCADE,
  source_agent_id TEXT NOT NULL, client_key TEXT NOT NULL, request_hash TEXT NOT NULL,
  agent_name TEXT NOT NULL, snapshot TEXT, revision TEXT NOT NULL,
  includes_instructions INTEGER NOT NULL, quick_start_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL, revoked_at INTEGER, closed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (sender_id, client_key), CHECK (sender_id<>recipient_id)
);
CREATE INDEX IF NOT EXISTS ot_agent_copy_grants_sent ON ot_agent_copy_grants(sender_id,seq);
CREATE INDEX IF NOT EXISTS ot_agent_copy_grants_source ON ot_agent_copy_grants(sender_id,source_agent_id,seq);
CREATE INDEX IF NOT EXISTS ot_agent_copy_grants_received ON ot_agent_copy_grants(recipient_id,seq);
`;

const ROOT = "/v1/ot/agent-copy-grants";
const GRANT_ID = /^otag_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;
const OWNER_ID = /^[A-Za-z0-9._:-]{1,80}$/;
const SOURCE_ID = /^[a-f0-9]{32}$/;
const KEY = /^[A-Za-z0-9_-]{16,64}$/;
const REVISION = /^[a-f0-9]{64}$/;

type Template = { name: string; summary: string; category: string | null; instructions: string; quick_starts: string[] };
type Grant = {
  id: string; sender_id: string; recipient_id: string; source_agent_id: string; request_hash: string;
  agent_name: string; snapshot: string | null; revision: string;
  includes_instructions: number; quick_start_count: number; created_at: number; revoked_at: number | null; closed: number;
};

const METADATA = `id,sender_id,recipient_id,source_agent_id,agent_name,includes_instructions,quick_start_count,
  created_at,revoked_at,closed`;
type GrantHeader = Omit<Grant, "request_hash" | "snapshot" | "revision">;

function object(value: unknown, fields: string[]) {
  assert(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => fields.includes(key)),
    400, "invalid_request", "Unexpected private agent copy fields");
  return value as Record<string, unknown>;
}

function identifier(value: unknown, pattern: RegExp, name: string) {
  assert(typeof value === "string" && pattern.test(value), 400, "invalid_request", `Invalid ${name}`);
  return value;
}

function exportedTemplate(input: Record<string, unknown>): Template {
  const selected = object(input.template, ["name", "summary", "category", "instructions", "quick_starts"]);
  const instructionsSelected = input.share_instructions;
  const startsSelected = input.share_quick_starts;
  assert((instructionsSelected === undefined || typeof instructionsSelected === "boolean")
    && (startsSelected === undefined || typeof startsSelected === "boolean"),
    400, "invalid_request", "Choose explicitly which optional agent fields to share");
  assert(instructionsSelected === true || selected.instructions === undefined, 400, "invalid_request", "Instructions were not selected for sharing");
  assert(startsSelected === true || selected.quick_starts === undefined, 400, "invalid_request", "Quick starts were not selected for sharing");
  const category = selected.category ?? null;
  assert(category === null || (typeof category === "string" && CATEGORIES.includes(category)), 400, "invalid_request", "Unknown agent category");
  const starts = selected.quick_starts === undefined ? [] : selected.quick_starts;
  assert(Array.isArray(starts) && starts.length <= 5, 400, "invalid_request", "Share up to five quick starts");
  return {
    name: text(selected.name, "name", {min:1,max:80}),
    summary: text(selected.summary === undefined ? "" : selected.summary, "summary", {max:500,multiline:true}),
    category,
    instructions: text(selected.instructions === undefined ? "" : selected.instructions, "instructions", {max:16_000,multiline:true}),
    quick_starts: starts.map(value => text(typeof value === "string" ? value.trim() : value, "quick start", {min:1,max:80,multiline:true})),
  };
}

const reachable = (sender: string, recipient: string) => `(
  EXISTS (SELECT 1 FROM ot_contacts contact WHERE contact.owner_a=MIN(${sender},${recipient})
    AND contact.owner_b=MAX(${sender},${recipient}) AND contact.status='accepted')
  OR EXISTS (SELECT 1 FROM ot_team_members membership JOIN ot_team_members teammate ON teammate.team_id=membership.team_id
    WHERE membership.owner_id=${sender} AND teammate.owner_id=${recipient} AND membership.suspended=0 AND teammate.suspended=0)
)`;

function registerReachabilityChanges(ot: OtContext) {
  const pair = `((sender_id=OLD.owner_a AND recipient_id=OLD.owner_b) OR (sender_id=OLD.owner_b AND recipient_id=OLD.owner_a))`;
  const side = `(sender_id=OLD.owner_id OR recipient_id=OLD.owner_id)`;
  const events = [
    ["contact_update", "UPDATE OF status ON ot_contacts WHEN OLD.status='accepted' AND NEW.status<>'accepted'", pair],
    ["contact_delete", "DELETE ON ot_contacts WHEN OLD.status='accepted'", pair],
    ["team_suspend", "UPDATE OF suspended ON ot_team_members WHEN OLD.suspended=0 AND NEW.suspended=1", side],
    ["team_member_delete", "DELETE ON ot_team_members WHEN OLD.suspended=0", side],
  ];
  for (const [name,event,affected] of events) {
    ot.run(`CREATE TRIGGER IF NOT EXISTS ot_agent_copy_grants_${name} AFTER ${event} BEGIN
      UPDATE ot_agent_copy_grants SET closed=1,snapshot=NULL
        WHERE snapshot IS NOT NULL AND ${affected} AND NOT ${reachable("sender_id", "recipient_id")};
    END`);
  }
}

function peerView(ot: OtContext, ownerId: string) {
  const {owner_id,handle,display_name} = ot.profileView(ownerId);
  return {owner_id,handle,display_name};
}

function grantView(ot: OtContext, row: GrantHeader, owner: string) {
  return {
    id:row.id, state:row.revoked_at !== null ? "revoked" : row.closed ? "closed" : "active",
    agent_name:row.agent_name, created_at:row.created_at, revoked_at:row.revoked_at,
    includes_instructions:row.includes_instructions === 1, quick_start_count:row.quick_start_count,
    sender:peerView(ot,row.sender_id), recipient:peerView(ot,row.recipient_id),
    ...(row.sender_id === owner ? {source_agent_id:row.source_agent_id} : {}),
  };
}

function recipientGrant(ot: OtContext, req: FastifyRequest, revision?: string) {
  const {ownerId} = ot.me(req);
  const row = ot.get<Grant & {reachable: number}>(`SELECT *, ${reachable("sender_id", "recipient_id")} AS reachable
    FROM ot_agent_copy_grants WHERE id=? AND recipient_id=?`, params(req).id, ownerId);
  assert(row, 404, "agent_copy_not_found", "找不到智能体分享。");
  assert(row.revoked_at === null, 410, "agent_copy_revoked", "分享者已撤回这份智能体分享。");
  assert(!row.closed && row.reachable && row.snapshot, 410, "agent_copy_closed", "这份智能体分享已失效。");
  assert(revision === undefined || revision === row.revision, 409, "agent_copy_version_changed", "请重新预览智能体分享。");
  const {name,summary,category,instructions,quick_starts} = JSON.parse(row.snapshot) as Template;
  return {grant:grantView(ot,row,ownerId),template:{name,summary,category,instructions,quick_starts,revision:row.revision}};
}

export function registerAgentCopyGrants(app: FastifyInstance, ot: OtContext) {
  registerReachabilityChanges(ot);
  app.register(async privateRoutes => {
    privateRoutes.addHook("onRequest", async (_req, reply) => { reply.header("Cache-Control", "private, no-store"); });
    privateRoutes.get(ROOT + "/recipients", async req => {
      const {ownerId} = ot.me(req);
      const q = object(query(req), ["limit", "after"]);
      const rawAfter = one(q.after, "after");
      const after = rawAfter === undefined ? "" : identifier(rawAfter, OWNER_ID, "recipient cursor");
      const limit = Math.max(1, intParam(q.limit, "limit", 50, 100));
      const rows = ot.all<{owner_id: string; handle: string; display_name: string}>(`WITH eligible(owner_id) AS (
        SELECT owner_b FROM ot_contacts WHERE owner_a=? AND status='accepted'
        UNION SELECT owner_a FROM ot_contacts WHERE owner_b=? AND status='accepted'
        UNION SELECT teammate.owner_id FROM ot_team_members membership
          JOIN ot_team_members teammate ON teammate.team_id=membership.team_id AND teammate.owner_id<>membership.owner_id
          WHERE membership.owner_id=? AND membership.suspended=0 AND teammate.suspended=0
      ) SELECT peer.owner_id,peer.handle,peer.display_name FROM eligible JOIN ot_profiles peer ON peer.owner_id=eligible.owner_id
        WHERE peer.owner_id>? ORDER BY peer.owner_id LIMIT ?`, ownerId, ownerId, ownerId, after, limit+1);
      return {items:rows.slice(0,limit),next_cursor:rows.length>limit ? rows[limit-1].owner_id : null};
    });

    privateRoutes.post(ROOT, {bodyLimit:128*1024}, async (req, reply) => {
      const {ownerId} = ot.me(req);
      object(query(req), []);
      const input = object(body(req), ["recipient_owner_id", "source_agent_id", "client_key", "share_instructions", "share_quick_starts", "template"]);
      const recipient = identifier(input.recipient_owner_id, OWNER_ID, "recipient id");
      const source = identifier(input.source_agent_id, SOURCE_ID, "source agent id");
      const key = identifier(input.client_key, KEY, "client key");
      assert(recipient !== ownerId, 400, "invalid_request", "请选择另一位收件人。");
      const template = exportedTemplate(input);
      const requestHash = hashCode(JSON.stringify([recipient,source,template]));
      const result = ot.db.transaction(() => {
        const prior = ot.get<GrantHeader & {request_hash: string}>(`SELECT ${METADATA},request_hash FROM ot_agent_copy_grants
          WHERE sender_id=? AND client_key=?`, ownerId, key);
        if (prior) {
          assert(prior.request_hash === requestHash, 409, "agent_copy_request_conflict", "这次分享已用于不同的收件人或内容。");
          return {created:false,row:prior};
        }
        const recipientAccess = ot.get(`SELECT 1 FROM ot_profiles peer CROSS JOIN (SELECT ? AS owner_id) sender
          WHERE peer.owner_id=? AND ${reachable("sender.owner_id", "peer.owner_id")}`, ownerId, recipient);
        assert(recipientAccess, 409, "agent_copy_recipient_unavailable", "这位收件人已经不在联系人或可用团队中。");
        const id = newId("otag");
        ot.run(`INSERT INTO ot_agent_copy_grants(id,sender_id,recipient_id,source_agent_id,client_key,request_hash,
          agent_name,snapshot,revision,includes_instructions,quick_start_count,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        id,ownerId,recipient,source,key,requestHash,template.name,JSON.stringify(template),hashCode(JSON.stringify([id,requestHash])),
        Number(Boolean(template.instructions)),template.quick_starts.length,ot.now());
        return {created:true,row:ot.get<GrantHeader>(`SELECT ${METADATA} FROM ot_agent_copy_grants WHERE id=?`,id)!};
      }).immediate();
      return reply.status(result.created ? 201 : 200).send({grant:grantView(ot,result.row,ownerId)});
    });

    privateRoutes.get(ROOT, async req => {
      const {ownerId} = ot.me(req);
      const q = object(query(req), ["direction", "limit", "after", "source_agent_id"]);
      assert(q.direction === "received" || q.direction === "sent", 400, "invalid_request", "Choose received or sent grants");
      const sent = q.direction === "sent";
      assert(sent || q.source_agent_id === undefined, 400, "invalid_request", "Source agent only filters sent grants");
      const source = q.source_agent_id === undefined ? null : identifier(q.source_agent_id, SOURCE_ID, "source agent id");
      const scope = `${sent ? "sender_id" : "recipient_id"}=?${source ? " AND source_agent_id=?" : ""}`;
      const bindings = source ? [ownerId,source] : [ownerId];
      const limit = Math.max(1, intParam(q.limit, "limit", 50, 100));
      const after = one(q.after,"after");
      let anchor;
      if (after !== undefined) {
        identifier(after, GRANT_ID, "grant cursor");
        anchor = ot.get<{seq: number}>(`SELECT seq FROM ot_agent_copy_grants WHERE ${scope} AND id=?`, ...bindings, after);
        if (!anchor) return {items:[],next_cursor:null};
      }
      const rows = ot.all<GrantHeader>(`SELECT ${METADATA} FROM ot_agent_copy_grants WHERE ${scope}
        ${anchor ? "AND seq<?" : ""} ORDER BY seq DESC LIMIT ?`, ...bindings, ...(anchor ? [anchor.seq] : []), limit+1);
      return {items:rows.slice(0,limit).map(row=>grantView(ot,row,ownerId)),next_cursor:rows.length>limit ? rows[limit-1].id : null};
    });

    privateRoutes.get(ROOT + "/:id", async req => {
      object(query(req), []);
      return recipientGrant(ot,req);
    });
    privateRoutes.post(ROOT + "/:id/claim", {bodyLimit:1024}, async req => {
      object(query(req), []);
      const input = object(body(req), ["revision"]);
      return recipientGrant(ot,req,identifier(input.revision, REVISION, "release revision"));
    });
    privateRoutes.delete(ROOT + "/:id", async req => {
      const {ownerId} = ot.me(req);
      const q = object(query(req), ["source_agent_id"]);
      const source = q.source_agent_id === undefined ? null : identifier(q.source_agent_id,SOURCE_ID,"source agent id");
      return ot.db.transaction(() => {
        const row = ot.get<GrantHeader>(`SELECT ${METADATA} FROM ot_agent_copy_grants WHERE id=? AND sender_id=?`,params(req).id,ownerId);
        assert(row && (!source || row.source_agent_id === source), 404, "agent_copy_not_found", "找不到智能体分享。");
        if (row.revoked_at === null) {
          row.revoked_at = ot.now();
          ot.run("UPDATE ot_agent_copy_grants SET revoked_at=?,snapshot=NULL WHERE id=?",row.revoked_at,row.id);
        }
        return {grant:grantView(ot,row,ownerId)};
      }).immediate();
    });
  });
}
