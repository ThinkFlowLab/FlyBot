/**
 * A conversation whose own clock ran out must settle the cards it leaves behind.
 *
 * `materializeExpiry` closes the row (`status = 'closed'`, `outcome = 'expired'`) and nothing else: no pending
 * card is cancelled, no `conversation.closed` audit entry is written and neither side is told. A manual close
 * (`closeConversation`) does all three, so the two ways into `closed` leave different side effects.
 *
 * The gap is reachable: an approval card lives 24h (`LIMITS.approvalTtlMs`) while a conversation's default
 * life is 72h, so a draft written just before the clock runs out is still pending when the chat is gone, and
 * `deliverMessage` never looks at the conversation's status — approving it delivers a line into a dead chat.
 *
 * Red first on 0d379b3:
 *   (a) the card is still `pending`, no `conversation_expired` notification and no `conversation.closed` audit;
 *   (b) neither Bot hears that the chat expired;
 *   (c) the stale card is approved and the peer receives `message.received`.
 * Green on 0d379b3 and kept green: (d) the invitee's accept draft still decides on an expired chat (#105).
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { friends, inDays, startServer } from "./helpers.js";

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(); });
after(async () => { await S.stop(); });

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const meeting = (extra: Record<string, unknown> = {}) => ({
  type: "schedule_meeting", summary: "sync",
  params: { duration_minutes: 30, window: { start: inDays(1, 0), end: inDays(8, 23) } },
  ...extra,
});
const row = (sql: string, ...args: unknown[]) => S.platform.db.prepare(sql).get(...args) as any;

/** A pair, one conversation and one pending draft from A; then the conversation's clock runs out. */
async function expiredWithDraft() {
  const { A, B } = await friends(S.base);
  const cid = (await A.bot.startConversation(B.bot.id, meeting())).conversation_id as string;
  const draft = await A.bot.draftMessage(cid, { text: "a draft that outlives the chat" });
  assert.equal(draft.status, "pending_approval");
  S.platform.db.prepare("UPDATE conversations SET expires_at = ? WHERE id = ?").run(ago(1000), cid);
  return { A, B, cid, draft };
}

/** The only way the product materialises the expiry: the next trip through a conversation door. */
async function materialise(bot: any, cid: string) {
  await assert.rejects(bot.draftMessage(cid, { text: "after the clock" }), (e: any) => e.status === 409 && e.code === "conversation_closed");
}

describe("an expired conversation settles its pending cards", () => {
  test("(a) the card is cancelled as conversation_expired, audited, and the Bot is told once", async () => {
    const { A, B, cid, draft } = await expiredWithDraft();
    await materialise(B.bot, cid);

    const card = row("SELECT status, decision FROM approvals WHERE id = ?", draft.approval_id);
    assert.equal(card.status, "cancelled", "the card does not stay decidable on a chat that no longer exists");
    assert.equal(card.decision, "conversation_expired");
    assert.equal(row("SELECT status FROM messages WHERE id = ?", draft.message_id).status, "cancelled", "the draft itself is settled too");

    const evs = (await A.bot.events()).events.filter((e: any) => e.event_type === "approval.decided" && e.approval_id === draft.approval_id);
    assert.equal(evs.length, 1, "the Bot whose card died hears it exactly once");
    assert.equal(evs[0].decision, "cancelled");
    assert.equal(evs[0].reason, "conversation_expired", "the reason is its own, not the approval's own 24h expiry");

    const audits = (await A.owner.req("GET", `/v1/audit-events?subject=${cid}`)).events.filter((e: any) => e.action === "conversation.closed");
    assert.equal(audits.length, 1, "the expiry is recorded like a close");
    assert.equal(audits[0].data.outcome, "expired");
  });

  test("(b) both sides hear the chat expired, once, as a platform event without peer text", async () => {
    const { A, B, cid } = await expiredWithDraft();
    await materialise(B.bot, cid);

    for (const bot of [A.bot, B.bot]) {
      const evs = (await bot.events()).events.filter((e: any) => e.event_type === "conversation.closed" && e.conversation_id === cid);
      assert.equal(evs.length, 1, "one event per side");
      assert.equal(evs[0].outcome, "expired");
      assert.equal(evs[0].trust, "platform", "the platform closed it; no peer wrote anything");
      assert.equal(evs[0].summary ?? null, null);
    }

    // A second trip through the door must not replay the transition.
    await materialise(A.bot, cid);
    const again = (await B.bot.events()).events.filter((e: any) => e.event_type === "conversation.closed" && e.conversation_id === cid);
    assert.equal(again.length, 1, "the open -> closed transition is announced exactly once");
  });

  test("(c) a card nothing settled yet is refused, never delivered into the dead chat", async () => {
    const { A, B, cid, draft } = await expiredWithDraft();
    const received = async () => (await B.bot.events()).events.filter((e: any) => e.event_type === "message.received").length;
    const before = await received();

    await assert.rejects(A.owner.req("POST", `/v1/approvals/${draft.approval_id}/decision`, { decision: "approved" }),
      (e: any) => e.status === 409 && e.code === "invalid_state");

    assert.equal(await received(), before, "the peer receives nothing from a conversation that is gone");
    assert.equal(row("SELECT status FROM conversations WHERE id = ?", cid).status, "closed", "deciding is enough to materialise the expiry");
    assert.equal(row("SELECT status FROM messages WHERE id = ?", draft.message_id).status, "cancelled");
    assert.equal(row("SELECT status FROM approvals WHERE id = ?", draft.approval_id).status, "cancelled");
  });

  test("(d) guard: the invitee's accept still decides on an expired chat", async () => {
    const { A, B } = await friends(S.base);
    const cid = (await A.bot.startConversation(B.bot.id, meeting())).conversation_id as string;
    const book = await A.bot.draftAction(cid, "calendar.book", { title: "Sync", start: inDays(1, 10), end: inDays(1, 11), attendees: [B.bot.id] });
    const ex: any = await A.owner.req("POST", `/v1/approvals/${book.approval_id}/decision`, { decision: "approved" });
    assert.equal(ex.status, "executed");
    const acc = await B.bot.draftAction(cid, "calendar.accept_invite", { booking_id: ex.result.booking_id });
    assert.equal(acc.status, "pending_approval");

    S.platform.db.prepare("UPDATE conversations SET expires_at = ? WHERE id = ?").run(ago(1000), cid);
    const done: any = await B.owner.req("POST", `/v1/approvals/${acc.approval_id}/decision`, { decision: "approved" });
    assert.equal(done.status, "executed", "the booking decision outlives the chat it was made in");
    assert.equal(done.result.invitee_status, "accepted");
    assert.equal(row("SELECT status FROM calendar_entries WHERE booking_id = ? AND owner_id = ?", ex.result.booking_id, B.owner_id).status, "confirmed");
  });
});
