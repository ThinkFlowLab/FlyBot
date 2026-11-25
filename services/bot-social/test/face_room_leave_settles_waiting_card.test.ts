/**
 * A line waiting in a face room whose sender leaves that room can never be approved: the decision door answers
 * `409 not_a_member`, so the card sits pending for its whole clock and the owner's only way to clear it is to
 * reject it. The seat ends through `removeFaceMember`, the one door every "this Bot is out" path goes through, so
 * the card is settled there — this Bot's own held lines for this room, announced once with the reason — and nothing
 * else: another member's card, the same Bot's card in another room, and an action card keep their state.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { friends, inDays, ownerWithBot, startServer } from "./helpers.js";

async function req(base: string, method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}

/** Every owner joins one room by the same number and the first owner starts it; the last answer names it. */
async function openRoom(base: string, code: string, ...owners: any[]) {
  let roomId = "";
  for (const o of owners) {
    const r = await req(base, "POST", "/v1/face-rooms/join", o.owner.token, { code, bots: [o.bot.id] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    roomId = r.body.room_id as string;
  }
  const started = await req(base, "POST", `/v1/face-rooms/${roomId}/start`, owners[0].owner.token);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  return roomId;
}

/** A held face-room line: queued, waiting for the owner's decision, nothing delivered yet. */
async function heldLine(s: any, roomId: string, o: any, text = "a line waiting for a decision") {
  const d = await req(s.base, "POST", `/v1/face-rooms/${roomId}/messages`, o.owner.token, { bot_id: o.bot.id, text });
  assert.equal(d.status, 202, JSON.stringify(d.body));
  assert.equal(d.body.status, "pending_approval");
  return { approvalId: d.body.approval_id as string, messageId: d.body.message_id as string };
}

const leave = (s: any, roomId: string, o: any) =>
  req(s.base, "POST", `/v1/face-rooms/${roomId}/leave`, o.owner.token, { bots: [o.bot.id] });

const approvalRow = (s: any, id: string) =>
  s.platform.db.prepare("SELECT status, decision, decided_at FROM approvals WHERE id = ?").get(id) as any;
const draftRow = (s: any, id: string) =>
  s.platform.db.prepare("SELECT status FROM face_room_drafts WHERE id = ?").get(id) as any;
const decidedEvents = async (bot: any, approvalId: string) =>
  ((await bot.events()).events as any[]).filter((e) => e.event_type === "approval.decided" && e.approval_id === approvalId);

test("leaving a room settles the waiting card of the Bot that left", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "lena");
  const B = await ownerWithBot(s.base, "lenb");
  const roomId = await openRoom(s.base, "616071", A, B);
  const held = await heldLine(s, roomId, A);

  const out = await leave(s, roomId, A);
  assert.equal(out.status, 200, JSON.stringify(out.body));

  const card = approvalRow(s, held.approvalId);
  assert.equal(card.status, "cancelled", "a line whose sender walked out is not a decision the owner can still make");
  assert.equal(card.decision, "room_left", "the settled card says why it was settled");
  assert.ok(card.decided_at, "the settled card records when it was settled");
  assert.equal(draftRow(s, held.messageId).status, "cancelled", "the draft behind the card is settled with it");

  // The owner's queue no longer asks for a decision that can only be refused.
  const pending = await req(s.base, "GET", "/v1/approvals?status=pending", A.owner.token);
  assert.equal(pending.status, 200, JSON.stringify(pending.body));
  assert.ok(!(pending.body.approvals as any[]).some((a) => a.approval_id === held.approvalId), "the dead card left the pending queue");

  // Deciding it now says the seat is gone, not that the sender is no longer a member.
  const decided = await req(s.base, "POST", `/v1/approvals/${held.approvalId}/decision`, A.owner.token, { decision: "approved" });
  assert.equal(decided.status, 409, JSON.stringify(decided.body));
  assert.equal(decided.body.error?.code, "invalid_state", "a settled card is not a `not_a_member` refusal");
  assert.equal(decided.body.error?.message, "the Bot is no longer in the room this draft was for; this draft can no longer be approved");

  // The room lives on for the member who stayed.
  const view = await req(s.base, "GET", `/v1/face-rooms/${roomId}`, B.owner.token);
  assert.equal(view.status, 200, JSON.stringify(view.body));
  assert.equal(view.body.status, "open", "one member leaving does not close the room");
  assert.ok((view.body.members as any[]).some((m) => m.bot_id === B.bot.id), "the member who stayed is still in the room");
});

