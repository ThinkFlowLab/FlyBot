/**
 * A cancellation that cannot write its subject leaves the card half-cancelled.
 *
 * `cancelPendingFor` settles a card and the row it holds as a chain of plain writes with no transaction around them:
 * the card (`status: cancelled`, `decided_at`), then the `approval.cancelled` audit line, then the subject row
 * (`messages` / `actions` / `face_room_drafts` / `invites` / `relationships`), then the event and the outlet notice.
 * When the store refuses the subject write — here a `BEFORE UPDATE` trigger on `messages`, the shape any failed write
 * takes — the card is already `cancelled` while the line it holds still reads `pending_approval`, and the audit line
 * that names the cancellation outlives a settlement that never happened.
 *
 * A cancellation is one write: a rollback must leave the card exactly as it waited (still `pending`, no `decided_at`),
 * its subject untouched, no `approval.cancelled` line, no event and no push — the failure goes to the caller, it is
 * not swallowed into a silent success. The control below proves the door still settles the card and its line together
 * without the refusal, so the fix is a transaction and not a disabled sweep.
 *
 * The last two tests pin the two other kinds a cancel must not strand: an `invite` must not stay at `pending_owner`
 * once its card is gone, and a `relationship_request` must not stay at `pending_requester_owner`. Both are driven
 * through the stop, the door that settles both kinds for a Bot's own cards.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

const PUSH = "https://push.test/cancel-whole";

type S = Awaited<ReturnType<typeof startServer>>;

/** A server whose webhook POSTs are captured instead of sent, so a push is counted, not guessed. */
async function server() {
  const calls: { url: string; body: string }[] = [];
  const fetchImpl = (async (url: string, init: any) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  const s = await startServer({ fetchImpl });
  return { s, calls };
}

const count = (s: S, sql: string, ...args: unknown[]) => (s.platform.db.prepare(sql).get(...args) as any).n as number;
const auditCount = (s: S) => (s.platform.audit.db.prepare("SELECT COUNT(*) n FROM audit_events").get() as any).n as number;

function snap(s: S) {
  return {
    approvals: count(s, "SELECT COUNT(*) n FROM approvals"),
    messages: count(s, "SELECT COUNT(*) n FROM messages"),
    events: count(s, "SELECT COUNT(*) n FROM events"),
    webhook_deliveries: count(s, "SELECT COUNT(*) n FROM webhook_deliveries"),
    audit: auditCount(s),
  };
}

const delta = (after: ReturnType<typeof snap>, before: ReturnType<typeof snap>) => ({
  approvals: after.approvals - before.approvals,
  messages: after.messages - before.messages,
  events: after.events - before.events,
  webhook_deliveries: after.webhook_deliveries - before.webhook_deliveries,
  audit: after.audit - before.audit,
});

const approvalRow = (s: S, id: string) => s.platform.db.prepare("SELECT status, decision, decided_at FROM approvals WHERE id = ?").get(id) as any;
const messageRow = (s: S, id: string) => s.platform.db.prepare("SELECT status FROM messages WHERE id = ?").get(id) as any;
const inviteRow = (s: S, id: string) => s.platform.db.prepare("SELECT status FROM invites WHERE id = ?").get(id) as any;
const relationshipRow = (s: S, id: string) => s.platform.db.prepare("SELECT status FROM relationships WHERE id = ?").get(id) as any;
const cancelledAudits = (s: S, approvalId: string) =>
  (s.platform.audit.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action = 'approval.cancelled' AND subject = ?").get(approvalId) as any).n as number;
const decidedEvents = (s: S, approvalId: string) =>
  count(s, "SELECT COUNT(*) n FROM events WHERE type = 'approval.decided' AND data LIKE ?", `%${approvalId}%`);
const cancelledPushes = (calls: { body: string }[]) =>
  calls.filter((c) => c.body.includes("approval.decided")).length;

/** Two owners whose Bots are friends, the giver's Bot carrying a webhook so a push is counted. */
async function friendsWithPush(s: S) {
  const A = await ownerWithBot(s.base, "canalice", PUSH);
  const B = await ownerWithBot(s.base, "canbob");
  const rel = await A.owner.req("POST", "/v1/relationships", { from_bot_id: A.bot.id, target_handle: B.handle, message: "hi", requested_capabilities: ["chat.public"] });
  await B.owner.req("POST", `/v1/relationships/${rel.relationship_id}/consent`, { decision: "accept", grant_capabilities: [] });
  return { A, B, relId: rel.relationship_id as string };
}

/** The live chat share the grantor's owner gave that Bot — the row whose revoke settles the held line. */
const grantFor = (s: S, grantorOwner: string, granteeBot: string) =>
  s.platform.db.prepare("SELECT id FROM grants WHERE grantor_owner = ? AND grantee_bot = ? AND capability = 'chat.public' AND IFNULL(room_id, '') = '' AND status = 'active' ORDER BY created_at DESC LIMIT 1").get(grantorOwner, granteeBot) as any;

async function heldLine(s: S) {
  const { A, B } = await friendsWithPush(s);
  const conv: any = await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "a cancellation that is refused" });
  const draft: any = await A.bot.draftMessage(conv.conversation_id, { text: "never sent" });
  assert.equal(draft.status, "pending_approval", JSON.stringify(draft));
  const g = grantFor(s, B.owner_id, A.bot.id);
  assert.ok(g, "B's owner shares chat.public with A's Bot when the friendship starts");
  return { A, B, conv, card: draft as { approval_id: string; message_id: string }, g };
}

