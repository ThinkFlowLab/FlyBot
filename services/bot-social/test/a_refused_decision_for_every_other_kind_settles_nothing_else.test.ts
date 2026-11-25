// The four kinds lane G did not take still settle the whole platform on their way to a refusal.
//
// Lane E moved `grant_request` onto "settle only this card" and lane G did the same for `relationship_request`,
// putting the platform-wide sweep in the branch that actually writes a decision. The four remaining kinds --
// `outbound_message`, `face_room_message`, `action` and `invite` -- still ran `expireStale()` at the top of
// `decideApprovalOnce`, before the card's own status was read and before the line or the link was looked at. So a
// call whose card was already cancelled, or whose invite was revoked under it, answered `409` after having settled
// every other owner's lapsed card and lapsed request on the instance, given back their spent invite use and told
// their Bot.
//
// Each refusal case here plants a third owner's lapsed join (a pending request, its card, one spent use of a 1-use
// invite, both clocks in the past) and then asks one door to refuse: three kinds through a card that is already
// cancelled, and `invite` through a revoked link under a card an older build left pending, which is the branch's own
// `409`. The third owner's rows must be exactly where they were planted.
//
// The two success controls are the other half: an approved line and an approved invite still settle that third
// owner's queue, so a change that simply deletes the sweep fails here instead of looking green.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bulkAuth, expectApiError, friends, inDays, ownerWithBot, startServer } from "./helpers.js";

type S = Awaited<ReturnType<typeof startServer>>;

const past = () => new Date(Date.now() - 3600e3).toISOString();
const count = (db: any, sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as any).n as number;
const meeting = () => ({
  type: "schedule_meeting", summary: "sync",
  params: { duration_minutes: 30, window: { start: inDays(1, 0), end: inDays(8, 23) } },
});

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
  assert.equal(st.card.status, "pending", "a refused decision settled another owner's card");
  assert.equal(st.card.decided_at, null, "a refused decision stamped a decision on another owner's card");
  assert.equal(st.request.status, "pending_requester_owner", "a refused decision settled another owner's request");
  assert.equal(st.invite.uses, 1, "a refused decision gave another owner's invite use back");
  assert.equal(st.approvalExpired, 0, "a refused decision wrote an expiry audit line");
  assert.equal(st.relationshipExpired, 0, "a refused decision wrote a relationship expiry audit line");
  assert.equal(st.events, 0, "a refused decision told another owner's Bot");
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

/** The row-count half of the footprint: every table a decision can add a row to. */
const rowCounts = (s: S) => {
  const f = footprint(s);
  return { approvals: f.approvals, grants: f.grants, relationships: f.relationships, invites: f.invites };
};

/** A card whose status is no longer pending: the door must answer about it, not sweep the instance on the way. */
const cancelCard = (s: S, approvalId: string) =>
  s.platform.db.prepare("UPDATE approvals SET status = 'cancelled', decision = NULL, decided_at = ? WHERE id = ?").run(new Date().toISOString(), approvalId);

const decide = (owner: { req: Function }, approvalId: string, body: unknown) =>
  owner.req("POST", `/v1/approvals/${approvalId}/decision`, body as any);

/** The card id behind the line a Bot just drafted, from the door's own answer. */
const draftedCard = (d: any) => {
  assert.ok(d.approval_id, `a drafted line waits on a card: ${JSON.stringify(d)}`);
  return d.approval_id as string;
};

// --------------------------------------------------------------- a refusal is about one card
test("a refused invite decision whose card is already cancelled settles nothing else", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const { A } = await friends(s.base);
  const minted: any = await A.bot.signed("/v1/invites", "invite.create", { auto_accept: false, max_uses: 1 });
  const card = draftedCard(minted);
  cancelCard(s, card);
  const third = await lapsedThirdPartyJoin(s, "invite-gone");
  const before = footprint(s);

  await expectApiError(decide(A.owner, card, { decision: "approved" }), 409, "invalid_state");

  assertThirdPartyStillWaiting(s, third);
  assert.deepEqual(footprint(s), before, "a refused invite decision wrote a row anyway");
});

test("a refused outbound_message decision settles nothing else", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const conv: any = await A.bot.startConversation(B.bot.id, meeting());
  const card = draftedCard(await A.bot.draftMessage(conv.conversation_id, { text: "a line whose card is gone" }));
  cancelCard(s, card);
  const third = await lapsedThirdPartyJoin(s, "msg");
  const before = footprint(s);

  await expectApiError(decide(A.owner, card, { decision: "approved" }), 409, "invalid_state");

  assertThirdPartyStillWaiting(s, third);
  assert.deepEqual(footprint(s), before, "a refused outbound_message decision wrote a row anyway");
});

