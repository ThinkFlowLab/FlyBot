/**
 * A stopped Bot is not a place to start a share.
 *
 * `grantBotToFriend` is the one owner-side door that writes a Bot share without asking `assertInvitable`. Every other
 * door that hands reach out answers a stopped identity with `403 bot_frozen` and a removed one with `403 bot_revoked`
 * (`test/home_send_frozen.test.ts` states the rule as "every other owner-side door says so with `bot_frozen`"), and
 * this door's own docstring says it writes "the same per-Bot full share that accepting an invite would" -- while the
 * invite path checks both ends. Here it answered 201 and wrote the share anyway, and, when the friend was named only
 * by owner, it first opened a fresh `active` relationship row towards the peer's Bot: a Bot under an emergency stop
 * collected a new live pairing. The card that route is about is the same one the invite door refuses.
 *
 * The state after the stop matters too. A share written before a freeze was never rescinded, so nothing in the
 * platform asks anyone to approve it again when the Bot is resumed; the last case pins that the row that was there
 * before the stop is byte for byte the row that answers afterwards, and that the friend's side never sees a second
 * request.
 *
 * The refusals are cut the way the rest of this family is (`test/a_refused_grant_settles_nothing_else.test.ts`,
 * `test/an_idempotent_grant_settles_nothing_else.test.ts`): an answer that writes nothing writes nothing at all -- no
 * `grants` row, no `relationships` row, no `approvals` row, no audit line, no event at either end. This door also
 * settles the platform's lapsed cards when it writes, so every refusal here is checked against a third owner's card
 * past its deadline: the card stays `pending`, its `approval.expired` line is never written, its Bot is never told,
 * and the `pending_owner` invite the card is holding still stands.
 *
 * A stop outranks the door's own idempotent answer: a share that is already live is answered `idempotent: true` -- and
 * that answer writes nothing, so this door's refusal to act for a stopped Bot must come before it. The case
 * "a stopped Bot's own live share is refused, not answered" pins that a frozen Bot's repeat is a 403, never a 201.
 *
 * The controls are the same door once it really writes a share -- the delivery moment is moved, not deleted: an active
 * peer is still granted, and the queue is still settled by that call.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { generateEd25519 } from "../src/crypto.js";
import { bulkAuth, expectApiError, friends, ownerWithBot, startServer } from "./helpers.js";

type S = Awaited<ReturnType<typeof startServer>>;
const past = () => new Date(Date.now() - 3600e3).toISOString();
const count = (db: any, sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as any).n as number;

const post = async (base: string, path: string, token: string, body: unknown) => {
  const r = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as any };
};

/** Everything a refused share must not move: rows, audit chain, events at either end. */
function snapshot(s: S) {
  const db = s.platform.db;
  return {
    grants: count(db, "SELECT COUNT(*) n FROM grants"),
    relationships: count(db, "SELECT COUNT(*) n FROM relationships"),
    approvals: count(db, "SELECT COUNT(*) n FROM approvals"),
    audit: count(s.platform.audit.db, "SELECT COUNT(*) n FROM audit_events"),
    events: count(db, "SELECT COUNT(*) n FROM events"),
  };
}

/** A second Bot of the same owner: no relationship of its own, so the unnamed-owner path has to open one. */
async function addBot(owner: any, handle: string) {
  const kp = generateEd25519();
  const bot: any = await owner.req("POST", "/v1/bots", { handle: `${handle}.bot`, public_key: { alg: "Ed25519", kid: "k1", value: kp.publicKey } });
  assert.ok(bot.bot_id, JSON.stringify(bot));
  return bot;
}

/** Take the live share the accepted friendship wrote away, so the door under test would really write. */
async function dropShares(owner: any, botId: string) {
  const listed: any = await owner.req("GET", `/v1/bots/${botId}/grants`);
  for (const g of listed.grants) await owner.req("DELETE", `/v1/bots/${botId}/grants/${g.grant_id}`);
}

