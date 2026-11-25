// A decision that is refused is not a delivery moment.
//
// `consent` and the `grant_request` approval both answer a card or a request someone was waiting on, and both open the
// platform's clock first: `expireStale()` settles every lapsed share, every lapsed pending relationship and every card
// past its deadline, for every owner. That is right for the call that really answers the caller's own row -- the row it
// judges is settled with everything else, and an owner who answers a request that lapsed while it waited still sees
// `409 invalid_state`. It is wrong for a call that is refused before it judges anything. A `403 bot_frozen` /
// `403 bot_revoked` from a stop or a removal that happened after the card was minted, and a `409 invalid_state` for a
// card an older build left pending, are answers about the caller's own row -- and they used to settle every other
// owner's queue on the way out: the third owner's card flipped to `expired`, the invite link behind it burned, an
// `approval.expired` line written, and that owner's Bot told its card had been settled.
//
// The rule the fix follows is narrow. A refused branch settles only the row this door is judging: the pending
// relationship between the two Bots (`expirePendingBetween`), and the card itself when it is the one that lapsed. The
// platform-wide sweep stays where it belongs -- on the path that actually answers the caller's request. The two control
// cases pin that the sweep is moved, not deleted: with both identities live, the same door still settles the third
// owner's lapsed card.
//
// The last case is the regression pin for the share that must not be lost on the way: a pair that already holds a live
// row of the requested capability, plus a refused approval of a second request for that same capability, must leave
// that row exactly as it was -- the supersede that approval would have written never runs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { OwnerClient } from "../src/client.js";
import { bulkAuth, expectApiError, friends, ownerWithBot, startServer } from "./helpers.js";

const CAP = "calendar.freebusy.read";
const SCOPED = { window_days: 14 };
type S = Awaited<ReturnType<typeof startServer>>;

const past = () => new Date(Date.now() - 3600e3).toISOString();
const count = (db: any, sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as any).n as number;

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

/** A member Bot of that home: only a home member can be removed, and removal is the door that leaves a Bot `revoked`. */
async function addMember(owner: OwnerClient, homeId: string, name: string) {
  const r: any = await owner.req("POST", `/v1/homes/${homeId}/members`, { name, display_name: name.toUpperCase() });
  return { botId: r.bot_id as string, handle: r.handle as string };
}

/**
 * A third owner whose Bot minted an `auto_accept: false` invite: a card waits at `pending_owner` behind it, and the
 * card is past its deadline. Any platform-wide sweep shows on it, so a call that must settle only its own row is
 * checked here.
 */
async function plantLapsedCard(s: S, name: string) {
  const C = await ownerWithBot(s.base, name);
  const minted: any = await C.bot.signed("/v1/invites", "invite.create", { auto_accept: false });
  assert.equal(minted.status, "pending_owner", JSON.stringify(minted));
  assert.ok(minted.approval_id, "a Bot-created invite waits behind a card");
  s.platform.db.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?").run(past(), minted.approval_id);
  return { owner: C.owner, bot: C.bot, card: minted.approval_id as string, invite: minted.invite_id as string };
}

/** Everything of the third owner's a refused call must leave alone: the card, the link behind it, and the Bot. */
function assertThirdPartyUntouched(s: S, p: { bot: any; card: string; invite: string }) {
  const card = s.platform.db.prepare("SELECT status, decided_at FROM approvals WHERE id = ?").get(p.card) as any;
  assert.equal(card.status, "pending", "a refused decision settled another owner's card");
  assert.equal(card.decided_at, null, "a refused decision stamped a decision on another owner's card");
  const invite = s.platform.db.prepare("SELECT status FROM invites WHERE id = ?").get(p.invite) as any;
  assert.equal(invite.status, "pending_owner", "a refused decision expired another owner's invite link");
  assert.equal(count(s.platform.audit.db, "SELECT COUNT(*) n FROM audit_events WHERE action = 'approval.expired'"), 0, "a refused decision wrote an expiry audit line");
  assert.equal(count(s.platform.db, "SELECT COUNT(*) n FROM events WHERE type = 'approval.decided' AND bot_id = ?", p.bot.id), 0, "a refused decision told another owner's Bot");
}

/** The same third owner's card once the door really answers its caller: the delivery moment is moved, not deleted. */
function assertThirdPartySettled(s: S, p: { bot: any; card: string; invite: string }) {
  const card = s.platform.db.prepare("SELECT status, decided_at FROM approvals WHERE id = ?").get(p.card) as any;
  assert.equal(card.status, "expired", "a door that answers its caller still opens the delivery moment");
  assert.ok(card.decided_at, "settled with the instant it happened");
  const invite = s.platform.db.prepare("SELECT status FROM invites WHERE id = ?").get(p.invite) as any;
  assert.equal(invite.status, "expired", "a lapsed card's link ends with it");
  assert.equal(count(s.platform.audit.db, "SELECT COUNT(*) n FROM audit_events WHERE action = 'approval.expired'"), 1, "the expiry is on the audit chain");
  assert.equal(count(s.platform.db, "SELECT COUNT(*) n FROM events WHERE type = 'approval.decided' AND bot_id = ?", p.bot.id), 1, "the other owner's Bot heard the settlement");
}

