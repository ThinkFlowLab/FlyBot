/**
 * A face-room card whose draft row is gone must not answer 500.
 *
 * The owner's pending list already tolerates such a card: a `face_room_message` whose `face_room_drafts` row is
 * missing is listed without its room detail instead of taking the whole queue down (see #516). The decision door
 * did not keep the same promise. Both decisions read the draft row unconditionally — approving through
 * `deliverFaceRoomMessage`, rejecting through `rejectFaceRoomMessage` — so both answered 500 with
 * `internal_error`: the card stayed pending, the Bot heard nothing, and the queue kept offering a decision that
 * could not succeed.
 *
 * The shape #516/#525/#535 gave the other kinds is the fix: settle the card once, by id, with the reason
 * (`cancelled` / `draft_unavailable`) and answer 409 that names what the card was waiting on. Unlike the action
 * card, the guard covers the reject leg too: rejecting a room line reads the draft it would mark rejected, so
 * neither decision can settle this card without the row.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { friends, startServer } from "./helpers.js";

const DRAFT_GONE = "the draft this card was for was never written; this card can no longer be approved";

/** Two owners join one room by the same number and the first starts it; the last answer names it. */
async function openRoom(s: any, code: string, A: any, B: any) {
  let roomId = "";
  for (const o of [A, B]) {
    const r: any = await o.owner.req("POST", "/v1/face-rooms/join", { code, bots: [o.bot.id] });
    roomId = r.room_id as string;
  }
  await A.owner.req("POST", `/v1/face-rooms/${roomId}/start`);
  return roomId;
}

/** A line waiting for its owner's decision; nothing is delivered and the card is still pending. */
async function heldLine(s: any, roomId: string, o: any, text: string) {
  const d: any = await o.owner.req("POST", `/v1/face-rooms/${roomId}/messages`, { bot_id: o.bot.id, text });
  assert.equal(d.status, "pending_approval");
  return { approvalId: d.approval_id as string, messageId: d.message_id as string };
}

const cardRow = (s: any, id: string) => s.platform.db.prepare("SELECT status, decision FROM approvals WHERE id = ?").get(id) as any;
const draftRows = (s: any, id: string) => (s.platform.db.prepare("SELECT COUNT(*) n FROM face_room_drafts WHERE id = ?").get(id) as any).n as number;
const roomEvents = (s: any, roomId: string) => (s.platform.db.prepare("SELECT COUNT(*) n FROM face_room_events WHERE room_id = ?").get(roomId) as any).n as number;
const decidedEvents = async (bot: any, approvalId: string) =>
  ((await bot.events()).events as any[]).filter((e) => e.event_type === "approval.decided" && e.approval_id === approvalId);

/** The state a torn write an older build allowed leaves behind: the card is there, the row it points at is not. */
async function orphanCard(s: any, code: string, text: string) {
  const { A, B } = await friends(s.base);
  const roomId = await openRoom(s, code, A, B);
  const held = await heldLine(s, roomId, A, text);
  s.platform.db.prepare("DELETE FROM face_room_drafts WHERE id = ?").run(held.messageId);
  return { A, B, roomId, held };
}

test("approving a card whose draft was never written is a 409 that names the missing draft, not a 500", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, roomId, held } = await orphanCard(s, "918301", "the line whose draft row is gone");
  const eventsBefore = roomEvents(s, roomId);

  await assert.rejects(
    A.owner.req("POST", `/v1/approvals/${held.approvalId}/decision`, { decision: "approved" }),
    (e: any) => {
      assert.equal(e.status, 409, `a card without its draft must be a 409, not a ${e.status} (${e.message})`);
      assert.equal(e.code, "invalid_state");
      assert.equal(e.body?.error?.message, DRAFT_GONE, "the refusal names what the card was waiting on");
      return true;
    },
  );

  // Settled once, by id, with a reason a client can show — not left pending for the next read of the queue.
  const card = cardRow(s, held.approvalId);
  assert.equal(card.status, "cancelled", "the card is settled by the refusal");
  assert.equal(card.decision, "draft_unavailable", "and records why");
  assert.equal(draftRows(s, held.messageId), 0, "the refusal writes no draft row");
  assert.equal(roomEvents(s, roomId), eventsBefore, "and delivers nothing into the room");

  const told = await decidedEvents(A.bot, held.approvalId);
  assert.equal(told.length, 1, "the Bot hears about the settled card once");
  assert.equal(told[0].decision, "cancelled");
  assert.equal(told[0].reason, "draft_unavailable");
  assert.equal(told[0].message_id, held.messageId, "the event names the draft that is not there");

  // The queue no longer offers it, and asking again names the settled card instead of failing the same way twice.
  const queue: any = await A.owner.req("GET", "/v1/approvals?status=pending");
  assert.equal(queue.approvals.some((x: any) => x.approval_id === held.approvalId), false, "a settled card is not offered again");
  await assert.rejects(
    A.owner.req("POST", `/v1/approvals/${held.approvalId}/decision`, { decision: "approved" }),
    (e: any) => {
      assert.equal(e.status, 409);
      assert.equal(e.code, "invalid_state");
      assert.equal(e.body?.error?.message, "approval is cancelled", "the second answer is about the card's state");
      return true;
    },
  );
});

