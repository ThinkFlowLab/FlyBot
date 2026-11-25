// A decision on a `relationship_request` card is not a delivery moment until it is actually taken.
//
// Deciding the card a Bot-signed join wrote answers the joining Bot's own owner. On master at dd1bc1cb the door opens
// the platform's clock before it knows whether it will answer at all: lane E narrowed `grant_request` to its own card,
// and every other kind still runs the platform-wide `expireStale()` -- `relationship_request` among them. So a call
// that ends in a refusal has already settled every other owner's queue: their lapsed card flipped to `expired`, their
// lapsed pending request flipped to `expired`, the invite use that request was holding given back, an
// `approval.expired` and a `relationship.expired` line written, and both owners' Bots told their card had been settled.
//
// Two refusals are reachable on this kind, and both are answers about the caller's own card:
//   - the relationship the card waits on was never written (the torn-write shape an older build allowed): the card is
//     cancelled with the reason and the call answers `409 invalid_state`;
//   - the card is approved against an auto-accept invite, and the far end of the pair was stopped or removed while the
//     card waited: `maybeAutoAcceptInvite` -> `autoAcceptSpecs` answers `403 bot_frozen` / `403 bot_revoked` and leaves
//     the card pending, never undoing a stop by approving it.
//
// The rule the fix follows is narrow, and the same one `consent` and `grant_request` already follow. A refused branch
// settles only the row this door is judging: this card when it is the one that lapsed, and this request's own row when
// that row is the one that lapsed (`settlePendingRelationships` on the single row, because `expireApproval`'s
// `relationship_request` branch deliberately does not touch the relationship row). The platform-wide sweep stays where
// it belongs -- on the path that actually takes the decision, after every refusal is behind it -- so a lapsed card
// still answers `409 invalid_state` and a stopped peer still answers `403`, exactly as before.
//
// The two control cases pin that the sweep is moved, not deleted: with both identities live, the same door still
// settles the third owner's lapsed card and their lapsed request. The last case is the regression pin for the rows a
// refused decision would have written: the link's own row and the use its join spent are exactly as they were, and the
// approval wrote no grant on the way out.
import assert from "node:assert/strict";
import { test } from "node:test";
import { expectApiError, ownerWithBot, startServer } from "./helpers.js";

type S = Awaited<ReturnType<typeof startServer>>;
const past = () => new Date(Date.now() - 3600e3).toISOString();
const count = (db: any, sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as any).n as number;
const owner = (o: any) => ({ kind: "owner" as const, ownerId: o.owner_id });

const card = (s: S, id: string) => s.platform.db.prepare("SELECT status, decided_at, decision FROM approvals WHERE id = ?").get(id) as any;
const row = (s: S, id: string) => s.platform.db.prepare("SELECT status, expires_at FROM relationships WHERE id = ?").get(id) as any;
const uses = (s: S, id: string) => (s.platform.db.prepare("SELECT uses FROM invites WHERE id = ?").get(id) as any).uses;
const invite = (s: S, id: string) => s.platform.db.prepare("SELECT status, uses FROM invites WHERE id = ?").get(id) as any;
const audits = (s: S, action: string, subject: string) => count(s.platform.audit.db, "SELECT COUNT(*) n FROM audit_events WHERE action = ? AND subject = ?", action, subject);
const told = (s: S, botId: string) => count(s.platform.db, "SELECT COUNT(*) n FROM events WHERE type = 'approval.decided' AND bot_id = ?", botId);

/**
 * The card under test: another owner's Bot joins an invite, so the join waits on that Bot's own owner. With
 * `autoAccept` the link is the inviter's standing consent -- approving the card is what runs the auto-accept gate.
 */
