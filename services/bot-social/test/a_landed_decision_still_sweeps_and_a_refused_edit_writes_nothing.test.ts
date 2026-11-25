// A decision that lands is still a delivery moment; a decision refused over a bad edit is not.
//
// Lane E moved the platform-wide sweep off the answers that refuse and left it on the paths that really answer the
// caller: `consent`'s `decline` sweeps before it writes its row, `consent`'s `accept` sweeps after its own refusals and
// before `activateRelationship`, a rejected `grant_request` card sweeps before its own decision, and an approved one
// sweeps after both `assertInvitable` calls, the scope check and `grantExpiry`. "Moved, not deleted" needs a witness:
// the first two cases plant a third owner's lapsed request -- one pending join, one lapsed card, one spent invite use,
// all past their clocks -- and ask each successful door to settle it. The card must end `expired` with a `decided_at`,
// the request must end `expired`, `approval.expired` and `relationship.expired` must be on the audit chain, the asking
// Bot must hear `approval.decided`, and the invite's use must come back.
//
// The other half is why the sweep sits behind the checks: a refused edit is not a delivery moment either. A
// `grant_request` card decided `approved_with_edits` with a bad `expires_in_days` or a bad scope answers 400 from
// `grantExpiry` / `assertScope` -- both before the sweep, before the supersede, before the card is decided and before
// any grant row. The third owner's card must stay pending with `decided_at` NULL, its join must stay waiting with the
// use still spent, and no `approval.expired`, `relationship.expired`, `approval.decided` or `grant.created` row may
// appear. These cases are also the control for the first two: a change that simply stops sweeping everywhere would
// fail them the other way round, because the two successful doors above would then leave the third owner's card
// waiting.
//
// Nothing here changes a production line: both halves pin behaviour the platform already has, so the file is green on
// the base commit and red only under the three mutations listed in the pull request.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bulkAuth, expectApiError, friends, ownerWithBot, startServer } from "./helpers.js";

const CAP = "calendar.freebusy.read";
const SCOPED = { window_days: 14 };
type S = Awaited<ReturnType<typeof startServer>>;

const past = () => new Date(Date.now() - 3600e3).toISOString();
const count = (db: any, sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as any).n as number;

/**
 * A third owner's lapsed join: one pending request, the card behind it, and one spent use of a 1-use invite. The
 * joins are minted through the platform's own doors so `releaseInviteUse` has a real `relationship_invites` row to
 * find; then both clocks are set into the past, which is the state a platform-wide sweep is expected to settle.
 */
async function lapsedThirdPartyJoin(s: S, tag: string) {
  const A = await ownerWithBot(s.base, `third-a-${tag}`);
  const B = await ownerWithBot(s.base, `third-b-${tag}`);
  const inv = (s.platform as any).createInvite(
    { kind: "owner" as const, ownerId: A.owner_id },
    { bot_id: A.bot.id, auto_accept: false, max_uses: 1 },
  );
  const join: any = await B.bot.signed(`/v1/invites/${inv.code}/join`, "invite.join", { code: inv.code });
  assert.equal(join.status, "pending_requester_owner", JSON.stringify(join));
  assert.ok(join.approval_id, "a Bot's join waits on its own owner's card");
  s.platform.db.prepare("UPDATE relationships SET expires_at = ? WHERE id = ?").run(past(), join.relationship_id);
  s.platform.db.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?").run(past(), join.approval_id);
  return {
    owner: A.owner,
    askingBot: B.bot,
    botId: B.bot.id as string,
    code: inv.code as string,
    relId: join.relationship_id as string,
    approvalId: join.approval_id as string,
  };
}

