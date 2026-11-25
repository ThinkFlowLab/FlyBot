/**
 * A stored file the sweep destroys leaves one line of its own in the audit chain.
 *
 * Uploads and downloads each write their line (`attachment.uploaded`, `attachment.downloaded`), and every other
 * settled row in this family names its end too (`approval.expired`, `grant.expired`, `relationship.expired`,
 * `conversation.closed` with `outcome: "expired"`). The hourly sweep (`cleanupAttachments`) was the exception: it
 * deleted each row past `expires_at` in silence. The uploader's own chain then read uploaded, maybe downloaded, and
 * nothing -- a delivered message keeps naming the file, the recipient's link stops resolving, and neither home can
 * say from its audit log that the bytes expired rather than that the id was never real. The upload clock is the only
 * clock here, so the end is a fact the chain should carry: one line per destroyed file, actor `platform`, both homes
 * named when the peer had received the ref, the uploader alone otherwise.
 *
 * The line is the sweep's, not the clock's: a file a waiting card still holds is not destroyed (`a_pending_card_keeps_its_file`),
 * so it gets no line either, and a second sweep over the same rows writes nothing twice. The console reads the new
 * action as a sentence like every other attached-file line, not as a raw identifier.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { friends, startServer } from "./helpers.js";
import { loadConsole } from "./ui_helpers.js";

const b64 = (s: string) => Buffer.from(s).toString("base64");
const past = () => new Date(Date.now() - 3600e3).toISOString();

type S = Awaited<ReturnType<typeof startServer>>;

/** One upload for this owner's Bot, the ref a draft carries. */
async function upload(A: any, name: string, body: string) {
  const up: any = await A.owner.req("POST", "/v1/attachments", { bot_id: A.bot.id, name, content_base64: b64(body) });
  return up.attachment as { id: string; name: string; size: number; mime: string; sha256: string };
}

/** Every audit line written for one attachment, oldest first, as the owner's own view reads them. */
const linesFor = (s: S, id: string) =>
  (s.platform.audit.db.prepare("SELECT action, actor, owners, data FROM audit_events WHERE subject = ? ORDER BY seq").all(id) as any[])
    .map((r) => ({ ...r, owners: JSON.parse(r.owners), data: JSON.parse(r.data) }));

const expiredLines = (s: S) =>
  (s.platform.audit.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action = 'attachment.expired'").get() as any).n as number;

const fileRows = (s: S, id: string) =>
  (s.platform.db.prepare("SELECT COUNT(*) n FROM attachments WHERE id = ?").get(id) as any).n as number;

const ageIt = (s: S, id: string) =>
  s.platform.db.prepare("UPDATE attachments SET expires_at = ? WHERE id = ?").run(past(), id);

test("a file the sweep destroys leaves one line naming its end, and a waiting card's file leaves none", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);

  // A file the peer actually received: it is bound to a delivered message, so both homes have a stake in its end.
  const sent = await upload(A, "plan.md", "# Plan\nship it");
  const conv: any = await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "an attachment's last day" });
  const draft: any = await A.bot.signed(`/v1/conversations/${conv.conversation_id}/messages`, "message.draft",
    { text: "see attached", attachments: [sent] }, { conversation_id: conv.conversation_id });
  assert.equal(draft.status, "pending_approval", JSON.stringify(draft));
  await A.owner.req("POST", `/v1/approvals/${draft.approval_id}/decision`, { decision: "approved" });
  assert.equal((s.platform.db.prepare("SELECT status FROM messages WHERE id = ?").get(draft.message_id) as any).status, "delivered");

  // An upload nobody ever sent, and a file a card is still waiting on (its own clock runs, the card is not settled).
  const orphan = await upload(A, "orphan.txt", "never sent");
  const waiting = await upload(A, "waiting.txt", "still a card's");
  const conv2: any = await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "a card that still waits" });
  const waitingDraft: any = await A.bot.signed(`/v1/conversations/${conv2.conversation_id}/messages`, "message.draft",
    { text: "one file", attachments: [waiting] }, { conversation_id: conv2.conversation_id });
  assert.equal(waitingDraft.status, "pending_approval", JSON.stringify(waitingDraft));

  for (const f of [sent, orphan, waiting]) ageIt(s, f.id);
  assert.equal(expiredLines(s), 0, "nothing has been destroyed yet, so there is no end to record");

  // The waiting card's file is spared; the other two go, each with its own line.
  assert.equal(s.platform.cleanupAttachments(), 2);
  assert.equal(expiredLines(s), 2, "one line for each file the sweep destroyed");

  const sentLines = linesFor(s, sent.id);
  assert.deepEqual(sentLines.map((l) => l.action), ["attachment.uploaded", "attachment.expired"], "the owner's chain ends with the destruction");
  const sentEnd = sentLines.at(-1)!;
  assert.equal(sentEnd.actor, "platform", "the sweep is the platform's own act");
  assert.deepEqual(sentEnd.owners, [A.owner_id, B.owner_id].sort(), "a received file's end names both homes");
  assert.equal(sentEnd.data.message_id, draft.message_id, "the line says which message still names the file");
  assert.equal(sentEnd.data.name, "plan.md");
  assert.equal(sentEnd.data.size, sent.size);
  assert.equal(sentEnd.data.sha256, sent.sha256, "the hash the signed payload carries");

  const orphanLines = linesFor(s, orphan.id);
  assert.deepEqual(orphanLines.map((l) => l.action), ["attachment.uploaded", "attachment.expired"]);
  const orphanEnd = orphanLines.at(-1)!;
  assert.deepEqual(orphanEnd.owners, [A.owner_id], "a file no line held names only the home that uploaded it");
  assert.equal(orphanEnd.data.message_id, undefined, "no message to name");

  // The card's file is untouched, so no end was recorded for it.
  assert.equal(fileRows(s, waiting.id), 1, "the waiting card still holds its file");
  assert.deepEqual(linesFor(s, waiting.id).map((l) => l.action), ["attachment.uploaded"]);

  // And the sweep is idempotent: a second run destroys nothing and records nothing.
  assert.equal(s.platform.cleanupAttachments(), 0);
  assert.equal(expiredLines(s), 2, "a settled sweep does not write its lines again");
});

test("the audit page reads the sweep's line as a sentence", () => {
  const { AUDIT_LABEL } = loadConsole(["AUDIT_LABEL"]);
  const sentence = AUDIT_LABEL["attachment.expired"];
  assert.equal(typeof sentence, "string", "the console has a sentence for the line the sweep writes");
  assert.match(sentence, /attachment/i, "the sentence says what was removed");
  assert.notEqual(sentence, "attachment.expired", "the action name is not the sentence");
});
