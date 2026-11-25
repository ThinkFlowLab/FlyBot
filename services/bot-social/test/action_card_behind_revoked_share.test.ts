// A booking card waits on the same share a line does: the chat the owner let the other Bot talk in. When that share
// is revoked, an approval that still executes books a meeting on the very calendar whose owner stopped sharing, and
// tells the other Bot about it — a commitment made past a door the owner closed. So a card held on a revoked share is
// settled like a held line, whether the revoke was live or the row was left behind by an older build. The invitee's
// own answer to a booking is the one card a closed door does not take: it is not a line this share was carrying.
import assert from "node:assert/strict";
import { test } from "node:test";
import { friends, inDays, startServer } from "./helpers.js";

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

/** The live chat share the grantor's owner gave that Bot. */
const grantFor = (s: any, grantorOwner: string, granteeBot: string) =>
  s.platform.db.prepare("SELECT id FROM grants WHERE grantor_owner = ? AND grantee_bot = ? AND capability = 'chat.public' AND IFNULL(room_id, '') = '' AND status = 'active' ORDER BY created_at DESC LIMIT 1").get(grantorOwner, granteeBot) as any;

const cardIn = async (base: string, owner: any, status: string, id: string) =>
  (((await req(base, "GET", `/v1/approvals?status=${status}`, owner.token)).body.approvals as any[]) ?? []).find((a) => a.approval_id === id) ?? null;

const approve = (base: string, owner: any, id: string) =>
  req(base, "POST", `/v1/approvals/${id}/decision`, owner.token, { decision: "approved" });

const entries = async (owner: any) => ((await owner.req("GET", "/v1/calendar/entries")).entries as any[]);

const bookedEvents = async (bot: any) =>
  ((await bot.events()).events as any[]).filter((e) => e.event_type === "event.meeting_booked");

/** A meeting A's Bot put up for approval: nothing is written until A's owner decides. */
async function heldBooking(A: any, B: any, title = "Sync") {
  const cid = (await A.bot.startConversation(B.bot.id, meetingIntent())).conversation_id as string;
  const d: any = await A.bot.draftAction(cid, "calendar.book", { title, start: inDays(3, 15), end: inDays(3, 15.5), attendees: [B.bot.id] });
  assert.equal(d.status, "pending_approval");
  return { cid, approvalId: d.approval_id as string, actionId: d.action_id as string };
}

test("a booking card an older build left pending behind a revoked share is settled, never executed", async () => {
  const s = await startServer();
  try {
    const { A, B } = await friends(s.base);
    const held = await heldBooking(A, B);
    const g = grantFor(s, B.owner_id, A.bot.id);
    assert.ok(g, "B's owner shares chat.public with A's Bot when they become friends");
    // The row an older build left behind: the share is gone, the card was never settled.
    s.platform.db.prepare("UPDATE grants SET status = 'revoked', revoked_at = ? WHERE id = ?").run(new Date().toISOString(), g.id);
    assert.ok(await cardIn(s.base, A.owner, "pending", held.approvalId), "the stale card is still pending");

    const refused: any = await approve(s.base, A.owner, held.approvalId);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.error.code, "invalid_state");
    assert.match(refused.body.error.message, /the share this draft was waiting on was revoked/);

    const settled: any = await cardIn(s.base, A.owner, "cancelled", held.approvalId);
    assert.ok(settled, "the stale card is settled instead of executed");
    assert.equal(settled.decision, "grant_revoked");
    assert.equal((s.platform.db.prepare("SELECT status FROM actions WHERE id = ?").get(held.actionId) as any).status, "cancelled");
    assert.equal((await entries(A.owner)).length, 0, "the requester's calendar stays empty");
    assert.equal((await entries(B.owner)).length, 0, "and so does the calendar whose owner stopped sharing");
    assert.equal((await bookedEvents(A.bot)).length + (await bookedEvents(B.bot)).length, 0, "no booking is announced");
  } finally { await s.stop(); }
});

test("a booking card drafted after the share was revoked cannot be approved either", async () => {
  const s = await startServer();
  try {
    const { A, B } = await friends(s.base);
    const held = await heldBooking(A, B);
    const g = grantFor(s, B.owner_id, A.bot.id);
    assert.equal((await req(s.base, "DELETE", `/v1/grants/${g.id}`, B.owner.token)).status, 200);
    assert.ok(await cardIn(s.base, A.owner, "cancelled", held.approvalId), "the card held at revoke time is settled");

    // A draft that starts after the door closed: the chat is still there, the share is not.
    const late: any = await A.bot.draftAction(held.cid, "calendar.book", { title: "Late", start: inDays(4, 15), end: inDays(4, 15.5), attendees: [B.bot.id] });
    assert.equal(late.status, "pending_approval");

    const refused: any = await approve(s.base, A.owner, late.approval_id);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.error.code, "invalid_state");
    assert.match(refused.body.error.message, /the share this draft was waiting on was revoked/);
    assert.equal((await cardIn(s.base, A.owner, "cancelled", late.approval_id)).decision, "grant_revoked");
    assert.equal((await entries(A.owner)).length, 0);
    assert.equal((await entries(B.owner)).length, 0);
  } finally { await s.stop(); }
});

test("guard: a booking card whose share is still live executes as it always did", async () => {
  const s = await startServer();
  try {
    const { A, B } = await friends(s.base);
    const held = await heldBooking(A, B);
    const ok: any = await approve(s.base, A.owner, held.approvalId);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.status, "executed");
    const mine = await entries(A.owner), theirs = await entries(B.owner);
    assert.equal(mine.length, 1, "the requester's calendar holds the booking");
    assert.equal(mine[0].status, "confirmed");
    assert.equal(theirs.length, 1, "the peer is invited");
    assert.equal(theirs[0].status, "invited");
    assert.equal((await bookedEvents(A.bot)).length, 1);
    assert.equal((await bookedEvents(B.bot)).length, 1, "the peer's Bot is told, as before");
  } finally { await s.stop(); }
});

test("guard: the invitee's accept-invite card still decides after the chat share ends", async () => {
  const s = await startServer();
  try {
    const { A, B } = await friends(s.base);
    const cid = (await A.bot.startConversation(B.bot.id, meetingIntent())).conversation_id as string;
    const book: any = await A.bot.draftAction(cid, "calendar.book", { title: "Sync", start: inDays(3, 15), end: inDays(3, 15.5), attendees: [B.bot.id] });
    const done: any = await approve(s.base, A.owner, book.approval_id);
    assert.equal(done.body.status, "executed");
    const acc: any = await B.bot.draftAction(cid, "calendar.accept_invite", { booking_id: done.body.result.booking_id });
    assert.equal(acc.status, "pending_approval");

    // A's owner stops sharing their Bot with B's Bot: the answer to the booking is not a line that share carried.
    const g = grantFor(s, A.owner_id, B.bot.id);
    assert.ok(g);
    assert.equal((await req(s.base, "DELETE", `/v1/grants/${g.id}`, A.owner.token)).status, 200);
    assert.ok(await cardIn(s.base, B.owner, "pending", acc.approval_id), "the invite decision stays decidable");

    const accepted: any = await approve(s.base, B.owner, acc.approval_id);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.status, "executed");
    assert.equal((await entries(B.owner))[0].status, "confirmed", "the invited entry is accepted");
  } finally { await s.stop(); }
});