test("and tells that Bot which line it was holding", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "lenc");
  const B = await ownerWithBot(s.base, "lend");
  const roomId = await openRoom(s.base, "616072", A, B);
  const held = await heldLine(s, roomId, A);

  await leave(s, roomId, A);

  const told = await decidedEvents(A.bot, held.approvalId);
  assert.equal(told.length, 1, "the Bot that owned the card hears the cancellation once, not silently");
  assert.equal(told[0].kind, "face_room_message");
  assert.equal(told[0].decision, "cancelled");
  assert.equal(told[0].reason, "room_left");
  assert.equal(told[0].message_id, held.messageId, "the event names the line it was holding");
});

test("another member's line, the same Bot's line in another room, and an action card keep their state", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const C = await ownerWithBot(s.base, "leng");
  const here = await openRoom(s.base, "616073", A, B);
  const elsewhere = await openRoom(s.base, "616074", A, C);
  const mine = await heldLine(s, here, A, "the line in the room I leave");
  const theirs = await heldLine(s, here, B, "the line of the member who stays");
  const other = await heldLine(s, elsewhere, A, "the line in the room I stay in");
  const cid = (await A.bot.startConversation(B.bot.id, { type: "schedule_meeting", summary: "sync", params: { duration_minutes: 30, window: { start: inDays(1, 0), end: inDays(8, 23) } } })).conversation_id as string;
  const booking: any = await A.bot.draftAction(cid, "calendar.book", { title: "Sync", start: inDays(3, 15), end: inDays(3, 15.5), attendees: [B.bot.id] });
  assert.equal(booking.status, "pending_approval");

  await leave(s, here, A);

  assert.equal(approvalRow(s, mine.approvalId).status, "cancelled", "this Bot's own line in the room it left is settled");
  assert.equal(approvalRow(s, theirs.approvalId).status, "pending", "another member's line in the same room is not this leave's business");
  assert.equal(draftRow(s, theirs.messageId).status, "pending_approval");
  assert.equal(approvalRow(s, other.approvalId).status, "pending", "the same Bot's line in another room is not this leave's business");
  assert.equal(draftRow(s, other.messageId).status, "pending_approval");
  assert.equal(approvalRow(s, booking.approval_id).status, "pending", "an action card is not a line in the room that was left");
});

test("a second leave settles nothing again and writes no second event", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "lenh");
  const B = await ownerWithBot(s.base, "leni");
  const roomId = await openRoom(s.base, "616075", A, B);
  const held = await heldLine(s, roomId, A);

  const first = await leave(s, roomId, A);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const again = await leave(s, roomId, A);
  assert.equal(again.status, 404, "a Bot that is already out is not in the room to leave");
  assert.equal(again.body.error?.code, "face_room_not_found", JSON.stringify(again.body));

  assert.equal((await decidedEvents(A.bot, held.approvalId)).length, 1, "the Bot is told exactly once");
  const leftEvents = s.platform.db.prepare("SELECT COUNT(*) n FROM face_room_events WHERE room_id = ? AND type = 'member.left' AND actor_bot = ?").get(roomId, A.bot.id) as any;
  assert.equal(leftEvents.n, 1, "the room records one member.left, not two");
  const audit = await req(s.base, "GET", "/v1/audit-events?limit=200", A.owner.token);
  const rows = (audit.body.events as any[]).filter((e) => e.action === "face_room.left" && e.subject === roomId);
  assert.equal(rows.length, 1, "the leave is audited once, not twice");
  assert.deepEqual(rows[0].data?.bots, [A.bot.id], "the audit row names the Bot that left");
});

test("a line whose sender stays is still the owner's to approve and deliver", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "lenj");
  const B = await ownerWithBot(s.base, "lenk");
  const roomId = await openRoom(s.base, "616076", A, B);
  const held = await heldLine(s, roomId, A, "still goes out");

  const decided = await req(s.base, "POST", `/v1/approvals/${held.approvalId}/decision`, A.owner.token, { decision: "approved" });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));

  assert.equal(approvalRow(s, held.approvalId).status, "approved");
  assert.equal(draftRow(s, held.messageId).status, "delivered");
  const view = await req(s.base, "GET", `/v1/face-rooms/${roomId}`, B.owner.token);
  assert.ok((view.body.events as any[]).some((e) => e.type === "room.message"), "the line reached the room");
});
