// A stop is not undone by a card or a consent that arrives later.
//
// A share is written by three doors: the owner route (`POST /v1/relationships/:id/grants`), the `grant_request`
// approval, and the consent that accepts a pending friendship. The auto-accept invite path asks `assertInvitable` of
// both Bots the share names, and its comment says why — "a stop that happened while the card waited cannot be undone
// by approving it". The other three doors never asked: a Bot frozen (`emergency-stop`) or removed from its home
// (`revoked`) after the card or the request was written was still shared by the decision that arrived later. The
// approval wrote the grant, the consent wrote the whole activation set, both answered 2xx and told the owners the
// share was live, while every later reach answers 403 `bot_frozen` / `bot_revoked`. That is the same hole for the
// same rule, so one refusal shape covers all three: a 403 through `invitableFailure`, and the card / the pending row
// left exactly as it was — no grant, no `grant.created`, no `relationship.accepted`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { OwnerClient } from "../src/client.js";
import { bulkAuth, expectApiError, friends, ownerWithBot, startServer } from "./helpers.js";

const CAP = "calendar.freebusy.read";
const SCOPED = { window_days: 14 };

type Server = Awaited<ReturnType<typeof startServer>>;

/** The card as it stands: a refusal leaves it pending, with no `decided_at`. */
const card = (s: Server, approvalId: string) =>
  s.platform.db.prepare("SELECT status, decided_at FROM approvals WHERE id = ?").get(approvalId) as any;

/** Every live row of the pair's share, of any capability, so a snapshot compares the whole set. */
const liveGrants = (s: Server, relId: string) =>
  (s.platform.db.prepare("SELECT COUNT(*) n FROM grants WHERE relationship_id = ? AND status = 'active'").get(relId) as any).n as number;

/** The `grant.created` lines that name one capability of this relationship. */
const createdLines = (s: Server, relId: string, capability: string) =>
  s.platform.audit.list({ limit: 1000 })
    .filter((e: any) => e.action === "grant.created" && e.data?.relationship_id === relId && e.data?.capability === capability);

/** The `relationship.accepted` lines that name this request. */
const acceptedLines = (s: Server, relId: string) =>
  s.platform.audit.list({ limit: 1000 }).filter((e: any) => e.action === "relationship.accepted" && e.subject === relId);

/** A FlyBot home plus its owner login token (connector tokens are refused on the console REST routes). */
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

/** A member Bot of that home: a Bot outside a home cannot be removed, and removal is the door that leaves a Bot
 *  `revoked`, so this is the only fixture shape that reaches the removed half of the rule. */
async function addMember(owner: OwnerClient, homeId: string, name: string) {
  const r: any = await owner.req("POST", `/v1/homes/${homeId}/members`, { name, display_name: name.toUpperCase() });
  return { botId: r.bot_id as string, handle: r.handle as string };
}

/** Two owners who are friends, with A's Bot asking B's Bot for a capability: the request the card holds. */
async function waitingGrantCard(s: Server) {
  const { A, B, relId } = await friends(s.base);
  const req: any = await A.bot.requestGrant(relId, CAP, SCOPED);
  assert.equal(req.status, "pending_owner_approval");
  return { A, B, relId, approvalId: req.approval_id as string };
}

/** The same request between a plain owner and one Bot of a FlyBot home, so that the target side can be removed. */
async function waitingGrantCardToHomeMember(s: Server) {
  const A = await ownerWithBot(s.base, "alice");
  const B = await flyHome(s.base, "bob");
  const member = await addMember(B.owner, B.homeId, "writer");
  const asked: any = await A.owner.req("POST", "/v1/relationships", { from_bot_id: A.bot.id, target_handle: member.handle, message: "hi", requested_capabilities: ["chat.public"] });
  await B.owner.req("POST", `/v1/relationships/${asked.relationship_id}/consent`, { decision: "accept" });
  const req: any = await A.bot.requestGrant(asked.relationship_id, CAP, SCOPED);
  assert.equal(req.status, "pending_owner_approval");
  return { A, B, member, relId: asked.relationship_id as string, approvalId: req.approval_id as string };
}