/** A third owner whose Bot minted an `auto_accept: false` invite: a card waits at `pending_owner` behind it, and the
 *  card is past its deadline. Any platform-wide sweep shows on it, so a call that must write nothing is checked here. */
async function plantLapsedCard(s: S, name: string) {
  const C = await ownerWithBot(s.base, name);
  const minted: any = await C.bot.signed("/v1/invites", "invite.create", { auto_accept: false });
  assert.equal(minted.status, "pending_owner", JSON.stringify(minted));
  assert.ok(minted.approval_id, "a Bot-created invite waits behind a card");
  s.platform.db.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?").run(past(), minted.approval_id);
  return { owner: C.owner, bot: C.bot, card: minted.approval_id, invite: minted.invite_id };
}

/** Everything of the third owner's the refused call must leave alone: the card, the link behind it, the audit chain,
 *  and the Bot that is never told. */
function assertThirdPartyUntouched(s: S, p: { bot: any; card: string; invite: string }) {
  const card = s.platform.db.prepare("SELECT status, decided_at FROM approvals WHERE id = ?").get(p.card) as any;
  assert.equal(card.status, "pending", "a refused share settled another owner's card");
  assert.equal(card.decided_at, null, "a refused share stamped a decision on another owner's card");
  const invite = s.platform.db.prepare("SELECT status FROM invites WHERE id = ?").get(p.invite) as any;
  assert.equal(invite.status, "pending_owner", "a refused share expired another owner's invite link");
  assert.equal(count(s.platform.audit.db, "SELECT COUNT(*) n FROM audit_events WHERE action = 'approval.expired'"), 0, "a refused share wrote an expiry audit line");
  assert.equal(count(s.platform.db, "SELECT COUNT(*) n FROM events WHERE type = 'approval.decided' AND bot_id = ?", p.bot.id), 0, "a refused share told another owner's Bot");
}

/** The same third owner's card, once the door really writes a share: the delivery moment is moved, not deleted. */
function assertThirdPartySettled(s: S, p: { bot: any; card: string; invite: string }) {
  const card = s.platform.db.prepare("SELECT status, decided_at FROM approvals WHERE id = ?").get(p.card) as any;
  assert.equal(card.status, "expired", "a door that writes a share still opens the delivery moment");
  assert.ok(card.decided_at, "settled with the instant it happened");
  const invite = s.platform.db.prepare("SELECT status FROM invites WHERE id = ?").get(p.invite) as any;
  assert.equal(invite.status, "expired", "a lapsed card's link ends with it");
  assert.equal(count(s.platform.audit.db, "SELECT COUNT(*) n FROM audit_events WHERE action = 'approval.expired'"), 1, "the expiry is on the audit chain");
  assert.equal(count(s.platform.db, "SELECT COUNT(*) n FROM events WHERE type = 'approval.decided' AND bot_id = ?", p.bot.id), 1, "the other owner's Bot heard the settlement");
}

test("a share from a stopped Bot is refused with the stop, and writes nothing", async (t) => {
  const s = await startServer({ ...bulkAuth });
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  await dropShares(A.owner, A.bot.id);
  const third = await plantLapsedCard(s, "carol");
  const stopped = await A.owner.req("POST", "/v1/emergency-stop", { bot_id: A.bot.id });
  assert.equal(stopped.status, "frozen");
  const before = snapshot(s);
  const err = await expectApiError(A.owner.req("POST", `/v1/bots/${A.bot.id}/grants`, { friend_bot_id: B.bot.id }), 403, "bot_frozen");
  assert.equal(err.body.error.message, "this bot is frozen (emergency stop)", "a stop is resumable, so it names the stop, not a removal");
  assert.deepEqual(snapshot(s), before, "a share held back by the stop wrote nothing at all");
  assertThirdPartyUntouched(s, third);
});

