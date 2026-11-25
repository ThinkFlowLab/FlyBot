/**
 * P15 — an owner's `edited_params` at an action approval must re-run the doors the action draft closed.
 *
 * `executeAction` merged `edited_params` into the draft's params and then went straight to the calendar write, so
 * an owner edit could book a meeting that ends before it starts, invite a third bot, put DLP-blocked text into both
 * calendars, or retarget an accept at a booking that does not exist (which base answers with `200 {status:"failed"}`,
 * consuming the approval so the accept can never be retried).
 *
 * These tests are the fail-first half: every refusal must leave the card pending and write nothing, and the same
 * card must execute once the owner sends a valid edit.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { friends, inDays, ownerWithBot, startServer } from "./helpers.js";

const meetingIntent = () => ({ type: "schedule_meeting", summary: "sync", params: { duration_minutes: 30, window: { start: inDays(1, 0), end: inDays(8, 23) } } });

const decide = (owner: any, id: string, edited_params: unknown) =>
  owner.req("POST", `/v1/approvals/${id}/decision`, { decision: "approved_with_edits", edited_params });

/** status + code + a message that names the rule, not just "refused"; returns the error body for detail checks. */
async function expectRefused(p: Promise<unknown>, status: number, code: string, re: RegExp) {
  try {
    await p;
  } catch (e: any) {
    assert.equal(e.status, status, `expected ${status}, got ${e.status}: ${e.message}`);
    assert.equal(e.code, code, e.message);
    assert.match(e.message, re);
    return e;
  }
  assert.fail(`expected ${status} ${code}, but the call succeeded`);
}

const entries = async (owner: any) => ((await owner.req("GET", "/v1/calendar/entries")) as any).entries as any[];
const pendingHas = async (owner: any, id: string) => ((await owner.req("GET", "/v1/approvals?status=pending")) as any).approvals.some((a: any) => a.approval_id === id);
const actionRow = (S: any, id: string) => S.platform.db.prepare("SELECT status, result FROM actions WHERE id = ?").get(id) as any;
const countEvents = (S: any, type: string) => (S.platform.db.prepare("SELECT COUNT(*) n FROM events WHERE type = ?").get(type) as any).n;

/** Every refusal shape: nothing booked on either side, action untouched, no booking event, card still pending. */
async function assertNothingHappened(S: any, p: any, actionId: string, approvalId: string, who: string) {
  assert.equal((await entries(p.A.owner)).length, 0, `nothing may be booked for the organizer (${who})`);
  assert.equal((await entries(p.B.owner)).length, 0, `the peer's calendar stays untouched (${who})`);
  const row = actionRow(S, actionId);
  assert.equal(row.status, "pending_approval", `a refused edit leaves the action pending (${who})`);
  assert.equal(row.result, null, `a refused edit writes no result (${who})`);
  assert.equal(countEvents(S, "event.meeting_booked"), 0, `no booking event reaches either bot (${who})`);
  assert.equal(countEvents(S, "action.failed"), 0, `a refusal is not an executed failure (${who})`);
  assert.ok(await pendingHas(p.A.owner, approvalId), `a refused edit must not consume the approval (${who})`);
}