test("a refused face_room_message decision settles nothing else", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const ownerA = { kind: "owner" as const, ownerId: A.owner_id };
  const ownerB = { kind: "owner" as const, ownerId: B.owner_id };
  const first = s.platform.joinFaceRoom(ownerA, { code: "840202", bots: [A.bot.id] });
  s.platform.joinFaceRoom(ownerB, { code: "840202", bots: [B.bot.id] });
  s.platform.startFaceRoom(ownerA, first.room_id);
  const drafted: any = s.platform.draftFaceRoomMessage(ownerA, first.room_id, { text: "a room line whose card is gone" });
  const card = draftedCard(drafted);
  cancelCard(s, card);
  const third = await lapsedThirdPartyJoin(s, "room");
  const before = footprint(s);

  await expectApiError(decide(A.owner, card, { decision: "approved" }), 409, "invalid_state");

  assertThirdPartyStillWaiting(s, third);
  assert.deepEqual(footprint(s), before, "a refused face_room_message decision wrote a row anyway");
});

test("a refused action decision settles nothing else", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const conv: any = await A.bot.startConversation(B.bot.id, meeting());
  const card = draftedCard(await A.bot.draftAction(conv.conversation_id, "calendar.book", {
    title: "Sync", start: inDays(1, 10), end: inDays(1, 11), attendees: [B.bot.id],
  }, "plan the week"));
  cancelCard(s, card);
  const third = await lapsedThirdPartyJoin(s, "action");
  const before = footprint(s);

  await expectApiError(decide(A.owner, card, { decision: "approved" }), 409, "invalid_state");

  assertThirdPartyStillWaiting(s, third);
  assert.deepEqual(footprint(s), before, "a refused action decision wrote a row anyway");
});

test("a refused invite decision settles nothing else", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const { A } = await friends(s.base);
  const minted: any = await A.bot.signed("/v1/invites", "invite.create", { auto_accept: false, max_uses: 1 });
  const card = draftedCard(minted);
  // The link was revoked under a card an older build left waiting: the branch's own `409`, not the status check.
  s.platform.db.prepare("UPDATE invites SET status = 'revoked' WHERE id = ?").run(
    (s.platform.db.prepare("SELECT subject_id FROM approvals WHERE id = ?").get(card) as any).subject_id,
  );
  const third = await lapsedThirdPartyJoin(s, "invite");
  const rowsBefore = rowCounts(s);

  const refusal = await expectApiError(decide(A.owner, card, { decision: "approved" }), 409, "invalid_state");
  assert.match(refusal.message, /revoked/, "the refusal names what happened to the link");

  assertThirdPartyStillWaiting(s, third);
  // This door settles its own card (and says so); that is the only row it may write.
  assert.deepEqual(rowCounts(s), rowsBefore, "a refused invite decision added a row anyway");
  const cardRow: any = s.platform.db.prepare("SELECT status, decision FROM approvals WHERE id = ?").get(card);
  assert.equal(cardRow.status, "cancelled", "the card it answered about is settled");
  assert.equal(cardRow.decision, "invite_revoked", "settled with the reason the link gives");
  assert.equal(count(s.platform.audit.db, "SELECT COUNT(*) n FROM audit_events WHERE action = 'approval.expired'"), 0, "a refused invite decision wrote an expiry audit line");
  assert.equal(count(s.platform.audit.db, "SELECT COUNT(*) n FROM audit_events WHERE action = 'relationship.expired'"), 0, "a refused invite decision wrote a relationship expiry audit line");
});

// --------------------------------------------------------------- a decision that lands still settles the queue
test("an approved outbound message still settles the third owner's lapsed card", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const conv: any = await A.bot.startConversation(B.bot.id, meeting());
  const card = draftedCard(await A.bot.draftMessage(conv.conversation_id, { text: "the line that really lands" }));
  const third = await lapsedThirdPartyJoin(s, "msg-ok");

  const decided: any = await decide(A.owner, card, { decision: "approved" });
  assert.equal(decided.decision, "approved", JSON.stringify(decided));
  assertThirdPartySettled(s, third);
});

test("an approved invite still settles the third owner's lapsed card", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const { A } = await friends(s.base);
  const minted: any = await A.bot.signed("/v1/invites", "invite.create", { auto_accept: false, max_uses: 1 });
  const card = draftedCard(minted);
  const third = await lapsedThirdPartyJoin(s, "invite-ok");

  const decided: any = await decide(A.owner, card, { decision: "approved" });
  assert.equal(decided.status, "active", JSON.stringify(decided));
  assertThirdPartySettled(s, third);
});
