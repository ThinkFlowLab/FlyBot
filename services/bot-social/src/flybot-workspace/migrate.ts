// Privileged, idempotent platform → Bot Social membership migration.
// Authority is a manager-attested (platform user, isolated runtime, Social
// owner/home) tuple plus a consistent platform snapshot. Display names, first
// visitors, and a pre-existing workspace mapping are not proof of ownership.
// Conflicting Social state is refused; this path never mints invite codes or
// replays history as new sends.
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError, assert } from "../errors.js";
import { OtContext } from "./core.js";

export const MIGRATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS ot_migrate_receipts (
  digest TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL, applied_at INTEGER NOT NULL, result TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ot_legacy_ids (
  kind TEXT NOT NULL, platform_id TEXT NOT NULL, social_id TEXT NOT NULL,
  PRIMARY KEY (kind, platform_id), UNIQUE (kind, social_id)
);
`;

const HEX = /^[0-9a-f]{32}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const OWNER = /^[A-Za-z0-9._:-]{1,80}$/;
const ROLE = new Set(["owner", "admin", "member"]);
const ASSIGNABLE = new Set(["admin", "member"]);
const REQUEST_STATUS = new Set(["pending", "approved", "rejected"]);

export function canonicalDigest(value: unknown) {
  return createHash("sha256").update(stable(value), "utf8").digest("hex");
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stable(obj[k])}`).join(",")}}`;
}

function text(value: unknown, name: string, pattern?: RegExp, max = 80) {
  assert(typeof value === "string" && value.length > 0 && value.length <= max, 400, "invalid_request", `${name} is required`);
  assert(!pattern || pattern.test(value), 400, "invalid_request", `${name} is invalid`);
  return value;
}

function intMs(value: unknown, name: string) {
  assert(Number.isSafeInteger(value) && (value as number) >= 0, 400, "invalid_request", `${name} must be a non-negative integer`);
  return value as number;
}

function conflict(message: string, extra: Record<string, unknown> = {}): never {
  throw new ApiError(409, "membership_migration_conflict", message, extra);
}

export function loadMigrateKey(env = process.env) {
  const path = env.FLYBOT_WORKSPACE_SOCIAL_MIGRATE_KEY_FILE;
  if (path) {
    try { return readFileSync(path, "utf8").trim(); }
    catch (error: any) {
      if (error?.code === "ENOENT") return null;
      throw new ApiError(503, "migrate_key_unavailable", "membership migrate key is unavailable");
    }
  }
  const raw = env.FLYBOT_WORKSPACE_SOCIAL_MIGRATE_KEY?.trim();
  return raw || null;
}

export function requireMigrateKey(req: FastifyRequest, env = process.env) {
  const configured = loadMigrateKey(env);
  assert(configured && configured.length >= 32, 503, "migrate_key_unconfigured", "membership migrate key is not configured");
  const header = String(req.headers.authorization || "");
  const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : String(req.headers["x-ot-migrate-key"] || "").trim();
  const a = Buffer.from(configured);
  const b = Buffer.from(presented);
  // Compare equal-length SHA-256 digests so the raw key length is not leaked.
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  assert(presented.length >= 32 && timingSafeEqual(ha, hb) && a.length === b.length && timingSafeEqual(a, b), 401, "unauthorized", "migrate key rejected");
}

function mapUser(accounts: Map<string, any>, platformId: string, field: string) {
  const row = accounts.get(platformId);
  if (!row) conflict("snapshot references an unattested platform account", { platform_user_id: platformId, field });
  return row.social_owner_id as string;
}

function remember(ot: OtContext, kind: string, platformId: string, socialId: string) {
  const prior = ot.get<any>("SELECT social_id FROM ot_legacy_ids WHERE kind = ? AND platform_id = ?", kind, platformId);
  if (prior && prior.social_id !== socialId) conflict("legacy id is already mapped differently", { kind, platform_id: platformId });
  const taken = ot.get<any>("SELECT platform_id FROM ot_legacy_ids WHERE kind = ? AND social_id = ?", kind, socialId);
  if (taken && taken.platform_id !== platformId) conflict("social id is already mapped to another platform row", { kind, social_id: socialId });
  if (!prior) ot.run("INSERT INTO ot_legacy_ids(kind, platform_id, social_id) VALUES (?,?,?)", kind, platformId, socialId);
}

function bindAccounts(ot: OtContext, accounts: any[]) {
  const mapped = new Map<string, any>();
  for (const row of accounts) {
    const platformId = text(row?.platform_user_id, "platform_user_id", HEX);
    const socialOwnerId = text(row?.social_owner_id, "social_owner_id", OWNER);
    const instanceId = text(row?.instance_id, "instance_id", HEX);
    const homeId = text(row?.home_id, "home_id", OWNER);
    const home = ot.get<any>("SELECT id, owner_id, integration_type, status FROM bots WHERE id = ?", homeId);
    assert(home && home.owner_id === socialOwnerId && home.integration_type === "flybot-home" && home.status !== "deleted", 409, "membership_migration_conflict", "attested home is not this owner's provisioned FlyBot home", { instance_id: instanceId });
    assert(ot.get("SELECT 1 FROM ot_profiles WHERE owner_id = ?", socialOwnerId), 409, "membership_migration_conflict", "attested Social owner has no profile");
    const taken = ot.get<any>("SELECT owner_id, platform_user_id FROM ot_profiles WHERE platform_user_id = ?", platformId);
    if (taken && taken.owner_id !== socialOwnerId) conflict("platform user is already bound to a different Social owner", { platform_user_id: platformId });
    const existing = ot.get<any>("SELECT platform_user_id FROM ot_profiles WHERE owner_id = ?", socialOwnerId);
    if (existing?.platform_user_id && existing.platform_user_id !== platformId) conflict("Social owner is already bound to a different platform user", { social_owner_id: socialOwnerId });
    if (!existing?.platform_user_id) {
      ot.run("UPDATE ot_profiles SET platform_user_id = ?, updated_at = ? WHERE owner_id = ?", platformId, ot.now(), socialOwnerId);
    }
    mapped.set(platformId, { ...row, platform_user_id: platformId, social_owner_id: socialOwnerId });
  }
  const byOwner = new Map<string, string>();
  for (const [platformId, row] of mapped) {
    const prior = byOwner.get(row.social_owner_id);
    if (prior && prior !== platformId) conflict("one Social owner is attested to multiple platform users", { social_owner_id: row.social_owner_id });
    byOwner.set(row.social_owner_id, platformId);
  }
  return mapped;
}

function sameMember(a: { role: string; suspended: number; created_at: number }, b: { role: string; suspended: number; created_at: number }) {
  return a.role === b.role && !!a.suspended === !!b.suspended && a.created_at === b.created_at;
}

function applyWorkspace(ot: OtContext, accounts: Map<string, any>, workspace: any) {
  const workspaceId = text(workspace?.workspace_id, "workspace_id", HEX);
  const name = typeof workspace?.name === "string" && workspace.name.trim() ? String(workspace.name).slice(0, 60) : "Workspace";
  const createdAt = intMs(workspace?.created_at, "created_at");
  const ownerPlatform = text(workspace?.owner_platform_user_id, "owner_platform_user_id", HEX);
  const ownerId = mapUser(accounts, ownerPlatform, "owner");
  const members = Array.isArray(workspace?.members) ? workspace.members : [];
  const expected = new Map<string, { role: string; suspended: number; created_at: number; added_by: string }>();
  let sawOwner = false;
  for (const row of members) {
    const platformId = text(row?.platform_user_id, "member.platform_user_id", HEX);
    const socialId = mapUser(accounts, platformId, "member");
    const role = text(row?.role, "member.role");
    assert(ROLE.has(role), 400, "invalid_request", "member role is invalid");
    if (role === "owner") {
      assert(socialId === ownerId, 409, "membership_migration_conflict", "workspace owner does not match owner membership");
      sawOwner = true;
    }
    const created = intMs(row?.created_at, "member.created_at");
    const suspended = row?.suspended ? 1 : 0;
    assert(!(role === "owner" && suspended), 409, "membership_migration_conflict", "an owner cannot be suspended");
    const addedBy = row?.added_by_platform_user_id ? mapUser(accounts, text(row.added_by_platform_user_id, "added_by", HEX), "added_by") : ownerId;
    expected.set(socialId, { role, suspended, created_at: created, added_by: addedBy });
  }
  assert(sawOwner && expected.has(ownerId), 400, "invalid_request", "workspace snapshot must include the owner membership");

  const existing = ot.get<any>("SELECT * FROM ot_teams WHERE workspace_id = ?", workspaceId);
  let teamId: string;
  if (existing) {
    if (existing.owner_id !== ownerId) conflict("workspace is already bound to a different Social owner", { workspace_id: workspaceId });
    const current = ot.all<any>("SELECT owner_id, role, suspended, created_at FROM ot_team_members WHERE team_id = ?", existing.id);
    for (const row of current) {
      const want = expected.get(row.owner_id);
      if (!want || !sameMember(row, want)) conflict("existing Social membership does not match the platform snapshot", { workspace_id: workspaceId });
    }
    teamId = existing.id;
    const listed = workspace?.listed ? 1 : 0;
    const summary = typeof workspace?.summary === "string" ? String(workspace.summary).slice(0, 200) : existing.summary;
    const slug = typeof workspace?.slug === "string" && workspace.slug ? workspace.slug : existing.slug;
    if (slug && slug !== existing.slug) {
      const taken = ot.get("SELECT 1 FROM ot_teams WHERE slug = ? AND id != ?", slug, existing.id);
      if (taken) conflict("team slug already exists", { workspace_id: workspaceId });
    }
    ot.run("UPDATE ot_teams SET name = ?, summary = ?, listed = ?, slug = COALESCE(?, slug), updated_at = ? WHERE id = ?",
      name, summary, listed, slug || null, ot.now(), existing.id);
  } else {
    if (workspace?.slug) {
      assert(!ot.get("SELECT 1 FROM ot_teams WHERE slug = ?", workspace.slug), 409, "membership_migration_conflict", "team slug already exists");
    }
    teamId = workspaceId; // preserve the workspace UUID as the Social team id and mapping.
    ot.run("INSERT INTO ot_teams(id, slug, name, owner_id, summary, listed, workspace_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
      teamId, workspace?.slug ?? null, name, ownerId, typeof workspace?.summary === "string" ? String(workspace.summary).slice(0, 200) : "", workspace?.listed ? 1 : 0, workspaceId, createdAt, createdAt);
  }
  remember(ot, "workspace", workspaceId, teamId);
  for (const [socialId, row] of expected) {
    const have = ot.get<any>("SELECT role, suspended, created_at FROM ot_team_members WHERE team_id = ? AND owner_id = ?", teamId, socialId);
    if (!have) {
      ot.run("INSERT INTO ot_team_members(team_id, owner_id, role, suspended, added_by, created_at) VALUES (?,?,?,?,?,?)",
        teamId, socialId, row.role, row.suspended, row.added_by, row.created_at);
    }
  }

  for (const invite of workspace?.invites ?? []) {
    const id = text(invite?.id, "invite.id", HEX);
    const role = text(invite?.role, "invite.role");
    assert(ASSIGNABLE.has(role), 400, "invalid_request", "invite role is invalid");
    const codeHash = text(invite?.token_hash, "invite.token_hash", DIGEST);
    const created = intMs(invite?.created_at, "invite.created_at");
    const expires = intMs(invite?.expires_at, "invite.expires_at");
    const createdBy = mapUser(accounts, text(invite?.created_by, "invite.created_by", HEX), "invite.created_by");
    const maxUses = intMs(invite?.max_uses, "invite.max_uses");
    const useCount = intMs(invite?.use_count, "invite.use_count");
    const revoked = invite?.revoked ? 1 : 0;
    const frozen = invite?.frozen ? 1 : 0;
    const requiresApproval = invite?.requires_approval ? 1 : 0;
    // Never mint a fresh invite code. Store the original token hash only.
    const prior = ot.get<any>("SELECT * FROM ot_invites WHERE id = ?", id);
    const hashed = ot.get<any>("SELECT * FROM ot_invites WHERE code_hash = ?", codeHash);
    const fields = { team_id: teamId, code_hash: codeHash, role, expires_at: expires, max_uses: maxUses, use_count: useCount, revoked, frozen, requires_approval: requiresApproval, created_by: createdBy, created_at: created };
    const same = (row: any) => row.team_id === fields.team_id && row.code_hash === fields.code_hash && row.role === fields.role
      && row.expires_at === fields.expires_at && row.max_uses === fields.max_uses && row.use_count === fields.use_count
      && !!row.revoked === !!fields.revoked && !!row.frozen === !!fields.frozen && !!row.requires_approval === !!fields.requires_approval
      && row.created_by === fields.created_by && row.created_at === fields.created_at;
    if (prior && !same(prior)) conflict("existing invite does not match the snapshot", { invite_id: id });
    if (hashed && hashed.id !== id) conflict("invite token hash already used by another invite", { invite_id: id });
    if (!prior) {
      ot.run("INSERT INTO ot_invites(id, team_id, code_hash, role, expires_at, max_uses, use_count, revoked, frozen, requires_approval, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        id, teamId, codeHash, role, expires, maxUses, useCount, revoked, frozen, requiresApproval, createdBy, created);
    }
    remember(ot, "invite", id, id);
  }

  for (const request of workspace?.join_requests ?? []) {
    const id = text(request?.id, "join_request.id", HEX);
    const status = text(request?.status, "join_request.status");
    assert(REQUEST_STATUS.has(status), 400, "invalid_request", "join request status is invalid");
    const role = text(request?.role, "join_request.role");
    assert(ASSIGNABLE.has(role), 400, "invalid_request", "join request role is invalid");
    const owner = mapUser(accounts, text(request?.platform_user_id, "join_request.platform_user_id", HEX), "join_request");
    const created = intMs(request?.created_at, "join_request.created_at");
    const decidedAt = request?.decided_at == null ? null : intMs(request.decided_at, "join_request.decided_at");
    const decidedBy = request?.decided_by ? mapUser(accounts, text(request.decided_by, "join_request.decided_by", HEX), "join_request.decided_by") : null;
    const inviteId = request?.invite_id ? text(request.invite_id, "join_request.invite_id", HEX) : null;
    const member = expected.get(owner);
    // Approved/rejected history cannot become a live member unless the snapshot already lists them.
    if (status === "approved" && !member) conflict("approved join request is missing from membership snapshot", { join_request_id: id });
    if (status === "pending" && member && !member.suspended) conflict("pending join request cannot also be an active member", { join_request_id: id });
    const prior = ot.get<any>("SELECT * FROM ot_join_requests WHERE id = ?", id);
    const taken = ot.get<any>("SELECT * FROM ot_join_requests WHERE team_id = ? AND owner_id = ?", teamId, owner);
    const same = (row: any) => row.team_id === teamId && row.owner_id === owner && row.role === role && row.status === status
      && row.created_at === created && (row.decided_at ?? null) === decidedAt && (row.decided_by ?? null) === decidedBy
      && (row.invite_id ?? null) === inviteId;
    if (prior && !same(prior)) conflict("existing join request does not match the snapshot", { join_request_id: id });
    if (taken && taken.id !== id) conflict("join request already exists for this member", { join_request_id: id });
    if (!prior) {
      ot.run("INSERT INTO ot_join_requests(id, team_id, owner_id, invite_id, role, status, created_at, decided_at, decided_by) VALUES (?,?,?,?,?,?,?,?,?)",
        id, teamId, owner, inviteId, role, status, created, decidedAt, decidedBy);
    }
    remember(ot, "join_request", id, id);
  }

  for (const convo of workspace?.conversations ?? []) applyConversation(ot, accounts, teamId, expected, convo);
  return teamId;
}

function applyConversation(ot: OtContext, accounts: Map<string, any>, teamId: string, teamMembers: Map<string, any>, convo: any) {
  const id = text(convo?.id, "conversation.id", HEX);
  const kind = text(convo?.kind, "conversation.kind");
  assert(kind === "dm" || kind === "group", 400, "invalid_request", "conversation kind is invalid");
  const title = typeof convo?.title === "string" ? String(convo.title).slice(0, 200) : "";
  const created = intMs(convo?.created_at, "conversation.created_at");
  const updated = intMs(convo?.updated_at ?? convo?.created_at, "conversation.updated_at");
  const memberIds = (Array.isArray(convo?.member_ids) ? convo.member_ids : []).map((uid: unknown) => mapUser(accounts, text(uid, "conversation.member", HEX), "conversation.member"));
  if (kind === "dm") assert(memberIds.length === 2 && new Set(memberIds).size === 2, 400, "invalid_request", "direct messages must have two members");
  else assert(memberIds.length >= 1 && new Set(memberIds).size === memberIds.length, 400, "invalid_request", "conversation members are invalid");
  for (const mid of memberIds) assert(teamMembers.has(mid), 409, "membership_migration_conflict", "conversation member is not in the workspace snapshot");
  const createdBy = mapUser(accounts, text(convo?.created_by, "conversation.created_by", HEX), "conversation.created_by");
  const dmKey = kind === "dm" ? (typeof convo?.dm_key === "string" && convo.dm_key ? convo.dm_key : [...memberIds].sort().join(":")) : null;
  const prior = ot.get<any>("SELECT * FROM ot_conversations WHERE id = ?", id);
  if (prior) {
    if (prior.kind !== kind || (prior.team_id ?? null) !== teamId || prior.title !== title || prior.created_by !== createdBy || prior.created_at !== created) {
      conflict("existing conversation does not match the snapshot", { conversation_id: id });
    }
  } else if (dmKey && ot.get("SELECT 1 FROM ot_conversations WHERE dm_key = ?", dmKey)) {
    conflict("direct message key already exists", { conversation_id: id });
  } else {
    ot.run("INSERT INTO ot_conversations(id, kind, title, team_id, dm_key, created_by, last_seq, created_at, updated_at) VALUES (?,?,?,?,?,?,0,?,?)",
      id, kind, title, teamId, dmKey, createdBy, created, updated);
  }
  remember(ot, "conversation", id, id);
  const reads = convo?.reads && typeof convo.reads === "object" ? convo.reads : {};
  const pins = convo?.pins && typeof convo.pins === "object" ? convo.pins : {};
  const mutes = convo?.mutes && typeof convo.mutes === "object" ? convo.mutes : {};
  for (const mid of memberIds) {
    const platformId = [...accounts.entries()].find(([, row]) => row.social_owner_id === mid)?.[0];
    const readSeq = intMs(platformId && reads[platformId] != null ? reads[platformId] : 0, "read_seq");
    const pinned = platformId && pins[platformId] ? 1 : 0;
    const muted = platformId && mutes[platformId] ? 1 : 0;
    const have = ot.get<any>("SELECT owner_id, read_seq, pinned, muted, created_at FROM ot_conversation_members WHERE conversation_id = ? AND owner_id = ?", id, mid);
    if (have && (have.read_seq !== readSeq || !!have.pinned !== !!pinned || !!have.muted !== !!muted)) {
      conflict("existing conversation membership does not match the snapshot", { conversation_id: id });
    }
    if (!have) {
      ot.run("INSERT INTO ot_conversation_members(conversation_id, owner_id, read_seq, pinned, muted, created_at) VALUES (?,?,?,?,?,?)",
        id, mid, readSeq, pinned, muted, created);
    }
  }
  const extras = ot.all<any>("SELECT owner_id FROM ot_conversation_members WHERE conversation_id = ?", id);
  if (extras.some((row) => !memberIds.includes(row.owner_id))) conflict("existing conversation has unexpected members", { conversation_id: id });

  for (const agent of convo?.agents ?? []) {
    const ref = text(agent?.agent_ref ?? agent?.agent_id, "agent_ref", HEX);
    const owner = mapUser(accounts, text(agent?.owner_platform_user_id ?? convo?.created_by, "agent.owner", HEX), "agent.owner");
    const agentName = typeof agent?.name === "string" ? String(agent.name).slice(0, 80) : "agent";
    const auto = agent?.auto_reply ? 1 : 0;
    const agentCreated = intMs(agent?.created_at ?? created, "agent.created_at");
    const have = ot.get<any>("SELECT * FROM ot_conversation_agents WHERE conversation_id = ? AND agent_ref = ? AND owner_id = ?", id, ref, owner);
    if (have && (have.name !== agentName || !!have.auto_reply !== !!auto)) conflict("existing group agent does not match the snapshot", { conversation_id: id, agent_ref: ref });
    if (!have) ot.run("INSERT INTO ot_conversation_agents(conversation_id, agent_ref, owner_id, name, auto_reply, created_at) VALUES (?,?,?,?,?,?)",
      id, ref, owner, agentName, auto, agentCreated);
  }

  let lastSeq = prior?.last_seq ?? 0;
  for (const message of convo?.messages ?? []) {
    const mid = text(message?.id, "message.id", HEX);
    const seq = intMs(message?.seq, "message.seq");
    const authorKind = message?.author_kind === "agent" ? "agent" : "member";
    const author = authorKind === "agent"
      ? mapUser(accounts, text(message?.owner_platform_user_id ?? message?.platform_user_id, "message.owner", HEX), "message.owner")
      : mapUser(accounts, text(message?.platform_user_id, "message.author", HEX), "message.author");
    const body = message?.retracted ? "" : String(message?.body ?? "");
    assert(body.length <= 4000, 400, "invalid_request", "message body is too long");
    const createdAt = intMs(message?.created_at, "message.created_at");
    const editedAt = message?.edited_at == null ? null : intMs(message.edited_at, "message.edited_at");
    const retracted = message?.retracted ? 1 : 0;
    const agentRef = authorKind === "agent" ? text(message?.agent_ref ?? message?.agent_id, "message.agent_ref", HEX) : null;
    const agentName = authorKind === "agent" ? String(message?.agent_name ?? "agent").slice(0, 80) : null;
    const have = ot.get<any>("SELECT * FROM ot_messages WHERE id = ?", mid);
    const same = (row: any) => row.conversation_id === id && row.seq === seq && row.author_id === author && row.author_kind === authorKind
      && row.body === body && !!row.retracted === !!retracted && (row.edited_at ?? null) === editedAt
      && (row.agent_ref ?? null) === agentRef;
    if (have && !same(have)) conflict("existing message does not match the snapshot", { message_id: mid });
    const seqTaken = ot.get<any>("SELECT id FROM ot_messages WHERE conversation_id = ? AND seq = ?", id, seq);
    if (seqTaken && seqTaken.id !== mid) conflict("message sequence already used", { conversation_id: id, seq });
    if (!have) {
      // Insert with the recorded id, sequence and timestamp. This is not a send.
      ot.run("INSERT INTO ot_messages(id, conversation_id, seq, author_id, author_kind, agent_ref, agent_name, body, mentions, reply_to, client_key, created_at, edited_at, retracted, pinned_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        mid, id, seq, author, authorKind, agentRef, agentName, body, JSON.stringify(message?.mentions ?? []), message?.reply_to ?? null, message?.client_key ?? `legacy:${mid}`, createdAt, editedAt, retracted, message?.pinned_by ? mapUser(accounts, text(message.pinned_by, "pinned_by", HEX), "pinned_by") : null);
    }
    remember(ot, "message", typeof message?.platform_id === "string" ? message.platform_id : mid, mid);
    lastSeq = Math.max(lastSeq, seq);
    for (const reaction of message?.reactions ?? []) {
      const who = mapUser(accounts, text(reaction?.platform_user_id, "reaction.user", HEX), "reaction");
      const emoji = text(reaction?.emoji, "reaction.emoji");
      const at = intMs(reaction?.created_at ?? createdAt, "reaction.created_at");
      ot.run("INSERT OR IGNORE INTO ot_reactions(message_id, owner_id, emoji, created_at) VALUES (?,?,?,?)", mid, who, emoji, at);
    }
  }
  ot.run("UPDATE ot_conversations SET last_seq = ?, updated_at = ? WHERE id = ?", lastSeq, updated, id);
}

export function applyMembershipMigrate(ot: OtContext, body: any) {
  const snapshotId = text(body?.snapshot_id, "snapshot_id");
  const digest = text(body?.digest, "digest", DIGEST);
  const accounts = Array.isArray(body?.accounts) ? body.accounts : null;
  const workspaces = Array.isArray(body?.workspaces) ? body.workspaces : null;
  assert(accounts && workspaces, 400, "invalid_request", "accounts and workspaces are required");
  const material = { accounts, workspaces };
  const expected = canonicalDigest(material);
  assert(expected === digest, 400, "invalid_request", "snapshot digest does not match the payload");
  const receipt = ot.get<any>("SELECT result, snapshot_id FROM ot_migrate_receipts WHERE digest = ?", digest);
  if (receipt) return { ...JSON.parse(receipt.result), idempotent: true };
  try {
    return ot.tx(() => {
      const mapped = bindAccounts(ot, accounts);
      const teamIds: string[] = [];
      for (const workspace of workspaces) teamIds.push(applyWorkspace(ot, mapped, workspace));
      const result = { snapshot_id: snapshotId, digest, workspaces: teamIds.length, accounts: mapped.size, team_ids: teamIds };
      ot.run("INSERT INTO ot_migrate_receipts(digest, snapshot_id, applied_at, result) VALUES (?,?,?,?)", digest, snapshotId, ot.now(), JSON.stringify(result));
      return { ...result, idempotent: false };
    });
  } catch (error: any) {
    if (error instanceof ApiError) throw error;
    const message = String(error?.message ?? error);
    if (/UNIQUE|FOREIGN KEY|constraint/i.test(message)) conflict("existing Social rows conflict with the snapshot");
    throw error;
  }
}

export function registerMigrate(app: FastifyInstance, ot: OtContext) {
  ot.db.exec(MIGRATE_SCHEMA);
  app.post("/v1/ot/ops/membership-migrate", { bodyLimit: 32 * 1024 * 1024 }, async (req) => {
    requireMigrateKey(req);
    return applyMembershipMigrate(ot, req.body);
  });
}