test("P15a: an accept retargeted to a booking that does not exist is 404, keeps the card, then executes", async () => {
  const S = await startServer();
  try {
    const p = await friends(S.base);
    const cid = (await p.A.bot.startConversation(p.B.bot.id, meetingIntent())).conversation_id;
    const book: any = await p.A.bot.draftAction(cid, "calendar.book", { title: "Sync", start: inDays(2, 10), end: inDays(2, 11), attendees: [p.B.bot.id] }, "plan");
    const booked: any = await p.A.owner.req("POST", `/v1/approvals/${book.approval_id}/decision`, { decision: "approved" });
    const booking_id = booked.result.booking_id;
    const [invited] = await entries(p.B.owner);
    assert.equal(invited.booking_id, booking_id);
    assert.equal(invited.status, "invited");

    const acc: any = await p.B.bot.draftAction(cid, "calendar.accept_invite", { booking_id }, "accept the invite");
    assert.equal(acc.status, "pending_approval");

    // The edit points the accept at a booking that does not exist for B's owner: the draft door answered this
    // before the card existed, so it must be answered with the same 404 here, not with a consumed failure. An
    // idempotency key claimed by the refused call is released by it, so the retry can carry the same key.
    const key = "p15-accept-retarget-1";
    await expectRefused(p.B.owner.req("POST", `/v1/approvals/${acc.approval_id}/decision`, { decision: "approved_with_edits", edited_params: { booking_id: "bkg_does_not_exist" }, idempotency_key: key }), 404, "invite_not_found", /no pending invite with that booking_id for your owner/);
    const row = actionRow(S, acc.action_id);
    assert.equal(row.status, "pending_approval", "the action row is untouched");
    assert.equal(row.result, null, "no result row is written");
    assert.equal(countEvents(S, "action.failed"), 0, "no failure event reaches the bot");
    assert.ok(await pendingHas(p.B.owner, acc.approval_id), "the card stays pending");
    assert.equal((await entries(p.B.owner))[0].status, "invited", "the invite is not consumed by the refusal");

    // The same card, pointed back at the real booking, executes — and says exactly what base would have said.
    const ok: any = await p.B.owner.req("POST", `/v1/approvals/${acc.approval_id}/decision`, { decision: "approved_with_edits", edited_params: { booking_id }, idempotency_key: key });
    assert.deepEqual(ok, {
      approval_id: acc.approval_id,
      decision: "approved_with_edits",
      action_id: acc.action_id,
      status: "executed",
      result: { booking_id, invitee_status: "accepted", start: invited.start, end: invited.end },
    });
    assert.equal((await entries(p.B.owner))[0].status, "confirmed");
  } finally {
    await S.stop();
  }
});

test("P15b: edited_params null is no edit — it executes like a plain approval", async () => {
  const S = await startServer();
  try {
    const p = await friends(S.base);
    const cid = (await p.A.bot.startConversation(p.B.bot.id, meetingIntent())).conversation_id;
    const act: any = await p.A.bot.draftAction(cid, "calendar.book", { title: "Null edit", start: inDays(3, 9), end: inDays(3, 10), attendees: [p.B.bot.id] }, "plan");

    const ok: any = await p.A.owner.req("POST", `/v1/approvals/${act.approval_id}/decision`, { decision: "approved_with_edits", edited_params: null });
    assert.equal(ok.status, "executed");
    const [mine] = await entries(p.A.owner);
    assert.equal(mine.title, "Null edit", "a null edit books the draft as drafted");
    assert.equal((await entries(p.B.owner)).length, 1, "the peer is invited once");
    assert.ok(!(await pendingHas(p.A.owner, act.approval_id)), "the card is decided");
  } finally {
    await S.stop();
  }
});

test("P15c: an edited attendee list must be exactly the peer, and the same card then books the draft's range", async () => {
  const S = await startServer();
  try {
    const p = await friends(S.base);
    const carol = await ownerWithBot(S.base, "carol");
    const cid = (await p.A.bot.startConversation(p.B.bot.id, meetingIntent())).conversation_id;
    const start = inDays(4, 9);
    const end = inDays(4, 10);
    const act: any = await p.A.bot.draftAction(cid, "calendar.book", { title: "Sync", start, end, attendees: [p.B.bot.id] }, "plan");

    await expectRefused(decide(p.A.owner, act.approval_id, { attendees: [p.B.bot.id, carol.bot.id] }), 400, "invalid_request", /attendees must be exactly the peer bot/);
    await assertNothingHappened(S, p, act.action_id, act.approval_id, "third party");

    const ok: any = await decide(p.A.owner, act.approval_id, { attendees: [p.B.bot.id] });
    assert.equal(ok.status, "executed");
    const [mine] = await entries(p.A.owner);
    const [theirs] = await entries(p.B.owner);
    assert.equal(mine.start, new Date(Date.parse(start)).toISOString(), "retry books the draft's own start");
    assert.equal(mine.end, new Date(Date.parse(end)).toISOString(), "retry books the draft's own end");
    assert.equal(theirs.status, "invited", "the peer is invited once");
    assert.equal(theirs.booking_id, mine.booking_id);
  } finally {
    await S.stop();
  }
});

