/**
 * A consent that is refused settles nothing that belongs to another owner.
 *
 * `Platform.consent` is the fourth door that opened the platform-wide delivery moment before it knew whether the call
 * was its own: `expireStale()` ran before the relationship row was even read, so any owner's token naming an id that
 * does not exist, or one whose target owner is somebody else, settled every lapsed card and request on the instance on
 * the way to its own 404/403 — flipping another owner's card to `expired`, expiring the line it held, moving that
 * owner's chat out of `awaiting_approval`, expiring a friend request that was still waiting, writing
 * `approval.expired`/`relationship.expired`, telling that owner's Bot and pushing its webhook. The same function backs
 * the owner route and the MCP `respond_friend_request` tool.
 *
 * The question "is this request mine to answer" is answered before anything is settled. Once it is answered yes, the
 * delivery moment still happens exactly as before: a consent really given still settles the queue, and a request that
 * lapsed under its own target owner's hand still answers `relationship is expired` instead of being accepted.
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
  /** A request from D's Bot waiting on B's consent, live: the success control accepts this one. */
  incomingId: string;
  posts: any[];
}

/** A and B are friends. C is a third owner with two lapsed pieces: a drafted line to A and a friend request to B. B
 *  also holds a live request from D's Bot, which the success controls answer. C's Bot is its owner's outlet and is
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

  // C is friends with A, so C's Bot may open the chat it drafts into. This acceptance is the first delivery moment the
  // fixture opens; nothing is lapsed yet.
  const rel = await C.owner.req("POST", "/v1/relationships", { from_bot_id: C.bot.id, target_handle: A.handle, message: "hi" });
  await A.owner.req("POST", `/v1/relationships/${rel.relationship_id}/consent`, { decision: "accept" });
  const conv = await C.bot.startConversation(A.bot.id, { type: "general_chat", summary: "third party" });
  const draft: any = await C.bot.draftMessage(conv.conversation_id, { text: "hello" });
  assert.equal(draft.status, "pending_approval", JSON.stringify(draft));
  const pending: any = await C.bot.requestFriend(B.handle, "let us be friends");
  assert.ok(pending.approval_id, JSON.stringify(pending));

  // The live request B can really answer. Its own door opens a delivery moment, so it is written before the deadlines
  // below move: that sweep would otherwise settle C's cards before the call under test runs.
  const D = await ownerWithBot(s.base, "dave");
  const incoming: any = await D.owner.req("POST", "/v1/relationships", { from_bot_id: D.bot.id, target_handle: B.handle, message: "hi" });
  assert.equal(incoming.status, "pending_target", JSON.stringify(incoming));

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
    incomingId: incoming.relationship_id, posts,
  };
}

/** Everything of C's the refused consent must leave alone. */
function assertThirdPartyUntouched(f: Fixture, postsBefore: number) {
  for (const id of [f.card, f.relCard]) {
    const card = f.s.platform.db.prepare("SELECT status, decided_at FROM approvals WHERE id = ?").get(id) as any;
    assert.equal(card.status, "pending", "a refused consent settled another owner's card");
    assert.equal(card.decided_at, null, "a refused consent stamped a decision on another owner's card");
  }
  const message = f.s.platform.db.prepare("SELECT status FROM messages WHERE id = ?").get(f.messageId) as any;
  assert.equal(message.status, "pending_approval", "a refused consent expired another owner's message");
  const conv = f.s.platform.db.prepare("SELECT status, updated_at FROM conversations WHERE id = ?").get(f.convId) as any;
  assert.equal(conv.status, "awaiting_approval", "a refused consent moved another owner's conversation");
  assert.equal(conv.updated_at, f.convUpdatedAt, "a refused consent touched another owner's conversation clock");
  const rel = f.s.platform.db.prepare("SELECT status, updated_at FROM relationships WHERE id = ?").get(f.relId) as any;
  assert.equal(rel.status, "pending_requester_owner", "a refused consent expired another owner's friend request");
  assert.equal(rel.updated_at, f.relUpdatedAt, "a refused consent touched another owner's relationship clock");
  assert.equal(count(f.s.platform.audit.db, "SELECT COUNT(*) n FROM audit_events WHERE action = 'approval.expired'"), 0, "a refused consent wrote an expiry audit line");
  assert.equal(count(f.s.platform.audit.db, "SELECT COUNT(*) n FROM audit_events WHERE action = 'relationship.expired'"), 0, "a refused consent wrote an expired-request audit line");
  assert.equal(count(f.s.platform.db, "SELECT COUNT(*) n FROM events WHERE type = 'approval.decided'"), 0, "a refused consent told another owner's Bot");
  assert.equal(f.posts.length, postsBefore, "a refused consent pushed another owner's webhook");
}

test("a consent that names no request settles nothing of another owner", async (t) => {
  const f = await fixture(t);
  const before = f.posts.length;
  await expectApiError(f.A.owner.req("POST", "/v1/relationships/rel_does_not_exist/consent", { decision: "accept" }), 404, "relationship_not_found");
  await settle();
  assertThirdPartyUntouched(f, before);
});

test("a consent on another owner's request settles nothing of that owner", async (t) => {
  const f = await fixture(t);
  // The request exists and is pending; only its target owner (B) may answer it, so A is refused.
  const before = f.posts.length;
  await expectApiError(f.A.owner.req("POST", `/v1/relationships/${f.relId}/consent`, { decision: "accept" }), 403, "forbidden");
  await settle();
  assertThirdPartyUntouched(f, before);
});

