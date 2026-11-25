/**
 * A pending card whose `conversations` pointer names a chat that is not there must not take its doors down.
 *
 * The read door already tolerates this row: the owner's pending list reports the card without its conversation
 * detail instead of failing the whole queue. The doors that settle the card did not. `decideApproval` reads that
 * chat before it even looks at the decision, so both answers were a bare `404 conversation_not_found` with the card
 * left pending and nothing written; `cancelPendingFor` (the kill switch) and `expireApproval` (the clock) read it
 * only to refresh the chat's status, and that throw rolled the stop transaction back — the Bot stayed `active`, its
 * token kept working and no `bot.emergency_stop` audit line was written — or, in the sweep, left the approval row
 * `expired` while the `approval.expired` audit line was never reached.
 *
 * The chat is context, not the thing being decided: the line the card holds, and the chat it was written in, are
 * both still there. So the three reads tolerate a missing row and skip only the status refresh; the card settles as
 * it always would, with its audit line, and the stop and the sweep finish.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { friends, startServer } from "./helpers.js";

const auditOf = async (o: any, subject: string, action: string) => {
  const r: any = await o.owner.req("GET", `/v1/audit-events?subject=${subject}`);
  return (r.events as any[]).filter((e) => e.action === action);
};

const cardRow = (s: any, id: string) => s.platform.db.prepare("SELECT status, decision FROM approvals WHERE id = ?").get(id) as any;
const told = async (bot: any, approvalId: string) =>
  ((await bot.events()).events as any[]).filter((e) => e.event_type === "approval.decided" && e.approval_id === approvalId);
/** The same question asked of the queue table, for the one test where the stop revoked the Bot's own token. */
const toldRaw = (s: any, botId: string, approvalId: string) =>
  (s.platform.db.prepare("SELECT type, data FROM events WHERE bot_id = ?").all(botId) as any[])
    .filter((e) => e.type === "approval.decided")
    .map((e) => JSON.parse(e.data))
    .filter((d) => d.approval_id === approvalId);
const liveBotTokens = (s: any, botId: string) =>
  (s.platform.db.prepare("SELECT COUNT(*) n FROM tokens WHERE kind = 'bot' AND subject_id = ? AND revoked_at IS NULL").get(botId) as any).n as number;

/** The shape a corrupt card row leaves behind: its chat pointer names a conversation that is not there. */
const detachFromChat = (s: any, approvalId: string) =>
  s.platform.db.prepare("UPDATE approvals SET conversation_id = ? WHERE id = ?").run("conv_not_there", approvalId);

/** A line A's Bot holds for B, with the card's chat pointer moved off the real chat. */
async function lineOnAMissingChat(s: any, A: any, B: any, text: string) {
  const c = await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "hi" });
  const d: any = await A.bot.draftMessage(c.conversation_id, { text });
  assert.equal(d.status, "pending_approval");
  detachFromChat(s, d.approval_id);
  return { cid: c.conversation_id as string, approvalId: d.approval_id as string, messageId: d.message_id as string };
}

/** A real pending line, untouched, for the controls. */
async function heldLine(A: any, B: any, text: string) {
  const c = await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "hi" });
  const d: any = await A.bot.draftMessage(c.conversation_id, { text });
  assert.equal(d.status, "pending_approval");
  return { cid: c.conversation_id as string, approvalId: d.approval_id as string, messageId: d.message_id as string };
}

test("approving a card whose chat pointer is gone still delivers the line the card holds", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const held = await lineOnAMissingChat(s, A, B, "the line whose card lost its chat");

  const r: any = await A.owner.req("POST", `/v1/approvals/${held.approvalId}/decision`, { decision: "approved" });
  assert.equal(r.status, "delivered", "the decision is a decision, not a 404 about a chat nobody asked about");
  const card = cardRow(s, held.approvalId);
  assert.equal(card.status, "approved", "the card must be settled");
  assert.equal(card.decision, "approved");
  const m = s.platform.db.prepare("SELECT status FROM messages WHERE id = ?").get(held.messageId) as any;
  assert.equal(m.status, "delivered", "the line the card held still reaches its peer");
  const audit = await auditOf(A, held.approvalId, "approval.decided");
  assert.equal(audit.length, 1, "the decision is audited once");
  assert.equal((await told(A.bot, held.approvalId)).length, 1, "and the Bot that wrote the line hears it once");
});

