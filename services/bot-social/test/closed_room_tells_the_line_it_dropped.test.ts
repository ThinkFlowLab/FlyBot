/**
 * When the last member leaves a face room, `faceCloseIfEmpty` settles every line still waiting in it with
 * hand-written SQL: the approval row becomes `cancelled / room_closed` and its draft is cancelled with it, but
 * nothing is emitted. Every other door that kills a card tells the Bot that owned it (`expireApproval`,
 * `cancelPendingFor` with `notify`); the room's own closure is the one that silently rewrites the card under the
 * Bot, so the Bot that wrote the line never learns it was dropped — it only finds the room gone and its own line
 * gone with it, with no `approval.decided` to tell why. Settle the same rows through the existing canceller
 * (`cancelPendingFor(..., "room_closed", { notify: true })`) so the outcome keeps its shape and the Bot hears about
 * it exactly once; a line held in another room that is still open is not its business and stays quiet.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { friends, startServer } from "./helpers.js";

async function req(base: string, method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}

const approvalRow = (s: any, id: string) =>
  s.platform.db.prepare("SELECT status, decision FROM approvals WHERE id = ?").get(id) as any;
const draftRow = (s: any, id: string) =>
  s.platform.db.prepare("SELECT status FROM face_room_drafts WHERE id = ?").get(id) as any;
const roomRow = (s: any, id: string) =>
  s.platform.db.prepare("SELECT status FROM face_rooms WHERE id = ?").get(id) as any;
const decidedEvents = async (bot: any, id: string) =>
  ((await bot.events()).events as any[]).filter((e) => e.event_type === "approval.decided" && e.approval_id === id);

/** A and B (different owners) share one open room, each with their own Bot seated in it. */
async function openRoom(s: any, code: string, A: any, B: any) {
  const a = await req(s.base, "POST", "/v1/face-rooms/join", A.owner.token, { code, bots: [A.bot.id] });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const b = await req(s.base, "POST", "/v1/face-rooms/join", B.owner.token, { code, bots: [B.bot.id] });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.equal(b.body.room_id, a.body.room_id, "both owners are in the same room");
  const roomId = a.body.room_id as string;
  const started = await req(s.base, "POST", `/v1/face-rooms/${roomId}/start`, A.owner.token);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  return roomId;
}

/** A line waiting for its owner's decision; nothing is delivered and no card is decided yet. */
async function heldLine(s: any, roomId: string, o: any, text: string) {
  const d = await req(s.base, "POST", `/v1/face-rooms/${roomId}/messages`, o.owner.token, { bot_id: o.bot.id, text });
  assert.equal(d.status, 202, JSON.stringify(d.body));
  assert.equal(d.body.status, "pending_approval");
  return { approvalId: d.body.approval_id as string, messageId: d.body.message_id as string };
}

test("a room that closes with a waiting line tells its Bot that the line was dropped", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const roomId = await openRoom(s, "707301", A, B);
  const gone = await heldLine(s, roomId, A, "a line the sender's own leave settles");

  // The sender walks out first: its seat ends, so its own waiting line goes with it, and that is the leave's
  // business rather than the closure's. Nothing is left pending for the room to drop when it closes.
  const left = await req(s.base, "POST", `/v1/face-rooms/${roomId}/leave`, A.owner.token, {});
  assert.equal(left.status, 200, JSON.stringify(left.body));
  assert.equal(approvalRow(s, gone.approvalId).decision, "room_left", "the seat took its own waiting line with it");

  // A line written by the member who stays is still waiting when that member is the last one to walk out.
  const line = await heldLine(s, roomId, B, "a line the closed room drops");

  // The last member leaves too: the room closes with the line still waiting.
  const last = await req(s.base, "POST", `/v1/face-rooms/${roomId}/leave`, B.owner.token, {});
  assert.equal(last.status, 200, JSON.stringify(last.body));
  assert.equal(roomRow(s, roomId).status, "closed", "the room is closed");

  const card = approvalRow(s, line.approvalId);
  assert.equal(card.status, "cancelled", "the closed room does not leave a card nobody can decide");
  assert.equal(card.decision, "room_closed", "the settled card says why it was settled");
  assert.equal(draftRow(s, line.messageId).status, "cancelled", "the line behind the card is settled with it");

  // Every other way a card dies tells its Bot; the room closing must not be the silent one.
  const told = await decidedEvents(B.bot, line.approvalId);
  assert.equal(told.length, 1, "the Bot that wrote the dropped line hears about it exactly once");
  assert.equal(told[0].decision, "cancelled");
  assert.equal(told[0].kind, "face_room_message");
  assert.equal(told[0].reason, "room_closed", "the event names the closure as the reason");
  assert.equal(told[0].message_id, line.messageId, "the event names the line that was dropped");
});

test("a room that is still open keeps its waiting line, and its Bot hears nothing", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const closingRoom = await openRoom(s, "707302", A, B);
  const openRoomId = await openRoom(s, "707303", A, B);
  const dropped = await heldLine(s, closingRoom, A, "the line the closing room drops");
  const kept = await heldLine(s, openRoomId, A, "the line the open room keeps");

  await req(s.base, "POST", `/v1/face-rooms/${closingRoom}/leave`, A.owner.token, {});
  const last = await req(s.base, "POST", `/v1/face-rooms/${closingRoom}/leave`, B.owner.token, {});
  assert.equal(last.status, 200, JSON.stringify(last.body));
  assert.equal(roomRow(s, closingRoom).status, "closed", "the room with nobody left in it is closed");
  assert.equal(roomRow(s, openRoomId).status, "open", "the other room is not closed");

  assert.equal(approvalRow(s, dropped.approvalId).status, "cancelled", "the closing room settled its own line");
  assert.equal(approvalRow(s, kept.approvalId).status, "pending", "the open room's line is still waiting");
  assert.equal(draftRow(s, kept.messageId).status, "pending_approval", "and its draft is still held");
  assert.equal((await decidedEvents(A.bot, kept.approvalId)).length, 0, "the Bot hears nothing about the open room's line");
  const pending = await A.owner.req("GET", "/v1/approvals?status=pending");
  assert.ok((pending.approvals as any[]).some((a) => a.approval_id === kept.approvalId), "its card is still the owner's to decide");
});