test("a stopped Bot's own live share is refused, not answered", async (t) => {
  const s = await startServer({ ...bulkAuth });
  t.after(s.stop);
  const { A, B, relId } = await friends(s.base);
  // The accepted friendship already wrote the full share, so the call below is the door's idempotent answer: it writes
  // nothing. A stop must still be the answer -- the kill switch is not undone by a retry.
  const before = s.platform.db.prepare(
    "SELECT id, capability, status FROM grants WHERE relationship_id = ? AND grantor_owner = ? ORDER BY capability, id",
  ).all(relId, A.owner_id) as any[];
  assert.ok(before.some((g) => g.status === "active"), "the fixture has a live share to repeat");
  const third = await plantLapsedCard(s, "carol");
  const stopped = await A.owner.req("POST", "/v1/emergency-stop", { bot_id: A.bot.id });
  assert.equal(stopped.status, "frozen");
  const snap = snapshot(s);
  const again = await post(s.base, `/v1/bots/${A.bot.id}/grants`, A.owner.token, { friend_bot_id: B.bot.id });
  assert.equal(again.status, 403, JSON.stringify(again.body));
  assert.equal(again.body.error?.code, "bot_frozen", "a frozen Bot's repeat is the stop's answer, not `idempotent: true`");
  assert.equal(again.body.error?.message, "this bot is frozen (emergency stop)");
  assert.equal(again.body.idempotent, undefined, "the door did not answer the live share");
  assert.deepEqual(snapshot(s), snap, "the stopped repeat wrote nothing");
  assertThirdPartyUntouched(s, third);
});

test("a share from a removed Bot is refused with the removal, and writes nothing", async (t) => {
  const s = await startServer({ ...bulkAuth });
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  await dropShares(A.owner, A.bot.id);
  // Removal has no standalone door for a Bot that never joined a home; `removeHomeMember` leaves this same state, and
  // the other doors' tests set it the same way (`test/frozen_bot_cannot_rewrite_its_profile.test.ts`).
  s.platform.db.prepare("UPDATE bots SET status = 'revoked' WHERE id = ?").run(A.bot.id);
  const third = await plantLapsedCard(s, "carol");
  const before = snapshot(s);
  const err = await expectApiError(A.owner.req("POST", `/v1/bots/${A.bot.id}/grants`, { friend_bot_id: B.bot.id }), 403, "bot_revoked");
  assert.equal(err.body.error.message, "this bot identity was revoked", "a removed identity is gone for good");
  assert.deepEqual(snapshot(s), before, "a share from a removed Bot wrote nothing at all");
  assertThirdPartyUntouched(s, third);
});

test("a share aimed at a stopped or removed friend Bot is refused on both ways of naming it", async (t) => {
  const s = await startServer({ ...bulkAuth });
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  await dropShares(A.owner, A.bot.id);
  const second = await addBot(A.owner, "aliceextra");

  const stopped = await B.owner.req("POST", "/v1/emergency-stop", { bot_id: B.bot.id });
  assert.equal(stopped.status, "frozen");
  const third = await plantLapsedCard(s, "carol");
  const before = snapshot(s);
  // Named by Bot: an active friendship with that Bot, and no live share of it, so this call would write the bundle.
  const named = await expectApiError(A.owner.req("POST", `/v1/bots/${A.bot.id}/grants`, { friend_bot_id: B.bot.id }), 403, "bot_frozen");
  assert.equal(named.body.error.message, "this bot is frozen (emergency stop)");
  // Named only by owner: the derived path used to open the `active` relationship row before it wrote anything.
  const derived = await expectApiError(A.owner.req("POST", `/v1/bots/${second.bot_id}/grants`, { friend_owner_id: B.owner_id }), 403, "bot_frozen");
  assert.equal(derived.body.error.message, "this bot is frozen (emergency stop)");
  assert.equal(count(s.platform.db, "SELECT COUNT(*) n FROM relationships WHERE requester_bot = ? OR target_bot = ?", second.bot_id, second.bot_id), 0,
    "a share aimed at a stopped Bot opened no relationship row");
  assert.deepEqual(snapshot(s), before, "a share aimed at a stopped friend Bot wrote nothing at all");
  assertThirdPartyUntouched(s, third);

  const thirdGone = third;
  s.platform.db.prepare("UPDATE bots SET status = 'revoked' WHERE id = ?").run(B.bot.id);
  const beforeGone = snapshot(s);
  const namedGone = await expectApiError(A.owner.req("POST", `/v1/bots/${A.bot.id}/grants`, { friend_bot_id: B.bot.id }), 403, "bot_revoked");
  assert.equal(namedGone.body.error.message, "this bot identity was revoked");
  const derivedGone = await expectApiError(A.owner.req("POST", `/v1/bots/${second.bot_id}/grants`, { friend_owner_id: B.owner_id }), 403, "bot_revoked");
  assert.equal(derivedGone.body.error.message, "this bot identity was revoked");
  assert.equal(count(s.platform.db, "SELECT COUNT(*) n FROM relationships WHERE requester_bot = ? OR target_bot = ?", second.bot_id, second.bot_id), 0,
    "a share aimed at a removed Bot opened no relationship row");
  assert.deepEqual(snapshot(s), beforeGone, "a share aimed at a removed friend Bot wrote nothing at all");
  assertThirdPartyUntouched(s, thirdGone);
});