test("the reject leg is guarded too: rejecting a room line reads the draft it would mark rejected", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, roomId, held } = await orphanCard(s, "918302", "the line whose draft row is gone (reject)");
  const eventsBefore = roomEvents(s, roomId);

  await assert.rejects(
    A.owner.req("POST", `/v1/approvals/${held.approvalId}/decision`, { decision: "rejected" }),
    (e: any) => {
      assert.equal(e.status, 409, `rejecting such a card must be a 409, not a ${e.status} (${e.message})`);
      assert.equal(e.code, "invalid_state");
      assert.equal(e.body?.error?.message, DRAFT_GONE, "the refusal names the draft, not just the state");
      return true;
    },
  );

  const card = cardRow(s, held.approvalId);
  assert.equal(card.status, "cancelled");
  assert.equal(card.decision, "draft_unavailable");
  assert.equal(draftRows(s, held.messageId), 0, "the refusal writes no draft row");
  assert.equal(roomEvents(s, roomId), eventsBefore, "and delivers nothing into the room");
  const told = await decidedEvents(A.bot, held.approvalId);
  assert.equal(told.length, 1, "the card is announced once, not once per attempt");
  assert.equal(told[0].message_id, held.messageId);
});

test("an owner edit on such a card is refused the same way, and settles it only once", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, roomId, held } = await orphanCard(s, "918303", "the line whose draft row is gone (edit)");
  const eventsBefore = roomEvents(s, roomId);

  await assert.rejects(
    A.owner.req("POST", `/v1/approvals/${held.approvalId}/decision`, { decision: "approved_with_edits", edited_payload: { text: "an edited line" } }),
    (e: any) => {
      assert.equal(e.status, 409);
      assert.equal(e.code, "invalid_state");
      assert.equal(e.body?.error?.message, DRAFT_GONE);
      return true;
    },
  );

  assert.equal(cardRow(s, held.approvalId).decision, "draft_unavailable");
  assert.equal(roomEvents(s, roomId), eventsBefore, "an edit cannot deliver a line whose draft is not there");
  assert.equal((await decidedEvents(A.bot, held.approvalId)).length, 1, "the card is announced once");
});

test("control: a card with its draft row is still approved and delivered", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const roomId = await openRoom(s, "918304", A, B);
  const held = await heldLine(s, roomId, A, "the line whose draft is there");
  const eventsBefore = roomEvents(s, roomId);

  const r: any = await A.owner.req("POST", `/v1/approvals/${held.approvalId}/decision`, { decision: "approved" });
  assert.equal(r.status, "delivered", "the guard leaves a real room card alone");
  assert.equal(cardRow(s, held.approvalId).status, "approved");
  assert.equal(roomEvents(s, roomId), eventsBefore + 1, "the approved line lands in the room");
});

test("control: a card with its draft row is still rejected", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const roomId = await openRoom(s, "918305", A, B);
  const held = await heldLine(s, roomId, A, "the line whose draft is there (reject)");

  const r: any = await A.owner.req("POST", `/v1/approvals/${held.approvalId}/decision`, { decision: "rejected" });
  assert.equal(r.status, "rejected", "rejecting a real room line still settles the draft it wrote");
  assert.equal(cardRow(s, held.approvalId).status, "rejected");
  const d = s.platform.db.prepare("SELECT status FROM face_room_drafts WHERE id = ?").get(held.messageId) as any;
  assert.equal(d.status, "rejected");
});
