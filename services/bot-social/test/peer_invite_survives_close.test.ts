import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { bulkAuth, friends, inDays, startServer } from "./helpers.js";

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(bulkAuth); });
after(async () => { await S.stop(); });

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const meeting = (extra: Record<string, unknown> = {}) => ({
  type: "schedule_meeting", summary: "sync",
  params: { duration_minutes: 30, window: { start: inDays(1, 0), end: inDays(8, 23) } },
  ...extra,
});
const approvalCard = async (owner: any, status: string, id: string) =>
  ((await owner.req("GET", `/v1/approvals?status=${status}`)).approvals as any[]).find((a) => a.approval_id === id);

/** A books a meeting and its owner approves, so B holds a live `invited` calendar entry. */
async function bookedMeeting(A: any, B: any, intent: unknown = meeting(), hour = 10) {
  const cid = (await A.bot.startConversation(B.bot.id, intent)).conversation_id as string;
  const book = await A.bot.draftAction(cid, "calendar.book", { title: "Sync", start: inDays(1, hour), end: inDays(1, hour + 1), attendees: [B.bot.id] });
  const ex: any = await A.owner.req("POST", `/v1/approvals/${book.approval_id}/decision`, { decision: "approved" });
  assert.equal(ex.status, "executed", "the booking must execute before the invitee can accept it");
  return { cid, booking_id: ex.result.booking_id as string };
}

describe("closing a chat keeps the peer's invite decision, and says what it cancelled (P13)", () => {
  test("(a) the peer's accept draft survives the initiator's close and can still be approved into a confirmed booking", async () => {
    const { A, B } = await friends(S.base);
    const { cid, booking_id } = await bookedMeeting(A, B);
    const acc = await B.bot.draftAction(cid, "calendar.accept_invite", { booking_id });
    assert.equal(acc.status, "pending_approval");

    await A.bot.close(cid, "agreed", "slot agreed");

    assert.ok(await approvalCard(B.owner, "pending", acc.approval_id), "the peer's accept is still decidable after the close");
    assert.equal((await approvalCard(B.owner, "cancelled", acc.approval_id)), undefined, "and it was not silently cancelled");
    const evs = (await B.bot.events()).events.filter((e: any) => e.event_type === "approval.decided" && e.approval_id === acc.approval_id);
    assert.equal(evs.length, 0, "nothing to announce while the card is still live");

    const done: any = await B.owner.req("POST", `/v1/approvals/${acc.approval_id}/decision`, { decision: "approved" });
    assert.equal(done.status, "executed");
    assert.equal(done.result.invitee_status, "accepted");
    assert.equal((S.platform.db.prepare("SELECT status FROM calendar_entries WHERE booking_id = ? AND owner_id = ?").get(booking_id, B.owner_id) as any).status, "confirmed");
  });

  test("(b) a peer message draft cancelled by the close is announced, readable on the card, and cannot be decided", async () => {
    const { A, B } = await friends(S.base);
    const cid = (await A.bot.startConversation(B.bot.id, meeting())).conversation_id;
    const draft = await B.bot.draftMessage(cid, { text: "peer draft that must not vanish silently" });
    assert.equal(draft.status, "pending_approval");

    await A.bot.close(cid, "abandoned", "closing");

    const evs = (await B.bot.events()).events.filter((e: any) => e.event_type === "approval.decided" && e.approval_id === draft.approval_id);
    assert.equal(evs.length, 1, "the Bot that owned the card is told exactly once");
    assert.equal(evs[0].decision, "cancelled");
    assert.equal(evs[0].reason, "conversation_closed");

    const card: any = await approvalCard(B.owner, "cancelled", draft.approval_id);
    assert.equal(card.status, "cancelled");
    assert.equal(card.decision, "conversation_closed", "the card carries a readable reason");
    assert.equal((S.platform.db.prepare("SELECT status FROM messages WHERE id = ?").get(draft.message_id) as any).status, "cancelled");

    await assert.rejects(B.owner.req("POST", `/v1/approvals/${draft.approval_id}/decision`, { decision: "approved" }),
      (e: any) => e.status === 409 && e.code === "invalid_state");
  });

  test("(c) an accept draft lands on a closed and on an expired conversation, even when the initiator narrowed allowed_capabilities", async () => {
    const { A, B } = await friends(S.base);
    // The initiator could always narrow this list; it used to veto the invitee's accept.
    const narrow = meeting({ allowed_capabilities: ["chat.public", "calendar.book"] });

    // Closed by agreement: the invite outlives the chat.
    const closed = await bookedMeeting(A, B, narrow);
    await A.bot.close(closed.cid, "agreed", "done");
    const onClosed = await B.bot.draftAction(closed.cid, "calendar.accept_invite", { booking_id: closed.booking_id });
    assert.equal(onClosed.status, "pending_approval");
    const closedView: any = await B.bot.getConversation(closed.cid);
    assert.equal(closedView.status, "closed");
    assert.equal(closedView.outcome, "agreed", "drafting the accept must not reopen the conversation");

    // Expired: materialising the expiry closes it with outcome expired, and the draft still lands.
    const expired = await bookedMeeting(A, B, narrow, 12);
    S.platform.db.prepare("UPDATE conversations SET expires_at = ? WHERE id = ?").run(ago(1000), expired.cid);
    const onExpired = await B.bot.draftAction(expired.cid, "calendar.accept_invite", { booking_id: expired.booking_id });
    assert.equal(onExpired.status, "pending_approval");
    const expiredView: any = await B.bot.getConversation(expired.cid);
    assert.equal(expiredView.status, "closed");
    assert.equal(expiredView.outcome, "expired");
  });

  test("(d) the closing side's own pending cards are still cancelled and still listed", async () => {
    const { A, B } = await friends(S.base);
    const cid = (await A.bot.startConversation(B.bot.id, meeting())).conversation_id;
    const mine = await A.bot.draftMessage(cid, { text: "my own pending draft" });
    await B.bot.draftMessage(cid, { text: "peer pending draft" });
    await A.bot.close(cid, "declined", "no fit");
    const card: any = await approvalCard(A.owner, "cancelled", mine.approval_id);
    assert.ok(card, "?status=cancelled still lists it");
    assert.equal(card.decision, "conversation_closed");
    assert.equal((S.platform.db.prepare("SELECT status FROM messages WHERE id = ?").get(mine.message_id) as any).status, "cancelled");
  });

  test("(e) an expired action draft reaches ?status=expired and the Bot is told", async () => {
    const { A, B } = await friends(S.base);
    const cid = (await A.bot.startConversation(B.bot.id, meeting())).conversation_id;
    const book = await A.bot.draftAction(cid, "calendar.book", { title: "Sync", start: inDays(2, 10), end: inDays(2, 11), attendees: [B.bot.id] });
    S.platform.db.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?").run(ago(1000), book.approval_id);

    assert.ok(await approvalCard(A.owner, "expired", book.approval_id), "the sweep must reach ?status=expired");
    const evs = (await A.bot.events()).events.filter((e: any) => e.event_type === "approval.decided" && e.approval_id === book.approval_id);
    assert.equal(evs.length, 1, "the action branch is no longer the silent one");
    assert.equal(evs[0].kind, "action");
    assert.equal(evs[0].decision, "expired");
    assert.equal((S.platform.db.prepare("SELECT status FROM actions WHERE id = ?").get(book.action_id) as any).status, "expired");
  });
});