async function waitingRelationshipCard(s: S, opts: { autoAccept: boolean }) {
  const A = await ownerWithBot(s.base, "alice");   // the inviter's Bot: the card is not addressed to this owner
  const B = await ownerWithBot(s.base, "bob");     // the Bot that joined: its owner holds the card
  const inv: any = (s.platform as any).createInvite(owner(A), { bot_id: A.bot.id, auto_accept: opts.autoAccept });
  if (inv.status === "pending_owner") {
    const approved: any = await A.owner.req("POST", `/v1/approvals/${inv.approval_id}/decision`, { decision: "approved" });
    assert.equal(approved.status, "active", "the fixture's link really is usable: " + JSON.stringify(approved));
  }
  const join: any = await B.bot.signed(`/v1/invites/${inv.code}/join`, "invite.join", { code: inv.code });
  assert.equal(join.status, "pending_requester_owner", "the join waits on its own owner: " + JSON.stringify(join));
  assert.ok(join.approval_id, "a Bot-signed join writes its owner a card");
  assert.equal(card(s, join.approval_id).status, "pending", "the card is the one this door decides");
  return { A, B, inv, relId: join.relationship_id as string, approvalId: join.approval_id as string };
}

/** Another owner's request that lapsed while it waited: its row, its card, and the link use its join spent. */
async function plantLapsedRequest(s: S, name: string) {
  const H = await ownerWithBot(s.base, `${name}-home`);
  const J = await ownerWithBot(s.base, `${name}-join`);
  const inv: any = (s.platform as any).createInvite(owner(H), { bot_id: H.bot.id, auto_accept: false });
  assert.equal(inv.status, "active", "an owner-minted link is live at once");
  const join: any = await J.bot.signed(`/v1/invites/${inv.code}/join`, "invite.join", { code: inv.code });
  assert.equal(join.status, "pending_requester_owner", "the fixture request is pending");
  assert.equal(uses(s, inv.invite_id), 1, "the fixture request spent its link's only use");
  return { relId: join.relationship_id as string, cardId: join.approval_id as string, inviteId: inv.invite_id as string, botId: J.bot.id };
}

/** A third owner's card that is past its deadline: any platform-wide sweep shows on it. */
async function plantLapsedCard(s: S, name: string) {
  const C = await ownerWithBot(s.base, name);
  const minted: any = await C.bot.signed("/v1/invites", "invite.create", { auto_accept: false });
  assert.equal(minted.status, "pending_owner", "the fixture card waits on its own owner");
  s.platform.db.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?").run(past(), minted.approval_id);
  return { botId: C.bot.id, cardId: minted.approval_id as string, inviteId: minted.invite_id as string };
}

/** Backdate a waiting request so its own clock has run out. */
const lapse = (s: S, relId: string) =>
  s.platform.db.prepare("UPDATE relationships SET expires_at = ? WHERE id = ?").run(past(), relId);

/** A refused decision leaves the third owner's card and the link behind it exactly where they were. */
function assertThirdPartyUntouched(s: S, third: { botId: string; cardId: string; inviteId: string }) {
  const c = card(s, third.cardId);
  assert.equal(c.status, "pending", "a refused decision settled another owner's card");
  assert.equal(c.decided_at, null, "a refused decision stamped a decision on another owner's card");
  assert.equal(invite(s, third.inviteId).status, "pending_owner", "a refused decision expired another owner's invite link");
  assert.equal(audits(s, "approval.expired", third.cardId), 0, "a refused decision wrote an expiry line for another owner's card");
  assert.equal(told(s, third.botId), 0, "a refused decision told another owner's Bot");
}

/** And it leaves the other owner's lapsed request, its card and the use it spent exactly where they were. */
function assertLapsedRequestUntouched(s: S, lapsed: { relId: string; cardId: string; inviteId: string; botId: string }) {
  assert.equal(row(s, lapsed.relId).status, "pending_requester_owner", "a refused decision settled another owner's lapsed request");
  assert.equal(card(s, lapsed.cardId).status, "pending", "a refused decision settled the card under another owner's lapsed request");
  assert.equal(uses(s, lapsed.inviteId), 1, "a refused decision gave back an invite use another owner's request was holding");
  assert.equal(audits(s, "approval.expired", lapsed.cardId), 0, "a refused decision expired the card under another owner's lapsed request");
  assert.equal(audits(s, "relationship.expired", lapsed.relId), 0, "a refused decision wrote a relationship expiry line for another owner");
  assert.equal(told(s, lapsed.botId), 0, "a refused decision told the Bot waiting under another owner's request");
}

