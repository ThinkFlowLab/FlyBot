/**
 * A file a card is still waiting on is not the sweep's to delete, and a line whose file is already gone must not be
 * delivered.
 *
 * `checkRefs` binds an upload to the message at draft time, so the card and the file are one thing until the owner
 * decides. The hourly sweep (`cleanupAttachments`) deleted every row past `expires_at`, whatever it was bound to:
 * a file drafted onto a card that still waited disappeared under it, and approving that card delivered a ref the
 * peer could never download (`404 attachment_not_found`). The upload clock is the wrong clock for a bound file --
 * while the card waits, the card decides how long the bytes stay.
 *
 * The sweep is only half of it. `BOTSOCIAL_ATTACHMENT_TTL_DAYS` can make a file shorter-lived than the card, so a
 * card can be decided after its file's own deadline has passed even though nothing was swept. That decision is
 * refused before any write (`410 attachment_expired`), and the card stays pending so the owner can reject it and
 * upload the file again: a delivered message must never name bytes nobody can read.
 *
 * (1) the sweep spares a bound file while its card waits, and still deletes an unbound one; (2) the end-to-end
 * shape: a file that dies under a waiting card, whose approval is refused with zero writes; (3) the control: a live
 * file delivers and the peer reads it back; (4) a rejection still unbinds, so the next sweep collects the row;
 * (5) that stay lasts exactly as long as the card does.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { expectApiError, friends, startServer } from "./helpers.js";

const b64 = (s: string) => Buffer.from(s).toString("base64");
const past = () => new Date(Date.now() - 3600e3).toISOString();

type S = Awaited<ReturnType<typeof startServer>>;

async function setup(t: any) {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  return { s, A, B };
}

/** One upload for this bot, exactly the ref a draft carries. */
async function upload(A: any, name = "plan.md", body = "# Plan\nship it") {
  const up: any = await A.owner.req("POST", "/v1/attachments", { bot_id: A.bot.id, name, content_base64: b64(body) });
  return up.attachment as { id: string; name: string; size: number; mime: string; sha256: string };
}

/** A line that carries `file` and waits for its owner. */
async function draftWithFile(A: any, B: any, file: any, text = "see attached") {
  const conv: any = await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "attachment lifetime" });
  const draft: any = await A.bot.signed(`/v1/conversations/${conv.conversation_id}/messages`, "message.draft",
    { text, attachments: [file] }, { conversation_id: conv.conversation_id });
  assert.equal(draft.status, "pending_approval", JSON.stringify(draft));
  assert.equal(draft.policy.hold_reason, "attachment", "the card is the file's, not the blanket hold's");
  return { cid: conv.conversation_id as string, approvalId: draft.approval_id as string, messageId: draft.message_id as string };
}

const attachmentRow = (s: S, id: string) => s.platform.db.prepare("SELECT message_id, expires_at FROM attachments WHERE id = ?").get(id) as any;
const messageRow = (s: S, id: string) => s.platform.db.prepare("SELECT status, delivered_payload FROM messages WHERE id = ?").get(id) as any;
const approvalRow = (s: S, id: string) => s.platform.db.prepare("SELECT status, decision FROM approvals WHERE id = ?").get(id) as any;
const eventCount = (s: S, botId: string, type: string) =>
  (s.platform.db.prepare("SELECT COUNT(*) n FROM events WHERE bot_id = ? AND type = ?").get(botId, type) as any).n as number;
