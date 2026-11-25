import type { FastifyInstance } from "fastify";
import { assert } from "../errors.js";
import { body, hashCode, type OtContext, params, secretCode } from "./core.js";
import { groupOwner, managedGroup, type Group } from "./group-management.js";
import { roleOf } from "./teams.js";

export const GROUP_INVITES_SCHEMA = `
CREATE TABLE IF NOT EXISTS ot_group_invites (
  conversation_id TEXT PRIMARY KEY REFERENCES ot_conversations(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE, created_by TEXT NOT NULL, expires_at INTEGER NOT NULL
);
`;

const SEVEN_DAYS = 7 * 86_400_000;
const GROUP_MEMBER_LIMIT = 50;
type InviteGroup = Group & {last_seq: number; invited_by: string; expires_at: number};

function isGroupMember(ot: OtContext, id: string, owner: string) {
  return Boolean(ot.get("SELECT 1 FROM ot_conversation_members WHERE conversation_id=? AND owner_id=?", id, owner));
}

function canAccessTeam(ot: OtContext, teamId: string | null, owner: string) {
  if (!teamId) return true;
  const membership = roleOf(ot, teamId, owner);
  return Boolean(membership && !membership.suspended);
}

function requireGroupOwner(ot: OtContext, id: string, actor: string) {
  const group = ot.get<Group>("SELECT * FROM ot_conversations WHERE id=?", id);
  assert(group && managedGroup(group) && group.group_archived_at === null
    && isGroupMember(ot, id, actor) && canAccessTeam(ot, group.team_id, actor),
  404, "conversation_not_found", "No such group conversation");
  assert(groupOwner(group) === actor, 403, "forbidden", "Only the group owner may manage invite links");
  return group;
}

function readInvite(ot: OtContext, code: unknown, actor: string) {
  assert(typeof code === "string" && /^[A-Za-z0-9_-]{32}$/.test(code), 400, "invalid_invite", "Invalid group invitation link");
  const group = ot.get<InviteGroup>(`SELECT c.*, i.created_by AS invited_by, i.expires_at
    FROM ot_group_invites i JOIN ot_conversations c ON c.id=i.conversation_id WHERE i.code_hash=?`, hashCode(code));
  assert(group && managedGroup(group) && group.group_archived_at === null && group.expires_at > ot.now()
    && groupOwner(group) === group.invited_by && isGroupMember(ot, group.id, group.invited_by)
    && canAccessTeam(ot, group.team_id, group.invited_by), 410, "group_invite_unavailable", "This group invite is unavailable");
  assert(canAccessTeam(ot, group.team_id, actor), 403, "group_invite_team_required", "Membership of the group workspace is required");
  const member = isGroupMember(ot, group.id, actor);
  const count = group.account_group ? ot.get<{n: number}>(
    "SELECT COUNT(*) AS n FROM ot_conversation_members WHERE conversation_id=?", group.id)?.n ?? 0 : 0;
  assert(member || count < GROUP_MEMBER_LIMIT, 410, "group_invite_full", "The group is full");
  return {group, member};
}

export function registerGroupInvites(app: FastifyInstance, ot: OtContext) {
  app.get("/v1/ot/conversations/:id/invite", async req => {
    const me = ot.me(req);
    const group = requireGroupOwner(ot, params(req).id, me.ownerId);
    const invite = ot.get<{expires_at: number}>(`SELECT expires_at FROM ot_group_invites
      WHERE conversation_id=? AND created_by=? AND expires_at>?`, group.id, me.ownerId, ot.now());
    return {expires_at: invite?.expires_at ?? null};
  });
  app.post("/v1/ot/conversations/:id/invite", async req => {
    const me = ot.me(req);
    return ot.tx(() => {
      const group = requireGroupOwner(ot, params(req).id, me.ownerId);
      const code = secretCode();
      const expiresAt = ot.now() + SEVEN_DAYS;
      ot.run(`INSERT INTO ot_group_invites(conversation_id,code_hash,created_by,expires_at) VALUES (?,?,?,?)
        ON CONFLICT(conversation_id) DO UPDATE SET code_hash=excluded.code_hash,created_by=excluded.created_by,expires_at=excluded.expires_at`,
      group.id, hashCode(code), me.ownerId, expiresAt);
      return {code, expires_at: expiresAt};
    });
  });
  app.delete("/v1/ot/conversations/:id/invite", async req => {
    const me = ot.me(req);
    return ot.tx(() => {
      const group = requireGroupOwner(ot, params(req).id, me.ownerId);
      ot.run("DELETE FROM ot_group_invites WHERE conversation_id=?", group.id);
      return {expires_at: null};
    });
  });
  app.post("/v1/ot/group-invites/preview", {bodyLimit: 1024}, async req => {
    const me = ot.me(req);
    const {group, member} = readInvite(ot, body(req).code, me.ownerId);
    return {title: group.title, member};
  });
  app.post("/v1/ot/group-invites/accept", {bodyLimit: 1024}, async req => {
    const me = ot.me(req);
    return ot.tx(() => {
      const {group, member} = readInvite(ot, body(req).code, me.ownerId);
      const workspaceId = group.team_id ? ot.get<{workspace_id: string}>(
        "SELECT workspace_id FROM ot_teams WHERE id=?", group.team_id)?.workspace_id : null;
      assert(!group.team_id || workspaceId, 410, "group_invite_unavailable", "This group workspace is unavailable");
      if (!member) {
        ot.run("INSERT INTO ot_conversation_members(conversation_id,owner_id,read_seq,created_at) VALUES (?,?,?,?)",
          group.id, me.ownerId, group.last_seq, ot.now());
      }
      return {conversation_id: group.id, workspace_id: workspaceId};
    });
  });
}
