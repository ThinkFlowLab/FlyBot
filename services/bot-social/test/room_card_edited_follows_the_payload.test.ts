import assert from "node:assert/strict";
import { test } from "node:test";
import { friends, ownerWithBot, startServer } from "./helpers.js";

// "Did the owner edit this line" is answered by what the request carries, not by the word alone: the chat door reads
// `body.decision === "approved_with_edits" && body.edited_payload`, and both the recipient event and the audit row
// say `edited` from that. The face-room door computed the same answer for its mention list and then asked only the
// decision word when it marked the room event, and its audit row carried no `edited` at all -- so one body said
// "edited" in a room and "not edited" in a chat, and the room's chain could not be corrected by a reader. The room
// door answers with the payload's `edited` and records it, the way `message.delivered` does.

const CODE = "737373";

async function room(t: any) {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "rea");
  const B = await ownerWithBot(s.base, "reb");
  const a = (await A.owner.req("POST", "/v1/face-rooms/join", { code: CODE, bots: [A.bot.id] })) as any;
  await B.owner.req("POST", "/v1/face-rooms/join", { code: CODE, bots: [B.bot.id] });
  const roomId = a.room_id as string;
  const draft = (text: string, mentions?: string[]) =>
    A.owner.req("POST", `/v1/face-rooms/${roomId}/messages`, { text, bot_id: A.bot.id, ...(mentions ? { mentions } : {}) }) as Promise<any>;
  const decide = (approvalId: string, body: any) => A.owner.req("POST", `/v1/approvals/${approvalId}/decision`, body) as Promise<any>;
  const roomEvents = async () =>
    ((await B.owner.req("GET", `/v1/face-rooms/${roomId}`)) as any).events.filter((e: any) => e.type === "room.message");
  const delivered = (id: string) =>
    JSON.parse((s.platform.audit.db.prepare("SELECT data FROM audit_events WHERE action = 'face_room.message_delivered' AND subject = ?").get(id) as any).data);
  const stored = (sql: string, ...args: unknown[]) => s.platform.db.prepare(sql).get(...args) as any;
  return { s, A, B, roomId, draft, decide, roomEvents, delivered, stored };
}

test("a room card decided approved_with_edits with no edited payload is not an edit, and the room is told so", async (t) => {
  const h = await room(t);
  const d = await h.draft("the held line", [h.B.handle]);
  const r = await h.decide(d.approval_id, { decision: "approved_with_edits" });
  assert.equal(r.status, "delivered", JSON.stringify(r));
  const [ev] = await h.roomEvents();
  assert.equal(ev.untrusted_content.text, "the held line", "the draft's own text went out");
  assert.equal(ev.edited_by_owner, false, "nothing was rewritten, so no member is told the owner edited the line");
  assert.deepEqual(ev.mentions, [h.B.handle.toLowerCase()], "the list describes the text that went out, so it stands");
  assert.deepEqual(JSON.parse(h.stored("SELECT mentions FROM face_room_drafts WHERE id = ?", d.message_id).mentions), [h.B.handle.toLowerCase()], "and the stored list is the one delivered");
  assert.equal(h.delivered(d.message_id).edited, false, "the audit row says what the room event says");
});

test("a room card decided approved_with_edits with an edited payload is an edit, in the event, the stored list and the audit row", async (t) => {
  const h = await room(t);
  const d = await h.draft("the held line", [h.B.handle]);
  const r = await h.decide(d.approval_id, { decision: "approved_with_edits", edited_payload: { text: "the owner's own line" } });
  assert.equal(r.status, "delivered", JSON.stringify(r));
  const [ev] = await h.roomEvents();
  assert.equal(ev.untrusted_content.text, "the owner's own line");
  assert.equal(ev.edited_by_owner, true, "the owner rewrote it, so every member reads that");
  assert.equal("mentions" in ev, false, "the list described the text the Bot wrote, and that text is gone");
  assert.equal(h.stored("SELECT mentions FROM face_room_drafts WHERE id = ?", d.message_id).mentions, null, "nor is it stored");
  assert.equal(h.delivered(d.message_id).edited, true, "the audit row agrees with the event");
});

test("the chat door reads the same body the same way, so the two lanes say one thing", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const conv = (await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "one body, one answer" })) as any;
  const d = (await A.bot.req("POST", `/v1/conversations/${conv.conversation_id}/messages`,
    A.bot.envelope("message.draft", { text: "the draft" }, { conversation_id: conv.conversation_id }))) as any;
  const r = (await A.owner.req("POST", `/v1/approvals/${d.approval_id}/decision`, { decision: "approved_with_edits" })) as any;
  assert.equal(r.status, "delivered", JSON.stringify(r));
  const ev = ((await B.bot.events()) as any).events.filter((e: any) => e.event_type === "message.received")[0];
  assert.equal(ev.untrusted_content.text, "the draft");
  assert.equal(ev.edited_by_owner, false, "a word without a payload is not an edit here either");
  const row = JSON.parse((s.platform.audit.db.prepare("SELECT data FROM audit_events WHERE action = 'message.delivered' AND subject = ?").get(d.message_id) as any).data);
  assert.equal(row.edited, false, "and the chat chain records the same answer the room chain does");
});
