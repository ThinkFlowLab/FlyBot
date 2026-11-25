/**
 * P20 — a pending `relationship_request` approval that expires must tell the requesting Bot.
 *
 * The desktop-audit finding: `expireApproval` has a branch for the other five kinds but none for
 * `relationship_request`, and the real-world path never even reaches `expireApproval`. `expireStale` walks the
 * relationships first and flips their pending approvals with one bulk `UPDATE approvals SET status = 'expired'`
 * (no `decided_at`, no `approval.expired` audit, no event); by the time the approval sweep runs, the row is no
 * longer `pending`. The requesting Bot kept sitting in "waiting for my owner to approve" with nothing to read.
 *
 * Fix shape (P20): `expireApproval` gets the `relationship_request` branch and emits to `a.bot_id`, and the
 * relationship loop calls `expireApproval` per pending approval instead of the bulk UPDATE. The relationship row
 * itself is still flipped by `expireStale`, before the approvals, so the event is only delivered once the
 * relationship already reads terminal.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(); });
after(async () => { await S.stop(); });

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const approvalRow = (approvalId: string) => S.platform.db.prepare("SELECT status, kind, subject_id, bot_id, decided_at FROM approvals WHERE id = ?").get(approvalId) as any;
const relationshipRow = (relId: string) => S.platform.db.prepare("SELECT status FROM relationships WHERE id = ?").get(relId) as any;
const expiryEvents = async (bot: any) => (await bot.events()).events.filter((e: any) => e.event_type === "approval.decided" && e.kind === "relationship_request");

describe("an expiring relationship request tells the requesting Bot (P20)", () => {
  test("(a) the relationship sweep expires the approval with one event, a decided_at and a released relationship", async () => {
    const A = await ownerWithBot(S.base, "relreq-a");
    const B = await ownerWithBot(S.base, "relreq-b");
    const req: any = await A.bot.requestFriend(B.handle, "let's be friends");
    assert.equal(req.status, "pending_requester_owner");
    assert.ok(req.approval_id, "a Bot-sent friend request waits on its own owner's approval");

    // Nothing is decided yet: the card is live in the requesting Bot's owner list, and neither Bot was told.
    assert.equal((await expiryEvents(A.bot)).length, 0, "no decision event while the request is live");
    assert.equal((await expiryEvents(B.bot)).length, 0, "the target Bot is never the addressee");
    const pendingBefore = ((await A.owner.req("GET", "/v1/approvals?status=pending")).approvals as any[]).some((c) => c.approval_id === req.approval_id);
    assert.ok(pendingBefore, "the requesting Bot's owner sees the card while it is live");

    // The real-world shape: both rows carry the same TTL, and the relationship row is written 1ms earlier, so the
    // relationship sweep always reaches the row first. Keep that ordering in the past.
    S.platform.db.prepare("UPDATE relationships SET expires_at = ? WHERE id = ?").run(ago(2000), req.relationship_id);
    S.platform.db.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?").run(ago(1000), req.approval_id);
    // Any read runs the platform's stale sweep; that sweep is what must reach the Bot.
    const cards = (await A.owner.req("GET", "/v1/approvals?status=all")).approvals as any[];
    const card = cards.find((c) => c.approval_id === req.approval_id);
    assert.equal(card.status, "expired", "the card left pending as expired");

    // The requesting Bot is told exactly once, with the fields a client can act on.
    const evs = await expiryEvents(A.bot);
    assert.equal(evs.length, 1, "one approval.decided carries the expiry");
    assert.equal(evs[0].decision, "expired");
    assert.equal(evs[0].kind, "relationship_request");
    assert.equal(evs[0].relationship_id, req.relationship_id);
    assert.equal(evs[0].approval_id, req.approval_id);
    assert.equal((await expiryEvents(B.bot)).length, 0, "the target Bot — not the requester — is not the addressee");

    // The audit trail the bulk UPDATE used to skip: a real decision timestamp now exists.
    const row = approvalRow(req.approval_id);
    assert.equal(row.status, "expired");
    assert.equal(row.kind, "relationship_request");
    assert.equal(row.subject_id, req.relationship_id);
    assert.equal(row.bot_id, A.bot.id);
    assert.ok(row.decided_at, "the expired approval records when it was decided");
    assert.equal(relationshipRow(req.relationship_id).status, "expired");
    const pendingAfter = ((await A.owner.req("GET", "/v1/approvals?status=pending")).approvals as any[]).some((c) => c.approval_id === req.approval_id);
    assert.ok(!pendingAfter, "the expired card is gone from pending");
    await assert.rejects(A.owner.req("POST", `/v1/approvals/${req.approval_id}/decision`, { decision: "approved" }),
      (e: any) => e.status === 409 && e.code === "invalid_state" && /expired/.test(e.message));

    // The relationship is terminal, so the Bot can ask again instead of being answered relationship_exists forever.
    const again: any = await A.bot.requestFriend(B.handle, "trying again");
    assert.notEqual(again.relationship_id, req.relationship_id);
    assert.equal(relationshipRow(again.relationship_id).status, "pending_requester_owner");

    // Idempotent: further sweeps do not emit a second expiry for the old card.
    await A.owner.req("GET", "/v1/approvals?status=all");
    await B.owner.req("GET", "/v1/approvals?status=pending");
    assert.equal((await expiryEvents(A.bot)).length, 1, "no duplicate expiry event");
    assert.equal(approvalRow(req.approval_id).status, "expired");
  });

  test("(b) control: a live friend request emits nothing and keeps its pending card", async () => {
    const A = await ownerWithBot(S.base, "relreq-c");
    const B = await ownerWithBot(S.base, "relreq-d");
    const req: any = await A.bot.requestFriend(B.handle, "still waiting");
    assert.equal(approvalRow(req.approval_id).status, "pending");
    assert.equal((await expiryEvents(A.bot)).length, 0, "a live request emits nothing");
    assert.equal((await expiryEvents(B.bot)).length, 0);
    const live = ((await A.owner.req("GET", "/v1/approvals?status=pending")).approvals as any[]).some((c) => c.approval_id === req.approval_id);
    assert.ok(live, "the card is still pending");
    assert.equal(relationshipRow(req.relationship_id).status, "pending_requester_owner");
  });

  test("(c) defensive: an approval that expires before its relationship still tells the requesting Bot", async () => {
    const A = await ownerWithBot(S.base, "relreq-e");
    const B = await ownerWithBot(S.base, "relreq-f");
    const req: any = await A.bot.requestFriend(B.handle, "only the approval expires");
    // Not reachable in production (both rows are written with the same TTL and the relationship row is 1ms older),
    // but this is the path item 1 of the fix — the `expireApproval` branch — exists for. It keeps the branch locked.
    // Read the event list before backdating: `GET /v1/events` itself runs the stale sweep, so asking after the DB
    // change would be a sweep, not a check that nothing has been emitted yet.
    assert.equal((await expiryEvents(A.bot)).length, 0, "no decision event while the request is live");
    S.platform.db.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?").run(ago(1000), req.approval_id);
    await A.owner.req("GET", "/v1/approvals?status=all");

    const row = approvalRow(req.approval_id);
    assert.equal(row.status, "expired");
    assert.ok(row.decided_at, "the approval-only path also stamps decided_at");
    const evs = await expiryEvents(A.bot);
    assert.equal(evs.length, 1, "the requesting Bot hears the expiry");
    assert.equal(evs[0].decision, "expired");
    assert.equal(evs[0].relationship_id, req.relationship_id);
    assert.equal(evs[0].approval_id, req.approval_id);
    assert.equal((await expiryEvents(B.bot)).length, 0, "the target Bot hears nothing");

    // No relationship-row semantics change here: the relationship stays where it was (this path is defensive only).
    assert.equal(relationshipRow(req.relationship_id).status, "pending_requester_owner");
    await A.owner.req("GET", "/v1/approvals?status=all");
    assert.equal((await expiryEvents(A.bot)).length, 1, "no duplicate expiry event");
  });
});
