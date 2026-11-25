/**
 * An expiry that cannot write its line leaves the card half-settled.
 *
 * `expireApproval` settles a card and the row it holds as two plain UPDATEs with no transaction around them
 * (`src/platform.ts`: the card first, the subject row after). When the store refuses the second write — here a
 * `BEFORE UPDATE` trigger on `messages`, the shape any failed write takes — the card is already `expired` and
 * `decided_at` is already written, while the line it was about is still `pending_approval`. The owner's queue then
 * reads a card that says `expired` next to a line that never ended, and the answer to the read is a 500 on top of it.
 * A decision is one write: a rollback must leave the card exactly as it waited (still `pending`, no `decided_at`),
 * no event, no audit line, and no push — the failure goes to the caller, it is not swallowed into a silent success.
 *
 * A second test pins the other half of the same order: with the injection on the card's own UPDATE, the line must not
 * be flipped to `expired` behind a card that stayed `pending`. That is what a settlement that writes the line first
 * and the card last would do, and it is the same defect read backwards.
 *
 * The third test is the control: without the injection the same read settles the card and its line together, so the
 * door's work is still done — the fix is a transaction, not a disabled sweep.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { friends, startServer } from "./helpers.js";

const past = () => new Date(Date.now() - 3600e3).toISOString();

const count = (s: any, sql: string, ...args: unknown[]) => (s.platform.db.prepare(sql).get(...args) as any).n as number;

function snap(s: any) {
  return {
    approvals: count(s, "SELECT COUNT(*) n FROM approvals"),
    messages: count(s, "SELECT COUNT(*) n FROM messages"),
    events: count(s, "SELECT COUNT(*) n FROM events"),
    webhook_deliveries: count(s, "SELECT COUNT(*) n FROM webhook_deliveries"),
    audit: (s.platform.audit.db.prepare("SELECT COUNT(*) n FROM audit_events").get() as any).n as number,
  };
}

const delta = (after: ReturnType<typeof snap>, before: ReturnType<typeof snap>) => ({
  approvals: after.approvals - before.approvals,
  messages: after.messages - before.messages,
  events: after.events - before.events,
  webhook_deliveries: after.webhook_deliveries - before.webhook_deliveries,
  audit: after.audit - before.audit,
});

async function heldCard(s: any) {
  const { A, B } = await friends(s.base);
  const conv: any = await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "half settlement" });
  const draft: any = await A.bot.draftMessage(conv.conversation_id, { text: "never approved" });
  assert.equal(draft.status, "pending_approval", JSON.stringify(draft));
  return { A, B, card: draft as { approval_id: string; message_id: string } };
}

test("a refused line write leaves the card pending, unannounced and unaudited", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, card } = await heldCard(s);

  // Everything before this run succeeds: the card flips first, and only the subject line is refused.
  s.platform.db.exec("CREATE TEMP TRIGGER refuse_line_expiry BEFORE UPDATE ON messages WHEN NEW.status = 'expired' BEGIN SELECT RAISE(ABORT, 'store refused the line write'); END");
  s.platform.db.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?").run(past(), card.approval_id);
  const before = snap(s);

  await assert.rejects(
    A.owner.req("GET", "/v1/approvals?status=all"),
    (e: any) => e.status === 500 && e.code === "internal_error",
    "the store refused the settlement, so the read fails rather than answering as if the card had expired",
  );

  const after = snap(s);
  const row = s.platform.db.prepare("SELECT status, decided_at FROM approvals WHERE id = ?").get(card.approval_id) as any;
  const line = s.platform.db.prepare("SELECT status FROM messages WHERE id = ?").get(card.message_id) as any;
  assert.equal(row.status, "pending", "the card is still waiting for a decision: the failed settlement left nothing behind");
  assert.equal(row.decided_at, null, "and it carries no decision time it never reached");
  assert.equal(line.status, "pending_approval", "the line is where the card left it: no half of the pair moved");
  assert.deepEqual(delta(after, before), { approvals: 0, messages: 0, events: 0, webhook_deliveries: 0, audit: 0 }, "no row, event, push or audit line outlives the rollback");
  assert.doesNotThrow(() => s.platform.audit.verify(), "the audit chain is intact");

  // Drop the refusal: the same card can still be settled, whole, by the next read.
  s.platform.db.exec("DROP TRIGGER refuse_line_expiry");
  const listed: any = await A.owner.req("GET", "/v1/approvals?status=all");
  const shown = (listed.approvals as any[]).find((a) => a.approval_id === card.approval_id);
  assert.equal(shown.status, "expired", "the card is settled on the retry");
  assert.equal(shown.message?.status ?? null, "expired", "together with the line it was about");
});

test("a refused card write leaves the line pending instead of expiring it behind the card", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, card } = await heldCard(s);

  s.platform.db.exec("CREATE TEMP TRIGGER refuse_card_expiry BEFORE UPDATE ON approvals WHEN NEW.status = 'expired' BEGIN SELECT RAISE(ABORT, 'store refused the card write'); END");
  s.platform.db.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?").run(past(), card.approval_id);
  const before = snap(s);

  await assert.rejects(
    A.owner.req("GET", "/v1/approvals?status=all"),
    (e: any) => e.status === 500 && e.code === "internal_error",
    "the refused settlement fails the read",
  );

  const after = snap(s);
  const row = s.platform.db.prepare("SELECT status, decided_at FROM approvals WHERE id = ?").get(card.approval_id) as any;
  const line = s.platform.db.prepare("SELECT status FROM messages WHERE id = ?").get(card.message_id) as any;
  assert.equal(row.status, "pending", "the card never reached its settlement");
  assert.equal(row.decided_at, null, "and carries no decision time");
  assert.equal(line.status, "pending_approval", "the line behind it is not expired on its own: the pair settles together or not at all");
  assert.deepEqual(delta(after, before), { approvals: 0, messages: 0, events: 0, webhook_deliveries: 0, audit: 0 }, "a refused card leaves no row, event, push or audit line");
  assert.doesNotThrow(() => s.platform.audit.verify(), "the audit chain is intact");
});

test("without the refusal the same read settles the card and its line together, once", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, card } = await heldCard(s);

  s.platform.db.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?").run(past(), card.approval_id);
  const before = snap(s);
  const listed: any = await A.owner.req("GET", "/v1/approvals?status=all");
  const after = snap(s);

  const shown = (listed.approvals as any[]).find((a) => a.approval_id === card.approval_id);
  assert.equal(shown.status, "expired", "the card is expired");
  assert.equal(shown.message?.status ?? null, "expired", "and the line it was about ends with it");
  const row = s.platform.db.prepare("SELECT decided_at FROM approvals WHERE id = ?").get(card.approval_id) as any;
  assert.ok(row.decided_at, "the decision moment is written");
  assert.deepEqual(delta(after, before), { approvals: 0, messages: 0, events: 1, webhook_deliveries: 0, audit: 1 }, "one settlement tells the Bot once and leaves one audit line");
  assert.doesNotThrow(() => s.platform.audit.verify(), "the audit chain is intact");
});
