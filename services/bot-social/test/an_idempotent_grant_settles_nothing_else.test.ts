/**
 * An answer that writes nothing settles nothing: the idempotent Bot share.
 *
 * `grantBotToFriend` opens the platform's delivery moment before it writes a share: the cards past their deadline are
 * settled first, so the announcement and the digest never name a card its owner can no longer decide. The door has a
 * second exit that writes no byte at all -- a live full share of this Bot to this friend is already in place, and the
 * call is answered `idempotent: true`. That exit settled the whole platform anyway, from two places that both had to
 * go: the door's own sweep stood in front of the idempotent scan, and the one read the answer used to name the share
 * (`listBotGrants`, whose documented behaviour is that "a read also settles lapsed access") ran the same platform-wide
 * sweep a second time. So a call that wrote nothing expired a third owner's waiting card, wrote its
 * `approval.expired` line, told that owner's Bot, and burned the `pending_owner` invite the card was holding -- and a
 * repeat of a share is exactly the call a client makes on a retry.
 *
 * This is the fifth door of the family `test/a_refused_write_settles_nothing_else.test.ts` states ("a 404 or a 403
 * must not be the call that expires another owner's cards") and the sibling of
 * `test/a_refused_grant_settles_nothing_else.test.ts`, which pins the refusals of this same door. The rule here is
 * wider than "a refusal": an answer is a delivery moment only when it is about to write.
 *
 * The controls are the same door once it really writes a share -- the delivery moment is moved, not deleted -- and
 * the repeat's own answer: 201 with `idempotent: true`, naming the share that already exists.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { bulkAuth, friends, ownerWithBot, startServer } from "./helpers.js";

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

interface Fixture {
  s: S;
  A: any;
  B: any;
  C: any;
  card: string;
  invite: string;
  first: any;
}

/** A and B are friends; C is a third owner whose Bot minted an `auto_accept: false` invite, so C has a card waiting
 *  and the link sits at `pending_owner` behind it -- and the card is past its deadline.
 *
 *  A's share of its Bot to B is revoked first, so the door's first call really writes (an accepted friendship already
 *  wrote the full share, and a second grant of it would be the idempotent answer this file is about). The lapsed card
 *  is minted after that write by default, so it is still `pending` when the share is repeated; `lapsedBeforeShare`
 *  puts it before the write, which is the control that the door still settles the queue when it does write. */
async function fixture(t: any, { lapsedBeforeShare = false } = {}): Promise<Fixture> {
  const s = await startServer({ ...bulkAuth });
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const listed: any = await A.owner.req("GET", `/v1/bots/${A.bot.id}/grants`);
  for (const g of listed.grants) await A.owner.req("DELETE", `/v1/bots/${A.bot.id}/grants/${g.grant_id}`);
  const C = await ownerWithBot(s.base, "carol");
  const mint = async () => {
    const minted: any = await C.bot.signed("/v1/invites", "invite.create", { auto_accept: false });
    assert.equal(minted.status, "pending_owner", JSON.stringify(minted));
    assert.ok(minted.approval_id, "a Bot-created invite waits behind a card");
    s.platform.db.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?").run(past(), minted.approval_id);
    return minted;
  };
  const early = lapsedBeforeShare ? await mint() : null;
  const first: any = await A.owner.req("POST", `/v1/bots/${A.bot.id}/grants`, { friend_bot_id: B.bot.id });
  assert.equal(first.idempotent, false, "the fixture's first call writes the share");
  const minted = early ?? (await mint());
  return { s, A, B, C, card: minted.approval_id, invite: minted.invite_id, first };
}

/** Everything of C's the repeat must leave alone. */
function assertThirdPartyUntouched(f: Fixture) {
  const card = f.s.platform.db.prepare("SELECT status, decided_at FROM approvals WHERE id = ?").get(f.card) as any;
  assert.equal(card.status, "pending", "an idempotent share settled another owner's card");
  assert.equal(card.decided_at, null, "an idempotent share stamped a decision on another owner's card");
  const invite = f.s.platform.db.prepare("SELECT status FROM invites WHERE id = ?").get(f.invite) as any;
  assert.equal(invite.status, "pending_owner", "an idempotent share expired another owner's invite link");
  assert.equal(count(f.s.platform.audit.db, "SELECT COUNT(*) n FROM audit_events WHERE action = 'approval.expired'"), 0, "an idempotent share wrote an expiry audit line");
  assert.equal(count(f.s.platform.db, "SELECT COUNT(*) n FROM events WHERE type = 'approval.decided' AND bot_id = ?", f.C.bot.id), 0, "an idempotent share told another owner's Bot");
}

test("a repeated share answers without settling another owner's card", async (t) => {
  const f = await fixture(t);
  const again = await post(f.s.base, `/v1/bots/${f.A.bot.id}/grants`, f.A.owner.token, { friend_bot_id: f.B.bot.id });
  assert.equal(again.status, 201, JSON.stringify(again.body));
  assert.equal(again.body.idempotent, true, "a live share is answered, not written");
  assert.equal(again.body.status, "active", JSON.stringify(again.body));
  assert.equal(again.body.grantee_bot, f.B.bot.id);
  // The answer still names a live grant of this relationship: which row of the bundle it names is the same question it
  // was before this change (the bundle is revoked as one).
  const named = f.s.platform.db.prepare("SELECT status, relationship_id FROM grants WHERE id = ?").get(again.body.grant_id) as any;
  assert.equal(named?.status, "active", "the answer names a live grant row");
  assert.equal(named?.relationship_id, again.body.relationship_id);
  assertThirdPartyUntouched(f);
});

test("the same door, once it really writes a share, still settles the queue (control)", async (t) => {
  const f = await fixture(t, { lapsedBeforeShare: true });
  assert.equal(f.first.idempotent, false, "the control writes a share, it does not find one");
  const card = f.s.platform.db.prepare("SELECT status, decided_at FROM approvals WHERE id = ?").get(f.card) as any;
  assert.equal(card.status, "expired", "a door that writes a share still opens the delivery moment");
  assert.ok(card.decided_at, "settled with the instant it happened");
  const invite = f.s.platform.db.prepare("SELECT status FROM invites WHERE id = ?").get(f.invite) as any;
  assert.equal(invite.status, "expired", "a lapsed card's link ends with it");
  assert.equal(count(f.s.platform.audit.db, "SELECT COUNT(*) n FROM audit_events WHERE action = 'approval.expired'"), 1, "the expiry is on the audit chain");
  assert.equal(count(f.s.platform.db, "SELECT COUNT(*) n FROM events WHERE type = 'approval.decided' AND bot_id = ?", f.C.bot.id), 1, "the other owner's Bot heard the settlement");
});

test("a repeated share is answered as the share it found (control)", async (t) => {
  const f = await fixture(t);
  const again = await post(f.s.base, `/v1/bots/${f.A.bot.id}/grants`, f.A.owner.token, { friend_bot_id: f.B.bot.id });
  assert.equal(again.status, 201, "the idempotent answer keeps the door's status");
  assert.equal(again.body.idempotent, true, "a live share answers idempotent, not a second write");
  assert.equal(again.body.status, "active");
  assert.equal(again.body.relationship_id, f.first.relationship_id, "the answer names the same relationship");
  assert.equal(again.body.bot_id, f.first.bot_id);
  assert.equal(again.body.grantee_bot, f.first.grantee_bot);
  assert.equal(again.body.reply_only, false);
  assert.deepEqual([...again.body.capabilities].sort(), [...f.first.capabilities].sort(), "the answer names the share's own capabilities");
});
