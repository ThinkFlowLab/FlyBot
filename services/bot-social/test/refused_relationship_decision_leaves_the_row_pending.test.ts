/**
 * A refused friend-request approval must leave no half write.
 *
 * A Bot's signed `invite.join` on an auto-accept invite waits on the joiner's owner as a `relationship_request`
 * card. Approving it moved the relationships row to `pending_target` first and only then asked the invite whether
 * it could still activate: with the inviter's Bot frozen in the meantime, `assertInvitable` answered 403
 * `bot_frozen` after the row had already moved (the UPDATE runs in autocommit). The card stayed pending, the
 * inviter's owner read a live `pending_target` the platform never announced, and once that owner consented the
 * old card activated the friendship a second time — four fresh grants, superseding the four the pair held.
 *
 * The door's own sentence is in `autoAcceptSpecs`: "A refusal leaves the card pending." A refusal is not a
 * settlement. The row, the card and the counters must read exactly as they did before the decision, and the
 * same card must still be decidable once the Bot is back.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { expectApiError, ownerWithBot, startServer } from "./helpers.js";

const relRow = (S: any, relId: string) => S.platform.db.prepare("SELECT status, updated_at FROM relationships WHERE id = ?").get(relId) as any;
const approvalRow = (S: any, approvalId: string) => S.platform.db.prepare("SELECT status, decision FROM approvals WHERE id = ?").get(approvalId) as any;
const inviteUses = (S: any, code: string) => (S.platform.db.prepare("SELECT uses FROM invites WHERE code = ?").get(code) as any).uses;
const auditCount = (S: any) => (S.platform.audit.db.prepare("SELECT COUNT(*) AS n FROM audit_events").get() as any).n;

/** What a refused decision must not move: neither the pair's rows nor the two ledgers. */
function counters(S: any) {
  const db = S.platform.db;
  return {
    relationships: (db.prepare("SELECT COUNT(*) AS n FROM relationships").get() as any).n,
    grants: (db.prepare("SELECT COUNT(*) AS n FROM grants").get() as any).n,
    events: (db.prepare("SELECT COUNT(*) AS n FROM events").get() as any).n,
    audit: auditCount(S),
  };
}

/** An auto-accept invite whose join waits on the joiner's owner: the card this door decides. */
async function waitingJoin(S: any, name: string) {
  const INV = await ownerWithBot(S.base, `${name}-inv`);
  const REQ = await ownerWithBot(S.base, `${name}-req`);
  const inv: any = await INV.owner.req("POST", "/v1/invites", { bot_id: INV.bot.id, auto_accept: true, offered_capabilities: ["chat.public"] });
  assert.equal(inv.auto_accept, true);
  const joined: any = await REQ.bot.signed(`/v1/invites/${inv.code}/join`, "invite.join", {});
  assert.equal(joined.status, "pending_requester_owner");
  assert.ok(joined.approval_id, "the Bot's join waits on its own owner");
  assert.equal(relRow(S, joined.relationship_id).status, "pending_requester_owner");
  assert.equal(approvalRow(S, joined.approval_id).status, "pending");
  return { INV, REQ, inv, joined };
}

test("a frozen Bot refuses the decision and the waiting card keeps its row", async (t) => {
  const S = await startServer();
  t.after(S.stop);
  const { INV, REQ, inv, joined } = await waitingJoin(S, "refused-frozen");

  // The inviter's owner stops the Bot while the joiner's card waits. The card belongs to the joiner's owner, so
  // the stop leaves it decidable (the shape `stopped_bot_relationship_request_settles` pins from the other side).
  const stopped: any = await INV.owner.req("POST", "/v1/emergency-stop", { bot_id: INV.bot.id });
  assert.equal(stopped.status, "frozen");
  assert.equal(approvalRow(S, joined.approval_id).status, "pending");
  const rowBefore = relRow(S, joined.relationship_id);
  const before = counters(S);

  await expectApiError(REQ.owner.req("POST", `/v1/approvals/${joined.approval_id}/decision`, { decision: "approved" }), 403, "bot_frozen");

  // The refusal wrote nothing at all: not the row, not the card, not the invite's uses, not one ledger line.
  assert.deepEqual(counters(S), before, "a refusal leaves no row, grant, event or audit line behind");
  assert.equal(relRow(S, joined.relationship_id).status, "pending_requester_owner", "a refusal is not a settlement");
  assert.equal(relRow(S, joined.relationship_id).updated_at, rowBefore.updated_at, "the row is untouched, not rewritten in place");
  assert.equal(approvalRow(S, joined.approval_id).status, "pending", "the owner can decide the same card again");
  assert.equal(inviteUses(S, inv.code), 1, "the join's slot stays spent while the request still waits");
  // The peer's owner never reads a live request the platform never announced.
  const peer: any = await INV.owner.req("GET", "/v1/relationships");
  const theirs = peer.relationships.find((r: any) => r.relationship_id === joined.relationship_id);
  assert.equal(theirs.status, "pending_requester_owner");
  assert.equal(theirs.direction, "incoming");
  assert.equal(S.platform.audit.verify().ok, true);

  // The refusal is not a dead end: with the Bot back, the same card activates the auto-accept friendship once.
  await INV.owner.req("POST", `/v1/bots/${INV.bot.id}/resume`);
  const accepted: any = await REQ.owner.req("POST", `/v1/approvals/${joined.approval_id}/decision`, { decision: "approved" });
  assert.equal(accepted.status, "active", "the waiting auto-accept invite activates on the approval that succeeds");
  assert.equal(relRow(S, joined.relationship_id).status, "active");
  const grants = S.platform.db.prepare("SELECT status FROM grants WHERE relationship_id = ?").all(joined.relationship_id) as any[];
  assert.ok(grants.length > 0, "the live friendship carries its grants");
  assert.equal(grants.filter((g) => g.status === "superseded").length, 0, "one activation supersedes nothing");
  const acceptedLines = S.platform.audit.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'relationship.accepted' AND subject = ?").get(joined.relationship_id) as any;
  assert.equal(acceptedLines.n, 1, "the friendship is announced once");
});

