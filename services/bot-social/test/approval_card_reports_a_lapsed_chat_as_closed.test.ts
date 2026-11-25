/**
 * A pending card must not call a lapsed chat open.
 *
 * An approval card lives 24h (`LIMITS.approvalTtlMs`) while a chat's own clock is the shorter of its intent and the
 * console's ceiling, so a draft written just before that clock runs out is still pending when the chat is gone. The
 * conversation read surface settles that on read (`reportedConvState`: a row past `expires_at` reads `closed` /
 * `expired` and the row itself is never touched), but the approval read does not: `approvalCard` copies the raw
 * `conversations.status`, so the owner's pending list and the Bot's `list_approvals` report the dead chat as
 * `open` / `awaiting_approval` while the chat page already says it expired.
 *
 * The read now reports the chat the same way the conversation read does, and settles nothing: the card stays pending
 * and no row is written, because a read is not the place to cancel an approval.
 *
 * Red first on 14462470: the card on a lapsed chat reports the raw `awaiting_approval` (its `outcome` is absent)
 * while the conversation read already reports `closed` / `expired`. Green on base and kept green: the live chat's
 * card, the pending list still holding the card, and the rows the read leaves untouched.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { friends, inDays, startServer } from "./helpers.js";

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const meeting = () => ({
  type: "schedule_meeting", summary: "sync",
  params: { duration_minutes: 30, window: { start: inDays(1, 0), end: inDays(8, 23) } },
});
const ownerOf = (A: any) => ({ kind: "owner" as const, ownerId: A.owner_id });

/** A pair, one chat and one pending draft from A; then the chat's clock runs out under the card. */
async function lapsedWithDraft(s: any) {
  const { A, B } = await friends(s.base);
  const cid = (await A.bot.startConversation(B.bot.id, meeting())).conversation_id as string;
  const draft = await A.bot.draftMessage(cid, { text: "a line written before the clock ran out" });
  assert.equal(draft.status, "pending_approval");
  s.platform.db.prepare("UPDATE conversations SET expires_at = ? WHERE id = ?").run(ago(1000), cid);
  return { A, B, cid, draft };
}

const cardOf = (s: any, A: any, approvalId: string) =>
  s.platform.listApprovals(ownerOf(A), "pending").find((a: any) => a.approval_id === approvalId);

test("a pending card on a chat whose clock ran out reports it closed and expired", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, cid, draft } = await lapsedWithDraft(s);

  const card = cardOf(s, A, draft.approval_id);
  assert.ok(card, "the card is still in the pending list: the read settles nothing");
  assert.equal(card.conversation.conversation_id, cid);
  assert.equal(card.conversation.status, "closed", "a lapsed chat is not reported open by its pending card");
  assert.equal(card.conversation.outcome, "expired", "and it says why it ended");
});

test("the read leaves the card and the chat exactly as it found them", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, cid, draft } = await lapsedWithDraft(s);
  const row = (sql: string, ...args: unknown[]) => s.platform.db.prepare(sql).get(...args) as any;
  const before = {
    conversation: row("SELECT status, outcome FROM conversations WHERE id = ?", cid),
    approval: row("SELECT status, decision FROM approvals WHERE id = ?", draft.approval_id),
    message: row("SELECT status FROM messages WHERE id = ?", draft.message_id),
  };
  assert.equal(before.conversation.status, "awaiting_approval", "the row is lapsed but not closed: only a write path closes it");

  const card = cardOf(s, A, draft.approval_id);
  assert.equal(card?.status, "pending", "reading a card does not decide it");

  assert.deepEqual({
    conversation: row("SELECT status, outcome FROM conversations WHERE id = ?", cid),
    approval: row("SELECT status, decision FROM approvals WHERE id = ?", draft.approval_id),
    message: row("SELECT status FROM messages WHERE id = ?", draft.message_id),
  }, before, "the approval read writes nothing: no expiry is materialised here");
});

test("a card on a chat that is still running reports it as it is", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const cid = (await A.bot.startConversation(B.bot.id, meeting())).conversation_id as string;
  const draft = await A.bot.draftMessage(cid, { text: "a line with time on the clock" });
  assert.equal(draft.status, "pending_approval");

  const card = cardOf(s, A, draft.approval_id);
  assert.ok(card, "the card is pending");
  assert.equal(card.status, "pending");
  assert.equal(card.conversation.status, "awaiting_approval", "a live chat keeps the state the row holds");
  assert.equal(card.conversation.outcome ?? null, null, "and it has no ending to report");
});

test("the conversation read already agrees about the same chat", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, cid } = await lapsedWithDraft(s);

  const r = await fetch(s.base + `/v1/conversations/${cid}`, { headers: { authorization: `Bearer ${A.owner.token}` } });
  const body = await r.json() as any;
  assert.equal(r.status, 200, JSON.stringify(body));
  const conv = body.conversation ?? body;
  assert.equal(conv.status, "closed", "the chat page reports the clock");
  assert.equal(conv.outcome, "expired");
});