// ------------------------------------------------------------------ the wait for the sharing owner
test("a grant card approved after the sharing Bot was stopped writes nothing", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const { A, B, relId, approvalId } = await waitingGrantCard(s);
  await B.owner.req("POST", "/v1/emergency-stop", { bot_id: B.bot.id });

  const refusal = await expectApiError(B.owner.req("POST", `/v1/approvals/${approvalId}/decision`, { decision: "approved" }), 403, "bot_frozen");
  assert.match(refusal.message, /this bot is frozen/, "the refusal names the stop, not a broken door");

  // The decision is neither performed nor spent: the card still waits, and nothing of the share was written.
  const after = card(s, approvalId);
  assert.equal(after.status, "pending", "the card is still pending");
  assert.equal(after.decided_at, null, "the card was not decided");
  assert.equal(s.platform.findGrant(B.owner_id, A.bot.id, CAP), null, "no live share of the stopped Bot");
  assert.equal(createdLines(s, relId, CAP).length, 0, "no grant.created line claims the share");
});

test("a grant card approved after the sharing Bot was removed writes nothing", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const { A, B, member, relId, approvalId } = await waitingGrantCardToHomeMember(s);
  const removed: any = await B.owner.req("DELETE", `/v1/homes/${B.homeId}/members/${member.botId}`);
  assert.equal(removed.status, "revoked", "the fixture really removed the Bot");

  const refusal = await expectApiError(B.owner.req("POST", `/v1/approvals/${approvalId}/decision`, { decision: "approved" }), 403, "bot_revoked");
  assert.match(refusal.message, /this bot identity was revoked/, "the refusal names the removal");

  const after = card(s, approvalId);
  assert.equal(after.status, "pending", "the card is still pending");
  assert.equal(after.decided_at, null, "the card was not decided");
  assert.equal(s.platform.findGrant(B.owner_id, A.bot.id, CAP), null, "no live share of the removed Bot");
  assert.equal(createdLines(s, relId, CAP).length, 0, "no grant.created line claims the share");
});

test("a grant card approved while both Bots answer still writes the share (control)", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const { A, B, relId, approvalId } = await waitingGrantCard(s);

  const decided: any = await B.owner.req("POST", `/v1/approvals/${approvalId}/decision`, { decision: "approved" });
  assert.equal(decided.decision, "approved");
  assert.equal(decided.status, undefined, "the approval answer is not a refusal");
  assert.ok(s.platform.findGrant(B.owner_id, A.bot.id, CAP), "the live share exists");
  assert.equal(card(s, approvalId).status, "approved");
  assert.equal(createdLines(s, relId, CAP).length, 1, "one grant.created line names the share");
});

// ------------------------------------------------------------------ the owner route, same rule
test("the owner route refuses a share of a stopped Bot and writes nothing", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const { A, B, relId } = await friends(s.base);
  const before = liveGrants(s, relId);
  await B.owner.req("POST", "/v1/emergency-stop", { bot_id: B.bot.id });

  await expectApiError(B.owner.req("POST", `/v1/relationships/${relId}/grants`, { capability: CAP, scope: SCOPED }), 403, "bot_frozen");
  assert.equal(liveGrants(s, relId), before, "no grant row was written");
  assert.equal(createdLines(s, relId, CAP).length, 0, "no grant.created line claims the share");
});

test("the owner route refuses a share of a removed Bot and writes nothing", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const { A, B, member, relId } = await waitingGrantCardToHomeMember(s);
  const before = liveGrants(s, relId);
  await B.owner.req("DELETE", `/v1/homes/${B.homeId}/members/${member.botId}`);

  await expectApiError(B.owner.req("POST", `/v1/relationships/${relId}/grants`, { capability: CAP, scope: SCOPED }), 403, "bot_revoked");
  assert.equal(liveGrants(s, relId), before, "no grant row was written");
  assert.equal(createdLines(s, relId, CAP).length, 0, "no grant.created line claims the share");
});

test("the owner route refuses a share to a stopped friend Bot", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const { A, B, relId } = await friends(s.base);
  const before = liveGrants(s, relId);
  // The other end of the share is checked too: this is the Bot that would receive it.
  await A.owner.req("POST", "/v1/emergency-stop", { bot_id: A.bot.id });

  const frozen = await expectApiError(B.owner.req("POST", `/v1/relationships/${relId}/grants`, { capability: CAP, scope: SCOPED }), 403, "bot_frozen");
  assert.match(frozen.message, /this bot is frozen/, "the refusal names the receiving side's stop");
  assert.equal(liveGrants(s, relId), before, "no grant row was written");
  assert.equal(createdLines(s, relId, CAP).length, 0, "no grant.created line claims the share");
});