/** A pending friendship waiting for B's owner to answer; the target side is a removable home member. */
async function pendingConsentToHomeMember(s: S) {
  const A = await ownerWithBot(s.base, "alice");
  const B = await flyHome(s.base, "bob");
  const member = await addMember(B.owner, B.homeId, "writer");
  const asked: any = await A.owner.req("POST", "/v1/relationships", { from_bot_id: A.bot.id, target_handle: member.handle, message: "hi", requested_capabilities: ["chat.public"] });
  return { A, B, member, relId: asked.relationship_id as string };
}

/** The same request the other way round: the asking side is the removable home member. */
async function pendingConsentFromHomeMember(s: S) {
  const A = await flyHome(s.base, "alice");
  const requester = await addMember(A.owner, A.homeId, "asker");
  const B = await ownerWithBot(s.base, "bob");
  const asked: any = await A.owner.req("POST", "/v1/relationships", { from_bot_id: requester.botId, target_handle: B.handle, message: "hi", requested_capabilities: ["chat.public"] });
  return { A, B, requester, relId: asked.relationship_id as string };
}

/** A refusal must leave the friendship request exactly where it was: pending, with no grant and no acceptance line. */
function assertConsentStillPending(s: S, relId: string) {
  const row = s.platform.db.prepare("SELECT status FROM relationships WHERE id = ?").get(relId) as any;
  assert.equal(row.status, "pending_target", "a refused consent turned the request active");
  assert.equal(count(s.platform.db, "SELECT COUNT(*) n FROM grants WHERE relationship_id = ?", relId), 0, "a refused consent wrote a grant");
  assert.equal(count(s.platform.audit.db, "SELECT COUNT(*) n FROM audit_events WHERE action = 'relationship.accepted' AND subject = ?", relId), 0, "a refused consent audited an acceptance");
}

/** Two friends, with A's Bot asking B's Bot for one capability: the `grant_request` card B's owner decides. */
async function waitingGrantCard(s: S) {
  const { A, B, relId } = await friends(s.base);
  const req: any = await A.bot.requestGrant(relId, CAP, SCOPED);
  assert.equal(req.status, "pending_owner_approval");
  return { A, B, relId, approvalId: req.approval_id as string };
}

/** The card as it stands: a refusal leaves it pending, with no `decided_at`. */
const card = (s: S, approvalId: string) =>
  s.platform.db.prepare("SELECT status, decided_at FROM approvals WHERE id = ?").get(approvalId) as any;

// ------------------------------------------------------------------ the consent that is refused
test("a consent refused for a stopped accepting Bot settles nothing else", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const p = await pendingConsentToHomeMember(s);
  const third = await plantLapsedCard(s, "carol");
  const stopped = await p.B.owner.req("POST", "/v1/emergency-stop", { bot_id: p.member.botId });
  assert.equal(stopped.status, "frozen");

  const refusal = await expectApiError(p.B.owner.req("POST", `/v1/relationships/${p.relId}/consent`, { decision: "accept" }), 403, "bot_frozen");
  assert.match(refusal.message, /this bot is frozen/, "the refusal names the stop");
  assertConsentStillPending(s, p.relId);
  assertThirdPartyUntouched(s, third);
});

test("a consent refused for a removed accepting Bot settles nothing else", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const p = await pendingConsentToHomeMember(s);
  const third = await plantLapsedCard(s, "carol");
  const removed: any = await p.B.owner.req("DELETE", `/v1/homes/${p.B.homeId}/members/${p.member.botId}`);
  assert.equal(removed.status, "revoked", "the fixture really removed the Bot");

  const refusal = await expectApiError(p.B.owner.req("POST", `/v1/relationships/${p.relId}/consent`, { decision: "accept" }), 403, "bot_revoked");
  assert.match(refusal.message, /revoked/, "the refusal names the removal");
  assertConsentStillPending(s, p.relId);
  assertThirdPartyUntouched(s, third);
});

test("a consent refused for a stopped asking Bot settles nothing else", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const p = await pendingConsentFromHomeMember(s);
  const third = await plantLapsedCard(s, "carol");
  const stopped = await p.A.owner.req("POST", "/v1/emergency-stop", { bot_id: p.requester.botId });
  assert.equal(stopped.status, "frozen");

  await expectApiError(p.B.owner.req("POST", `/v1/relationships/${p.relId}/consent`, { decision: "accept" }), 403, "bot_frozen");
  assertConsentStillPending(s, p.relId);
  assertThirdPartyUntouched(s, third);
});

test("a consent refused for a removed asking Bot settles nothing else", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const p = await pendingConsentFromHomeMember(s);
  const third = await plantLapsedCard(s, "carol");
  const removed: any = await p.A.owner.req("DELETE", `/v1/homes/${p.A.homeId}/members/${p.requester.botId}`);
  assert.equal(removed.status, "revoked", "the fixture really removed the Bot");

  await expectApiError(p.B.owner.req("POST", `/v1/relationships/${p.relId}/consent`, { decision: "accept" }), 403, "bot_revoked");
  assertConsentStillPending(s, p.relId);
  assertThirdPartyUntouched(s, third);
});

