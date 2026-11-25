/**
 * A repeat names a share whose far end the door checked.
 *
 * `grantBotToFriend` reads one far end before it answers: when the friend is named only by owner, it takes the newest
 * active friendship of that owner and refuses that friendship's Bot when it is stopped. The idempotent answer below it
 * then loops over **every** active friendship of the owner and returns on the first one that has a live share -- which
 * can be an older friendship than the one the door read. A Bot stopped after that older share was written came back as
 * `grantee_bot` with `status: "active"` and `idempotent: true`, from a door that refuses a stopped Bot on both ends
 * everywhere else. Nothing was written, so the impact was a stale answer: a retry read it as "the stopped Bot still has
 * live access".
 *
 * The defect needs the newest friendship to have no live share, so the loop falls through to the older one: the first
 * case stops the older peer, repeats the owner-only call, and pins that the answer is the stop's own `403 bot_frozen`
 * and that it writes nothing (rows, audit chain, events). The control is the same shape with both peers active: the
 * answer still names the live share on the older friendship and still answers `idempotent: true` with no new row, so
 * the fix adds the far-end check rather than changing what the loop may answer from.
 *
 * Written-by: bot-social 实现线
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { generateEd25519 } from "../src/crypto.js";
import { bulkAuth, expectApiError, friends, startServer } from "./helpers.js";

type S = Awaited<ReturnType<typeof startServer>>;
const count = (db: any, sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as any).n as number;

const post = async (base: string, path: string, token: string, body: unknown) => {
  const r = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as any };
};

/** Everything a refused repeat must not move: rows, audit chain, events. */
function snapshot(s: S) {
  return {
    grants: count(s.platform.db, "SELECT COUNT(*) n FROM grants"),
    relationships: count(s.platform.db, "SELECT COUNT(*) n FROM relationships"),
    approvals: count(s.platform.db, "SELECT COUNT(*) n FROM approvals"),
    audit: count(s.platform.audit.db, "SELECT COUNT(*) n FROM audit_events"),
    events: count(s.platform.db, "SELECT COUNT(*) n FROM events"),
  };
}

/** A friend owner with a second Bot, and a newer active friendship between Alice's Bot and that second Bot. */
async function secondFriendship(s: S, A: any, B: any) {
  const kp = generateEd25519();
  const second: any = await B.owner.req("POST", "/v1/bots", {
    handle: "bobsecond.bot",
    public_key: { alg: "Ed25519", kid: "k1", value: kp.publicKey },
  });
  assert.ok(second.bot_id, JSON.stringify(second));
  const rel: any = await A.owner.req("POST", "/v1/relationships", {
    from_bot_id: A.bot.id,
    target_handle: "@bobsecond.bot",
    message: "hi",
    requested_capabilities: ["chat.public"],
  });
  await B.owner.req("POST", `/v1/relationships/${rel.relationship_id}/consent`, { decision: "accept", grant_capabilities: [] });
  return { secondBotId: second.bot_id as string, relId: rel.relationship_id as string };
}

/** The accepted friendship gave Alice's Bot a live share to the newer peer; take it away, so only the older friendship
 *  holds a live share and the idempotent loop has to fall through to it. */
function dropNewerShare(s: S, relId: string) {
  const live = s.platform.db.prepare(
    "SELECT COUNT(*) n FROM grants WHERE relationship_id = ? AND status = 'active' AND room_id IS NULL",
  ).get(relId) as any;
  assert.ok(live.n > 0, "the fixture's newer friendship wrote a live share to drop");
  s.platform.db.prepare("UPDATE grants SET status = 'revoked', revoked_at = ? WHERE relationship_id = ?")
    .run(new Date().toISOString(), relId);
}

test("a repeat that falls through to an older friendship does not name its stopped Bot as active", async (t) => {
  const s = await startServer({ ...bulkAuth });
  t.after(s.stop);
  const { A, B, relId: olderRel } = await friends(s.base);
  const newer = await secondFriendship(s, A, B);
  dropNewerShare(s, newer.relId);

  // The stop lands after the older friendship's share was written, exactly the shape the security review measured.
  const stopped = await B.owner.req("POST", "/v1/emergency-stop", { bot_id: B.bot.id });
  assert.equal(stopped.status, "frozen");
  const olderShare = () => s.platform.db.prepare(
    "SELECT id, capability, status FROM grants WHERE relationship_id = ? AND grantor_owner = ? ORDER BY capability, id",
  ).all(olderRel, A.owner_id) as any[];
  assert.ok(olderShare().some((g) => g.status === "active"), "the older friendship still holds the live share the loop would name");

  const before = snapshot(s);
  const err = await expectApiError(
    A.owner.req("POST", `/v1/bots/${A.bot.id}/grants`, { friend_owner_id: B.owner_id }),
    403,
    "bot_frozen",
  );
  assert.equal(err.body.error.message, "this bot is frozen (emergency stop)", "the answer is the stop's own word, not `idempotent: true`");
  assert.equal(err.body.idempotent, undefined, "the door did not answer the stopped Bot's share");
  assert.equal(err.body.grantee_bot, undefined, "the stopped Bot is never named as the grantee");
  assert.ok(olderShare().some((g) => g.status === "active"), "the refusal left the share that was there before the stop alone");
  assert.deepEqual(snapshot(s), before, "the refused repeat wrote nothing at all: no row, no audit line, no event");
});

test("the same repeat answers the live share on an active older friendship (control)", async (t) => {
  const s = await startServer({ ...bulkAuth });
  t.after(s.stop);
  const { A, B, relId: olderRel } = await friends(s.base);
  const newer = await secondFriendship(s, A, B);
  dropNewerShare(s, newer.relId);

  // Both peers active: the newest friendship has no share of this Bot, the older one does. The door answers that share
  // and writes nothing, so the far-end check added for the stopped case changes no answer here.
  const before = snapshot(s);
  const again = await post(s.base, `/v1/bots/${A.bot.id}/grants`, A.owner.token, { friend_owner_id: B.owner_id });
  assert.equal(again.status, 201, JSON.stringify(again.body));
  assert.equal(again.body.idempotent, true, "a live share is answered, not written again");
  assert.equal(again.body.grantee_bot, B.bot.id, "the answer names the older friendship's live peer");
  assert.equal(again.body.relationship_id, olderRel, "and the relationship that share lives on");
  assert.equal(again.body.status, "active");
  assert.deepEqual(snapshot(s), before, "an idempotent answer writes nothing");
});
