/**
 * A refused write settles nothing that belongs to another owner.
 *
 * Every door that writes an approval card opens a delivery moment: the cards past their deadline are settled first, so
 * the announcement and the digest never name a card its owner can no longer decide. Three doors ran the platform-wide
 * sweep before their own refusal checks, so a call that was refused -- a duplicate friend request, an unknown or spent
 * invite code, a draft into a chat that has ended -- still flipped another owner's lapsed card, wrote its
 * `approval.expired` line, moved its conversation out of `awaiting_approval` and pushed that owner's webhook.
 *
 * The freshness those checks need is local: the two Bots in front of the door (so a timed-out request does not keep
 * answering `relationship_exists`) and, for a join, the lapsed joins the link is still counting (so a one-use link is
 * not read as spent while no friendship exists). Both must stay settled; neither justifies settling the platform.
 *
 * The last case is the control: the same door, once it really writes a card, still opens the delivery moment and still
 * settles the queue.
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
  card: string;
  messageId: string;
  convId: string;
  convUpdatedAt: string;
  posts: any[];
}

/** A and B are friends; C is a third owner whose Bot drafted a line, so C's owner has a card, and it is past its
 *  deadline. C's Bot is also the owner's designated outlet, watched by a local sink. */
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
  const rel = await C.owner.req("POST", "/v1/relationships", { from_bot_id: C.bot.id, target_handle: A.handle, message: "hi" });
  await A.owner.req("POST", `/v1/relationships/${rel.relationship_id}/consent`, { decision: "accept" });
  const conv = await C.bot.startConversation(A.bot.id, { type: "general_chat", summary: "third party" });
  const draft: any = await C.bot.signed(`/v1/conversations/${conv.conversation_id}/messages`, "message.draft", { text: "hello" }, { conversation_id: conv.conversation_id });
  assert.equal(draft.status, "pending_approval", JSON.stringify(draft));
  // Let the card's own announcement land, then move only the deadline: the sink baseline includes the announcement.
  await settle();
  s.platform.db.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?").run(past(), draft.approval_id);
  const convRow = s.platform.db.prepare("SELECT updated_at FROM conversations WHERE id = ?").get(conv.conversation_id) as any;
  return { s, A, B, C, card: draft.approval_id, messageId: draft.message_id, convId: conv.conversation_id, convUpdatedAt: convRow.updated_at, posts };
}

/** Everything of C's the refused call must leave alone. */
function assertThirdPartyUntouched(f: Fixture, postsBefore: number) {
  const card = f.s.platform.db.prepare("SELECT status, decided_at FROM approvals WHERE id = ?").get(f.card) as any;
  assert.equal(card.status, "pending", "a refused write settled another owner's card");
  assert.equal(card.decided_at, null, "a refused write stamped a decision on another owner's card");
  const message = f.s.platform.db.prepare("SELECT status FROM messages WHERE id = ?").get(f.messageId) as any;
  assert.equal(message.status, "pending_approval", "a refused write expired another owner's message");
  const conv = f.s.platform.db.prepare("SELECT status, updated_at FROM conversations WHERE id = ?").get(f.convId) as any;
  assert.equal(conv.status, "awaiting_approval", "a refused write moved another owner's conversation");
  assert.equal(conv.updated_at, f.convUpdatedAt, "a refused write touched another owner's conversation clock");
  assert.equal(count(f.s.platform.audit.db, "SELECT COUNT(*) n FROM audit_events WHERE action = 'approval.expired'"), 0, "a refused write wrote an expiry audit line");
  assert.equal(count(f.s.platform.db, "SELECT COUNT(*) n FROM events WHERE type = 'approval.decided' AND bot_id = ?", f.C.bot.id), 0, "a refused write told another owner's Bot");
  assert.equal(f.posts.length, postsBefore, "a refused write pushed another owner's webhook");
}

test("a duplicate friend request settles nothing of a third owner, and still settles its own pair", async (t) => {
  const f = await fixture(t);
  const postsBefore = f.posts.length;

  // A and B are already friends, so the same request again is refused with the duplicate answer.
  await expectApiError(f.A.owner.req("POST", "/v1/relationships", { from_bot_id: f.A.bot.id, target_handle: f.B.handle, message: "hi" }), 409, "relationship_exists");
  await settle();
  assertThirdPartyUntouched(f, postsBefore);

  // The door's own pair is the one thing it must see fresh: a request that timed out must not keep answering 409.
  const D = await ownerWithBot(f.s.base, "dave");
  const first: any = await f.A.owner.req("POST", "/v1/relationships", { from_bot_id: f.A.bot.id, target_handle: D.handle, message: "hi" });
  assert.equal(first.status, "pending_target", JSON.stringify(first));
  f.s.platform.db.prepare("UPDATE relationships SET expires_at = ? WHERE id = ?").run(past(), first.relationship_id);
  const again: any = await f.A.owner.req("POST", "/v1/relationships", { from_bot_id: f.A.bot.id, target_handle: D.handle, message: "hi" });
  assert.equal(again.status, "pending_target", "a lapsed request between the pair still settles before the duplicate check");
  assert.equal((f.s.platform.db.prepare("SELECT status FROM relationships WHERE id = ?").get(first.relationship_id) as any).status, "expired");
});

