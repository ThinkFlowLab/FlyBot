import assert from "node:assert/strict";
import { test } from "node:test";
import { hashToken } from "../src/crypto.js";
import { randomToken } from "../src/ids.js";
import { ownerWithBot, startServer } from "./helpers.js";

// #177: revocation is final — a revoked Bot can only come back as a newly created identity.
//
// ① The injection point is `rotateBotToken`: it revokes the old token and mints a fresh one without looking
//    at `status`, so the owner can hand a revoked identity a working token again. It must answer 403
//    `bot_revoked` instead, minting nothing and writing no `bot.token_rotated` audit.
// ③ `listEvents` is defense in depth: a bot token row that still exists while the identity is revoked must
//    not read the pre-revocation event queue.
//
// `frozen` behavior is unchanged: a frozen Bot's owner can still rotate its token, read its events and
// resume it (`test/frozen_bot_reach.test.ts:78-79` deliberately allows the rotation).

const req = async (base: string, method: string, path: string, token?: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
};

type Server = Awaited<ReturnType<typeof startServer>>;

/** A home with one member Bot holding a live token; then that member is removed (status `revoked`).
 *  With `inbound`, a peer asks to be friends first, so the member's event queue has history at removal. */
async function revokedBot(s: Server, name: string, inbound = false) {
  const fly = s.platform.onboardFlybot({ display_name: "Rivet" });
  const login = await req(s.base, "POST", "/v1/auth/login", undefined, { username: fly.username, password: fly.generated_password });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const ownerToken = login.body.owner_token as string;
  const added = await req(s.base, "POST", `/v1/homes/${fly.home.bot_id}/members`, ownerToken, { name, display_name: name });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const botId = added.body.bot_id as string;
  const handle = added.body.handle as string;
  if (inbound) {
    const peer = await ownerWithBot(s.base, `${name}-peer`);
    const asked = await peer.owner.req("POST", "/v1/relationships", { from_bot_id: peer.bot.id, target_handle: handle, message: "before the removal", requested_capabilities: ["chat.public"] });
    assert.ok(asked.relationship_id);
  }
  // One rotation while the Bot is still active: the only `bot.token_rotated` a correct build ever writes.
  const before = await req(s.base, "POST", `/v1/bots/${botId}/token`, ownerToken);
  assert.equal(before.status, 200, JSON.stringify(before.body));
  const removed = await req(s.base, "DELETE", `/v1/homes/${fly.home.bot_id}/members/${botId}`, ownerToken);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.status, "revoked");
  return { ownerToken, botId, oldToken: before.body.bot_token as string };
}

test("a revoked Bot cannot be issued a token again", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { ownerToken, botId, oldToken } = await revokedBot(s, "gone");

  const rotated = await req(s.base, "POST", `/v1/bots/${botId}/token`, ownerToken);
  assert.equal(rotated.status, 403, `rotating a revoked Bot's token must be refused, got ${rotated.status} ${JSON.stringify(rotated.body)}`);
  assert.equal(rotated.body.error.code, "bot_revoked");
  assert.equal(rotated.body.bot_token, undefined, "no token is minted");

  // The identity stays revoked, and the token from before the removal stays dead.
  const me = await req(s.base, "GET", "/v1/me", ownerToken);
  assert.equal(me.status, 200, JSON.stringify(me.body));
  assert.equal(me.body.bots.find((b: any) => b.id === botId).status, "revoked");
  assert.equal((await req(s.base, "GET", "/v1/me", oldToken)).status, 401);
});

test("a removed Bot's last rotation was the one before the removal", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { ownerToken, botId } = await revokedBot(s, "audited");

  const refused = await req(s.base, "POST", `/v1/bots/${botId}/token`, ownerToken);
  assert.equal(refused.status, 403, JSON.stringify(refused.body));

  const audit = await req(s.base, "GET", `/v1/audit-events?subject=${botId}`, ownerToken);
  assert.equal(audit.status, 200, JSON.stringify(audit.body));
  const rotated = audit.body.events.filter((e: any) => e.action === "bot.token_rotated");
  assert.equal(rotated.length, 1, "no bot.token_rotated audit is written after the revocation");
  const revoked = audit.body.events.find((e: any) => e.action === "home.member_revoked");
  assert.ok(revoked, "the revocation itself is audited");
  assert.ok(rotated[0].ts <= revoked.ts, "the one rotation happened before the revocation");
});

