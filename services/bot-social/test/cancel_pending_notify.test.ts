/**
 * P22 — ending a relationship must tell the Bot whose pending card it cancels.
 *
 * `cancelPendingFor` supports `opts.notify`, and `conversation_closed` already uses it, but the call in
 * `endRelationship` did not: blocking or revoking a relationship cancelled every pending card hanging off it
 * (drafts in its conversations, grant requests and friend requests whose subject is the relationship) and told
 * none of the Bots that owned them. Same silent cancellation shape as the expiry bugs (#104/#110/#113), with
 * "cancelled" instead of "expired".
 *
 * Reachability of each kind from this call site (where = conversation of the relationship OR subject_id = rel):
 * - outbound_message: conversation_id set → reachable (asserted below).
 * - action: conversation_id set → reachable (same clause).
 * - relationship_request: subject_id is the relationship id → reachable (asserted below).
 * - grant_request: subject_id is the relationship id → reachable (asserted below).
 * - face_room_message: conversation_id is null and its subject is a face_room_draft → not reachable, not faked.
 * - invite: conversation_id is null and its subject is an invite id → not reachable, not faked.
 *
 * For the two request kinds the relationship id lives in subject_id, so the event must carry it as
 * `relationship_id`: otherwise the Bot is told its card was cancelled but not which relationship it was on. The
 * expiry path (`expireApproval`, #113) already sends it, and the same event must not differ by which path fired.
 * (a2)/(a3) pin that field.
 *
 * The control test pins the other direction: `member_revoked` (a Bot whose token is gone) must stay silent, so
 * this fix cannot drift into the revoke/emergency-stop call sites.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { friends, ownerWithBot, startServer } from "./helpers.js";

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(); });
after(async () => { await S.stop(); });

const decidedEvents = async (bot: any) => (await bot.events()).events.filter((e: any) => e.event_type === "approval.decided");
const approvalRow = (id: string) => S.platform.db.prepare("SELECT status, decision, decided_at FROM approvals WHERE id = ?").get(id) as any;

describe("ending a relationship announces its cancelled cards (P22)", () => {
  test("(a) a blocked relationship tells the Bot whose pending draft was cancelled", async () => {
    const { A, B } = await friends(S.base);
    const conv: any = await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "cancel me" });
    const draft: any = await A.bot.draftMessage(conv.conversation_id, { text: "a draft that will be cancelled" });
    assert.equal(draft.status, "pending_approval");

    await B.owner.req("POST", "/v1/blocks", { bot_id: A.bot.id });

    const ev = (await decidedEvents(A.bot)).find((e: any) => e.approval_id === draft.approval_id);
    assert.ok(ev, "the Bot that owned the card hears the cancellation");
    assert.equal(ev.kind, "outbound_message");
    assert.equal(ev.decision, "cancelled");
    assert.equal(ev.reason, "blocked");
    assert.equal(ev.message_id, draft.message_id, "the event names the cancelled message");

    // (c) the card itself is unchanged: cancelled, blocked, with a decision timestamp.
    const card = approvalRow(draft.approval_id);
    assert.equal(card.status, "cancelled");
    assert.equal(card.decision, "blocked");
    assert.ok(card.decided_at, "the cancelled card records when it was cancelled");
  });

  test("(a2) a pending grant request on the relationship is cancelled and told", async () => {
    const { A, B, relId } = await friends(S.base);
    const req: any = await A.bot.requestGrant(relId, "calendar.freebusy.read");
    assert.ok(req.approval_id);

    await B.owner.req("POST", "/v1/blocks", { bot_id: A.bot.id });

    const ev = (await decidedEvents(A.bot)).find((e: any) => e.approval_id === req.approval_id);
    assert.ok(ev, "the requesting Bot hears its card was cancelled");
    assert.equal(ev.kind, "grant_request");
    assert.equal(ev.decision, "cancelled");
    assert.equal(ev.reason, "blocked");
    assert.equal(ev.relationship_id, relId, "the event names the relationship the request was made on");
  });

  test("(a3) a pending friend request on the relationship is cancelled and told", async () => {
    const A = await ownerWithBot(S.base, "cancel-a");
    const B = await ownerWithBot(S.base, "cancel-b");
    const req: any = await A.bot.requestFriend(B.handle, "let's be friends");
    assert.equal(req.status, "pending_requester_owner");

    await B.owner.req("POST", "/v1/blocks", { bot_id: A.bot.id });

    const ev = (await decidedEvents(A.bot)).find((e: any) => e.approval_id === req.approval_id);
    assert.ok(ev, "the requesting Bot hears its friend request was cancelled");
    assert.equal(ev.kind, "relationship_request");
    assert.equal(ev.decision, "cancelled");
    assert.equal(ev.reason, "blocked");
    assert.equal(ev.relationship_id, req.relationship_id, "the event names the relationship the friend request was made on");
  });

  test("(b) control: revoking a home member still cancels its cards silently", async () => {
    const p = S.platform;
    const a = p.onboardFlybot({ display_name: "Alice" });
    const b = p.onboardFlybot({ display_name: "Bob" });
    const A = { kind: "owner" as const, ownerId: a.owner_id };
    const B = { kind: "owner" as const, ownerId: b.owner_id };
    const writer = p.addHomeMember(A, a.home.bot_id, { name: "writer", display_name: "Writer" });
    const coder = p.addHomeMember(B, b.home.bot_id, { name: "coder", display_name: "Coder" });
    const rel = p.requestRelationship(A, { from_bot_id: writer.bot_id, target_bot_id: coder.bot_id, message: "hi" });
    p.consent(B, rel.relationship_id, { decision: "accept", grant_capabilities: [] });
    const sent: any = p.sendAsMember(A, { from_bot_id: writer.bot_id, to: coder.handle, text: "hello" });
    const approval = sent.message.approval_id as string;

    p.removeHomeMember(A, a.home.bot_id, writer.bot_id);

    const evs = p.db.prepare("SELECT COUNT(*) n FROM events WHERE bot_id = ? AND type = 'approval.decided'").get(writer.bot_id) as any;
    assert.equal(evs.n, 0, "member_revoked stays silent: a revoked Bot has no token to read an event");
    const row = approvalRow(approval);
    assert.equal(row.status, "cancelled");
    assert.equal(row.decision, "member_revoked");
  });
});