test("a refused line write leaves the card pending, unannounced and unaudited", async () => {
  const { s, calls } = await server();
  try {
    const { B, card, g } = await heldLine(s);
    await s.platform.flushWebhooks();
    calls.length = 0;

    // Everything before this run succeeds: the card flips first and the audit line is written; only the subject line
    // is refused. The trigger names this one row, so the fixture's own writes keep working.
    s.platform.db.exec(`CREATE TEMP TRIGGER refuse_cancelled_line BEFORE UPDATE ON messages
      WHEN NEW.id = '${card.message_id}' AND NEW.status = 'cancelled'
      BEGIN SELECT RAISE(ABORT, 'store refused the line write'); END`);
    const before = snap(s);
    const auditsBefore = cancelledAudits(s, card.approval_id);

    await assert.rejects(
      B.owner.req("DELETE", `/v1/grants/${g.id}`),
      (e: any) => e.status === 500 && e.code === "internal_error",
      "the store refused the settlement, so the revoke fails rather than answering as if the card had been cancelled",
    );
    await s.platform.flushWebhooks();

    const after = snap(s);
    const row = approvalRow(s, card.approval_id);
    assert.equal(row.status, "pending", "the card is still waiting for a decision: the failed settlement left nothing behind");
    assert.equal(row.decided_at, null, "and it carries no decision time it never reached");
    assert.equal(messageRow(s, card.message_id).status, "pending_approval", "the line is where the card left it: no half of the pair moved");
    assert.equal(cancelledAudits(s, card.approval_id), auditsBefore, "no audit line outlives the rollback");
    assert.deepEqual(delta(after, before), { approvals: 0, messages: 0, events: 0, webhook_deliveries: 0, audit: 0 }, "no row, event, push or audit line outlives the rollback");
    assert.equal(cancelledPushes(calls), 0, "the Bot that owns the card is not told of a cancellation that did not happen");
    assert.doesNotThrow(() => s.platform.audit.verify(), "the audit chain is intact");
  } finally {
    await s.stop();
  }
});