const auditCount = (s: S, action: string, subject: string) =>
  (s.platform.audit.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action = ? AND subject = ?").get(action, subject) as any).n as number;
const expire = (s: S, id: string) => s.platform.db.prepare("UPDATE attachments SET expires_at = ? WHERE id = ?").run(past(), id);

test("(1) the sweep spares a bound file while its card waits, and still collects an unbound one", async (t) => {
  const { s, A, B } = await setup(t);
  const file = await upload(A);
  const held = await draftWithFile(A, B, file);
  assert.equal(attachmentRow(s, file.id).message_id, held.messageId, "the waiting card holds the file");
  expire(s, file.id);

  assert.equal(s.platform.cleanupAttachments(), 0, "a file a waiting card holds is not the upload clock's to delete");
  assert.ok(attachmentRow(s, file.id), "the row is still there for the card to deliver");

  // Control: an upload nobody is waiting on still goes on its own deadline.
  const stray = await upload(A, "stray.md");
  expire(s, stray.id);
  assert.equal(s.platform.cleanupAttachments(), 1);
  assert.equal(attachmentRow(s, stray.id), undefined, "nothing holds it, so nothing keeps it");
});

test("(2) a card whose file died is refused, with zero writes", async (t) => {
  const { s, A, B } = await setup(t);
  const file = await upload(A);
  const held = await draftWithFile(A, B, file);
  expire(s, file.id);
  assert.equal(s.platform.cleanupAttachments(), 0, "the sweep is not what empties this card");

  // The bytes are gone by their own deadline, which `BOTSOCIAL_ATTACHMENT_TTL_DAYS` can put before the card's.
  await expectApiError(
    A.owner.req("POST", `/v1/approvals/${held.approvalId}/decision`, { decision: "approved" }),
    410, "attachment_expired");

  assert.equal(approvalRow(s, held.approvalId).status, "pending", "the card is still the owner's to decide");
  const m = messageRow(s, held.messageId);
  assert.equal(m.status, "pending_approval");
  assert.equal(m.delivered_payload, null, "nothing was delivered, so nothing was recorded as delivered");
  assert.equal(eventCount(s, B.bot.id, "message.received"), 0, "the peer is not told about a line that never went out");
  assert.equal(eventCount(s, A.bot.id, "approval.decided"), 0, "a refused approval decides nothing");
  assert.equal(auditCount(s, "message.delivered", held.messageId), 0);

  // Rejecting settles it as a card that never went out, and the file is free to be uploaded again.
  const rejected: any = await A.owner.req("POST", `/v1/approvals/${held.approvalId}/decision`, { decision: "rejected" });
  assert.equal(rejected.status, "rejected");
  assert.equal(attachmentRow(s, file.id).message_id, null);
});

test("(3) control: a live file delivers, and the peer reads the same bytes", async (t) => {
  const { s, A, B } = await setup(t);
  const body = "# Plan\nship it";
  const file = await upload(A, "plan.md", body);
  const held = await draftWithFile(A, B, file);

  const decided: any = await A.owner.req("POST", `/v1/approvals/${held.approvalId}/decision`, { decision: "approved" });
  assert.equal(decided.status, "delivered");
  assert.equal(eventCount(s, B.bot.id, "message.received"), 1);

  const delivered = JSON.parse(messageRow(s, held.messageId).delivered_payload);
  assert.deepEqual(delivered.attachments, [file], "the delivered payload carries the signed ref");

  const got: any = await B.bot.req("GET", `/v1/attachments/${file.id}?bot_id=${B.bot.id}`);
  assert.equal(got.attachment.sha256, file.sha256, "the hash the ref promised");
  assert.equal(Buffer.from(got.content_base64, "base64").toString(), body);
});

test("(4) a rejection still unbinds, and the next sweep collects the row", async (t) => {
  const { s, A, B } = await setup(t);
  const file = await upload(A);
  const held = await draftWithFile(A, B, file);

  await A.owner.req("POST", `/v1/approvals/${held.approvalId}/decision`, { decision: "rejected" });
  assert.equal(attachmentRow(s, file.id).message_id, null, "the file never went out, so it belongs to no message again");
  expire(s, file.id);
  assert.equal(s.platform.cleanupAttachments(), 1, "an unbound row is the sweep's again");
  assert.equal(attachmentRow(s, file.id), undefined);
});

test("(5) the stay lasts exactly as long as the card does", async (t) => {
  const { s, A, B } = await setup(t);
  const file = await upload(A);
  const held = await draftWithFile(A, B, file);
  expire(s, file.id);

  assert.equal(s.platform.cleanupAttachments(), 0);
  assert.equal(s.platform.cleanupAttachments(), 0, "a second sweep finds the same card waiting");
  assert.ok(attachmentRow(s, file.id), "the file stays while the card does");

  await A.owner.req("POST", `/v1/approvals/${held.approvalId}/decision`, { decision: "rejected" });
  assert.equal(attachmentRow(s, file.id).message_id, null);
  assert.equal(s.platform.cleanupAttachments(), 1, "once the card settles, the upload clock runs again");
  assert.equal(attachmentRow(s, file.id), undefined);
});