/** The same third parties once the door really takes the decision: the delivery moment is moved, not deleted. */
function assertQueueSettled(s: S, third: { botId: string; cardId: string; inviteId: string }, lapsed: { relId: string; cardId: string; inviteId: string; botId: string }) {
  const settled = card(s, third.cardId);
  assert.equal(settled.status, "expired", "a door that takes its decision still settles the lapsed card");
  assert.ok(settled.decided_at, "settled with the instant it happened");
  assert.equal(invite(s, third.inviteId).status, "expired", "a lapsed card's link ends with it");
  assert.equal(audits(s, "approval.expired", third.cardId), 1, "the third card's expiry is on the audit chain");
  assert.equal(audits(s, "approval.expired", lapsed.cardId), 1, "and so is the lapsed request's card");
  assert.equal(told(s, third.botId), 1, "the other owner's Bot heard the settlement");
  assert.equal(row(s, lapsed.relId).status, "expired", "the lapsed request of the other owner is settled too");
  assert.equal(card(s, lapsed.cardId).status, "expired", "with the card waiting under it");
  assert.equal(uses(s, lapsed.inviteId), 0, "and the use it held goes back to its link");
  assert.equal(audits(s, "relationship.expired", lapsed.relId), 1, "the request's end is on the audit chain");
  assert.equal(told(s, lapsed.botId), 1, "the Bot waiting under it is told");
}

// ------------------------------------------------------------------ the decision that is refused
test("a decision refused because the request was never written settles nothing else", async (t) => {
  const s = await startServer({ authRateLimit: { perIp: 1000, perAccount: 1000 } });
  t.after(s.stop);
  const p = await waitingRelationshipCard(s, { autoAccept: false });
  const lapsed = await plantLapsedRequest(s, "dave");
  const third = await plantLapsedCard(s, "carol");
  lapse(s, lapsed.relId);
  // The torn-write shape: the card outlived the row it was written for. The door settles the card with the reason and
  // answers 409 -- an answer about the caller's own card, not a delivery moment for the rest of the platform.
  s.platform.db.prepare("DELETE FROM relationships WHERE id = ?").run(p.relId);

  const refusal = await expectApiError(p.B.owner.req("POST", `/v1/approvals/${p.approvalId}/decision`, { decision: "approved" }), 409, "invalid_state");
  assert.match(refusal.message, /the request this card was for was never written/, "the refusal names the missing row");
  const settled = card(s, p.approvalId);
  assert.equal(settled.status, "cancelled", "the caller's own card is settled, as it always was");
  assert.equal(count(s.platform.db, "SELECT COUNT(*) n FROM grants WHERE relationship_id = ?", p.relId), 0, "a refused decision wrote no grant");
  assertThirdPartyUntouched(s, third);
  assertLapsedRequestUntouched(s, lapsed);
});

test("an approval refused for a stopped peer Bot settles nothing else", async (t) => {
  const s = await startServer({ authRateLimit: { perIp: 1000, perAccount: 1000 } });
  t.after(s.stop);
  const p = await waitingRelationshipCard(s, { autoAccept: true });
  const lapsed = await plantLapsedRequest(s, "dave");
  const third = await plantLapsedCard(s, "carol");
  lapse(s, lapsed.relId);
  // The inviter's standing consent is not a consent to a stopped identity: the auto-accept gate answers 403 and leaves
  // the card pending. The stop happened while the card waited, so the caller's own row is the only one this concerns.
  const stopped: any = await p.A.owner.req("POST", "/v1/emergency-stop", { bot_id: p.A.bot.id });
  assert.equal(stopped.status, "frozen", "the fixture really stopped the inviter's Bot");

  const refusal = await expectApiError(p.B.owner.req("POST", `/v1/approvals/${p.approvalId}/decision`, { decision: "approved" }), 403, "bot_frozen");
  assert.match(refusal.message, /this bot is frozen/, "the refusal names the stop");
  assert.equal(card(s, p.approvalId).status, "pending", "the refusal leaves the card pending, as it always did");
  assert.equal(row(s, p.relId).status, "pending_requester_owner", "and takes back the half write it made");
  assert.equal(count(s.platform.db, "SELECT COUNT(*) n FROM grants WHERE relationship_id = ?", p.relId), 0, "no grant was written for a refused approval");
  assertThirdPartyUntouched(s, third);
  assertLapsedRequestUntouched(s, lapsed);
});