describe("the close-time exception never widens past its one action type (P13 guards)", () => {
  test("paused_loop and paused_stop still refuse the peer's accept draft", async () => {
    const { A, B } = await friends(S.base);
    const { cid, booking_id } = await bookedMeeting(A, B);
    S.platform.db.prepare("UPDATE conversations SET status = 'paused_loop' WHERE id = ?").run(cid);
    await assert.rejects(B.bot.draftAction(cid, "calendar.accept_invite", { booking_id }),
      (e: any) => e.status === 409 && e.code === "conversation_paused");
    S.platform.db.prepare("UPDATE conversations SET status = 'paused_stop' WHERE id = ?").run(cid);
    await assert.rejects(B.bot.draftAction(cid, "calendar.accept_invite", { booking_id }),
      (e: any) => e.status === 409 && e.code === "conversation_paused");
  });

  test("emergency stop still cancels a pending accept", async () => {
    const { A, B } = await friends(S.base);
    const { cid, booking_id } = await bookedMeeting(A, B);
    const acc = await B.bot.draftAction(cid, "calendar.accept_invite", { booking_id });
    await B.owner.req("POST", "/v1/emergency-stop", { bot_id: B.bot.id });
    const card: any = await approvalCard(B.owner, "cancelled", acc.approval_id);
    assert.ok(card, "the kill switch must not leave an accept behind");
    assert.equal(card.decision, "emergency_stop");
    assert.equal((S.platform.db.prepare("SELECT status FROM actions WHERE id = ?").get(acc.action_id) as any).status, "cancelled");
  });
});
