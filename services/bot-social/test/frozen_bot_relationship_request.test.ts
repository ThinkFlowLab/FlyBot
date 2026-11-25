// The kill switch closes every outbound door that names a Bot. A friend request sent from the console names one in
// `from_bot_id`, and that door read the Bot without looking at its status: a frozen (or revoked) Bot still asked for
// a friendship, wrote the row, and told the other side. This pins that the sender's door answers like its siblings.
import assert from "node:assert/strict";
import { test } from "node:test";
import { OwnerClient } from "../src/client.js";
import { bulkAuth, expectApiError, ownerWithBot, startServer } from "./helpers.js";

test("a friend request sent from a frozen Bot is refused and writes nothing", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "alice");
  const B = await ownerWithBot(s.base, "bob");
  await A.owner.req("POST", "/v1/emergency-stop", { bot_id: A.bot.id });

  const refusal = await expectApiError(
    A.owner.req("POST", "/v1/relationships", { from_bot_id: A.bot.id, target_handle: B.handle, message: "hi" }),
    403,
    "bot_frozen",
  );
  assert.match(refusal.message, /this bot is frozen \(emergency stop\)/, "the refusal says which state stopped it");

  // The refusal is the whole answer: no relationship row, nothing told to the other Bot, no audit line claiming a
  // request that never happened.
  assert.equal((await A.owner.req("GET", "/v1/relationships")).relationships.length, 0, "no relationship row");
  assert.equal(
    (await B.bot.events(0)).events.filter((e: any) => e.event_type === "relationship.requested").length,
    0,
    "the target is not told",
  );
  assert.equal(
    (await A.owner.req("GET", "/v1/audit-events?limit=1000")).events.filter((e: any) => e.action === "relationship.requested").length,
    0,
    "no audit line claims the request",
  );

  // Control: the refusal is the freeze, not a broken door. Resuming the Bot makes the same request go through, and
  // the other side hears about it once.
  await A.owner.req("POST", `/v1/bots/${A.bot.id}/resume`);
  const rel = await A.owner.req("POST", "/v1/relationships", { from_bot_id: A.bot.id, target_handle: B.handle, message: "hi" });
  assert.equal(rel.status, "pending_target");
  assert.equal(
    (await B.bot.events(0)).events.filter((e: any) => e.event_type === "relationship.requested").length,
    1,
    "the target hears about the request once the Bot is back",
  );
});

test("a friend request sent from a revoked Bot is refused and writes nothing", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const B = await ownerWithBot(s.base, "bob");
  // A revoked identity is what removing a home member leaves behind: the Bot is gone, the owner is not.
  const onboard = await (await fetch(`${s.base}/v1/onboard/flybot`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "carol-revoked", password: "secret-pw" }),
  })).json();
  // The onboarding answer carries a connector token; the console half signs in for a login token.
  const login = await (await fetch(`${s.base}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "carol-revoked", password: "secret-pw" }),
  })).json();
  const C = new OwnerClient(s.base, login.owner_token);
  const member = await C.req("POST", `/v1/homes/${onboard.bot.bot_id}/members`, { name: "gone" });
  await C.req("DELETE", `/v1/homes/${onboard.bot.bot_id}/members/${member.bot_id}`);

  const refusal = await expectApiError(
    C.req("POST", "/v1/relationships", { from_bot_id: member.bot_id, target_handle: B.handle, message: "hi" }),
    403,
    "bot_revoked",
  );
  assert.match(refusal.message, /this bot identity was revoked/, "the refusal names the revocation, not a freeze");

  assert.equal((await C.req("GET", "/v1/relationships")).relationships.length, 0, "no relationship row");
  assert.equal(
    (await B.bot.events(0)).events.filter((e: any) => e.event_type === "relationship.requested").length,
    0,
    "the target is not told",
  );
  assert.equal(
    (await C.req("GET", "/v1/audit-events?limit=1000")).events.filter((e: any) => e.action === "relationship.requested").length,
    0,
    "no audit line claims the request",
  );
});
