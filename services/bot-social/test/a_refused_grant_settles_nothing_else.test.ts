/**
 * A refused Bot share settles nothing that belongs to another owner.
 *
 * `grantBotToFriend` is the fourth write door that opens a delivery moment: the cards past their deadline are settled
 * first, so the announcement and the digest never name a card its owner can no longer decide. On this door the
 * platform-wide sweep stood in front of the door's own refusals, so a call that was refused -- an owner who is not a
 * friend, a blocked pair -- still expired a third owner's waiting card, wrote its `approval.expired` line, told that
 * owner's Bot, and burned the invite link the card was holding (`expireApproval` flips a `pending_owner` invite to
 * `expired`, and an expired link is final: it answers 410 for good). The door's refusal decided another owner's share.
 *
 * `test/a_refused_write_settles_nothing_else.test.ts` states the rule and pins the three doors already fixed against
 * it: "a 404 or a 403 must not be the call that expires another owner's cards". This is the fourth.
 *
 * One refusal of this door already sat ahead of the sweep on the same code: a `friend_owner_id` that names no owner is
 * answered before it, so that case is kept here as the boundary -- the two refusals that used to sit behind the sweep
 * are the owner who is not a friend and the blocked pair.
 *
 * The control is the same door, once it really writes a share: the queue is still settled. It pins the door's visible
 * behaviour (a share that is granted does settle lapsed cards), not which call inside the door does it -- the read this
 * door ends with settles too.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { bulkAuth, expectApiError, friends, ownerWithBot, startServer } from "./helpers.js";

type S = Awaited<ReturnType<typeof startServer>>;
const past = () => new Date(Date.now() - 3600e3).toISOString();
const count = (db: any, sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as any).n as number;

interface Fixture {
  s: S;
  A: any;
  B: any;
  C: any;
  card: string;
  invite: string;
}

/** A and B are friends; C is a third owner whose Bot asked to mint an `auto_accept: false` invite, so C has a card
 *  waiting and the link sits at `pending_owner` behind it -- and the card is past its deadline. With `freshShare` A's
 *  share of its Bot to B is revoked first (before C's card lapses), so the door under test is one that really writes:
 *  accepting a friendship already writes the full share, and a second grant of it is answered as idempotent. */
async function fixture(t: any, { freshShare = false }: { freshShare?: boolean } = {}): Promise<Fixture> {
  const s = await startServer({ ...bulkAuth });
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  if (freshShare) {
    const listed: any = await A.owner.req("GET", `/v1/bots/${A.bot.id}/grants`);
    for (const g of listed.grants) await A.owner.req("DELETE", `/v1/bots/${A.bot.id}/grants/${g.grant_id}`);
  }
  const C = await ownerWithBot(s.base, "carol");
  const minted: any = await C.bot.signed("/v1/invites", "invite.create", { auto_accept: false });
  assert.equal(minted.status, "pending_owner", JSON.stringify(minted));
  assert.ok(minted.approval_id, "a Bot-created invite waits behind a card");
  s.platform.db.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?").run(past(), minted.approval_id);
  return { s, A, B, C, card: minted.approval_id, invite: minted.invite_id };
}

/** Everything of C's the refused call must leave alone. */
function assertThirdPartyUntouched(f: Fixture) {
  const card = f.s.platform.db.prepare("SELECT status, decided_at FROM approvals WHERE id = ?").get(f.card) as any;
  assert.equal(card.status, "pending", "a refused share settled another owner's card");
  assert.equal(card.decided_at, null, "a refused share stamped a decision on another owner's card");
  const invite = f.s.platform.db.prepare("SELECT status FROM invites WHERE id = ?").get(f.invite) as any;
  assert.equal(invite.status, "pending_owner", "a refused share expired another owner's invite link");
  assert.equal(count(f.s.platform.audit.db, "SELECT COUNT(*) n FROM audit_events WHERE action = 'approval.expired'"), 0, "a refused share wrote an expiry audit line");
  assert.equal(count(f.s.platform.db, "SELECT COUNT(*) n FROM events WHERE type = 'approval.decided' AND bot_id = ?", f.C.bot.id), 0, "a refused share told another owner's Bot");
}