test("a refused join settles nothing of a third owner, whether the code is unknown or spent", async (t) => {
  const f = await fixture(t);
  const postsBefore = f.posts.length;

  // (a) an unknown code: refused before anything of the link is read.
  await expectApiError(f.A.bot.signed("/v1/invites/nosuchcode/join", "invite.join", { code: "nosuchcode" }), 404, "invite_not_found");
  await settle();
  assertThirdPartyUntouched(f, postsBefore);

  // (b) a one-use link already spent: refused with the link's own status, and still nothing of a third owner.
  const one: any = await f.A.owner.req("POST", "/v1/invites", { bot_id: f.A.bot.id, max_uses: 1, auto_accept: false });
  f.s.platform.db.prepare("UPDATE invites SET uses = max_uses WHERE id = ?").run(one.invite_id);
  const D = await ownerWithBot(f.s.base, "dave");
  const before410 = f.posts.length;
  await expectApiError(D.owner.req("POST", `/v1/invites/${one.code}/join`, { from_bot_id: D.bot.id }), 410, "invite_unavailable");
  await settle();
  assertThirdPartyUntouched(f, before410);
});

test("a lapsed join still gives its link its use back", async (t) => {
  const f = await fixture(t);
  const one: any = await f.A.owner.req("POST", "/v1/invites", { bot_id: f.A.bot.id, max_uses: 1, auto_accept: false });
  const D = await ownerWithBot(f.s.base, "dave");
  const joined: any = await D.owner.req("POST", `/v1/invites/${one.code}/join`, { from_bot_id: D.bot.id });
  assert.equal(joined.status, "pending_target", JSON.stringify(joined));
  f.s.platform.db.prepare("UPDATE relationships SET expires_at = ? WHERE id = ?").run(past(), joined.relationship_id);

  // The lapsed join spent the link's only use; the next join must not read it as gone.
  const E = await ownerWithBot(f.s.base, "erin");
  const again: any = await E.owner.req("POST", `/v1/invites/${one.code}/join`, { from_bot_id: E.bot.id });
  assert.equal(again.status, "pending_target", "a lapsed join still gives the link its use back");
});

test("a draft refused because the chat has ended settles nothing of a third owner", async (t) => {
  const f = await fixture(t);
  const conv: any = await f.A.bot.startConversation(f.B.bot.id, { type: "general_chat", summary: "ended" });
  f.s.platform.db.prepare("UPDATE conversations SET status = 'closed', outcome = 'done' WHERE id = ?").run(conv.conversation_id);
  const postsBefore = f.posts.length;

  await expectApiError(f.A.bot.signed(`/v1/conversations/${conv.conversation_id}/messages`, "message.draft", { text: "hello" }, { conversation_id: conv.conversation_id }), 409, "conversation_closed");
  await settle();
  assertThirdPartyUntouched(f, postsBefore);
});

test("the same draft, once it writes a card, still settles the queue (control)", async (t) => {
  const f = await fixture(t);
  const conv: any = await f.A.bot.startConversation(f.B.bot.id, { type: "general_chat", summary: "control" });
  const postsBefore = f.posts.length;

  const drafted: any = await f.A.bot.signed(`/v1/conversations/${conv.conversation_id}/messages`, "message.draft", { text: "hello" }, { conversation_id: conv.conversation_id });
  assert.equal(drafted.status, "pending_approval", JSON.stringify(drafted));
  const card = f.s.platform.db.prepare("SELECT status, decided_at FROM approvals WHERE id = ?").get(f.card) as any;
  assert.equal(card.status, "expired", "a door that writes a card still opens the delivery moment");
  assert.ok(card.decided_at, "settled with the instant it happened");
  assert.equal(count(f.s.platform.audit.db, "SELECT COUNT(*) n FROM audit_events WHERE action = 'approval.expired'"), 1, "the expiry is on the audit chain");
  await settle();
  const heard = f.posts.slice(postsBefore).some((p) => p.bot?.bot_id === f.C.bot.id && (p.items ?? []).some((i: any) => i.type === "approval.decided"));
  assert.ok(heard, "the other owner's outlet heard the settlement");
});
