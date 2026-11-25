/**
 * A Bot reading `approval.decided` for a face-room line has to know which room the line belonged to: the same
 * line is held in several rooms at once, and a Bot that only hears "cancelled / room_left" cannot tell which
 * waiting line went away. The approved, rejected and expired decisions on a room line all carry `room_id`; the
 * cancelled decision is the one that leaves it out, so a Bot settling its own bookkeeping on the event alone
 * cannot match it to the room it was written in. Every decision on a room line names the room, whichever door
 * ended the card.
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

/** Two owners join one room by the same number and the first starts it; the last answer names it. */
async function openRoom(s: any, code: string, ...owners: any[]) {
  let roomId = "";
  for (const o of owners) {
    const r = await req(s.base, "POST", "/v1/face-rooms/join", o.owner.token, { code, bots: [o.bot.id] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    roomId = r.body.room_id as string;
  }
  const started = await req(s.base, "POST", `/v1/face-rooms/${roomId}/start`, owners[0].owner.token);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  return roomId;
}

/** A line waiting for its owner's decision; nothing is delivered and the card is still pending. */
async function heldLine(s: any, roomId: string, o: any, text: string) {
  const d = await req(s.base, "POST", `/v1/face-rooms/${roomId}/messages`, o.owner.token, { bot_id: o.bot.id, text });
  assert.equal(d.status, 202, JSON.stringify(d.body));
  assert.equal(d.body.status, "pending_approval");
  return { approvalId: d.body.approval_id as string, messageId: d.body.message_id as string };
}

const leave = (s: any, roomId: string, o: any) =>
  req(s.base, "POST", `/v1/face-rooms/${roomId}/leave`, o.owner.token, {});

const decidedEvents = async (bot: any, approvalId: string) =>
  ((await bot.events()).events as any[]).filter((e) => e.event_type === "approval.decided" && e.approval_id === approvalId);

test("a line settled because its sender left names the room it was written in", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const roomId = await openRoom(s, "717201", A, B);
  const held = await heldLine(s, roomId, A, "the line my leave settles");

  const out = await leave(s, roomId, A);
  assert.equal(out.status, 200, JSON.stringify(out.body));

  const told = await decidedEvents(A.bot, held.approvalId);
  assert.equal(told.length, 1, "the Bot hears about the settled line once");
  assert.equal(told[0].decision, "cancelled");
  assert.equal(told[0].reason, "room_left");
  assert.equal(told[0].message_id, held.messageId, "the event names the line");
  assert.equal(told[0].room_id, roomId, "the event names the room the line was written in");
});

test("a line dropped by a closing room names the room it was written in", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const roomId = await openRoom(s, "717202", A, B);
  const held = await heldLine(s, roomId, A, "the line the closed room drops");

  const first = await leave(s, roomId, B);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const last = await leave(s, roomId, A);
  assert.equal(last.status, 200, JSON.stringify(last.body));

  const told = await decidedEvents(A.bot, held.approvalId);
  assert.equal(told.length, 1, "the Bot hears about the dropped line once");
  assert.equal(told[0].decision, "cancelled");
  assert.equal(told[0].reason, "room_closed");
  assert.equal(told[0].room_id, roomId, "the event names the room the line was written in");
});

test("every decision on a room line names the room, the cancelled one included", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const roomId = await openRoom(s, "717203", A, B);
  const approved = await heldLine(s, roomId, A, "the line the owner approves");
  const rejected = await heldLine(s, roomId, A, "the line the owner rejects");
  const expired = await heldLine(s, roomId, A, "the line whose clock runs out");
  const cancelled = await heldLine(s, roomId, A, "the line my leave settles");

  const ok = await req(s.base, "POST", `/v1/approvals/${approved.approvalId}/decision`, A.owner.token, { decision: "approved" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const no = await req(s.base, "POST", `/v1/approvals/${rejected.approvalId}/decision`, A.owner.token, { decision: "rejected", note_to_bot: "not this one" });
  assert.equal(no.status, 200, JSON.stringify(no.body));

  // Let the third line's clock run out: the platform expires it on the next read of the owner's queue.
  s.platform.db.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", expired.approvalId);
  const pending = await req(s.base, "GET", "/v1/approvals?status=pending", A.owner.token);
  assert.equal(pending.status, 200, JSON.stringify(pending.body));

  const out = await leave(s, roomId, A);
  assert.equal(out.status, 200, JSON.stringify(out.body));

  for (const [label, held, decision] of [
    ["approved", approved, "approved"],
    ["rejected", rejected, "rejected"],
    ["expired", expired, "expired"],
    ["cancelled", cancelled, "cancelled"],
  ] as const) {
    const told = await decidedEvents(A.bot, held.approvalId);
    assert.equal(told.length, 1, `the ${label} line is announced once`);
    assert.equal(told[0].decision, decision, `the ${label} event carries its decision`);
    assert.equal(told[0].room_id, roomId, `the ${label} event names the room the line was written in`);
  }
});
