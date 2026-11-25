/**
 * P19 — a pending `grant_request` approval that expires must tell the requesting Bot.
 *
 * `expireApproval` closed four other kinds (`outbound_message`, `action`, `face_room_message`, `invite`) but had no
 * `grant_request` branch: the sweep flipped the approval row to `expired`, the peer owner's card silently left the
 * pending list, and the Bot that asked for the capability was never told. Same shape as #104's invite, except there
 * the joining side could still see the link; here nothing at all is emitted.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { friends, inDays, ownerWithBot, startServer } from "./helpers.js";

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(); });
after(async () => { await S.stop(); });

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const expireApprovalRow = (approvalId: string) => S.platform.db.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?").run(ago(1000), approvalId);
const approvalRow = (approvalId: string) => S.platform.db.prepare("SELECT status, kind, subject_id, bot_id FROM approvals WHERE id = ?").get(approvalId) as any;
const capGrants = (relId: string, capability: string) => S.platform.db.prepare("SELECT * FROM grants WHERE relationship_id = ? AND capability = ?").all(relId, capability) as any[];
const grantRequestEvents = async (bot: any) => (await bot.events()).events.filter((e: any) => e.event_type === "approval.decided" && e.kind === "grant_request");

const meetingIntent = () => ({ type: "schedule_meeting", summary: "sync", params: { duration_minutes: 30, window: { start: inDays(1, 0), end: inDays(8, 23) } } });

describe("an expiring grant request tells the requesting Bot (P19)", () => {
  test("(a) the sweep expires the card, emits one approval.decided with the exact kind/decision, and grants nothing", async () => {
    const { A, B, relId } = await friends(S.base);
    const cid = (await A.bot.startConversation(B.bot.id, meetingIntent())).conversation_id;
    const req: any = await A.bot.requestGrant(relId, "calendar.freebusy.read", undefined, "share freebusy for planning");
    assert.equal(req.status, "pending_owner_approval");
    assert.equal(capGrants(relId, "calendar.freebusy.read").length, 0, "a pending request grants nothing");

    // The requesting Bot hears nothing yet; the owner's card is the only trace.
    assert.equal((await grantRequestEvents(A.bot)).length, 0, "no decision event before the card expires");
    const pendingBefore = ((await B.owner.req("GET", "/v1/approvals?status=pending")).approvals as any[]).some((c) => c.approval_id === req.approval_id);
    assert.ok(pendingBefore, "the peer owner sees the request while it is live");

    expireApprovalRow(req.approval_id);
    // Any read of the approval list runs the platform's stale sweep; that sweep is what must reach the Bot.
    const cards = (await B.owner.req("GET", "/v1/approvals?status=all")).approvals as any[];
    const card = cards.find((c) => c.approval_id === req.approval_id);
    assert.equal(card.status, "expired", "the card left pending as expired");

    // The requesting Bot is told exactly once, with the fields a client can act on.
    const evs = await grantRequestEvents(A.bot);
    assert.equal(evs.length, 1, "one approval.decided carries the expiry");
    assert.equal(evs[0].decision, "expired");
    assert.equal(evs[0].kind, "grant_request");
    assert.equal(evs[0].relationship_id, relId);
    assert.equal(evs[0].approval_id, req.approval_id);
    assert.equal((await grantRequestEvents(B.bot)).length, 0, "the peer Bot — not the requester — is not the addressee");

    // The approval is over: no second decision, and the capability was never granted.
    const row = approvalRow(req.approval_id);
    assert.equal(row.status, "expired");
    assert.equal(row.kind, "grant_request");
    assert.equal(row.subject_id, relId);
    assert.equal(row.bot_id, A.bot.id);
    const pendingAfter = ((await B.owner.req("GET", "/v1/approvals?status=pending")).approvals as any[]).some((c) => c.approval_id === req.approval_id);
    assert.ok(!pendingAfter, "the expired card is gone from pending");
    await assert.rejects(B.owner.req("POST", `/v1/approvals/${req.approval_id}/decision`, { decision: "approved" }),
      (e: any) => e.status === 409 && e.code === "invalid_state" && /expired/.test(e.message));
    assert.equal(capGrants(relId, "calendar.freebusy.read").length, 0, "the expired request granted no capability");
    await assert.rejects(A.bot.freebusy(cid, ["self", B.bot.id]),
      (e: any) => e.status === 403 && e.code === "capability_not_granted");

    // Idempotent: another sweep does not emit a second expiry.
    await B.owner.req("GET", "/v1/approvals?status=all");
    await B.owner.req("GET", "/v1/approvals?status=pending");
    assert.equal((await grantRequestEvents(A.bot)).length, 1, "no duplicate expiry event");
    assert.equal(approvalRow(req.approval_id).status, "expired");
  });

  test("(b) a live request is not expired early and still ends in a real grant", async () => {
    const { A, B, relId } = await friends(S.base);
    const req: any = await A.bot.requestGrant(relId, "calendar.freebusy.read", { window_days: 14 });
    assert.equal((await grantRequestEvents(A.bot)).length, 0, "a live request emits nothing");
    assert.equal(approvalRow(req.approval_id).status, "pending");

    const decided: any = await B.owner.req("POST", `/v1/approvals/${req.approval_id}/decision`, { decision: "approved" });
    assert.ok(decided.grant_id, "approving a live request still creates the grant");
    assert.equal(capGrants(relId, "calendar.freebusy.read").length, 1);
    assert.equal(approvalRow(req.approval_id).status, "approved");
    const okEvs = await grantRequestEvents(A.bot);
    assert.equal(okEvs.length, 1, "the approved path keeps its own decision event");
    assert.equal(okEvs[0].decision, "approved", "and it is not an expiry");
  });
});
