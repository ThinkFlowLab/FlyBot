/**
 * A draft that never goes out must not keep its file.
 *
 * `checkRefs` binds each attachment ref to the message at draft time
 * (`UPDATE attachments SET message_id = ? WHERE id = ? AND message_id IS NULL`) so the same upload cannot be
 * attached to two lines. The row is only ever unbound by `cleanupAttachments`, which deletes expired rows; none
 * of the three refusal paths — a rejected card, an expired card, a cancelled card — put it back to `NULL`.
 *
 * The result is a file that was never delivered and can never be sent again: attaching the very same ref to the
 * next draft answers `409 attachment_in_use: attachment already sent; upload it again`, and the owner has to
 * upload up to the limit again. The recipient never saw the line, so nothing about the refusal is a reason to
 * keep the bytes busy.
 *
 * (1)–(3) pin the three settling paths. (4) is the control: a delivered message keeps its file bound, because
 * that file is the peer's to download by `message_id`. (5) is the end-to-end shape the defect was reported in.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { friends, startServer } from "./helpers.js";

const b64 = (s: string) => Buffer.from(s).toString("base64");
const past = () => new Date(Date.now() - 3600e3).toISOString();

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(); });
after(async () => { await S.stop(); });

const attachmentRow = (id: string) => S.platform.db.prepare("SELECT message_id FROM attachments WHERE id = ?").get(id) as any;
const messageRow = (id: string) => S.platform.db.prepare("SELECT status FROM messages WHERE id = ?").get(id) as any;
const approvalRow = (id: string) => S.platform.db.prepare("SELECT status, decision FROM approvals WHERE id = ?").get(id) as any;

/** One upload for this bot, exactly the ref a draft carries. */
async function upload(A: any) {
  const up: any = await A.owner.req("POST", "/v1/attachments", { bot_id: A.bot.id, name: "plan.md", content_base64: b64("# Plan\nship it") });
  return up.attachment as { id: string; name: string; size: number; mime: string; sha256: string };
}

/** A line that carries `file` and waits for its owner. */
async function draftWithFile(A: any, B: any, file: any, text = "see attached") {
  const conv: any = await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "attachment reuse" });
  const draft: any = await A.bot.signed(`/v1/conversations/${conv.conversation_id}/messages`, "message.draft",
    { text, attachments: [file] }, { conversation_id: conv.conversation_id });
  assert.equal(draft.status, "pending_approval", JSON.stringify(draft));
  return { cid: conv.conversation_id as string, approvalId: draft.approval_id as string, messageId: draft.message_id as string };
}

describe("a refused draft does not keep its file", () => {
  test("(1) a rejected draft frees its attachment", async () => {
    const { A, B } = await friends(S.base);
    const file = await upload(A);
    const held = await draftWithFile(A, B, file);
    assert.equal(attachmentRow(file.id).message_id, held.messageId, "the waiting card holds the file while its owner has not decided");

    const decided: any = await A.owner.req("POST", `/v1/approvals/${held.approvalId}/decision`, { decision: "rejected" });
    assert.equal(decided.status, "rejected");
    assert.equal(messageRow(held.messageId).status, "rejected");
    assert.equal(attachmentRow(file.id).message_id, null, "the file never went out, so it belongs to no message again");
  });

  test("(2) an expired draft frees its attachment", async () => {
    const { A, B } = await friends(S.base);
    const file = await upload(A);
    const held = await draftWithFile(A, B, file);

    // Let the lazy sweep run the way every read triggers it.
    S.platform.db.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?").run(past(), held.approvalId);
    await A.owner.req("GET", "/v1/approvals?status=pending");

    assert.equal(approvalRow(held.approvalId).status, "expired", "the card still settles");
    assert.equal(messageRow(held.messageId).status, "expired");
    assert.equal(attachmentRow(file.id).message_id, null, "an expired card never carried the file anywhere either");
  });

  test("(3) a cancelled draft frees its attachment", async () => {
    const { A, B } = await friends(S.base);
    const file = await upload(A);
    const held = await draftWithFile(A, B, file);

    const closed: any = await A.owner.req("POST", `/v1/conversations/${held.cid}/close`, { outcome: "abandoned" });
    assert.equal(closed.status, "closed");

    assert.equal(approvalRow(held.approvalId).status, "cancelled");
    assert.equal(messageRow(held.messageId).status, "cancelled");
    assert.equal(attachmentRow(file.id).message_id, null, "a line cancelled with its chat is not a line that was sent");
  });

  test("(4) a delivered message keeps its attachment bound", async () => {
    const { A, B } = await friends(S.base);
    const file = await upload(A);
    const held = await draftWithFile(A, B, file);

    const decided: any = await A.owner.req("POST", `/v1/approvals/${held.approvalId}/decision`, { decision: "approved" });
    assert.equal(decided.status, "delivered");

    assert.equal(attachmentRow(file.id).message_id, held.messageId, "a delivered line is exactly the message its file belongs to");
    const got: any = await B.bot.req("GET", `/v1/attachments/${file.id}?bot_id=${B.bot.id}`);
    assert.equal(Buffer.from(got.content_base64, "base64").toString(), "# Plan\nship it", "and the peer can still read the bytes");
  });

  test("(5) the same ref can be drafted again once the card is rejected", async () => {
    const { A, B } = await friends(S.base);
    const file = await upload(A);
    const first = await draftWithFile(A, B, file, "first attempt");
    await A.owner.req("POST", `/v1/approvals/${first.approvalId}/decision`, { decision: "rejected" });

    // Same upload, same ref: no re-upload, no 409.
    const second = await draftWithFile(A, B, file, "second attempt");
    assert.notEqual(second.messageId, first.messageId, "the retry is a new line");
    assert.equal(attachmentRow(file.id).message_id, second.messageId, "the file is now held by the draft that may still go out");
  });
});
