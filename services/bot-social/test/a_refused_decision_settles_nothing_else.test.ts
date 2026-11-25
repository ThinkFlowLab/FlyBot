/**
 * A decision that is refused settles nothing that belongs to another owner.
 *
 * `decideApprovalOnce` ran the platform-wide sweep before it even read the card: the owner check, the card lookup and
 * the "is this yours" refusal all came after it. Any owner could therefore name an approval id that does not exist, or
 * one that belongs to somebody else, and the platform settled every lapsed card on the instance on the way to its own
 * 404/403 — flipping a third party's card to `expired`, expiring the line it held, moving that owner's chat out of
 * `awaiting_approval`, writing `approval.expired`/`relationship.expired`, telling the Bot and pushing its webhook.
 *
 * The question "may I decide this card" is answered before anything is settled. Once it is answered yes, the delivery
 * moment still happens exactly as before: a decision really made still settles the queue, and a card that lapsed under
 * its own owner's hand still answers `approval is expired` instead of being decided.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { bulkAuth, expectApiError, friends, ownerWithBot, startServer } from "./helpers.js";

type S = Awaited<ReturnType<typeof startServer>>;
const past = () => new Date(Date.now() - 3600e3).toISOString();
const count = (db: any, sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as any).n as number;
const settle = () => new Promise((r) => setTimeout(r, 400));

interface Fixture {
  s: S;
  A: any;
  B: any;
  C: any;
  /** C's drafted line to A, past its deadline: the card, its message and its chat. */
  card: string;
  messageId: string;
  convId: string;
  convUpdatedAt: string;
  /** C's friend request to B, past its deadline: the relationship row and its own card. */
  relId: string;
  relUpdatedAt: string;
  relCard: string;
  /** A's own clean card, decidable by A. */
  ownCard: string;
  /** A's own card that carries a finding, so only an owner login may decide it. */
  heldCard: string;
  posts: any[];
}

/** A and B are friends. C is a third owner with two lapsed pieces: a drafted line to A and a friend request to B.
 *  A also holds a clean card of its own, which the success controls decide. C's Bot is its owner's outlet and is
 *  watched by a local sink. */
async function fixture(t: any): Promise<Fixture> {
  const posts: any[] = [];
  const sink = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => { posts.push(JSON.parse(body)); res.writeHead(200, { "content-type": "application/json" }).end("{}"); });
  });
  await new Promise<void>((r) => sink.listen(0, "127.0.0.1", () => r()));
  const port = (sink.address() as any).port;
  const s = await startServer({ ...bulkAuth, webhooks: { debounceMs: 0 } });
  t.after(async () => { await s.stop(); await new Promise<void>((r) => sink.close(() => r())); });

  const { A, B } = await friends(s.base);
  const C = await ownerWithBot(s.base, "carol", `http://127.0.0.1:${port}/hook`);
  await C.owner.req("PATCH", "/v1/me", { notify_bot_id: C.bot.id });
  // C's owner is asleep: the cards are recorded for the outlet but not announced until the window ends, so a
  // settlement that pushes is visible as a POST rather than folded into an announcement already delivered.
  await C.owner.req("PATCH", "/v1/me", { timezone: "UTC", quiet_start: "00:00", quiet_end: "23:59" });
  const rel = await C.owner.req("POST", "/v1/relationships", { from_bot_id: C.bot.id, target_handle: A.handle, message: "hi" });
  await A.owner.req("POST", `/v1/relationships/${rel.relationship_id}/consent`, { decision: "accept" });
  const conv = await C.bot.startConversation(A.bot.id, { type: "general_chat", summary: "third party" });
  const draft: any = await C.bot.draftMessage(conv.conversation_id, { text: "hello" });
  assert.equal(draft.status, "pending_approval", JSON.stringify(draft));
  const pending: any = await C.bot.requestFriend(B.handle, "let us be friends");
  assert.ok(pending.approval_id, JSON.stringify(pending));

  // A's own card: a clean line to B, nothing to refuse.
  const ownConv = await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "mine" });
  const own: any = await A.bot.draftMessage(ownConv.conversation_id, { text: "hi bob" });
  assert.equal(own.status, "pending_approval", JSON.stringify(own));
  // A's own card that carries a finding. Written before the deadlines below move: creating a card opens its own
  // delivery moment, and that sweep would settle C's cards before the call under test ever ran.
  await A.owner.req("PATCH", "/v1/me", { sensitive_terms: ["swordfish"] });
  const heldConv = await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "held" });
  const held: any = await A.bot.draftMessage(heldConv.conversation_id, { text: "swordfish notes" });
  assert.equal(held.status, "pending_approval", JSON.stringify(held));
  assert.equal(
    (s.platform.db.prepare("SELECT hold_reason FROM approvals WHERE id = ?").get(held.approval_id) as any).hold_reason,
    "risk", "the held card carries the finding that makes it the owner's",
  );

  // Let every announcement land, then move only the deadlines: the sink baseline includes the announcements.
  await settle();
  for (const id of [draft.approval_id, pending.approval_id]) {
    s.platform.db.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?").run(past(), id);
  }
  s.platform.db.prepare("UPDATE relationships SET expires_at = ? WHERE id = ?").run(past(), pending.relationship_id);
  const convRow = s.platform.db.prepare("SELECT updated_at FROM conversations WHERE id = ?").get(conv.conversation_id) as any;
  const relRow = s.platform.db.prepare("SELECT updated_at FROM relationships WHERE id = ?").get(pending.relationship_id) as any;
  return {
    s, A, B, C,
    card: draft.approval_id, messageId: draft.message_id, convId: conv.conversation_id, convUpdatedAt: convRow.updated_at,
    relId: pending.relationship_id, relUpdatedAt: relRow.updated_at, relCard: pending.approval_id,
    ownCard: own.approval_id, heldCard: held.approval_id, posts,
  };
}

