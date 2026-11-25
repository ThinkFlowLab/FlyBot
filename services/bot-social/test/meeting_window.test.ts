import assert from "node:assert/strict";
import { test } from "node:test";
import { friends, startServer } from "./helpers.js";

// A meeting is a window in time, and both doors that can act on it must read the same clock. `calendar.book` takes
// any `start` and `calendar.accept_invite` accepts any invitation, so a card drafted while the window was still
// ahead can be approved after the meeting has begun: the draft door then mints a card the calendar has already left
// behind, and the execute door writes it into the past and tells the peer.
//
// Both doors therefore refuse the same condition, `start <= now`: the draft door refuses to create the card
// (400 `invalid_request` / 410 `invite_expired`), and the execute door refuses to write it (failed, reason
// `meeting_in_past` / `invite_expired`), before any calendar row or event. A future window is unchanged.
//
// The clock is injected so "the meeting passes while the card waits" is the test's own step, not wall time.

const HOUR = 3600e3;
const iso = (ms: number) => new Date(ms).toISOString();

const meetingIntent = (start: string, end: string) => ({ type: "schedule_meeting", summary: "sync", params: { duration_minutes: 30, window: { start, end } } });

async function req(base: string, method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}
const approve = (base: string, owner: any, id: string) =>
  req(base, "POST", `/v1/approvals/${id}/decision`, owner.token, { decision: "approved" });
const calendarRows = (s: any, ownerId: string) =>
  (s.platform.db.prepare("SELECT COUNT(*) n FROM calendar_entries WHERE owner_id = ?").get(ownerId) as any).n as number;
const entryStatus = (s: any, bookingId: string, ownerId: string) =>
  (s.platform.db.prepare("SELECT status FROM calendar_entries WHERE booking_id = ? AND owner_id = ?").get(bookingId, ownerId) as any)?.status as string | undefined;
const actionRow = (s: any, id: string) =>
  s.platform.db.prepare("SELECT status, result FROM actions WHERE id = ?").get(id) as any;
const cardsFor = (s: any, conversationId: string) =>
  (s.platform.db.prepare("SELECT COUNT(*) n FROM actions WHERE conversation_id = ?").get(conversationId) as any).n as number;
const eventsOfType = async (bot: any, type: string) =>
  ((await bot.events()).events as any[]).filter((e) => e.event_type === type);

/** A server whose clock the test moves; everything else is the real platform. */
async function clockedServer(t: any) {
  const clock = { now: Date.now() };
  const s = await startServer({ now: () => clock.now });
  t.after(s.stop);
  return { s, clock };
}

test("a draft for a window that already started is refused, with no card", async (t) => {
  const { s, clock } = await clockedServer(t);
  const { A, B } = await friends(s.base);
  const cid = (await A.bot.startConversation(B.bot.id, meetingIntent(iso(clock.now + HOUR), iso(clock.now + 2 * HOUR)))).conversation_id as string;
  const beforeA = calendarRows(s, A.owner_id), beforeB = calendarRows(s, B.owner_id);
  const beforeCards = cardsFor(s, cid);

  await assert.rejects(
    A.bot.draftAction(cid, "calendar.book", { title: "Past sync", start: iso(clock.now - 2 * HOUR), end: iso(clock.now - HOUR), attendees: [B.bot.id] }),
    (e: any) => {
      assert.equal(e.status, 400);
      assert.equal(e.code, "invalid_request");
      assert.match(e.message, /after now/);
      return true;
    },
  );

  assert.equal(cardsFor(s, cid), beforeCards, "no approval card was minted");
  assert.equal(calendarRows(s, A.owner_id), beforeA, "no calendar row on the requester's side");
  assert.equal(calendarRows(s, B.owner_id), beforeB, "none on the peer's side");
  assert.equal((await eventsOfType(A.bot, "event.meeting_booked")).length, 0, "the requester hears of no booking");
});

test("a draft answer to an invitation whose meeting already started is refused, with no card", async (t) => {
  const { s, clock } = await clockedServer(t);
  const { A, B } = await friends(s.base);
  const cid = (await A.bot.startConversation(B.bot.id, meetingIntent(iso(clock.now + HOUR), iso(clock.now + 2 * HOUR)))).conversation_id as string;

  const d: any = await A.bot.draftAction(cid, "calendar.book", { title: "Stale sync", start: iso(clock.now + 2 * HOUR), end: iso(clock.now + 3 * HOUR), attendees: [B.bot.id] });
  const booked: any = await approve(s.base, A.owner, d.approval_id);
  assert.equal(booked.body.status, "executed");
  const bookingId = booked.body.result.booking_id as string;
  assert.equal(entryStatus(s, bookingId, B.owner_id), "invited");

  // The meeting passes while the invitation waits.
  clock.now += 4 * HOUR;
  const beforeCards = cardsFor(s, cid);

  await assert.rejects(B.bot.draftAction(cid, "calendar.accept_invite", { booking_id: bookingId }), (e: any) => {
    assert.equal(e.status, 410);
    assert.equal(e.code, "invite_expired");
    return true;
  });

  assert.equal(cardsFor(s, cid), beforeCards, "no approval card was minted");
  assert.equal(entryStatus(s, bookingId, B.owner_id), "invited", "the invite is untouched");
});