test("a decision on a request whose own row lapsed still answers 409 and settles nothing else", async (t) => {
  const s = await startServer({ authRateLimit: { perIp: 1000, perAccount: 1000 } });
  t.after(s.stop);
  const p = await waitingRelationshipCard(s, { autoAccept: false });
  const lapsed = await plantLapsedRequest(s, "dave");
  const third = await plantLapsedCard(s, "carol");
  lapse(s, lapsed.relId);
  // This is the one settlement the door does owe its own card: the request it was written for has run out, so the door
  // still answers 409 and still settles this request -- and nothing of another owner's.
  lapse(s, p.relId);

  const refusal = await expectApiError(p.B.owner.req("POST", `/v1/approvals/${p.approvalId}/decision`, { decision: "approved" }), 409, "invalid_state");
  assert.match(refusal.message, /approval is expired/, "the caller's own card lapsed, and the refusal says so");
  assert.equal(row(s, p.relId).status, "expired", "the caller's own request is settled with it");
  assert.equal(card(s, p.approvalId).status, "expired", "and so is the card");
  assert.equal(audits(s, "relationship.expired", p.relId), 1, "the door still settles the request it was written for");
  assertThirdPartyUntouched(s, third);
  assertLapsedRequestUntouched(s, lapsed);
});

// ------------------------------------------------------------------ the decision that is taken (controls)
test("the same card, rejected, still settles the queue (control)", async (t) => {
  const s = await startServer({ authRateLimit: { perIp: 1000, perAccount: 1000 } });
  t.after(s.stop);
  const p = await waitingRelationshipCard(s, { autoAccept: false });
  const lapsed = await plantLapsedRequest(s, "dave");
  const third = await plantLapsedCard(s, "carol");
  lapse(s, lapsed.relId);

  const decided: any = await p.B.owner.req("POST", `/v1/approvals/${p.approvalId}/decision`, { decision: "rejected" });
  assert.equal(decided.status, "cancelled", JSON.stringify(decided));
  assert.equal(uses(s, p.inv.invite_id), 0, "a real rejection gives its link's use back");
  assertQueueSettled(s, third, lapsed);
});

test("the same card, approved into an auto-accept invite, still settles the queue (control)", async (t) => {
  const s = await startServer({ authRateLimit: { perIp: 1000, perAccount: 1000 } });
  t.after(s.stop);
  const p = await waitingRelationshipCard(s, { autoAccept: true });
  const lapsed = await plantLapsedRequest(s, "dave");
  const third = await plantLapsedCard(s, "carol");
  lapse(s, lapsed.relId);

  const decided: any = await p.B.owner.req("POST", `/v1/approvals/${p.approvalId}/decision`, { decision: "approved" });
  assert.equal(decided.status, "active", JSON.stringify(decided));
  assert.equal(row(s, p.relId).status, "active", "the inviter's standing consent really activated the pair");
  assert.ok(count(s.platform.db, "SELECT COUNT(*) n FROM grants WHERE relationship_id = ? AND status = 'active'", p.relId) > 0, "the approved activation wrote its share");
  assertQueueSettled(s, third, lapsed);
});

// ------------------------------------------------------------------ the rows the refused decision would have written
test("a refused decision leaves the link's live row and the use its join spent exactly as they were", async (t) => {
  const s = await startServer({ authRateLimit: { perIp: 1000, perAccount: 1000 } });
  t.after(s.stop);
  const p = await waitingRelationshipCard(s, { autoAccept: true });
  const before = invite(s, p.inv.invite_id);
  assert.deepEqual(before, { status: "active", uses: 1 }, "the fixture link is live and has spent its one use");
  const stopped: any = await p.A.owner.req("POST", "/v1/emergency-stop", { bot_id: p.A.bot.id });
  assert.equal(stopped.status, "frozen");

  await expectApiError(p.B.owner.req("POST", `/v1/approvals/${p.approvalId}/decision`, { decision: "approved" }), 403, "bot_frozen");
  assert.deepEqual(invite(s, p.inv.invite_id), before, "a refused approval left the link's live row untouched");
  assert.equal(row(s, p.relId).status, "pending_requester_owner", "and the waiting request where it was");
  assert.equal(count(s.platform.db, "SELECT COUNT(*) n FROM grants WHERE relationship_id = ?", p.relId), 0, "and wrote no share");
  assert.equal(card(s, p.approvalId).decided_at, null, "the refused card carries no decision");
});