/** Everything of C's the refused decision must leave alone. */
function assertThirdPartyUntouched(f: Fixture, postsBefore: number) {
  for (const id of [f.card, f.relCard]) {
    const card = f.s.platform.db.prepare("SELECT status, decided_at FROM approvals WHERE id = ?").get(id) as any;
    assert.equal(card.status, "pending", "a refused decision settled another owner's card");
    assert.equal(card.decided_at, null, "a refused decision stamped a decision on another owner's card");
  }
  const message = f.s.platform.db.prepare("SELECT status FROM messages WHERE id = ?").get(f.messageId) as any;
  assert.equal(message.status, "pending_approval", "a refused decision expired another owner's message");
  const conv = f.s.platform.db.prepare("SELECT status, updated_at FROM conversations WHERE id = ?").get(f.convId) as any;
  assert.equal(conv.status, "awaiting_approval", "a refused decision moved another owner's conversation");
  assert.equal(conv.updated_at, f.convUpdatedAt, "a refused decision touched another owner's conversation clock");
  const rel = f.s.platform.db.prepare("SELECT status, updated_at FROM relationships WHERE id = ?").get(f.relId) as any;
  assert.equal(rel.status, "pending_requester_owner", "a refused decision expired another owner's friend request");
  assert.equal(rel.updated_at, f.relUpdatedAt, "a refused decision touched another owner's relationship clock");
  assert.equal(count(f.s.platform.audit.db, "SELECT COUNT(*) n FROM audit_events WHERE action = 'approval.expired'"), 0, "a refused decision wrote an expiry audit line");
  assert.equal(count(f.s.platform.audit.db, "SELECT COUNT(*) n FROM audit_events WHERE action = 'relationship.expired'"), 0, "a refused decision wrote an expired-request audit line");
  assert.equal(count(f.s.platform.db, "SELECT COUNT(*) n FROM events WHERE type = 'approval.decided'"), 0, "a refused decision told another owner's Bot");
  assert.equal(f.posts.length, postsBefore, "a refused decision pushed another owner's webhook");
}

test("a decision on an approval that does not exist settles nothing of another owner", async (t) => {
  const f = await fixture(t);
  const before = f.posts.length;
  await expectApiError(f.A.owner.req("POST", "/v1/approvals/apr_does_not_exist/decision", { decision: "approved" }), 404, "approval_not_found");
  await settle();
  assertThirdPartyUntouched(f, before);
});

test("a decision on another owner's card settles nothing of that owner", async (t) => {
  const f = await fixture(t);
  const before = f.posts.length;
  await expectApiError(f.A.owner.req("POST", `/v1/approvals/${f.card}/decision`, { decision: "approved" }), 403, "forbidden");
  await settle();
  assertThirdPartyUntouched(f, before);
});

