/**
 * A cancelled card left no line of its own in the audit chain.
 *
 * A card enters the chain when it is drafted (`message.drafted` and `action.drafted` carry its `approval_id`), and
 * two of its three ends name it there: a decision writes `approval.decided` and the clock writes `approval.expired`.
 * The third end — `cancelPendingFor` — settled the row (`status: cancelled`, the door's word in `decision`) and wrote
 * nothing, so the owner's own page reads "drafted a message" and then nothing at all. The same card can be cancelled
 * by the kill switch, a block, a share taken back, a closed chat, a room line's room closing, a removed home member,
 * or an invite being revoked; the Bot hears `approval.decided` on the paths that announce it and the owner's outlet
 * may hear it too, but neither is a record the owner can read back, and the deliberately silent paths have neither.
 *
 * The line is the sweep's: one row per card, actor `platform` like `approval.expired`, owners the card's owner, data
 * carrying the card's `kind`, the `subject_id` it settled and the `reason` the door wrote. It is not the
 * announcement, so a silent cancellation leaves it too. A card that already ended keeps the line its own end wrote,
 * and a settled row is not pending any more, so a later sweep writes nothing twice.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { friends, startServer } from "./helpers.js";
import { loadConsole } from "./ui_helpers.js";

const auditOf = async (o: any, subject: string, action: string) => {
  const r: any = await o.owner.req("GET", `/v1/audit-events?subject=${subject}`);
  return (r.events as any[]).filter((e) => e.action === action);
};
const past = () => new Date(Date.now() - 3600e3).toISOString();

async function chat(A: any, B: any) {
  const c: any = await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "cancelled card" });
  return c.conversation_id as string;
}

async function heldCard(bot: any, convId: string, text: string) {
  const d: any = await bot.draftMessage(convId, { text });
  assert.equal(d.status, "pending_approval", JSON.stringify(d));
  return d as { approval_id: string; message_id: string };
}

test("each card the stop settles leaves one line, and the line names that card", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const conv = await chat(A, B);
  const first = await heldCard(A.bot, conv, "the first line the stop cancels");
  const second = await heldCard(A.bot, conv, "the second line the stop cancels");

  await A.owner.req("POST", "/v1/emergency-stop", { bot_id: A.bot.id });

  for (const card of [first, second]) {
    const lines = await auditOf(A, card.approval_id, "approval.cancelled");
    assert.equal(lines.length, 1, `the card ${card.approval_id} is named once, not zero times and not twice`);
    assert.equal(lines[0].actor, `owner:${A.owner_id}`, "the stop is the owner's own door, so the line credits the owner");
    assert.deepEqual(lines[0].owners, [A.owner_id], "the card's owner is the only home the line belongs to");
    assert.equal(lines[0].data.kind, "outbound_message", "the line names what kind of card ended");
    assert.equal(lines[0].data.subject_id, card.message_id, "and the row the card was holding");
    assert.equal(lines[0].data.reason, "emergency_stop", "with the word the door wrote on the card itself");
  }
});

test("a card that already ended keeps the line its own end wrote, and the sweep adds none", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const conv = await chat(A, B);

  const decided = await heldCard(A.bot, conv, "a line the owner decides");
  await A.owner.req("POST", `/v1/approvals/${decided.approval_id}/decision`, { decision: "approved" });
  const lapsed = await heldCard(A.bot, conv, "a line the clock takes");
  s.platform.db.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?").run(past(), lapsed.approval_id);
  await A.owner.req("GET", "/v1/approvals?status=pending");
  const waiting = await heldCard(A.bot, conv, "a line still waiting for the stop");

  // A clock's cancellation credits the platform: this card's chat runs out and the chat's own expiry sweep settles it.
  const conv2 = await chat(A, B);
  const lapsedChat = await heldCard(A.bot, conv2, "a line whose chat runs out");
  s.platform.db.prepare("UPDATE conversations SET expires_at = ? WHERE id = ?").run(past(), conv2);
  await assert.rejects(B.bot.draftMessage(conv2, { text: "after the clock" }), (e: any) => e.status === 409 && e.code === "conversation_closed");
  const clockLines = await auditOf(A, lapsedChat.approval_id, "approval.cancelled");
  assert.equal(clockLines.length, 1, "the chat's expiry names the card it dropped");
  assert.equal(clockLines[0].actor, "platform", "a cancellation the clock made is the platform's, as an expiry's line is");
  assert.equal((clockLines[0].data as any).reason, "conversation_expired", "with the chat expiry's own word");

  await A.owner.req("POST", "/v1/emergency-stop", { bot_id: A.bot.id });

  assert.equal((await auditOf(A, decided.approval_id, "approval.decided")).length, 1, "the decision keeps its own line");
  assert.equal((await auditOf(A, decided.approval_id, "approval.cancelled")).length, 0, "and gains no cancellation line");
  assert.equal((await auditOf(A, lapsed.approval_id, "approval.expired")).length, 1, "the expiry keeps its own line");
  assert.equal((await auditOf(A, lapsed.approval_id, "approval.cancelled")).length, 0, "and gains no cancellation line");
  const stopped = await auditOf(A, waiting.approval_id, "approval.cancelled");
  assert.equal(stopped.length, 1, "the card the stop did settle is named once");
  assert.equal(stopped[0].actor, `owner:${A.owner_id}`, "and the stop's line credits the owner whose door it was");

  // Settled rows are not pending: the same sweep run again finds nothing and adds nothing.
  await A.owner.req("POST", "/v1/emergency-stop", { bot_id: A.bot.id }).catch(() => {});
  assert.equal((await auditOf(A, waiting.approval_id, "approval.cancelled")).length, 1, "a second sweep writes nothing again");
});

test("a silent cancellation leaves its line too: the record is not the announcement", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const p = s.platform;
  const a = p.onboardFlybot({ display_name: "Alice" });
  const b = p.onboardFlybot({ display_name: "Bob" });
  const A = { kind: "owner" as const, ownerId: a.owner_id };
  const B = { kind: "owner" as const, ownerId: b.owner_id };
  const writer = p.addHomeMember(A, a.home.bot_id, { name: "writer", display_name: "Writer" });
  const coder = p.addHomeMember(B, b.home.bot_id, { name: "coder", display_name: "Coder" });
  const rel = p.requestRelationship(A, { from_bot_id: writer.bot_id, target_bot_id: coder.bot_id, message: "hi" });
  p.consent(B, rel.relationship_id, { decision: "accept", grant_capabilities: [] });
  const sent: any = p.sendAsMember(A, { from_bot_id: writer.bot_id, to: coder.handle, text: "hello" });
  const card = sent.message.approval_id as string;

  p.removeHomeMember(A, a.home.bot_id, writer.bot_id);

  const heard = p.db.prepare("SELECT COUNT(*) n FROM events WHERE bot_id = ? AND type = 'approval.decided'").get(writer.bot_id) as any;
  assert.equal(heard.n, 0, "this path stays silent toward the Bot, as its own test pins");
  const lines = p.audit.list({ subject: card }).filter((e) => e.action === "approval.cancelled");
  assert.equal(lines.length, 1, "the card still leaves a line an owner can read back");
  const data = lines[0].data as any;
  assert.equal(data.reason, "member_revoked", "with the door's word, so the silence is explainable later");
  assert.equal(lines[0].actor, `owner:${a.owner_id}`, "and the owner whose door removed the member");
  assert.equal(data.subject_id, sent.message.message_id, "and the message whose line died with the card");
});

test("the console reads the cancellation as a sentence, not a raw identifier", () => {
  const { auditLine } = loadConsole(["auditLine"]);
  assert.equal(auditLine({ actor: "platform", action: "approval.cancelled" }), "Bot Social cancelled a waiting approval");
});
