// Trusted platform → Bot Social membership migration. Fixture accounts only.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bulkAuth, startServer } from "./helpers.js";
import { canonicalDigest } from "../src/flybot-workspace/migrate.js";

let S: Awaited<ReturnType<typeof startServer>>;
const KEY = "ot-migrate-test-key-which-is-32chars!!";
const prevKey = process.env.FLYBOT_WORKSPACE_SOCIAL_MIGRATE_KEY;
const prevFile = process.env.FLYBOT_WORKSPACE_SOCIAL_MIGRATE_KEY_FILE;

before(async () => {
  process.env.FLYBOT_WORKSPACE_SOCIAL_MIGRATE_KEY = KEY;
  delete process.env.FLYBOT_WORKSPACE_SOCIAL_MIGRATE_KEY_FILE;
  S = await startServer(bulkAuth);
});
after(async () => {
  await S.stop();
  if (prevKey === undefined) delete process.env.FLYBOT_WORKSPACE_SOCIAL_MIGRATE_KEY;
  else process.env.FLYBOT_WORKSPACE_SOCIAL_MIGRATE_KEY = prevKey;
  if (prevFile === undefined) delete process.env.FLYBOT_WORKSPACE_SOCIAL_MIGRATE_KEY_FILE;
  else process.env.FLYBOT_WORKSPACE_SOCIAL_MIGRATE_KEY_FILE = prevFile;
});

const hex = (label: string) => createHash("sha256").update(label).digest("hex").slice(0, 32);