/** Everything a sweep writes on that third party, in one read. */
function thirdParty(s: S, p: Awaited<ReturnType<typeof lapsedThirdPartyJoin>>) {
  return {
    card: s.platform.db.prepare("SELECT status, decided_at FROM approvals WHERE id = ?").get(p.approvalId) as any,
    request: s.platform.db.prepare("SELECT status FROM relationships WHERE id = ?").get(p.relId) as any,
    invite: s.platform.db.prepare("SELECT status, uses FROM invites WHERE code = ?").get(p.code) as any,
    approvalExpired: count(s.platform.audit.db, "SELECT COUNT(*) n FROM audit_events WHERE action = 'approval.expired' AND subject = ?", p.approvalId),
    relationshipExpired: count(s.platform.audit.db, "SELECT COUNT(*) n FROM audit_events WHERE action = 'relationship.expired' AND subject = ?", p.relId),
    events: count(s.platform.db, "SELECT COUNT(*) n FROM events WHERE type = 'approval.decided' AND bot_id = ?", p.botId),
  };
}

/** The third owner's row is exactly where it was planted: waiting, with the link's use still spent. */
function assertThirdPartyStillWaiting(s: S, p: Awaited<ReturnType<typeof lapsedThirdPartyJoin>>) {
  const st = thirdParty(s, p);
  assert.equal(st.card.status, "pending", "a call that was refused settled another owner's card");
  assert.equal(st.card.decided_at, null, "a call that was refused stamped a decision on another owner's card");
  assert.equal(st.request.status, "pending_requester_owner", "a call that was refused settled another owner's request");
  assert.equal(st.invite.uses, 1, "a call that was refused gave another owner's invite use back");
  assert.equal(st.approvalExpired, 0, "a call that was refused wrote an expiry audit line");
  assert.equal(st.relationshipExpired, 0, "a call that was refused wrote a relationship expiry audit line");
  assert.equal(st.events, 0, "a call that was refused told another owner's Bot");
}

/** The third owner's row is settled the way the sweep settles it: the clock is recorded, never silent. */
function assertThirdPartySettled(s: S, p: Awaited<ReturnType<typeof lapsedThirdPartyJoin>>) {
  const st = thirdParty(s, p);
  assert.equal(st.card.status, "expired", "a door that answers its caller still opens the delivery moment");
  assert.ok(st.card.decided_at, "the settlement records the instant it happened");
  assert.equal(st.request.status, "expired", "a lapsed request is written down with the queue it waited in");
  assert.equal(st.invite.uses, 0, "the lapsed request gives its invite use back");
  assert.equal(st.approvalExpired, 1, "the expiry is on the audit chain");
  assert.equal(st.relationshipExpired, 1, "the request's own settlement is on the audit chain");
  assert.equal(st.events, 1, "the asking Bot heard the settlement");
}

/** Row counts across the tables a decision can write; a refused call leaves every one of them unchanged. */
function footprint(s: S) {
  return {
    approvals: count(s.platform.db, "SELECT COUNT(*) n FROM approvals"),
    grants: count(s.platform.db, "SELECT COUNT(*) n FROM grants"),
    relationships: count(s.platform.db, "SELECT COUNT(*) n FROM relationships"),
    invites: count(s.platform.db, "SELECT COUNT(*) n FROM invites"),
    events: count(s.platform.db, "SELECT COUNT(*) n FROM events"),
    webhook_deliveries: count(s.platform.db, "SELECT COUNT(*) n FROM webhook_deliveries"),
    audit: count(s.platform.audit.db, "SELECT COUNT(*) n FROM audit_events"),
  };
}

/** A pending friendship that waits for B's owner. */
async function pendingConsent(s: S) {
  const A = await ownerWithBot(s.base, "consent-a");
  const B = await ownerWithBot(s.base, "consent-b");
  const asked: any = await A.owner.req("POST", "/v1/relationships", {
    from_bot_id: A.bot.id,
    target_handle: B.handle,
    message: "hi",
    requested_capabilities: ["chat.public"],
  });
  return { A, B, relId: asked.relationship_id as string };
}

/** Two friends, with A's Bot asking B's Bot for one capability: the `grant_request` card B's owner decides. */
async function waitingGrantCard(s: S) {
  const { A, B, relId } = await friends(s.base);
  const req: any = await A.bot.requestGrant(relId, CAP, SCOPED);
  assert.equal(req.status, "pending_owner_approval");
  return { A, B, relId, approvalId: req.approval_id as string };
}