test("rejecting such a card settles it the same way", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const held = await lineOnAMissingChat(s, A, B, "the line whose card lost its chat (reject)");

  const r: any = await A.owner.req("POST", `/v1/approvals/${held.approvalId}/decision`, { decision: "rejected" });
  assert.equal(r.status, "rejected", "rejecting never needed the chat the card pointed at");
  assert.equal(cardRow(s, held.approvalId).status, "rejected", "the card must be settled");
  const m = s.platform.db.prepare("SELECT status FROM messages WHERE id = ?").get(held.messageId) as any;
  assert.equal(m.status, "rejected");
  assert.equal((await auditOf(A, held.approvalId, "approval.decided")).length, 1, "the decision is audited once");
  assert.equal((await told(A.bot, held.approvalId)).length, 1);
});

test("the kill switch still stops the Bot while one of its cards points at a chat that is gone", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const held = await lineOnAMissingChat(s, A, B, "the line the stop settles");

  const stopped: any = await A.owner.req("POST", "/v1/emergency-stop", { bot_id: A.bot.id });
  assert.equal(stopped.status, "frozen", "the stop must still take effect");
  const bot = s.platform.db.prepare("SELECT status FROM bots WHERE id = ?").get(A.bot.id) as any;
  assert.equal(bot.status, "frozen", "the Bot is stopped");
  assert.equal(liveBotTokens(s, A.bot.id), 0, "its live token is revoked");
  assert.equal((await auditOf(A, A.bot.id, "bot.emergency_stop")).length, 1, "the stop is audited once");

  const card = cardRow(s, held.approvalId);
  assert.equal(card.status, "cancelled", "the card the stop settles must be settled");
  const heard = toldRaw(s, A.bot.id, held.approvalId);
  assert.equal(heard.length, 1, "and the Bot hears it once");
  assert.equal(heard[0].decision, "cancelled");
});

test("the clock settles such a card and writes the expiry audit the half-commit dropped", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const held = await lineOnAMissingChat(s, A, B, "the line the clock settles");
  s.platform.db.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", held.approvalId);

  const list: any = await A.owner.req("GET", "/v1/approvals?status=pending");
  assert.equal(list.approvals.some((c: any) => c.approval_id === held.approvalId), false, "the expired card is not offered");
  const card = cardRow(s, held.approvalId);
  assert.equal(card.status, "expired", "the card must be settled");
  assert.equal((await auditOf(A, held.approvalId, "approval.expired")).length, 1, "the expiry is audited once");
  const heard = await told(A.bot, held.approvalId);
  assert.equal(heard.length, 1);
  assert.equal(heard[0].decision, "expired");
});

test("control: a card whose chat pointer is real still decides, and a settled card still refuses", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const good = await heldLine(A, B, "the line with its chat");

  const delivered: any = await A.owner.req("POST", `/v1/approvals/${good.approvalId}/decision`, { decision: "approved" });
  assert.equal(delivered.status, "delivered", "a card with its chat is untouched by the tolerance");
  assert.equal(cardRow(s, good.approvalId).status, "approved", "the card is settled the way it always was");

  await assert.rejects(
    A.owner.req("POST", `/v1/approvals/${good.approvalId}/decision`, { decision: "approved" }),
    (e: any) => {
      assert.equal(e.status, 409, `a settled card still refuses with a 409, not a ${e.status}`);
      assert.match(e.body?.error?.message, /approval is approved/, "the refusal is still the card's own state");
      return true;
    },
  );
});