test("an owner who is not a friend is refused, and settles nothing of a third owner", async (t) => {
  const f = await fixture(t);
  const D = await ownerWithBot(f.s.base, "dave");
  const refused = await expectApiError(f.A.owner.req("POST", `/v1/bots/${f.A.bot.id}/grants`, { friend_owner_id: D.owner_id }), 404, "friend_not_found");
  assert.match((refused as any).message, /not an active friend/);
  assertThirdPartyUntouched(f);
});

test("an owner id that names no owner is refused, and settles nothing of a third owner", async (t) => {
  const f = await fixture(t);
  // This refusal already stands ahead of the sweep on the same code; the case keeps that boundary pinned so a later
  // move of the sweep cannot quietly put it behind one refusal again.
  const refused = await expectApiError(f.A.owner.req("POST", `/v1/bots/${f.A.bot.id}/grants`, { friend_owner_id: "own_nosuchowner" }), 404, "friend_not_found");
  assert.match((refused as any).message, /no such owner/);
  assertThirdPartyUntouched(f);
});

test("a blocked pair is refused, and settles nothing of a third owner", async (t) => {
  const f = await fixture(t);
  // A's friendship with B is on A's first Bot; A's second Bot is blocked against B, so the owner-level friendship is
  // still active while the pair this share would use is blocked -- the 403 this door answers.
  const second = await f.A.owner.req("POST", "/v1/bots", { handle: `${f.A.handle.replace(/^@/, "").replace(/\.bot$/, "")}-two.bot`, display_name: "Second" });
  await f.A.owner.req("POST", "/v1/blocks", { bot_id: f.B.bot.id, my_bot_id: second.bot_id });
  await expectApiError(f.A.owner.req("POST", `/v1/bots/${second.bot_id}/grants`, { friend_bot_id: f.B.bot.id }), 403, "blocked");
  assertThirdPartyUntouched(f);
});

test("the same door, once it really writes a share, still settles the queue (control)", async (t) => {
  const f = await fixture(t, { freshShare: true });
  const granted: any = await f.A.owner.req("POST", `/v1/bots/${f.A.bot.id}/grants`, { friend_bot_id: f.B.bot.id });
  assert.equal(granted.status, "active", JSON.stringify(granted));
  assert.equal(granted.idempotent, false, "the control writes a share, it does not find one");
  const card = f.s.platform.db.prepare("SELECT status, decided_at FROM approvals WHERE id = ?").get(f.card) as any;
  assert.equal(card.status, "expired", "a door that writes a share still opens the delivery moment");
  assert.ok(card.decided_at, "settled with the instant it happened");
  const invite = f.s.platform.db.prepare("SELECT status FROM invites WHERE id = ?").get(f.invite) as any;
  assert.equal(invite.status, "expired", "a lapsed card's link ends with it");
  assert.equal(count(f.s.platform.audit.db, "SELECT COUNT(*) n FROM audit_events WHERE action = 'approval.expired'"), 1, "the expiry is on the audit chain");
  assert.equal(count(f.s.platform.db, "SELECT COUNT(*) n FROM events WHERE type = 'approval.decided' AND bot_id = ?", f.C.bot.id), 1, "the other owner's Bot heard the settlement");
});

test("the delivery moment stands before this door's first write (control)", async (t) => {
  const f = await fixture(t, { freshShare: true });
  // The door's visible behaviour alone cannot tell "settled before the write" from "settled by the read it ends with",
  // so the write itself is asked: every `grants` row this call inserts records what C's card said at that moment. A
  // sweep left behind the write -- or dropped -- finds the card still `pending` here, while the card's own read door
  // would still settle it afterwards and hide the difference.
  f.s.platform.db.exec("CREATE TEMP TABLE grant_probe (card_status TEXT)");
  f.s.platform.db.exec(`CREATE TEMP TRIGGER probe_grant_write AFTER INSERT ON grants
    BEGIN INSERT INTO grant_probe (card_status) SELECT status FROM approvals WHERE id = '${f.card}'; END;`);
  const granted: any = await f.A.owner.req("POST", `/v1/bots/${f.A.bot.id}/grants`, { friend_bot_id: f.B.bot.id });
  assert.equal(granted.status, "active", JSON.stringify(granted));
  assert.equal(granted.idempotent, false, "the probe needs the door to write its share");
  const seen = f.s.platform.db.prepare("SELECT card_status FROM grant_probe").all() as any[];
  assert.ok(seen.length > 0, "the share wrote at least one grant row");
  assert.deepEqual([...new Set(seen.map((r) => r.card_status))], ["expired"], "the queue is settled before the first write of this door");
});