test("a consent really given still settles the queue and still records itself", async (t) => {
  const f = await fixture(t);
  const before = f.posts.length;
  const out: any = await f.B.owner.req("POST", `/v1/relationships/${f.incomingId}/consent`, { decision: "accept", grant_capabilities: ["chat.public"] });
  assert.equal(out.status, "active", JSON.stringify(out));
  assert.ok(out.grants.length > 0, "an accepted friendship keeps its grants");
  await settle();

  // The success path keeps the delivery moment: C's lapsed cards and request are settled exactly as before.
  for (const id of [f.card, f.relCard]) {
    const card = f.s.platform.db.prepare("SELECT status, decided_at FROM approvals WHERE id = ?").get(id) as any;
    assert.equal(card.status, "expired", "a real consent no longer settles the queue");
    assert.ok(card.decided_at, "the settled card records when it was settled");
  }
  assert.equal((f.s.platform.db.prepare("SELECT status FROM messages WHERE id = ?").get(f.messageId) as any).status, "expired", "the lapsed line is expired");
  assert.equal((f.s.platform.db.prepare("SELECT status FROM relationships WHERE id = ?").get(f.relId) as any).status, "expired", "the lapsed request is expired");
  assert.equal(count(f.s.platform.audit.db, "SELECT COUNT(*) n FROM audit_events WHERE action = 'approval.expired'"), 2, "both lapsed cards are audited");
  assert.equal(count(f.s.platform.audit.db, "SELECT COUNT(*) n FROM audit_events WHERE action = 'relationship.expired'"), 1, "the lapsed request is audited");
  assert.equal(count(f.s.platform.db, "SELECT COUNT(*) n FROM events WHERE type = 'approval.decided' AND bot_id = ?", f.C.bot.id), 2, "C's Bot is told about the two cards it waited on");
  assert.ok(f.posts.length > before, "C's outlet still hears the settlement");

  // The expiry keeps its own semantics: the platform is the actor, and the event names the settled card and its subject.
  const expiry = f.s.platform.audit.db.prepare("SELECT actor, data FROM audit_events WHERE action = 'approval.expired' AND subject = ?").get(f.relCard) as any;
  assert.ok(expiry, "the request card's expiry is audited");
  assert.equal(expiry.actor, "platform", "the clock, not the caller, credits the expiry");
  assert.equal(JSON.parse(expiry.data).kind, "relationship_request", "the audit names the card's kind");
  const heard = f.s.platform.db.prepare("SELECT data FROM events WHERE type = 'approval.decided' AND bot_id = ? ORDER BY id ASC").all(f.C.bot.id) as any[];
  const told = heard.map((e) => JSON.parse(e.data));
  assert.ok(told.some((d) => d.approval_id === f.relCard && d.decision === "expired" && d.relationship_id === f.relId), "the lapsed request's Bot hears which relationship ended");
  assert.ok(told.some((d) => d.approval_id === f.card && d.decision === "expired" && d.message_id === f.messageId), "the lapsed draft's Bot hears which line ended");

  // And the consent itself keeps its own record: audit under the target owner, both Bots told the friendship is live.
  const audit = f.s.platform.audit.db.prepare("SELECT actor, action, data FROM audit_events WHERE action = 'relationship.accepted' AND subject = ?").get(f.incomingId) as any;
  assert.ok(audit, "the consent is audited");
  assert.equal(audit.actor, `owner:${f.B.owner_id}`, "the audit names the owner who consented");
  assert.ok(JSON.parse(audit.data).granted_to_requester.length > 0, "the audit names what the requester was granted");
  const changed = f.s.platform.db.prepare("SELECT bot_id, data FROM events WHERE type = 'relationship.changed' AND data LIKE ?").all(`%"${f.incomingId}"%`) as any[];
  assert.equal(changed.length, 2, "both endpoints hear the friendship is live");
  for (const e of changed) {
    const d = JSON.parse(e.data);
    assert.equal(d.status, "active", "the event names the live status");
    assert.equal(d.grants_ready, true, "the event carries the grants already written");
  }
  assert.equal((f.s.platform.db.prepare("SELECT status FROM relationships WHERE id = ?").get(f.incomingId) as any).status, "active", "the request is accepted");
});

test("a request that lapsed under its own target owner's hand answers expired, not accepted", async (t) => {
  const f = await fixture(t);
  // B's own request lapses after the fixture made it; B answering it is the owner's own door, and the sweep it opens
  // must still settle the row before the decision is applied.
  f.s.platform.db.prepare("UPDATE relationships SET expires_at = ? WHERE id = ?").run(past(), f.incomingId);
  const err = await expectApiError(f.B.owner.req("POST", `/v1/relationships/${f.incomingId}/consent`, { decision: "accept" }), 409, "invalid_state");
  assert.match(err.message, /expired/, "the answer names the lapse");
  const rel = f.s.platform.db.prepare("SELECT status FROM relationships WHERE id = ?").get(f.incomingId) as any;
  assert.equal(rel.status, "expired", "a lapsed request is settled, not accepted");
  assert.equal(count(f.s.platform.audit.db, "SELECT COUNT(*) n FROM audit_events WHERE action = 'relationship.accepted' AND subject = ?", f.incomingId), 0, "no acceptance is recorded for a lapsed request");
});
