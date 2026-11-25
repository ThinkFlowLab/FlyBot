/**
 * A line waiting in a face room whose sender is taken out of that room can never be approved: the delivery door
 * answers `409 not_a_member`, so the card sits pending for its whole 24-hour clock and the owner's only way to clear
 * it is to reject it. Walking out is not the only door a seat ends through: revoking the share that brought the Bot
 * in removes it from the room the same way, and leaves the same dead card. So settle it there too, and tell the Bot
 * that owned it, the same way the other "your seat is gone" paths do — and nothing else: another member's line in
 * that room and the same Bot's booking card keep their state.
 *
 * A Bot walking out of a room on its own is a separate path with its own contract; this file stays off it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { friends, inDays, ownerWithBot, startServer } from "./helpers.js";

const meetingIntent = () => ({ type: "schedule_meeting", summary: "sync", params: { duration_minutes: 30, window: { start: inDays(1, 0), end: inDays(8, 23) } } });

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
  s.platform.db.prepare("SELECT status, decision, decided_at FROM approvals WHERE id = ?").get(id) as any;
const draftRow = (s: any, id: string) =>
  s.platform.db.prepare("SELECT status FROM face_room_drafts WHERE id = ?").get(id) as any;
const decidedEvents = async (bot: any, id: string) =>
  ((await bot.events()).events as any[]).filter((e) => e.event_type === "approval.decided" && e.approval_id === id);

/** A held face-room line: queued, waiting for the owner's decision, nothing delivered yet. */
async function heldLine(s: any, roomId: string, o: any, text = "a line waiting for a decision") {
  const d = await req(s.base, "POST", `/v1/face-rooms/${roomId}/messages`, o.owner.token, { bot_id: o.bot.id, text });
  assert.equal(d.status, 202, JSON.stringify(d.body));
  assert.equal(d.body.status, "pending_approval");
  return { approvalId: d.body.approval_id as string, messageId: d.body.message_id as string };
}

/** A shares its Bot with B, and B brings both Bots into one room: A's Bot sits there as B's guest. */
async function guestInRoom(s: any, code: string) {
  const { A, B } = await friends(s.base);
  const share = await req(s.base, "POST", `/v1/bots/${A.bot.id}/grants`, A.owner.token, { friend_bot_id: B.bot.id });
  assert.equal(share.status, 201, JSON.stringify(share.body));
  const joined = await req(s.base, "POST", "/v1/face-rooms/join", B.owner.token, { code, bots: [B.bot.id, A.bot.id] });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  return { A, B, roomId: joined.body.room_id as string, grantId: share.body.grant_id as string };
}

const revokeShare = (s: any, A: any, grantId: string) =>
  req(s.base, "DELETE", `/v1/bots/${A.bot.id}/grants/${grantId}`, A.owner.token);

test("a revoked share that takes a guest out of the room settles that Bot's waiting line", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B, roomId, grantId } = await guestInRoom(s, "606101");
  const guest = await heldLine(s, roomId, A, "the guest's waiting line");
  const host = await heldLine(s, roomId, B, "the host's waiting line");

  const revoked = await revokeShare(s, A, grantId);
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  assert.ok((revoked.body.rooms_removed as string[]).includes(roomId), "the revoked share takes the guest out of the room");

  const card = approvalRow(s, guest.approvalId);
  assert.equal(card.status, "cancelled", "a guest taken out of the room is not a decision its owner can still make");
  assert.equal(card.decision, "room_left", "the settled card says why it was settled");
  assert.equal(draftRow(s, guest.messageId).status, "cancelled", "the line behind the card is settled with it");
  assert.equal(approvalRow(s, host.approvalId).status, "pending", "the card of the member who stayed is not this share's business");

  // A settled card is never silent: the Bot that owned it is told, and can show which line ended.
  const told = await decidedEvents(A.bot, guest.approvalId);
  assert.equal(told.length, 1, "the Bot that owned the card hears about it exactly once");
  assert.equal(told[0].decision, "cancelled");
  assert.equal(told[0].kind, "face_room_message");
  assert.equal(told[0].reason, "room_left");
  assert.equal(told[0].message_id, guest.messageId, "the event names the line that ended");

  const view = await req(s.base, "GET", `/v1/face-rooms/${roomId}`, B.owner.token);
  assert.equal(view.status, 200, JSON.stringify(view.body));
  assert.ok(!(view.body.members as any[]).some((m: any) => m.bot_id === A.bot.id), "the guest's seat ended with the share");
});

test("another member's waiting line in the same room is not this share's business", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B, roomId, grantId } = await guestInRoom(s, "606102");
  const C = await ownerWithBot(s.base, "cat");
  const inRoom = await req(s.base, "POST", "/v1/face-rooms/join", C.owner.token, { code: "606102", bots: [C.bot.id] });
  assert.equal(inRoom.status, 200, JSON.stringify(inRoom.body));
  assert.equal(inRoom.body.room_id, roomId, "the third owner joins the same room");

  const guest = await heldLine(s, roomId, A, "the guest's waiting line");
  const host = await heldLine(s, roomId, B, "the host's waiting line");
  const other = await heldLine(s, roomId, C, "a third member's waiting line");

  const revoked = await revokeShare(s, A, grantId);
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));

  assert.equal(approvalRow(s, guest.approvalId).status, "cancelled", "only the card of the Bot that lost its seat is settled");
  assert.equal(approvalRow(s, host.approvalId).status, "pending", "the member who stayed keeps its decision");
  assert.equal(approvalRow(s, other.approvalId).status, "pending", "a third member's line is not this share's business");
  assert.equal(draftRow(s, other.messageId).status, "pending_approval");
});

test("the guest's own booking card is not a line in that room", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B, roomId, grantId } = await guestInRoom(s, "606103");
  const line = await heldLine(s, roomId, A, "the guest's waiting line");
  const cid = (await A.bot.startConversation(B.bot.id, meetingIntent())).conversation_id as string;
  const booking: any = await A.bot.draftAction(cid, "calendar.book", { title: "Sync", start: inDays(3, 15), end: inDays(3, 15.5), attendees: [B.bot.id] });
  assert.equal(booking.status, "pending_approval");

  const revoked = await revokeShare(s, A, grantId);
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));

  assert.equal(approvalRow(s, booking.approval_id).status, "pending", "a booking card is not a line in the room the guest was taken out of");
  assert.equal(approvalRow(s, line.approvalId).status, "cancelled", "the room's own line is settled");
});