async function flyHome(name: string) {
  const r: any = await (await fetch(`${S.base}/v1/onboard/flybot`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ display_name: `${name}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}` }),
  })).json();
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(S.base + path, {
      method,
      headers: { authorization: `Bearer ${r.connector.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  };
  // The runtime obtains its attestation by resolving the connector's profile.
  const profile = await call("GET", "/v1/ot/me");
  assert.equal(profile.status, 200);
  assert.equal(profile.data.owner_id, r.owner_id);
  return {
    social_owner_id: r.owner_id as string,
    home_id: r.home.bot_id as string,
    token: r.connector.token as string,
    call,
  };
}

async function migrate(body: unknown, key = KEY) {
  const res = await fetch(S.base + "/v1/ot/ops/membership-migrate", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() as any };
}

function payload(accounts: any[], workspaces: any[]) {
  const material = { accounts, workspaces };
  return { snapshot_id: canonicalDigest(material), digest: canonicalDigest(material), accounts, workspaces };
}

test("canonical digest matches the Python snapshot convention", () => {
  assert.equal(canonicalDigest({ accounts: [], workspaces: [] }), "20f236196817f6735a91f13fa4324e35cfe10e2b0d454b15da50b75e0b64722a");
  assert.equal(canonicalDigest({
    accounts: [{ home_id: "h1", instance_id: "0".repeat(32), platform_user_id: "a".repeat(32), social_owner_id: "own" }],
    workspaces: [],
  }), "c15e5844e8ab345dc65fdc430c8daa474b92ac6e2884ea40452d0dfc496fb5d5");
});

test("migrate refuses a missing or short key and a wrong key, and does not auto-generate one", async () => {
  const saved = process.env.FLYBOT_WORKSPACE_SOCIAL_MIGRATE_KEY;
  delete process.env.FLYBOT_WORKSPACE_SOCIAL_MIGRATE_KEY;
  assert.equal((await migrate({ snapshot_id: "x".repeat(32), digest: "ab".repeat(32), accounts: [], workspaces: [] })).status, 503);
  process.env.FLYBOT_WORKSPACE_SOCIAL_MIGRATE_KEY = saved;
  assert.equal((await migrate({ snapshot_id: "x".repeat(32), digest: "ab".repeat(32), accounts: [], workspaces: [] }, "short")).status, 401);
  assert.equal((await migrate({ snapshot_id: "x".repeat(32), digest: "ab".repeat(32), accounts: [], workspaces: [] }, "x".repeat(32) + "nope")).status, 401);
});

test("imports a fixture workspace with members, history, and invite states without minting or replaying", async () => {
  const owner = await flyHome("alice");
  const member = await flyHome("bob");
  const outsider = await flyHome("cara");
  const ownerUser = hex("owner");
  const memberUser = hex("member");
  const instOwner = hex("inst-owner");
  const instMember = hex("inst-member");
  const workspace = hex("workspace");
  const inviteLive = hex("invite-live");
  const inviteRevoked = hex("invite-revoked");
  const pendingReq = hex("join-pending");
  const convo = hex("convo-group");
  const msg = hex("message-1");
  const agentMsg = hex("message-agent");
  const agent = hex("agent-1");
  const now = 1_800_000_000_000;
  const liveToken = "live-invite-token-value-for-fixture-xx";
  const revokedToken = "revoked-invite-token-value-fixture-xx";
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");

  const accounts = [
    { platform_user_id: ownerUser, instance_id: instOwner, social_owner_id: owner.social_owner_id, home_id: owner.home_id },
    { platform_user_id: memberUser, instance_id: instMember, social_owner_id: member.social_owner_id, home_id: member.home_id },
  ];
  const workspaces = [{
    workspace_id: workspace,
    name: "Fixture Studio",
    slug: `fix-${workspace.slice(0, 8)}`,
    created_at: now,
    owner_platform_user_id: ownerUser,
    listed: true,
    summary: "fixture only",
    members: [
      { platform_user_id: ownerUser, role: "owner", created_at: now, suspended: false, added_by_platform_user_id: ownerUser },
      { platform_user_id: memberUser, role: "member", created_at: now + 1, suspended: false, added_by_platform_user_id: ownerUser },
    ],
    invites: [
      { id: inviteLive, token_hash: hash(liveToken), role: "member", created_at: now, expires_at: now + 86_400_000, created_by: ownerUser, max_uses: 2, use_count: 0, revoked: false, frozen: false, requires_approval: false },
      { id: inviteRevoked, token_hash: hash(revokedToken), role: "member", created_at: now, expires_at: now + 86_400_000, created_by: ownerUser, max_uses: 2, use_count: 0, revoked: true, frozen: false, requires_approval: false },
    ],
    join_requests: [
      { id: pendingReq, invite_id: inviteLive, platform_user_id: memberUser, role: "member", status: "rejected", created_at: now, decided_at: now + 2, decided_by: ownerUser },
    ],
    conversations: [{
      id: convo,
      kind: "group",
      title: "Standup",
      created_at: now,
      updated_at: now + 5,
      created_by: ownerUser,
      member_ids: [ownerUser, memberUser],
      reads: { [ownerUser]: 2, [memberUser]: 1 },
      pins: {},
      mutes: {},
      agents: [{ agent_ref: agent, name: "Note Bot", owner_platform_user_id: ownerUser, created_at: now, auto_reply: false }],
      messages: [
        { id: msg, seq: 1, platform_user_id: ownerUser, author_kind: "member", body: "hello fixture", created_at: now + 3, retracted: false, client_key: "legacy:" + msg, reactions: [{ platform_user_id: memberUser, emoji: "👍", created_at: now + 4 }] },
        { id: agentMsg, seq: 2, platform_user_id: ownerUser, owner_platform_user_id: ownerUser, author_kind: "agent", agent_ref: agent, agent_name: "Note Bot", body: "noted", created_at: now + 5, retracted: false, client_key: "legacy-agent:" + agentMsg, reactions: [] },
      ],
    }],
  }];

  const first = await migrate(payload(accounts, workspaces));
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.idempotent, false);
  assert.equal(first.data.workspaces, 1);
  assert.deepEqual(first.data.team_ids, [workspace]);

  const again = await migrate(payload(accounts, workspaces));
  assert.equal(again.status, 200);
  assert.equal(again.data.idempotent, true);
  assert.deepEqual(again.data.team_ids, [workspace]);

  const team = await owner.call("GET", `/v1/ot/teams/${workspace}`);
  assert.equal(team.status, 200);
  assert.equal(team.data.name, "Fixture Studio");
  const members = await owner.call("GET", `/v1/ot/teams/${workspace}/members`);
  assert.deepEqual(members.data.members.map((m: any) => m.role).sort(), ["member", "owner"]);

  const history = await owner.call("GET", `/v1/ot/conversations/${convo}/messages`);
  assert.equal(history.status, 200);
  const ids = history.data.messages.map((m: any) => m.id);
  assert.deepEqual(ids, [msg, agentMsg]);
  assert.equal(history.data.messages[0].body, "hello fixture");
  assert.equal(history.data.messages[1].author.kind, "agent");

  // A revoked fixture invite must not become membership for an outsider.
  const revoked = await outsider.call("POST", "/v1/ot/invites/accept", { code: revokedToken });
  assert.equal(revoked.status, 410);
  assert.equal((await outsider.call("GET", "/v1/ot/teams")).data.teams?.length ?? 0, 0);

  // The preserved live invite hash still works; this is not a newly minted code.
  const accepted = await outsider.call("POST", "/v1/ot/invites/accept", { code: liveToken });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  assert.equal(accepted.data.status, "member");
});

test("conflicting existing Social membership is refused and rolled back", async () => {
  const owner = await flyHome("dana");
  const other = await flyHome("ed");
  const user = hex("conflict-owner");
  const inst = hex("conflict-inst");
  const workspace = hex("conflict-ws");
  const now = 1_800_000_100_000;
  const created = await owner.call("POST", "/v1/ot/teams", { name: "Already Bound", slug: `bound-${workspace.slice(0, 8)}` });
  assert.ok(created.status < 300, JSON.stringify(created.data));
  // Manually bind that team to the workspace id with a different owner would require SQL; instead
  // apply a snapshot that claims this workspace UUID as a new team while a different mapping is absent,
  // then apply a second snapshot whose existing team (same workspace id after first success) has a wrong owner.
  const accounts = [
    { platform_user_id: user, instance_id: inst, social_owner_id: owner.social_owner_id, home_id: owner.home_id },
  ];
  const ok = await migrate(payload(accounts, [{
    workspace_id: workspace, name: "Source of Truth", created_at: now, owner_platform_user_id: user,
    listed: false, summary: "", members: [
      { platform_user_id: user, role: "owner", created_at: now, suspended: false, added_by_platform_user_id: user },
    ], invites: [], join_requests: [], conversations: [],
  }]));
  assert.equal(ok.status, 200, JSON.stringify(ok.data));

  const wrongUser = hex("wrong-owner");
  const wrongInst = hex("wrong-inst");
  const stolen = await migrate(payload([
    { platform_user_id: wrongUser, instance_id: wrongInst, social_owner_id: other.social_owner_id, home_id: other.home_id },
  ], [{
    workspace_id: workspace, name: "Hijack", created_at: now, owner_platform_user_id: wrongUser,
    listed: false, summary: "", members: [
      { platform_user_id: wrongUser, role: "owner", created_at: now, suspended: false, added_by_platform_user_id: wrongUser },
    ], invites: [], join_requests: [], conversations: [],
  }]));
  assert.equal(stolen.status, 409);
  assert.equal(stolen.data.error.code, "membership_migration_conflict");
  const still = await owner.call("GET", `/v1/ot/teams/${workspace}`);
  assert.equal(still.status, 200);
  assert.equal(still.data.name, "Source of Truth");
});

test("an unattested home or a name-only identity is refused", async () => {
  const owner = await flyHome("fay");
  const user = hex("missing-peer");
  const inst = hex("missing-inst");
  const workspace = hex("missing-ws");
  const now = 1_800_000_200_000;
  const peer = hex("ghost-user");
  const res = await migrate(payload([
    { platform_user_id: user, instance_id: inst, social_owner_id: owner.social_owner_id, home_id: owner.home_id },
  ], [{
    workspace_id: workspace, name: "Needs Peer", created_at: now, owner_platform_user_id: user,
    listed: false, summary: "", members: [
      { platform_user_id: user, role: "owner", created_at: now, suspended: false, added_by_platform_user_id: user },
      { platform_user_id: peer, role: "member", created_at: now, suspended: false, added_by_platform_user_id: user },
    ], invites: [], join_requests: [], conversations: [],
  }]));
  assert.equal(res.status, 409);
  assert.equal(res.data.error.code, "membership_migration_conflict");
  assert.equal((await owner.call("GET", `/v1/ot/teams/${workspace}`)).status, 404);

  const file = join(tmpdir(), `ot-migrate-key-${Date.now()}`);
  writeFileSync(file, KEY, { mode: 0o600 });
  process.env.FLYBOT_WORKSPACE_SOCIAL_MIGRATE_KEY_FILE = file;
  delete process.env.FLYBOT_WORKSPACE_SOCIAL_MIGRATE_KEY;
  const viaFile = await migrate(payload([
    { platform_user_id: user, instance_id: inst, social_owner_id: owner.social_owner_id, home_id: owner.home_id },
  ], [{
    workspace_id: hex("other-ws"), name: "File Key", created_at: now, owner_platform_user_id: user,
    listed: false, summary: "", members: [
      { platform_user_id: user, role: "owner", created_at: now, suspended: false, added_by_platform_user_id: user },
    ], invites: [], join_requests: [], conversations: [],
  }]));
  assert.equal(viaFile.status, 200, JSON.stringify(viaFile.data));
  process.env.FLYBOT_WORKSPACE_SOCIAL_MIGRATE_KEY = KEY;
  delete process.env.FLYBOT_WORKSPACE_SOCIAL_MIGRATE_KEY_FILE;
});
