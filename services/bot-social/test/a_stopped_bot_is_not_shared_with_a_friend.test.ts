// Regression for the friend-share door closed upstream by #778 (and later idempotent far-end checks).
// Exercise real HTTP refusals, removed home members, a live-share retry and the successful control.
// Refusals must not create grants/audit claims or revoke/migrate a pre-existing share.
import assert from "node:assert/strict";
import { test } from "node:test";
import { OwnerClient } from "../src/client.js";
import { bulkAuth, expectApiError, friends, ownerWithBot, startServer } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;

const createdViaDoor = (s: Server, grantedBot: string) =>
  s.platform.audit.list({ limit: 1000 })
    .filter((e: any) => e.action === "grant.created" && e.data?.via === "grant_bot_to_friend" && e.data?.granted_bot === grantedBot);

const liveShares = (s: Server, grantorOwner: string, grantedBot: string, granteeBot: string) =>
  (s.platform.db.prepare(
    `SELECT g.id, r.requester_bot, r.target_bot, r.requester_owner, r.target_owner
       FROM grants g JOIN relationships r ON r.id = g.relationship_id
      WHERE g.grantor_owner = ? AND g.grantee_bot = ? AND g.status = 'active' AND IFNULL(g.reply_only, 0) = 0
        AND r.status IN ('active','room')`,
  ).all(grantorOwner, granteeBot) as any[])
    .filter((g) => (g.requester_owner === grantorOwner ? g.requester_bot : g.target_bot) === grantedBot)
    .length;

async function flyHome(base: string, name: string) {
  const onboard: any = await (await fetch(`${base}/v1/onboard/flybot`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: name, password: "secret-pw", display_name: name }),
  })).json();
  const login: any = await (await fetch(`${base}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: name, password: "secret-pw" }),
  })).json();
  return { owner: new OwnerClient(base, login.owner_token as string), owner_id: onboard.owner_id as string, homeId: onboard.home.bot_id as string };
}

async function addMember(owner: OwnerClient, homeId: string, name: string) {
  const r: any = await owner.req("POST", `/v1/homes/${homeId}/members`, { name, display_name: name.toUpperCase() });
  return { botId: r.bot_id as string, handle: r.handle as string };
}

/** Two owners who are already friends, plus one never-shared member of a FlyBot home. */
async function homeWithUnsharedMember(s: Server) {
  const A = await flyHome(s.base, "alice");
  const member = await addMember(A.owner, A.homeId, "writer");
  const B = await ownerWithBot(s.base, "bob");
  const asked: any = await A.owner.req("POST", "/v1/relationships", {
    from_bot_id: A.homeId, target_handle: B.handle, message: "hi", requested_capabilities: ["chat.public"],
  });
  await B.owner.req("POST", `/v1/relationships/${asked.relationship_id}/consent`, { decision: "accept" });
  return { A, B, member, homeRelId: asked.relationship_id as string };
}

test("a first share of a stopped Bot is refused and writes nothing", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const { A, B, member } = await homeWithUnsharedMember(s);
  const before = liveShares(s, A.owner_id, member.botId, B.bot.id);
  const beforeLines = createdViaDoor(s, member.botId).length;

  await A.owner.req("POST", "/v1/emergency-stop", { bot_id: member.botId });
  const refusal = await expectApiError(
    A.owner.req("POST", `/v1/bots/${member.botId}/grants`, { friend_bot_id: B.bot.id, friend_owner_id: B.owner_id }),
    403, "bot_frozen",
  );
  assert.match(String(refusal.message), /frozen/i);
  assert.equal(liveShares(s, A.owner_id, member.botId, B.bot.id), before, "no live share was written");
  assert.equal(createdViaDoor(s, member.botId).length, beforeLines, "no grant.created line claims the share");
});

test("a first share of a removed home member is refused and writes nothing", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const { A, B, member } = await homeWithUnsharedMember(s);
  const before = liveShares(s, A.owner_id, member.botId, B.bot.id);
  const beforeLines = createdViaDoor(s, member.botId).length;

  await A.owner.req("DELETE", `/v1/homes/${A.homeId}/members/${member.botId}`);
  const refusal = await expectApiError(
    A.owner.req("POST", `/v1/bots/${member.botId}/grants`, { friend_bot_id: B.bot.id, friend_owner_id: B.owner_id }),
    403, "bot_revoked",
  );
  assert.match(String(refusal.message), /revoked/i);
  assert.equal(liveShares(s, A.owner_id, member.botId, B.bot.id), before, "no live share was written");
  assert.equal(createdViaDoor(s, member.botId).length, beforeLines, "no grant.created line claims the share");
});

test("an already-live share is left in place after a stop; a retry still writes nothing", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const { A, B, member } = await homeWithUnsharedMember(s);
  const written: any = await A.owner.req("POST", `/v1/bots/${member.botId}/grants`, { friend_bot_id: B.bot.id, friend_owner_id: B.owner_id });
  assert.equal(written.status, "active");
  assert.equal(written.idempotent, false);
  const live = liveShares(s, A.owner_id, member.botId, B.bot.id);
  assert.equal(live >= 1, true, "the first share wrote a live row");
  const lines = createdViaDoor(s, member.botId).length;

  await A.owner.req("POST", "/v1/emergency-stop", { bot_id: member.botId });
  await expectApiError(
    A.owner.req("POST", `/v1/bots/${member.botId}/grants`, { friend_bot_id: B.bot.id, friend_owner_id: B.owner_id }),
    403, "bot_frozen",
  );
  assert.equal(liveShares(s, A.owner_id, member.botId, B.bot.id), live, "the existing share was not revoked or migrated");
  assert.equal(createdViaDoor(s, member.botId).length, lines, "the refused retry wrote no grant.created line");

  const listed: any = await A.owner.req("GET", `/v1/bots/${member.botId}/grants`);
  assert.equal((listed.grants || []).some((g: any) => !g.reply_only), true, "GET still lists the share that already existed");
});

test("the share is written while both Bots answer (control)", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const written: any = await A.owner.req("POST", `/v1/bots/${A.bot.id}/grants`, { friend_bot_id: B.bot.id, friend_owner_id: B.owner_id });
  assert.equal(written.status, "active");
  assert.equal(typeof written.grant_id, "string");
  const again: any = await A.owner.req("POST", `/v1/bots/${A.bot.id}/grants`, { friend_bot_id: B.bot.id, friend_owner_id: B.owner_id });
  assert.equal(again.idempotent, true, "a repeat of a live share is still idempotent");
  assert.equal(again.grant_id, written.grant_id);
});

test("a first share is refused when the friend's Bot is stopped", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const { A, B, member } = await homeWithUnsharedMember(s);
  const before = liveShares(s, A.owner_id, member.botId, B.bot.id);
  await B.owner.req("POST", "/v1/emergency-stop", { bot_id: B.bot.id });
  await expectApiError(
    A.owner.req("POST", `/v1/bots/${member.botId}/grants`, { friend_bot_id: B.bot.id, friend_owner_id: B.owner_id }),
    403, "bot_frozen",
  );
  assert.equal(liveShares(s, A.owner_id, member.botId, B.bot.id), before, "no live share was written");
});