test("a meeting that already started is not booked behind the owner's approval", async (t) => {
  const { s, clock } = await clockedServer(t);
  const { A, B } = await friends(s.base);
  const cid = (await A.bot.startConversation(B.bot.id, meetingIntent(iso(clock.now + HOUR), iso(clock.now + 2 * HOUR)))).conversation_id as string;

  // The draft is legal when it is written: the window is still ahead.
  const d: any = await A.bot.draftAction(cid, "calendar.book", { title: "Late sync", start: iso(clock.now + 2 * HOUR), end: iso(clock.now + 3 * HOUR), attendees: [B.bot.id] });
  assert.equal(d.status, "pending_approval");
  const beforeA = calendarRows(s, A.owner_id), beforeB = calendarRows(s, B.owner_id);

  // The owner leaves it on their desk past the meeting.
  clock.now += 4 * HOUR;
  const r = await approve(s.base, A.owner, d.approval_id);
  assert.equal(r.body.status, "failed", "the card settles as failed, not executed");
  assert.equal(r.body.reason, "meeting_in_past");
  assert.equal(actionRow(s, d.action_id).status, "failed", "the action row says failed too");

  assert.equal(calendarRows(s, A.owner_id), beforeA, "no calendar row on the requester's side");
  assert.equal(calendarRows(s, B.owner_id), beforeB, "none on the peer's side either");
  assert.equal((await eventsOfType(A.bot, "event.meeting_booked")).length, 0, "the requester hears of no booking");
  assert.equal((await eventsOfType(B.bot, "event.meeting_booked")).length, 0, "and neither does the peer");
});

test("an invitation whose meeting already started cannot be accepted", async (t) => {
  const { s, clock } = await clockedServer(t);
  const { A, B } = await friends(s.base);
  const cid = (await A.bot.startConversation(B.bot.id, meetingIntent(iso(clock.now + HOUR), iso(clock.now + 2 * HOUR)))).conversation_id as string;

  const d: any = await A.bot.draftAction(cid, "calendar.book", { title: "Stale sync", start: iso(clock.now + 2 * HOUR), end: iso(clock.now + 3 * HOUR), attendees: [B.bot.id] });
  const booked: any = await approve(s.base, A.owner, d.approval_id);
  assert.equal(booked.body.status, "executed");
  const bookingId = booked.body.result.booking_id as string;
  assert.equal(entryStatus(s, bookingId, B.owner_id), "invited");

  // The invitee drafts the answer while the meeting is still ahead, then the meeting passes.
  const acc: any = await B.bot.draftAction(cid, "calendar.accept_invite", { booking_id: bookingId });
  assert.equal(acc.status, "pending_approval");
  const beforeA = calendarRows(s, A.owner_id), beforeB = calendarRows(s, B.owner_id);

  clock.now += 4 * HOUR;
  const r = await approve(s.base, B.owner, acc.approval_id);
  assert.equal(r.body.status, "failed", "the card settles as failed, not executed");
  assert.equal(r.body.reason, "invite_expired");
  assert.equal(actionRow(s, acc.action_id).status, "failed", "the action row says failed too");

  assert.equal(calendarRows(s, A.owner_id), beforeA, "no calendar row changed");
  assert.equal(calendarRows(s, B.owner_id), beforeB, "no calendar row changed");
  assert.equal(entryStatus(s, bookingId, B.owner_id), "invited", "the invite is not confirmed");
  assert.equal((await eventsOfType(A.bot, "event.invite_accepted")).length, 0, "the organizer is not told it was accepted");
  assert.equal((await eventsOfType(B.bot, "event.invite_accepted")).length, 0, "and neither is the invitee");
});

test("a future window books and accepts exactly as before", async (t) => {
  const { s, clock } = await clockedServer(t);
  const { A, B } = await friends(s.base);
  const cid = (await A.bot.startConversation(B.bot.id, meetingIntent(iso(clock.now + HOUR), iso(clock.now + 2 * HOUR)))).conversation_id as string;

  const beforeA = calendarRows(s, A.owner_id), beforeB = calendarRows(s, B.owner_id);
  const d: any = await A.bot.draftAction(cid, "calendar.book", { title: "Future sync", start: iso(clock.now + 3 * 24 * HOUR), end: iso(clock.now + 3 * 24 * HOUR + HOUR), attendees: [B.bot.id] });
  const booked: any = await approve(s.base, A.owner, d.approval_id);
  assert.equal(booked.body.status, "executed");
  assert.equal(calendarRows(s, A.owner_id), beforeA + 1, "the organizer's row is written");
  assert.equal(calendarRows(s, B.owner_id), beforeB + 1, "and the invitee's");
  assert.equal((await eventsOfType(A.bot, "event.meeting_booked")).length, 1);

  const acc: any = await B.bot.draftAction(cid, "calendar.accept_invite", { booking_id: booked.body.result.booking_id });
  const accepted: any = await approve(s.base, B.owner, acc.approval_id);
  assert.equal(accepted.body.status, "executed");
  assert.equal(entryStatus(s, booked.body.result.booking_id, B.owner_id), "confirmed");
  assert.equal((await eventsOfType(B.bot, "event.invite_accepted")).length, 1);
  assert.equal((await eventsOfType(A.bot, "event.invite_accepted")).length, 1);
});