test("a connector's refusal settles nothing of another owner", async (t) => {
  const f = await fixture(t);
  // The card under test is A's own and carries a finding: a connector token may not decide it.
  // The REST route refuses connector tokens on this route, so the principal is minted directly; the sweep under test
  // lives inside `decideApprovalOnce`, after this point.
  const connector = f.s.platform.authenticate(f.s.platform.createConnectorToken({ kind: "owner", ownerId: f.A.owner_id }, { label: "test" }).token);
  const before = f.posts.length;
  await assert.rejects(
    async () => f.s.platform.decideApproval(connector, f.heldCard, { decision: "approved" }),
    (e: any) => e.status === 403 && e.code === "owner_must_decide",
  );
  await settle();
  assertThirdPartyUntouched(f, before);
});

test("a decision really made still settles the queue and still records itself", async (t) => {
  const f = await fixture(t);
  const before = f.posts.length;
  const out: any = await f.A.owner.req("POST", `/v1/approvals/${f.ownCard}/decision`, { decision: "approved" });
  assert.equal(out.decision, "approved", JSON.stringify(out));
  await settle();

  // The success path keeps the delivery moment: C's lapsed cards are settled exactly as before.
  for (const id of [f.card, f.relCard]) {
    const card = f.s.platform.db.prepare("SELECT status, decided_at FROM approvals WHERE id = ?").get(id) as any;
    assert.equal(card.status, "expired", "a real decision no longer settles the queue");
    assert.ok(card.decided_at, "the settled card records when it was settled");
  }
  assert.equal((f.s.platform.db.prepare("SELECT status FROM messages WHERE id = ?").get(f.messageId) as any).status, "expired", "the lapsed line is expired");
  assert.equal((f.s.platform.db.prepare("SELECT status FROM relationships WHERE id = ?").get(f.relId) as any).status, "expired", "the lapsed request is expired");
  assert.equal(count(f.s.platform.audit.db, "SELECT COUNT(*) n FROM audit_events WHERE action = 'approval.expired'"), 2, "both lapsed cards are audited");
  assert.equal(count(f.s.platform.audit.db, "SELECT COUNT(*) n FROM audit_events WHERE action = 'relationship.expired'"), 1, "the lapsed request is audited");
  assert.equal(count(f.s.platform.db, "SELECT COUNT(*) n FROM events WHERE type = 'approval.decided' AND bot_id = ?", f.C.bot.id), 2, "C's Bot is told about the two cards it waited on");
  assert.ok(f.posts.length > before, "C's outlet still hears the settlement");

  // And the decision itself keeps its own record: audit under the owner, event to the card's Bot, chat refreshed.
  const audit = f.s.platform.audit.db.prepare("SELECT actor, action, subject, data FROM audit_events WHERE action = 'approval.decided' AND subject = ?").get(f.ownCard) as any;
  assert.ok(audit, "the decision is audited");
  assert.equal(audit.actor, `owner:${f.A.owner_id}`, "the audit names the owner");
  assert.equal(JSON.parse(audit.data).decision, "approved", "the audit names the decision");
  const ev = f.s.platform.db.prepare("SELECT data FROM events WHERE type = 'approval.decided' AND bot_id = ? ORDER BY id DESC LIMIT 1").get(f.A.bot.id) as any;
  assert.ok(ev, "the card's Bot is told");
  assert.equal(JSON.parse(ev.data).approval_id, f.ownCard, "the event names the card");
  assert.equal(JSON.parse(ev.data).decision, "approved", "the event names the decision");
  assert.equal((f.s.platform.db.prepare("SELECT status FROM approvals WHERE id = ?").get(f.ownCard) as any).status, "approved", "the card is decided");
});

test("a card that lapsed under its own owner's hand answers expired, not decided", async (t) => {
  const f = await fixture(t);
  f.s.platform.db.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?").run(past(), f.ownCard);
  await expectApiError(f.A.owner.req("POST", `/v1/approvals/${f.ownCard}/decision`, { decision: "approved" }), 409, "invalid_state");
  const card = f.s.platform.db.prepare("SELECT status, decision FROM approvals WHERE id = ?").get(f.ownCard) as any;
  assert.equal(card.status, "expired", "a lapsed card is settled, not decided");
  assert.equal(card.decision, null, "no decision is written on a lapsed card");
});