test("P15d: an edited range that ends before it starts is refused and books nothing", async () => {
  const S = await startServer();
  try {
    const p = await friends(S.base);
    const cid = (await p.A.bot.startConversation(p.B.bot.id, meetingIntent())).conversation_id;
    const start = inDays(5, 15);
    const end = inDays(5, 16);
    const act: any = await p.A.bot.draftAction(cid, "calendar.book", { title: "Sync", start, end, attendees: [p.B.bot.id] }, "plan");

    // The draft door refuses the same inversion; the edit door is the only way to reach it.
    await assert.rejects(p.A.bot.draftAction(cid, "calendar.book", { title: "Sync", start: end, end: start }, "plan"), { status: 400, code: "invalid_request" });

    await expectRefused(decide(p.A.owner, act.approval_id, { start: end, end: start }), 400, "invalid_request", /end must be after start/);
    await assertNothingHappened(S, p, act.action_id, act.approval_id, "inverted range");
    assert.equal(countEvents(S, "event.meeting_booked"), 0, "no booking event");
  } finally {
    await S.stop();
  }
});

test("P15e: edited_params must be an object, not a spread string or array", async () => {
  const S = await startServer();
  try {
    const p = await friends(S.base);
    const cid = (await p.A.bot.startConversation(p.B.bot.id, meetingIntent())).conversation_id;
    for (const bad of ["a string", [1, 2]] as unknown[]) {
      const act: any = await p.A.bot.draftAction(cid, "calendar.book", { title: "Sync", start: inDays(6, 9), end: inDays(6, 10), attendees: [p.B.bot.id] }, "plan");
      await expectRefused(decide(p.A.owner, act.approval_id, bad), 400, "invalid_request", /edited_params must be an object/);
      await assertNothingHappened(S, p, act.action_id, act.approval_id, JSON.stringify(bad));
    }
  } finally {
    await S.stop();
  }
});

test("P15f: an edited title the draft door blocks by DLP cannot reach either calendar", async () => {
  const S = await startServer();
  try {
    const p = await friends(S.base);
    const cid = (await p.A.bot.startConversation(p.B.bot.id, meetingIntent())).conversation_id;
    const act: any = await p.A.bot.draftAction(cid, "calendar.book", { title: "Budget sync", start: inDays(7, 10), end: inDays(7, 11), attendees: [p.B.bot.id] }, "plan");
    // The draft door blocks this text (422, no echo of the value); the edit must be blocked the same way.
    await assert.rejects(p.A.bot.draftAction(cid, "calendar.book", { title: "password: hunter2", start: inDays(7, 12), end: inDays(7, 13) }, "plan"), { status: 422, code: "dlp_blocked" });

    const err = await expectRefused(decide(p.A.owner, act.approval_id, { title: "password: hunter2" }), 422, "dlp_blocked", /edited_params blocked by DLP/);
    assert.deepEqual(Object.keys(err.body.error).sort(), ["code", "message"], "the refusal carries no DLP categories");
    await assertNothingHappened(S, p, act.action_id, act.approval_id, "DLP-blocked title");
    assert.ok(!JSON.stringify(await entries(p.B.owner)).includes("hunter2"), "the peer's calendar never sees the blocked value");

    const ok: any = await decide(p.A.owner, act.approval_id, { title: "Budget sync (owner edit)" });
    assert.equal(ok.status, "executed");
    assert.equal((await entries(p.A.owner))[0].title, "Budget sync (owner edit)");
  } finally {
    await S.stop();
  }
});
