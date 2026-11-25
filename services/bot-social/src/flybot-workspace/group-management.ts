import { assert } from "../errors.js";
import { type OtContext, hashCode, text } from "./core.js";
import { roleOf } from "./teams.js";

export const GROUP_MANAGEMENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS ot_group_management_receipts (
  conversation_id TEXT NOT NULL REFERENCES ot_conversations(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL, revision INTEGER NOT NULL, fingerprint TEXT NOT NULL,
  PRIMARY KEY(conversation_id,owner_id,revision)
);
`;

export type Group = {id: string; kind: string; dm_key: string | null; title: string; created_by: string;
  team_id: string | null; account_group: number; group_owner_id: string | null; group_revision: number; group_archived_at: number | null;
  group_reply_policy?: string | null};
type Lead = {owner_id: string; agent_id: string};
type ReplyPolicy = {mode: "default" | "everyone" | "mentions"} | {mode: "lead"; lead: Lead};
type GroupAction = {action: "rename"; title: string} | {action: "remove" | "transfer"; member_id: string} |
  {action: "leave"} | ({action: "reply_policy"} & ReplyPolicy);
const AGENT_PAIR_ID = /^[A-Za-z0-9._:-]{1,80}$/;

function validLead(value: unknown): value is Lead {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const lead = value as Record<string, unknown>;
  return Object.keys(lead).length === 2 && typeof lead.owner_id === "string" && AGENT_PAIR_ID.test(lead.owner_id) &&
    typeof lead.agent_id === "string" && AGENT_PAIR_ID.test(lead.agent_id);
}

function validReplyPolicy(input: Record<string, unknown>): input is ReplyPolicy {
  return input.mode === "lead" ? validLead(input.lead)
    : (input.mode === "default" || input.mode === "everyone" || input.mode === "mentions") && !Object.hasOwn(input, "lead");
}

export function readGroupReplyPolicy(group: Pick<Group, "group_reply_policy">): ReplyPolicy {
  if (group.group_reply_policy) {
    try {
      const policy = JSON.parse(group.group_reply_policy);
      if (policy && validReplyPolicy(policy)) return policy;
    } catch { /* An invalid stored policy cannot select an agent. */ }
  }
  return {mode: "default"};
}

export const groupOwner = (group: Group) => group.group_owner_id ?? group.created_by;
export const ordinaryGroup = (group: Group) => group.kind === "group" && group.dm_key === null;
export const managedGroup = (group: Group) => ordinaryGroup(group) && (group.account_group === 1 || Boolean(group.team_id));

export function registerGroupManagement(ot: OtContext, columns: Set<string>) {
  if (!columns.has("group_owner_id")) ot.run("ALTER TABLE ot_conversations ADD COLUMN group_owner_id TEXT");
  if (!columns.has("group_revision")) ot.run("ALTER TABLE ot_conversations ADD COLUMN group_revision INTEGER NOT NULL DEFAULT 0");
  if (!columns.has("group_archived_at")) ot.run("ALTER TABLE ot_conversations ADD COLUMN group_archived_at INTEGER");
  if (!columns.has("group_reply_policy")) ot.run("ALTER TABLE ot_conversations ADD COLUMN group_reply_policy TEXT");
  ot.db.exec(`
    CREATE TRIGGER IF NOT EXISTS ot_group_revision_title AFTER UPDATE OF title ON ot_conversations
    WHEN NEW.kind='group' AND NEW.dm_key IS NULL AND NEW.title IS NOT OLD.title
    BEGIN UPDATE ot_conversations SET group_revision=group_revision+1 WHERE id=NEW.id; END;
    CREATE TRIGGER IF NOT EXISTS ot_group_revision_owner AFTER UPDATE OF group_owner_id ON ot_conversations
    WHEN NEW.group_owner_id IS NOT OLD.group_owner_id
    BEGIN UPDATE ot_conversations SET group_revision=group_revision+1,activity_revision=activity_revision+1 WHERE id=NEW.id; END;
  `);
  for (const [event, row] of [["INSERT","NEW"],["DELETE","OLD"]]) {
    ot.db.exec(`CREATE TRIGGER IF NOT EXISTS ot_group_revision_member_${event.toLowerCase()}
      AFTER ${event} ON ot_conversation_members BEGIN
      UPDATE ot_conversations SET group_revision=group_revision+1
        WHERE id=${row}.conversation_id AND kind='group' AND dm_key IS NULL;
      END;`);
  }
  for (const [event, row, condition] of [
    ["INSERT","NEW","NEW.suspended=0"], ["DELETE","OLD","OLD.suspended=0"],
    ["UPDATE OF suspended,role","NEW","NEW.suspended IS NOT OLD.suspended OR NEW.role IS NOT OLD.role"],
  ]) {
    ot.db.exec(`CREATE TRIGGER IF NOT EXISTS ot_group_revision_teammate_${event.split(" ")[0].toLowerCase()}
      AFTER ${event} ON ot_team_members WHEN ${condition} BEGIN
      UPDATE ot_conversations SET group_revision=group_revision+1,activity_revision=activity_revision+1
        WHERE team_id=${row}.team_id AND kind='group' AND dm_key IS NULL AND group_archived_at IS NULL
        AND id IN (SELECT conversation_id FROM ot_conversation_members WHERE owner_id=${row}.owner_id);
      END;`);
  }
}

function roster(ot: OtContext, group: Group) {
  return ot.all<{id: string; active: number}>(`SELECT m.owner_id AS id, (? IS NULL OR teammate.suspended=0) AS active
    FROM ot_conversation_members m LEFT JOIN ot_team_members teammate ON teammate.team_id=? AND teammate.owner_id=m.owner_id
    WHERE m.conversation_id=? ORDER BY m.created_at,m.owner_id`, group.team_id, group.team_id, group.id);
}

function permissions(ot: OtContext, group: Group, actor: string, members = roster(ot, group)) {
  const activeMembers = members.filter(member => member.active).map(member => member.id);
  const owner = groupOwner(group);
  const ownerInactive = !activeMembers.includes(owner);
  const actorActive = activeMembers.includes(actor);
  const ownsGroup = actorActive && owner === actor;
  const teamRole = actorActive && ownerInactive && group.team_id ? roleOf(ot, group.team_id, actor)?.role : undefined;
  const leaveNeedsTransfer = ownsGroup && activeMembers.some(member => member !== actor);
  return {revision:group.group_revision,owner_id:owner,owner_inactive:ownerInactive,active_member_ids:activeMembers,
    can_rename:ownsGroup,can_remove:ownsGroup && members.some(member => member.id !== actor),
    can_transfer:(ownsGroup || teamRole === "owner" || teamRole === "admin") && activeMembers.some(member => member !== owner),
    can_leave:actorActive && !leaveNeedsTransfer,leave_requires_transfer:leaveNeedsTransfer};
}

export function groupManagementView(ot: OtContext, group: Group, actor: string) {
  return managedGroup(group) && group.group_archived_at === null ? permissions(ot, group, actor) : undefined;
}

export function groupManagementRequest(input: Record<string, unknown>) {
  const {action, revision, direct, workspace} = input;
  assert(action === "rename" || action === "remove" || action === "transfer" || action === "leave" || action === "reply_policy",
    400,"invalid_request","Invalid group management action");
  const fields = ["action","revision","direct","workspace",
    ...(action === "rename" ? ["title"] : action === "remove" || action === "transfer" ? ["member_id"]
      : action === "reply_policy" ? ["mode","lead"] : [])];
  assert(Object.keys(input).every(field => fields.includes(field)) && typeof revision === "number"
    && Number.isSafeInteger(revision) && revision >= 0, 400,"invalid_request","Provide the current group management revision");
  assert((direct === true && workspace === undefined)
    || ((direct === undefined || direct === false) && typeof workspace === "string" && /^[0-9a-f]{32}$/.test(workspace)),
  400,"invalid_request","Provide the exact group workspace or personal scope");
  let change: GroupAction;
  if (action === "rename") change = {action,title:text(input.title,"title",{min:1,max:80})};
  else if (action === "remove" || action === "transfer") {
    change = {action,member_id:text(input.member_id,"member_id",{min:1,max:80})};
  } else if (action === "reply_policy") {
    assert(validReplyPolicy(input), 400,"invalid_request","请选择有效的智能体回复策略。");
    change = input.mode === "lead" ? {action,mode:input.mode,lead:{owner_id:input.lead.owner_id,agent_id:input.lead.agent_id}}
      : {action,mode:input.mode};
  } else change = {action};
  const fingerprint = hashCode(JSON.stringify([direct === true ? "personal" : workspace,change]));
  return {change,revision,workspace:typeof workspace === "string" ? workspace : null,fingerprint};
}

function evict(ot: OtContext, group: Group, owner?: string) {
  const scope = owner === undefined ? "" : " AND owner_id=?";
  const owners = owner === undefined ? [] : [owner];
  ot.run(`DELETE FROM ot_conversation_members WHERE conversation_id=?${scope}`, group.id, ...owners);
  ot.run(`DELETE FROM ot_conversation_agents WHERE conversation_id=?${scope}`, group.id, ...owners);
  const call = ot.get<{id: string}>("SELECT id FROM ot_live_calls WHERE conversation_id=?", group.id);
  if (!call) return;
  ot.run(`DELETE FROM ot_call_peers WHERE call_id=?${scope}`, call.id, ...owners);
  if (!ot.get("SELECT 1 FROM ot_call_peers WHERE call_id=?", call.id)) {
    ot.run("UPDATE ot_call_records SET ended_at=MAX(started_at,?) WHERE id=? AND ended_at IS NULL", ot.now(), call.id);
    ot.run("DELETE FROM ot_live_calls WHERE id=?", call.id);
  }
}

export function changeGroup(ot: OtContext, group: Group, actor: string, change: GroupAction) {
  assert(ordinaryGroup(group) && group.group_archived_at === null, 404,"conversation_not_found","No such group conversation");
  const members = roster(ot, group);
  const access = permissions(ot, group, actor, members);
  assert(access.active_member_ids.includes(actor), 404,"conversation_not_found","No such group conversation");
  const owner = access.owner_id;
  switch (change.action) {
    case "reply_policy": {
      assert(actor === owner && managedGroup(group), 403,"forbidden","只有群主可以设置智能体回复策略。");
      if (change.mode === "lead") {
        const {owner_id,agent_id} = change.lead;
        assert(access.active_member_ids.includes(owner_id) && ot.get(`SELECT 1 FROM ot_conversation_agents
          WHERE conversation_id=? AND owner_id=? AND agent_ref=? AND direct_grant_id IS NULL`, group.id,owner_id,agent_id),
        409,"group_reply_lead_unavailable","所选智能体已无法在此群聊回复，请重新选择。");
      }
      const {action: _,...policy} = change;
      const saved = readGroupReplyPolicy(group);
      if (JSON.stringify(saved) === JSON.stringify(policy)) return false;
      const encoded = change.mode === "default" ? null : JSON.stringify(policy);
      ot.run(`UPDATE ot_conversations SET group_reply_policy=?,group_revision=group_revision+1,activity_revision=activity_revision+1
        WHERE id=?`, encoded,group.id);
      break;
    }
    case "rename":
      assert(access.can_rename, 403,"forbidden","Only the group owner may rename it");
      if (change.title === group.title) return false;
      ot.run("UPDATE ot_conversations SET title=?,updated_at=? WHERE id=?", change.title,ot.now(),group.id);
      break;
    case "remove":
      assert(actor === owner, 403,"forbidden","Only the group owner may remove members");
      assert(change.member_id !== owner, 400,"invalid_request","Use the leave action for your own membership");
      assert(members.some(member => member.id === change.member_id), 404,"member_not_found","No such group member");
      evict(ot, group, change.member_id);
      ot.run("DELETE FROM ot_group_invites WHERE conversation_id=?", group.id);
      break;
    case "transfer":
      assert(actor === owner || access.can_transfer, 403,"forbidden","Only the current group owner or an active team manager may transfer it");
      assert(change.member_id !== owner && access.active_member_ids.includes(change.member_id),
        404,"member_not_found","Select an active group member");
      ot.run("UPDATE ot_conversations SET group_owner_id=? WHERE id=?", change.member_id,group.id);
      ot.run("DELETE FROM ot_group_invites WHERE conversation_id=?", group.id);
      break;
    case "leave":
      assert(!access.leave_requires_transfer, 409,"group_owner_transfer_required","请先把群主转让给其他成员。");
      if (actor === owner) {
        ot.run("UPDATE ot_conversations SET group_archived_at=? WHERE id=?",ot.now(),group.id);
        evict(ot,group);
        ot.run("DELETE FROM ot_group_invites WHERE conversation_id=?", group.id);
      } else evict(ot,group,actor);
      break;
  }
  return true;
}