test("without the refusal the same revoke settles the card and its line together", async () => {
  const { s, calls } = await server();
  try {
    const { B, card, g } = await heldLine(s);
    await s.platform.flushWebhooks();
    calls.length = 0;

    await B.owner.req("DELETE", `/v1/grants/${g.id}`);
    await s.platform.flushWebhooks();

    const row = approvalRow(s, card.approval_id);
    assert.equal(row.status, "cancelled", "the card left pending");
    assert.equal(row.decision, "grant_revoked", "with the word the door wrote");
    assert.ok(row.decided_at, "and the moment it was settled");
    assert.equal(messageRow(s, card.message_id).status, "cancelled", "the line died with the card, not before it");
    assert.equal(cancelledAudits(s, card.approval_id), 1, "one audit line names the cancelled card, exactly once");
    assert.equal(decidedEvents(s, card.approval_id), 1, "the Bot that owned the card hears it once");
    assert.equal(cancelledPushes(calls), 1, "and the push naming it leaves once");
    assert.doesNotThrow(() => s.platform.audit.verify(), "the chain records the settlement and verifies");
  } finally {
    await s.stop();
  }
});

test("a stop that cancels an invite leaves the link out of pending_owner", async () => {
  const { s } = await server();
  try {
    const A = await ownerWithBot(s.base, "caninv", PUSH);
    const inv: any = await A.bot.signed("/v1/invites", "invite.create", { offered_capabilities: ["chat.public"] });
    assert.equal(inv.status, "pending_owner", "a Bot-created invite waits on its owner's approval");
    assert.ok(inv.approval_id, "and carries that card");

    await A.owner.req("POST", "/v1/emergency-stop", { bot_id: A.bot.id });
    await s.platform.flushWebhooks();

    assert.equal(approvalRow(s, inv.approval_id).status, "cancelled", "the stop settles the card");
    assert.equal(inviteRow(s, inv.invite_id).status, "expired", "and the link does not stay waiting for a card that is gone");
    assert.equal(cancelledAudits(s, inv.approval_id), 1, "the cancellation is in the chain");
  } finally {
    await s.stop();
  }
});

test("a stop that cancels a friend request leaves the pair out of pending_requester_owner", async () => {
  const { s } = await server();
  try {
    const A = await ownerWithBot(s.base, "canrel", PUSH);
    const B = await ownerWithBot(s.base, "canrelb");
    const req: any = await A.bot.requestFriend(B.handle, "hello");
    assert.equal(req.status, "pending_requester_owner", "a Bot-sent friend request waits on its own owner's approval");
    assert.ok(req.approval_id, "and carries that card");

    await A.owner.req("POST", "/v1/emergency-stop", { bot_id: A.bot.id });
    await s.platform.flushWebhooks();

    assert.equal(approvalRow(s, req.approval_id).status, "cancelled", "the stop settles the card");
    assert.equal(relationshipRow(s, req.relationship_id).status, "expired", "and the pair is not left waiting for a decision that cannot come");
    assert.equal(cancelledAudits(s, req.approval_id), 1, "the cancellation is in the chain");
  } finally {
    await s.stop();
  }
});

test("a refused card write leaves the line behind it untouched", async () => {
  // The other half of the order: a settlement that writes the subject first and the card last would leave a line
  // already cancelled behind a card that still waits. The fix writes the card first, inside one transaction, so the
  // refusal lands before the subject is touched.
  const { s, calls } = await server();
  try {
    const { B, card, g } = await heldLine(s);
    await s.platform.flushWebhooks();
    calls.length = 0;
    s.platform.db.exec(`CREATE TEMP TRIGGER refuse_cancelled_card BEFORE UPDATE ON approvals
      WHEN NEW.id = '${card.approval_id}' AND NEW.status = 'cancelled'
      BEGIN SELECT RAISE(ABORT, 'store refused the card write'); END`);

    await assert.rejects(
      B.owner.req("DELETE", `/v1/grants/${g.id}`),
      (e: any) => e.status === 500 && e.code === "internal_error",
      "the store refused the card, so the revoke fails rather than answering as if the card had been cancelled",
    );
    await s.platform.flushWebhooks();

    assert.equal(approvalRow(s, card.approval_id).status, "pending", "the card is still waiting for a decision");
    assert.equal(messageRow(s, card.message_id).status, "pending_approval", "the line behind it is not cancelled on its own: the pair settles together or not at all");
    assert.equal(cancelledAudits(s, card.approval_id), 0, "no audit line outlives the rollback");
    assert.equal(cancelledPushes(calls), 0, "and nobody is told");
  } finally {
    await s.stop();
  }
});
