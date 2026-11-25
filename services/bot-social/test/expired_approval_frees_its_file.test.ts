/**
 * A waiting card keeps its file only while the card itself is alive.
 *
 * #376's sweep exemption spares a bound file while its message is `pending_approval`, and that is right for a card the
 * owner can still decide. But a card has its own deadline: after `approvals.expires_at` passes, the owner can no longer
 * approve it. An instance whose queue is never read never runs `expireStale`, so the message stays `pending_approval`
 * and the exemption holds the bytes forever -- a zombie card paying rent on a file nobody can use.
 *
 * The sweep must read the card's deadline, not only the message's status: an expired card is not a waiting card.
 * (1) an expired card no longer holds its file; (2) control: a live card does; (3) once `expireStale` has settled the
 * card, the file is unbound and the next sweep collects it too. Delivery-door behaviour is #376's and is not touched.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { friends, startServer } from "./helpers.js";

const b64 = (s: string) => Buffer.from(s).toString("base64");
const past = () => new Date(Date.now() - 3600e3).toISOString();

type S = Awaited<ReturnType<typeof startServer>>;

async function setup(t: any) {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  return { s, A, B };
}

async function upload(A: any, name = "plan.md", body = "# Plan\nship it") {
  const up: any = await A.owner.req("POST", "/v1/attachments", { bot_id: A.bot.id, name, content_base64: b64(body) });
  return up.attachment as { id: string; name: string; size: number; mime: string; sha256: string };
}

async function draftWithFile(A: any, B: any, file: any, text = "see attached") {
  const conv: any = await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "attachment lifetime" });
  const draft: any = await A.bot.signed(`/v1/conversations/${conv.conversation_id}/messages`, "message.draft",
    { text, attachments: [file] }, { conversation_id: conv.conversation_id });
  assert.equal(draft.status, "pending_approval", JSON.stringify(draft));
  assert.equal(draft.policy.hold_reason, "attachment");
  return { cid: conv.conversation_id as string, approvalId: draft.approval_id as string, messageId: draft.message_id as string };
}

const attachmentRow = (s: S, id: string) => s.platform.db.prepare("SELECT message_id, expires_at FROM attachments WHERE id = ?").get(id) as any;
const messageRow = (s: S, id: string) => s.platform.db.prepare("SELECT status FROM messages WHERE id = ?").get(id) as any;
const approvalRow = (s: S, id: string) => s.platform.db.prepare("SELECT status, expires_at FROM approvals WHERE id = ?").get(id) as any;
const expireFile = (s: S, id: string) => s.platform.db.prepare("UPDATE attachments SET expires_at = ? WHERE id = ?").run(past(), id);
const expireCard = (s: S, id: string) => s.platform.db.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?").run(past(), id);

test("(1) an expired card does not hold its file: the sweep collects it", async (t) => {
  const { s, A, B } = await setup(t);
  const file = await upload(A);
  const held = await draftWithFile(A, B, file);
  expireFile(s, file.id);
  expireCard(s, held.approvalId);

  // No queue read and no decision: `expireStale` never runs, so the message is still `pending_approval`.
  assert.equal(messageRow(s, held.messageId).status, "pending_approval");
  assert.equal(approvalRow(s, held.approvalId).status, "pending");

  assert.equal(s.platform.cleanupAttachments(), 1, "an expired card is not a waiting card, so it does not hold the file");
  assert.equal(attachmentRow(s, file.id), undefined, "the expired file is reclaimed");
  assert.equal(messageRow(s, held.messageId).status, "pending_approval", "the sweep does not settle cards");
  assert.equal(approvalRow(s, held.approvalId).status, "pending", "the sweep does not settle cards");
});

test("(2) control: a live card still holds its file past the upload clock", async (t) => {
  const { s, A, B } = await setup(t);
  const file = await upload(A);
  const held = await draftWithFile(A, B, file);
  expireFile(s, file.id);

  assert.equal(approvalRow(s, held.approvalId).status, "pending");
  assert.ok(Date.parse(approvalRow(s, held.approvalId).expires_at) > Date.now(), "the card is still decidable");

  assert.equal(s.platform.cleanupAttachments(), 0, "the card's life, not the upload's, keeps the file");
  assert.ok(attachmentRow(s, file.id), "the row is still there for the card to deliver");
});

test("(3) once `expireStale` settles the card, the next sweep collects the file too", async (t) => {
  const { s, A, B } = await setup(t);
  const file = await upload(A);
  const held = await draftWithFile(A, B, file);
  expireFile(s, file.id);
  expireCard(s, held.approvalId);

  // Reading the queue is what runs `expireStale` on an instance that has a reader.
  const cards: any = await A.owner.req("GET", "/v1/approvals?status=pending");
  assert.ok(!cards.approvals.some((c: any) => c.approval_id === held.approvalId), "the expired card left the queue");

  assert.equal(approvalRow(s, held.approvalId).status, "expired");
  assert.equal(messageRow(s, held.messageId).status, "expired");
  assert.equal(attachmentRow(s, file.id).message_id, null, "the settled card unbinds its file");

  assert.equal(s.platform.cleanupAttachments(), 1, "an unbound expired row is the sweep's again");
  assert.equal(attachmentRow(s, file.id), undefined);
});