test("a share written before a stop still answers after the resume, with no second approval", async (t) => {
  const s = await startServer({ ...bulkAuth });
  t.after(s.stop);
  const { A, B, relId } = await friends(s.base);
  const share = () => s.platform.db.prepare(
    "SELECT id, capability, status, reply_only FROM grants WHERE relationship_id = ? AND grantor_owner = ? ORDER BY capability, id",
  ).all(relId, A.owner_id) as any[];
  const before = share();
  assert.ok(before.filter((g) => g.status === "active" && !g.reply_only).length > 0, "the join wrote a live share to bring back");
  const pending = async () => (await A.owner.req("GET", "/v1/approvals?status=pending")).approvals.length
    + (await B.owner.req("GET", "/v1/approvals?status=pending")).approvals.length;

  const stopped = await A.owner.req("POST", "/v1/emergency-stop", { bot_id: A.bot.id });
  assert.equal(stopped.status, "frozen");
  const resumed: any = await A.owner.req("POST", `/v1/bots/${A.bot.id}/resume`);
  assert.equal(resumed.status, "active");
  assert.ok(resumed.bot_token, "the resume hands back a working token");

  assert.deepEqual(share(), before, "the resume neither rescinded the share nor regranted it");
  assert.equal(await pending(), 0, "nobody is asked to approve a share that was already there");
  const remote: any = await B.owner.req("GET", "/v1/remote-bots");
  const held = remote.bots.find((b: any) => b.bot_id === A.bot.id || b.handle === A.handle);
  assert.ok(held, "the friend's side still holds the share after the resume");
  assert.equal(held.reply_only, false);

  const again = await post(s.base, `/v1/bots/${A.bot.id}/grants`, A.owner.token, { friend_bot_id: B.bot.id });
  assert.equal(again.status, 201, "the idempotent answer keeps the door's status");
  assert.equal(again.body.idempotent, true, "the door answers the share that never left, it does not ask again");
  assert.equal(again.body.relationship_id, relId);
  assert.deepEqual([...again.body.capabilities].sort(), before.filter((g) => g.status === "active" && !g.reply_only).map((g) => g.capability).sort());
});

test("the same door, once it writes a share to an active peer, still settles the queue (control)", async (t) => {
  const s = await startServer({ ...bulkAuth });
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  await dropShares(A.owner, A.bot.id);
  const third = await plantLapsedCard(s, "carol");
  const granted = await post(s.base, `/v1/bots/${A.bot.id}/grants`, A.owner.token, { friend_bot_id: B.bot.id });
  assert.equal(granted.status, 201, JSON.stringify(granted.body));
  assert.equal(granted.body.idempotent, false, "the control writes a share, it does not find one");
  assertThirdPartySettled(s, third);
});