test("the refusal is only the approve leg: rejecting the same card still settles it", async (t) => {
  const S = await startServer();
  t.after(S.stop);
  const { INV, REQ, inv, joined } = await waitingJoin(S, "refused-reject");

  const rejected: any = await REQ.owner.req("POST", `/v1/approvals/${joined.approval_id}/decision`, { decision: "rejected" });
  assert.equal(rejected.relationship_id, joined.relationship_id);
  assert.equal(relRow(S, joined.relationship_id).status, "cancelled");
  assert.equal(approvalRow(S, joined.approval_id).status, "rejected");
  assert.equal(inviteUses(S, inv.code), 0, "a rejected join gives the invite's slot back");
  assert.equal(S.platform.audit.verify().ok, true);
});

test("a card whose relationship is already live settles without re-activating it", async (t) => {
  const S = await startServer();
  t.after(S.stop);
  const { INV, REQ, joined } = await waitingJoin(S, "refused-live");

  // The shape an older build left behind: the decision door moved the row although it refused the card, and the
  // peer's owner then consented, so the friendship is live while the card still waits. This build cannot reach
  // that state (the row and the card now travel together), so it is seeded here, as the torn-write fixtures do.
  S.platform.db.prepare("UPDATE relationships SET status = 'pending_target' WHERE id = ?").run(joined.relationship_id);
  await INV.owner.req("POST", `/v1/relationships/${joined.relationship_id}/consent`, { decision: "accept", grant_capabilities: [] });
  assert.equal(relRow(S, joined.relationship_id).status, "active");

  const grantRows = () => S.platform.db.prepare("SELECT id, status FROM grants WHERE relationship_id = ? ORDER BY id").all(joined.relationship_id);
  const acceptedAudit = () => (S.platform.audit.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'relationship.accepted' AND subject = ?").get(joined.relationship_id) as any).n;
  const changedEvents = () => (S.platform.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'relationship.changed' AND data LIKE ?").get(`%${joined.relationship_id}%`) as any).n;
  const liveRow = relRow(S, joined.relationship_id);
  const grantsBefore = grantRows();
  assert.ok(grantsBefore.length > 0, "the live friendship carries its grants");
  const before = counters(S);

  const decided: any = await REQ.owner.req("POST", `/v1/approvals/${joined.approval_id}/decision`, { decision: "approved" });

  // The card settles against the relationship it found: 200, the row's own status, nothing re-activated.
  assert.equal(decided.status, "active");
  assert.equal(relRow(S, joined.relationship_id).status, "active");
  assert.equal(relRow(S, joined.relationship_id).updated_at, liveRow.updated_at, "the live row is not rewritten");
  assert.deepEqual(grantRows(), grantsBefore, "no grant is superseded and none is written again");
  assert.equal(acceptedAudit(), 1, "the friendship is not announced a second time");
  assert.equal(changedEvents(), 2, "each side hears the live friendship once");
  assert.equal(approvalRow(S, joined.approval_id).status, "approved", "the card itself is settled");
  // Only the card's own record moves: one audit line and one event for the Bot that owned the card.
  const after = counters(S);
  assert.equal(after.relationships, before.relationships);
  assert.equal(after.grants, before.grants);
  assert.equal(after.audit, before.audit + 1);
  assert.equal(after.events, before.events + 1);
  assert.equal(S.platform.audit.verify().ok, true);
});