test("a removed Bot's old token stays unauthorized everywhere", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { oldToken } = await revokedBot(s, "stale");
  for (const path of ["/v1/events", "/v1/me", "/v1/relationships"]) {
    const r = await req(s.base, "GET", path, oldToken);
    assert.equal(r.status, 401, `${path} must refuse a revoked Bot's old token, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error.code, "unauthorized");
  }
});

test("a safe-mode token row that outlives the revocation cannot read the event queue", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { botId } = await revokedBot(s, "sleeper", true);
  const queued = (s.platform as any).get("SELECT COUNT(*) n FROM events WHERE bot_id = ?", botId).n as number;
  assert.equal(queued, 1, "the pre-revocation relationship request is still in the queue");

  // The product code must be able to mint no token here, so the test writes the row itself: this is the
  // defense-in-depth case listEvents has to cover once a token exists at all.
  const token = randomToken("btk");
  (s.platform as any).run("INSERT INTO tokens (token_hash, kind, subject_id, created_at) VALUES (?,?,?,?)", hashToken(token), "bot", botId, new Date().toISOString());

  const events = await req(s.base, "GET", "/v1/events", token);
  assert.equal(events.status, 403, `a revoked identity's token must not read its event queue, got ${events.status} ${JSON.stringify(events.body)}`);
  assert.equal(events.body.error.code, "bot_revoked");
  assert.equal(events.body.events, undefined, "no pre-revocation events leave");
});

test("a frozen Bot's owner can still rotate the token and read its events, then resume", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "chilled");
  const stopped = await A.owner.req("POST", "/v1/emergency-stop", { bot_id: A.bot.id });
  assert.equal(stopped.status, "frozen");

  const rotated = await A.owner.req("POST", `/v1/bots/${A.bot.id}/token`);
  assert.ok(rotated.bot_token, "a frozen Bot's owner still rotates its token");

  const events = await req(s.base, "GET", "/v1/events", rotated.bot_token);
  assert.equal(events.status, 200, `a frozen Bot still reads its events, got ${events.status} ${JSON.stringify(events.body)}`);
  assert.ok(Array.isArray(events.body.events));

  const resumed = await A.owner.req("POST", `/v1/bots/${A.bot.id}/resume`);
  assert.equal(resumed.status, "active");
});

test("the kill switch refuses a removed Bot instead of making it resumable again", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { ownerToken, botId } = await revokedBot(s, "unrevivable", true);

  // #181: `emergency-stop` used to write `status = 'frozen'` without looking at the current status, and
  // `resumeBot` accepts `frozen` — so stopping a revoked identity handed back a working token for one whose
  // invites, drafts, rooms and seats were already torn down.
  const stopped = await req(s.base, "POST", "/v1/emergency-stop", ownerToken, { bot_id: botId });
  assert.equal(stopped.status, 403, `stopping a revoked Bot must be refused, got ${stopped.status} ${JSON.stringify(stopped.body)}`);
  assert.equal(stopped.body.error.code, "bot_revoked");
  assert.equal(stopped.body.status, undefined, "no frozen status is reported");

  const me = await req(s.base, "GET", "/v1/me", ownerToken);
  assert.equal(me.body.bots.find((b: any) => b.id === botId).status, "revoked", "the identity stays revoked, not frozen");

  // Nothing the kill switch does to a frozen Bot happened to this one.
  const paused = (s.platform as any).get("SELECT COUNT(*) n FROM conversations WHERE (initiator_bot = ? OR peer_bot = ?) AND status = 'paused_stop'", botId, botId).n as number;
  assert.equal(paused, 0, "no conversation is paused");
  const audit = await req(s.base, "GET", `/v1/audit-events?subject=${botId}`, ownerToken);
  assert.equal(audit.body.events.some((e: any) => e.action === "bot.emergency_stop"), false, "no bot.emergency_stop audit is written");

  // And the door stays shut: the resume guard still refuses the identity, minting no token.
  const resumed = await req(s.base, "POST", `/v1/bots/${botId}/resume`, ownerToken);
  assert.equal(resumed.status, 403, `resuming a revoked Bot must still be refused, got ${resumed.status} ${JSON.stringify(resumed.body)}`);
  assert.equal(resumed.body.error.code, "bot_revoked");
  assert.equal("bot_token" in resumed.body, false, "no fresh token is minted");
});