test("the owner route writes the share while both Bots answer (control)", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const { A, B, relId } = await friends(s.base);
  const before = liveGrants(s, relId);

  const written: any = await B.owner.req("POST", `/v1/relationships/${relId}/grants`, { capability: CAP, scope: SCOPED });
  assert.equal(written.status, "active");
  assert.equal(liveGrants(s, relId), before + 1, "one live row was written");
  assert.equal(createdLines(s, relId, CAP).length, 1);
});

// ------------------------------------------------------------------ the consent that arrives later
test("a consent is refused once the accepting side's own Bot was stopped", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "alice");
  const B = await flyHome(s.base, "bob");
  const member = await addMember(B.owner, B.homeId, "writer");
  const asked: any = await A.owner.req("POST", "/v1/relationships", { from_bot_id: A.bot.id, target_handle: member.handle, message: "hi", requested_capabilities: ["chat.public"] });
  await B.owner.req("POST", "/v1/emergency-stop", { bot_id: member.botId });

  await expectApiError(B.owner.req("POST", `/v1/relationships/${asked.relationship_id}/consent`, { decision: "accept" }), 403, "bot_frozen");
  await assertPending(s, B.owner, asked.relationship_id);
});

test("a consent is refused once the asking side's own Bot was stopped", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const A = await flyHome(s.base, "alice");
  const requester = await addMember(A.owner, A.homeId, "asker");
  const B = await ownerWithBot(s.base, "bob");
  const asked: any = await A.owner.req("POST", "/v1/relationships", { from_bot_id: requester.botId, target_handle: B.handle, message: "hi", requested_capabilities: ["chat.public"] });
  await A.owner.req("POST", "/v1/emergency-stop", { bot_id: requester.botId });

  await expectApiError(B.owner.req("POST", `/v1/relationships/${asked.relationship_id}/consent`, { decision: "accept" }), 403, "bot_frozen");
  await assertPending(s, B.owner, asked.relationship_id);
});

test("a consent is refused once the accepting side's own Bot was removed", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "alice");
  const B = await flyHome(s.base, "bob");
  const member = await addMember(B.owner, B.homeId, "writer");
  const asked: any = await A.owner.req("POST", "/v1/relationships", { from_bot_id: A.bot.id, target_handle: member.handle, message: "hi", requested_capabilities: ["chat.public"] });
  await B.owner.req("DELETE", `/v1/homes/${B.homeId}/members/${member.botId}`);

  await expectApiError(B.owner.req("POST", `/v1/relationships/${asked.relationship_id}/consent`, { decision: "accept" }), 403, "bot_revoked");
  await assertPending(s, B.owner, asked.relationship_id);
});

test("a consent is refused once the asking side's own Bot was removed", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const A = await flyHome(s.base, "alice");
  const requester = await addMember(A.owner, A.homeId, "asker");
  const B = await ownerWithBot(s.base, "bob");
  const asked: any = await A.owner.req("POST", "/v1/relationships", { from_bot_id: requester.botId, target_handle: B.handle, message: "hi", requested_capabilities: ["chat.public"] });
  await A.owner.req("DELETE", `/v1/homes/${A.homeId}/members/${requester.botId}`);

  await expectApiError(B.owner.req("POST", `/v1/relationships/${asked.relationship_id}/consent`, { decision: "accept" }), 403, "bot_revoked");
  await assertPending(s, B.owner, asked.relationship_id);
});

test("a consent between two Bots that answer still activates (control)", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "alice");
  const B = await flyHome(s.base, "bob");
  const member = await addMember(B.owner, B.homeId, "writer");
  const asked: any = await A.owner.req("POST", "/v1/relationships", { from_bot_id: A.bot.id, target_handle: member.handle, message: "hi", requested_capabilities: ["chat.public"] });

  const accepted: any = await B.owner.req("POST", `/v1/relationships/${asked.relationship_id}/consent`, { decision: "accept" });
  assert.equal(accepted.status, "active");
  assert.ok(liveGrants(s, asked.relationship_id) > 0, "the activation wrote its grants");
});

/** The row is a refusal's witness: still waiting, with no grant written and no `relationship.accepted` audited. */
async function assertPending(s: Server, owner: OwnerClient, relId: string) {
  const mine: any = await owner.req("GET", "/v1/relationships");
  const row = mine.relationships.find((r: any) => r.relationship_id === relId);
  assert.equal(row.status, "pending_target", "the row is not turned active");
  assert.equal(liveGrants(s, relId), 0, "no grant row was written");
  assert.equal(acceptedLines(s, relId).length, 0, "no relationship.accepted line was audited");
}
