/**
 * A stop must not leave a Bot-Sent friend request half settled.
 *
 * The kill switch cancels the `relationship_request` card but leaves the `relationships` row it was written for
 * at `pending_requester_owner`. The card is gone, so no door can decide it, and only the 7-day TTL in `expireStale`
 * ever flips the row. Until then every later request to the same peer is refused `relationship_exists`, for a card
 * nobody can approve: the pair is locked out for a week by its own stop.
 *
 * The shape the other kinds already have in `cancelPendingFor` — settle the subject row with the card — is the fix:
 * the relationship row becomes `expired` only while it is still `pending_requester_owner`, so a row the owner
 * approved (or that a block/unfriend already settled) is untouched.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { expectApiError, ownerWithBot, startServer } from "./helpers.js";

const relStatus = (S: any, relId: string) => (S.platform.db.prepare("SELECT status FROM relationships WHERE id = ?").get(relId) as any)?.status;
const relUpdatedAt = (S: any, relId: string) => (S.platform.db.prepare("SELECT updated_at FROM relationships WHERE id = ?").get(relId) as any)?.updated_at;
const approvalRow = (S: any, approvalId: string) => S.platform.db.prepare("SELECT status, decision FROM approvals WHERE id = ?").get(approvalId) as any;
const relationOf = async (owner: any, relId: string) => ((await owner.req("GET", "/v1/relationships")).relationships as any[]).find((r) => r.relationship_id === relId);

/** A's signed request to B, plus a stop of A: the shared opening of every case below. */
async function stoppedRequest(S: any, name: string) {
  const A = await ownerWithBot(S.base, `${name}-a`);
  const B = await ownerWithBot(S.base, `${name}-b`);
  // (1) A's signed request waits on A's owner: the card is pending and the pair carries the row.
  const req: any = await A.bot.requestFriend(B.handle, "let's be friends");
  assert.equal(req.status, "pending_requester_owner");
  assert.ok(req.approval_id, "a Bot-sent request waits on its own owner's approval");
  assert.equal(approvalRow(S, req.approval_id).status, "pending");
  assert.equal(relStatus(S, req.relationship_id), "pending_requester_owner");
  const beforeUpdatedAt = relUpdatedAt(S, req.relationship_id);
  // (2) The kill switch takes A down.
  await A.owner.req("POST", "/v1/emergency-stop", { bot_id: A.bot.id });
  return { A, B, req, beforeUpdatedAt };
}

test("the stop cancels the card and settles the relationship row it was written for", async (t) => {
  const S = await startServer();
  t.after(S.stop);
  const { A, req, beforeUpdatedAt } = await stoppedRequest(S, "stoprel-row");

  // The card is cancelled by the stop, with a reason a client can show.
  const card = approvalRow(S, req.approval_id);
  assert.equal(card.status, "cancelled");
  assert.equal(card.decision, "emergency_stop");

  // (3) The row the card was written for is terminal too: a card nobody can decide must not hold a relationship.
  assert.equal(relStatus(S, req.relationship_id), "expired", "the cancelled card's relationship row is settled");
  // Same row shape as the TTL path: `expireStale` writes `updated_at` when it settles a stale request, and every
  // other status transition on this table writes it too, so the row a stop settles must carry the moment it ended
  // rather than the moment the request was made (ISO strings compare as text).
  assert.ok(relUpdatedAt(S, req.relationship_id) > beforeUpdatedAt, "the settled row records when it was settled");
  const mine: any = await relationOf(A.owner, req.relationship_id);
  assert.equal(mine.status, "expired", "the requester's owner reads the request as expired, not pending");
});

test("the peer's owner is not left reading a live request", async (t) => {
  const S = await startServer();
  t.after(S.stop);
  const { B, req } = await stoppedRequest(S, "stoprel-peer");

  // (5) The peer cannot be asked about a card that no longer exists, so the row must not stay live for it either.
  const theirs: any = await relationOf(B.owner, req.relationship_id);
  assert.notEqual(theirs.status, "pending_requester_owner", "the target's owner is not left with a live request");
  assert.equal(theirs.status, "expired");
});

test("the pair can ask again once the Bot resumes", async (t) => {
  const S = await startServer();
  t.after(S.stop);
  const { A, B, req } = await stoppedRequest(S, "stoprel-again");

  // (4) The row from the stopped request is not a lock: resuming A lets the same pair ask again.
  const resumed = await A.owner.req("POST", `/v1/bots/${A.bot.id}/resume`);
  A.bot.cred.token = resumed.bot_token;
  const again: any = await A.bot.requestFriend(B.handle, "now that I am back");
  assert.notEqual(again.relationship_id, req.relationship_id);
  assert.equal(again.status, "pending_requester_owner");
  assert.equal(relStatus(S, again.relationship_id), "pending_requester_owner");

  // The old row stays terminal: the second request did not revive it.
  assert.equal(relStatus(S, req.relationship_id), "expired");
});

test("control: stopping the target does not settle the requester's pending request", async (t) => {
  const S = await startServer();
  t.after(S.stop);
  const A = await ownerWithBot(S.base, "stoprel-target-a");
  const B = await ownerWithBot(S.base, "stoprel-target-b");

  const req: any = await A.bot.requestFriend(B.handle, "still your turn");
  assert.equal(relStatus(S, req.relationship_id), "pending_requester_owner");

  // The card belongs to A's owner, so stopping B must leave it decidable and the row pending.
  await B.owner.req("POST", "/v1/emergency-stop", { bot_id: B.bot.id });
  assert.equal(approvalRow(S, req.approval_id).status, "pending", "the target's stop does not decide the requester's card");
  assert.equal(relStatus(S, req.relationship_id), "pending_requester_owner");

  // And it is still decidable: approving it moves the row to B's consent once B is back.
  await B.owner.req("POST", `/v1/bots/${B.bot.id}/resume`);
  await A.owner.req("POST", `/v1/approvals/${req.approval_id}/decision`, { decision: "approved" });
  assert.equal(relStatus(S, req.relationship_id), "pending_target");
  await B.owner.req("POST", `/v1/relationships/${req.relationship_id}/consent`, { decision: "accept", grant_capabilities: [] });
  assert.equal(relStatus(S, req.relationship_id), "active");
});

test("control: a row the owner already approved is not settled by a later stop", async (t) => {
  const S = await startServer();
  t.after(S.stop);
  const A = await ownerWithBot(S.base, "stoprel-approved-a");
  const B = await ownerWithBot(S.base, "stoprel-approved-b");

  const req: any = await A.bot.requestFriend(B.handle, "approve me");
  await A.owner.req("POST", `/v1/approvals/${req.approval_id}/decision`, { decision: "approved" });
  await B.owner.req("POST", `/v1/relationships/${req.relationship_id}/consent`, { decision: "accept", grant_capabilities: [] });

  await A.owner.req("POST", "/v1/emergency-stop", { bot_id: A.bot.id });
  // No pending card exists any more, so nothing sweeps the active row: the guard keeps a decided relationship.
  assert.equal(relStatus(S, req.relationship_id), "active", "an approved relationship is not expired by a stop");
  assert.equal(approvalRow(S, req.approval_id).status, "approved");
  await expectApiError(B.bot.startConversation(A.bot.id, { type: "general_chat", summary: "hello?" }), 403, "bot_frozen");
});