const card = (s: S, approvalId: string) =>
  s.platform.db.prepare("SELECT status, decided_at FROM approvals WHERE id = ?").get(approvalId) as any;

// ------------------------------------------------------------- a decision that lands still settles the queue
test("a declined consent still settles the third owner's lapsed card (the sweep is moved, not deleted)", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const p = await pendingConsent(s);
  const third = await lapsedThirdPartyJoin(s, "decline");

  const declined: any = await p.B.owner.req("POST", `/v1/relationships/${p.relId}/consent`, { decision: "decline" });
  assert.equal(declined.status, "declined", JSON.stringify(declined));
  assertThirdPartySettled(s, third);
});

test("a rejected grant card still settles the third owner's lapsed card (the sweep is moved, not deleted)", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const { A, B, approvalId } = await waitingGrantCard(s);
  const third = await lapsedThirdPartyJoin(s, "reject");

  const decided: any = await B.owner.req("POST", `/v1/approvals/${approvalId}/decision`, { decision: "rejected" });
  assert.equal(decided.decision, "rejected", JSON.stringify(decided));
  assert.equal(card(s, approvalId).status, "rejected", "the card itself is decided");
  assert.equal(s.platform.findGrant(B.owner_id, A.bot.id, CAP), null, "a rejection writes no share");
  assertThirdPartySettled(s, third);
});

// ------------------------------------------------------------- a refused edit is not a delivery moment
test("an approval edit refused for a bad expires_in_days writes nothing and settles nothing", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const { A, B, relId, approvalId } = await waitingGrantCard(s);
  const third = await lapsedThirdPartyJoin(s, "edit-expiry");
  const sharesOf = () => count(s.platform.audit.db, "SELECT COUNT(*) n FROM audit_events WHERE action = 'grant.created' AND json_extract(data, '$.relationship_id') = ?", relId);
  const before = { footprint: footprint(s), shares: sharesOf() };

  const refusal = await expectApiError(
    B.owner.req("POST", `/v1/approvals/${approvalId}/decision`, { decision: "approved_with_edits", edited_params: { expires_in_days: 0 } }),
    400,
    "invalid_request",
  );
  assert.match(refusal.message, /positive number of days/, "the refusal names the value it refused");

  const after = card(s, approvalId);
  assert.equal(after.status, "pending", "a refused edit decided the card");
  assert.equal(after.decided_at, null, "a refused edit stamped a decision on the card");
  assert.equal(s.platform.findGrant(B.owner_id, A.bot.id, CAP), null, "a refused edit wrote the share");
  assert.equal(sharesOf(), before.shares, "a refused edit audited a share");
  assertThirdPartyStillWaiting(s, third);
  assert.deepEqual(footprint(s), before.footprint, "a refused edit wrote a row anyway");
});

test("an approval edit refused for a bad scope writes nothing and settles nothing", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const { A, B, relId, approvalId } = await waitingGrantCard(s);
  const third = await lapsedThirdPartyJoin(s, "edit-scope");
  const sharesOf = () => count(s.platform.audit.db, "SELECT COUNT(*) n FROM audit_events WHERE action = 'grant.created' AND json_extract(data, '$.relationship_id') = ?", relId);
  const before = { footprint: footprint(s), shares: sharesOf() };

  const refusal = await expectApiError(
    B.owner.req("POST", `/v1/approvals/${approvalId}/decision`, { decision: "approved_with_edits", edited_params: { scope: { window_days: 0 } } }),
    400,
    "invalid_request",
  );
  assert.match(refusal.message, /scope\.window_days must be a positive whole number/, "the refusal names the value it refused");

  const after = card(s, approvalId);
  assert.equal(after.status, "pending", "a refused edit decided the card");
  assert.equal(after.decided_at, null, "a refused edit stamped a decision on the card");
  assert.equal(s.platform.findGrant(B.owner_id, A.bot.id, CAP), null, "a refused edit wrote the share");
  assert.equal(sharesOf(), before.shares, "a refused edit audited a share");
  assertThirdPartyStillWaiting(s, third);
  assert.deepEqual(footprint(s), before.footprint, "a refused edit wrote a row anyway");
});