test("the same consent door, once both Bots answer, still settles the queue (control)", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const p = await pendingConsentToHomeMember(s);
  const third = await plantLapsedCard(s, "carol");

  const accepted: any = await p.B.owner.req("POST", `/v1/relationships/${p.relId}/consent`, { decision: "accept" });
  assert.equal(accepted.status, "active", JSON.stringify(accepted));
  assertThirdPartySettled(s, third);
});

// ------------------------------------------------------------------ the approval that is refused
test("an approval refused for a stopped sharing Bot settles nothing else", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const { A, B, approvalId } = await waitingGrantCard(s);
  const third = await plantLapsedCard(s, "carol");
  const stopped = await B.owner.req("POST", "/v1/emergency-stop", { bot_id: B.bot.id });
  assert.equal(stopped.status, "frozen");

  const refusal = await expectApiError(B.owner.req("POST", `/v1/approvals/${approvalId}/decision`, { decision: "approved" }), 403, "bot_frozen");
  assert.match(refusal.message, /this bot is frozen/, "the refusal names the stop");
  const after = card(s, approvalId);
  assert.equal(after.status, "pending", "the card is still pending");
  assert.equal(after.decided_at, null, "the card was not decided");
  assert.equal(s.platform.findGrant(B.owner_id, A.bot.id, CAP), null, "no live share was written");
  assertThirdPartyUntouched(s, third);
});

test("an approval refused because the asking Bot was stopped settles nothing else", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const { A, B, approvalId } = await waitingGrantCard(s);
  const third = await plantLapsedCard(s, "carol");
  // The stop cancels the asking Bot's own waiting cards, so this call answers a card that is no longer pending: a 409
  // about the caller's own row must not be the call that settles a third owner's queue either.
  const stopped = await A.owner.req("POST", "/v1/emergency-stop", { bot_id: A.bot.id });
  assert.equal(stopped.status, "frozen");

  await expectApiError(B.owner.req("POST", `/v1/approvals/${approvalId}/decision`, { decision: "approved" }), 409, "invalid_state");
  assertThirdPartyUntouched(s, third);
});

test("an approval refused for a removed asking Bot settles nothing else", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const { A, B, approvalId } = await waitingGrantCard(s);
  const third = await plantLapsedCard(s, "carol");
  // The state `removeHomeMember` leaves, on a card an older build left pending: the refusal comes from the door's own
  // identity check, not from a cancellation, so the third owner's queue is the only thing this call could still move.
  s.platform.db.prepare("UPDATE bots SET status = 'revoked' WHERE id = ?").run(A.bot.id);

  const refusal = await expectApiError(B.owner.req("POST", `/v1/approvals/${approvalId}/decision`, { decision: "approved" }), 403, "bot_revoked");
  assert.match(refusal.message, /this bot identity was revoked/, "the refusal names the removal");
  const after = card(s, approvalId);
  assert.equal(after.status, "pending", "the card is still pending");
  assert.equal(after.decided_at, null, "the card was not decided");
  assertThirdPartyUntouched(s, third);
});

test("the same approval door, once it writes the share, still settles the queue (control)", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const { A, B, approvalId } = await waitingGrantCard(s);
  const third = await plantLapsedCard(s, "carol");

  const decided: any = await B.owner.req("POST", `/v1/approvals/${approvalId}/decision`, { decision: "approved" });
  assert.equal(decided.decision, "approved", JSON.stringify(decided));
  assert.ok(s.platform.findGrant(B.owner_id, A.bot.id, CAP), "the live share exists");
  assertThirdPartySettled(s, third);
});

// ------------------------------------------------------------------ the share that must not be lost on the way
test("a refused approval leaves the live row of the same capability it would have superseded", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  // The pair already holds a live row of this capability; the refused approval is a second request for the same one --
  // the write that would have ended the old row in the same transaction.
  const { A, B, relId } = await friends(s.base, { freebusy: true });
  const live = () => s.platform.db.prepare(
    "SELECT id, status, scope FROM grants WHERE relationship_id = ? AND grantor_owner = ? AND capability = ? AND status = 'active' ORDER BY id",
  ).all(relId, B.owner_id, CAP) as any[];
  const before = live();
  assert.equal(before.length, 1, "the fixture holds exactly one live row of the capability");
  const req: any = await A.bot.requestGrant(relId, CAP, SCOPED);
  assert.equal(req.status, "pending_owner_approval");
  const stopped = await B.owner.req("POST", "/v1/emergency-stop", { bot_id: B.bot.id });
  assert.equal(stopped.status, "frozen");

  await expectApiError(B.owner.req("POST", `/v1/approvals/${req.approval_id}/decision`, { decision: "approved" }), 403, "bot_frozen");
  assert.deepEqual(live(), before, "a refused approval left the live row of the same capability untouched");
  assert.equal(card(s, req.approval_id).status, "pending", "the refused card is still pending");
});
