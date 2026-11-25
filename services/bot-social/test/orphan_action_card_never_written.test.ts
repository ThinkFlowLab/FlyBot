/**
 * An action card whose subject row was never written must not answer 500.
 *
 * `draftAction` writes the `actions` row and the approval card; a torn write an older build allowed can leave the
 * card without its subject — the row the owner's list already tolerates (see `action_draft_card_integrity.test.ts`).
 * Approving that card sends the decision door into `executeAction`, which reads the `actions` row unconditionally: a
 * 500 that names nothing, with the card still pending, so the owner's queue keeps offering a decision that cannot
 * succeed and the Bot is told nothing at all.
 *
 * The shape #525 gave the outbound and relationship kinds is the fix, and it guards only the approve side: rejecting
 * such a card writes no action row, so it never needed the subject and must stay decidable. The approved side settles
 * the card once — `cancelled` / `action_unavailable` — and the Bot hears the decision, with the id of the row that is
 * not there, instead of a 500.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { friends, inDays, startServer } from "./helpers.js";

const meetingIntent = () => ({ type: "schedule_meeting", summary: "sync", params: { duration_minutes: 30, window: { start: inDays(1, 0), end: inDays(5, 23) } } });

/** A card an older build can leave behind: its subject action was never written. */
async function orphanCard(S: any, A: any, B: any, id: string) {
  const cid = (await A.bot.startConversation(B.bot.id, meetingIntent())).conversation_id as string;
  S.platform.db.prepare("INSERT INTO approvals (id, owner_id, kind, subject_id, bot_id, conversation_id, summary, reasons, risk_flags, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, A.owner_id, "action", "act_never_written", A.bot.id, cid, "Book a meeting", "[]", "[]", new Date().toISOString(), new Date(Date.now() + 3600e3).toISOString());
  return { cid, approvalId: id };
}

const cardRow = (S: any, id: string) => S.platform.db.prepare("SELECT status, decision FROM approvals WHERE id = ?").get(id) as any;
const actionRows = (S: any, cid: string) => (S.platform.db.prepare("SELECT COUNT(*) n FROM actions WHERE conversation_id = ?").get(cid) as any).n as number;
const decidedEvents = async (bot: any, approvalId: string) =>
  ((await bot.events()).events as any[]).filter((e) => e.event_type === "approval.decided" && e.approval_id === approvalId);

const ACTION_GONE = "the action this card was for was never written; this card can no longer be approved";

test("approving a card whose action was never written is a 409 that names the missing action, not a 500", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const { cid, approvalId } = await orphanCard(s, A, B, "apr_orphan_approved");
  const rowsBefore = actionRows(s, cid);

  await assert.rejects(
    A.owner.req("POST", `/v1/approvals/${approvalId}/decision`, { decision: "approved" }),
    (e: any) => {
      assert.equal(e.status, 409, `a card without its action must be a 409, not a ${e.status} (${e.message})`);
      assert.equal(e.code, "invalid_state");
      assert.equal(e.body?.error?.message, ACTION_GONE, "the refusal names what the card was waiting on");
      return true;
    },
  );

  // Settled once, by id, with a reason a client can show — not left pending for the next read of the queue.
  const card = cardRow(s, approvalId);
  assert.equal(card.status, "cancelled", "the card is settled by the refusal");
  assert.equal(card.decision, "action_unavailable", "and records why");
  assert.equal(actionRows(s, cid), rowsBefore, "the refusal writes no action row");

  const told = await decidedEvents(A.bot, approvalId);
  assert.equal(told.length, 1, "the Bot hears about the settled card once");
  assert.equal(told[0].decision, "cancelled");
  assert.equal(told[0].reason, "action_unavailable");
  assert.equal(told[0].action_id, "act_never_written", "the event names the action row that is not there");

  // The queue no longer offers it, and asking again names the settled card instead of failing the same way twice.
  const queue: any = await A.owner.req("GET", "/v1/approvals?status=pending");
  assert.equal(queue.approvals.some((x: any) => x.approval_id === approvalId), false, "a settled card is not offered again");
  await assert.rejects(
    A.owner.req("POST", `/v1/approvals/${approvalId}/decision`, { decision: "approved" }),
    (e: any) => {
      assert.equal(e.status, 409);
      assert.equal(e.code, "invalid_state");
      assert.equal(e.body?.error?.message, "approval is cancelled", "the second answer is about the card's state");
      return true;
    },
  );
});

test("an owner edit on such a card is refused the same way, and settles it only once", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const { cid, approvalId } = await orphanCard(s, A, B, "apr_orphan_edited");
  const rowsBefore = actionRows(s, cid);

  await assert.rejects(
    A.owner.req("POST", `/v1/approvals/${approvalId}/decision`, { decision: "approved_with_edits", edited_params: { title: "Sync" } }),
    (e: any) => {
      assert.equal(e.status, 409, `an edited approval of a card without its action must be a 409, not a ${e.status} (${e.message})`);
      assert.equal(e.code, "invalid_state");
      assert.equal(e.body?.error?.message, ACTION_GONE);
      return true;
    },
  );

  const card = cardRow(s, approvalId);
  assert.equal(card.status, "cancelled");
  assert.equal(card.decision, "action_unavailable");
  assert.equal(actionRows(s, cid), rowsBefore, "the refusal writes no action row, edited params or not");
  assert.equal((await decidedEvents(A.bot, approvalId)).length, 1, "the card is announced once, not once per attempt");
});

test("control: the same card can still be rejected, which never needed the action row", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const { approvalId } = await orphanCard(s, A, B, "apr_orphan_rejected");

  const r: any = await A.owner.req("POST", `/v1/approvals/${approvalId}/decision`, { decision: "rejected" });
  assert.equal(r.status, "rejected", "rejecting a card never read its subject");
  const card = cardRow(s, approvalId);
  assert.equal(card.status, "rejected");
});

test("control: a card with its action row is still approved and executed", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const cid = (await A.bot.startConversation(B.bot.id, meetingIntent())).conversation_id as string;
  const d: any = await A.bot.draftAction(cid, "calendar.book", { title: "Sync", start: inDays(1, 10), end: inDays(1, 11), attendees: [B.bot.id] }, "plan the week");
  assert.equal(d.status, "pending_approval");

  const r: any = await A.owner.req("POST", `/v1/approvals/${d.approval_id}/decision`, { decision: "approved" });
  assert.equal(r.status, "executed", "the guard leaves a real action card alone");
  const x = s.platform.db.prepare("SELECT status FROM actions WHERE id = ?").get(d.action_id) as any;
  assert.equal(x.status, "executed");
});
