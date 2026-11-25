/**
 * #266 — a retryable execution failure must not consume the approval.
 *
 * `executeAction`'s `fail()` writes `actions.status='failed'`, the audit row and the `action.failed` event, then
 * returns `{status:"failed", reason}`; `decideApprovalOnce` ignored that result and stamped the card `approved`
 * anyway. Two failures are inherently retryable — `calendar.book`'s `calendar_conflict` (the organizer's calendar
 * is busy at those times) and `calendar.accept_invite`'s `calendar_conflict` (the invitee's) — and both clear the
 * moment the owner moves the conflicting event, which is exactly what `approved_with_edits` exists for. Stamped
 * `approved`, that same card answered the sanctioned retry with `409 invalid_state` and the owner had to ask the
 * Bot for a new draft.
 *
 * These tests pin both sides: the retryable failure leaves the card pending (and the same card then executes with
 * corrected times), while a terminal failure (`invite_not_found`) still consumes it as before.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { friends, inDays, startServer } from "./helpers.js";

const meetingIntent = () => ({ type: "schedule_meeting", summary: "sync", params: { duration_minutes: 60, window: { start: inDays(1, 0), end: inDays(8, 23) } } });

const entries = async (owner: any) => ((await owner.req("GET", "/v1/calendar/entries")) as any).entries as any[];
const actionRow = (S: any, id: string) => S.platform.db.prepare("SELECT status, result FROM actions WHERE id = ?").get(id) as any;
const approvalRow = (S: any, id: string) => S.platform.db.prepare("SELECT status, decision, decided_at FROM approvals WHERE id = ?").get(id) as any;
const pendingHas = async (owner: any, id: string) => ((await owner.req("GET", "/v1/approvals?status=pending")) as any).approvals.some((a: any) => a.approval_id === id);
const countEvents = (S: any, type: string) => (S.platform.db.prepare("SELECT COUNT(*) n FROM events WHERE type = ?").get(type) as any).n;

test("#266a: a booking refused for a busy slot keeps its card, and that same card books a free window", async () => {
  const S = await startServer();
  try {
    const p = await friends(S.base);
    const cid = (await p.A.bot.startConversation(p.B.bot.id, meetingIntent())).conversation_id as string;
    await p.A.owner.req("POST", "/v1/calendar/entries", { start: inDays(2, 10), end: inDays(2, 11), title: "Standup" });
    const draft: any = await p.A.bot.draftAction(cid, "calendar.book", { title: "Sync", start: inDays(2, 10), end: inDays(2, 11), attendees: [p.B.bot.id] }, "plan");

    // The owner says yes, the server finds the times busy: the failure is still reported, and the Bot still learns.
    const failed: any = await p.A.owner.req("POST", `/v1/approvals/${draft.approval_id}/decision`, { decision: "approved" });
    assert.equal(failed.status, "failed", "the decision answer still carries the execution failure");
    assert.equal(failed.reason, "calendar_conflict");
    assert.equal(actionRow(S, draft.action_id).status, "failed", "the action row is written as failed, as today");
    assert.equal(JSON.parse(actionRow(S, draft.action_id).result).error, "calendar_conflict");
    assert.equal(countEvents(S, "action.failed"), 1, "the Bot still gets the action.failed event");

    // The card is the one thing that must not move: it was not spent on a failure the owner can fix.
    const apr = approvalRow(S, draft.approval_id);
    assert.equal(apr.status, "pending", "a retryable failure leaves the approval pending");
    assert.equal(apr.decision, null, "and records no decision");
    assert.equal(apr.decided_at, null, "and no decision time");
    assert.ok(await pendingHas(p.A.owner, draft.approval_id), "the owner still sees the card");
    assert.equal((await entries(p.A.owner)).length, 1, "nothing was booked by the failed attempt");

    // Retry the sanctioned way — the same card, corrected times — and it goes through.
    const ok: any = await p.A.owner.req("POST", `/v1/approvals/${draft.approval_id}/decision`, {
      decision: "approved_with_edits",
      edited_params: { title: "Sync", start: inDays(3, 10), end: inDays(3, 11), attendees: [p.B.bot.id] },
    });
    assert.equal(ok.status, "executed", `the same card executes with a free window: ${JSON.stringify(ok)}`);
    assert.equal(ok.result.invitee_status, "invited");
    assert.equal(ok.result.start, new Date(inDays(3, 10)).toISOString(), "the booking carries the owner's corrected time");
    assert.equal(ok.result.title, "Sync", "one booking, on the retried card");
    assert.equal((await entries(p.A.owner)).length, 2, "the original entry plus the booked meeting");
    assert.equal((await entries(p.B.owner)).length, 1, "and the invitee is on the calendar once");
    assert.equal(approvalRow(S, draft.approval_id).status, "approved", "the card is consumed by the successful retry");
    assert.equal(await pendingHas(p.A.owner, draft.approval_id), false, "and it leaves the pending list");
  } finally {
    await S.stop();
  }
});

test("#266b: an accept refused for a busy slot keeps its card, then executes once the slot is free", async () => {
  const S = await startServer();
  try {
    const p = await friends(S.base);
    const cid = (await p.A.bot.startConversation(p.B.bot.id, meetingIntent())).conversation_id as string;
    const book: any = await p.A.bot.draftAction(cid, "calendar.book", { title: "Sync", start: inDays(2, 10), end: inDays(2, 11), attendees: [p.B.bot.id] }, "plan");
    const booked: any = await p.A.owner.req("POST", `/v1/approvals/${book.approval_id}/decision`, { decision: "approved" });
    const booking_id = booked.result.booking_id;
    assert.equal((await entries(p.B.owner))[0].status, "invited");

    const acc: any = await p.B.bot.draftAction(cid, "calendar.accept_invite", { booking_id }, "accept the invite");
    // The invitee's own calendar already holds that window when the card is decided.
    await p.B.owner.req("POST", "/v1/calendar/entries", { start: inDays(2, 10), end: inDays(2, 11), title: "Clash" });

    const failed: any = await p.B.owner.req("POST", `/v1/approvals/${acc.approval_id}/decision`, { decision: "approved" });
    assert.equal(failed.status, "failed");
    assert.equal(failed.reason, "calendar_conflict");
    assert.equal(actionRow(S, acc.action_id).status, "failed", "the action row records the failure");
    assert.equal(approvalRow(S, acc.approval_id).status, "pending", "the invitee's card is not spent on a busy slot");
    assert.ok(await pendingHas(p.B.owner, acc.approval_id));
    assert.equal((await entries(p.B.owner)).find((e: any) => e.booking_id === booking_id).status, "invited", "the invite survives the failure");

    // The owner moves the conflicting event off that window, then approves the same card again.
    S.platform.db.prepare("DELETE FROM calendar_entries WHERE owner_id = ? AND title = 'Clash'").run(p.B.owner_id);
    const ok: any = await p.B.owner.req("POST", `/v1/approvals/${acc.approval_id}/decision`, { decision: "approved" });
    assert.equal(ok.status, "executed", `the retried card accepts the invite: ${JSON.stringify(ok)}`);
    assert.equal(ok.result.invitee_status, "accepted");
    assert.equal((await entries(p.B.owner)).find((e: any) => e.booking_id === booking_id).status, "confirmed");
    assert.equal(approvalRow(S, acc.approval_id).status, "approved", "the successful retry consumes the card");
  } finally {
    await S.stop();
  }
});

test("#266c: a terminal failure still consumes the card — retrying it stays 409", async () => {
  const S = await startServer();
  try {
    const p = await friends(S.base);
    const cid = (await p.A.bot.startConversation(p.B.bot.id, meetingIntent())).conversation_id as string;
    const book: any = await p.A.bot.draftAction(cid, "calendar.book", { title: "Sync", start: inDays(2, 10), end: inDays(2, 11), attendees: [p.B.bot.id] }, "plan");
    const booked: any = await p.A.owner.req("POST", `/v1/approvals/${book.approval_id}/decision`, { decision: "approved" });
    const booking_id = booked.result.booking_id;
    const acc: any = await p.B.bot.draftAction(cid, "calendar.accept_invite", { booking_id }, "accept the invite");

    // The invite is no longer pending by the time the card is decided: the draft door passed, the write cannot.
    S.platform.db.prepare("UPDATE calendar_entries SET status = 'confirmed' WHERE booking_id = ? AND owner_id = ?").run(booking_id, p.B.owner_id);

    const failed: any = await p.B.owner.req("POST", `/v1/approvals/${acc.approval_id}/decision`, { decision: "approved" });
    assert.equal(failed.status, "failed");
    assert.equal(failed.reason, "invite_not_found");
    assert.equal(actionRow(S, acc.action_id).status, "failed");
    assert.equal(approvalRow(S, acc.approval_id).status, "approved", "a terminal failure is still a decision: the card is consumed");
    assert.equal(await pendingHas(p.B.owner, acc.approval_id), false);

    let err: any = null;
    try {
      await p.B.owner.req("POST", `/v1/approvals/${acc.approval_id}/decision`, { decision: "approved" });
    } catch (e) {
      err = e;
    }
    assert.ok(err, "the spent card cannot be retried");
    assert.equal(err.status, 409);
    assert.equal(err.code, "invalid_state");
    assert.match(err.message, /approval is approved/);
  } finally {
    await S.stop();
  }
});
