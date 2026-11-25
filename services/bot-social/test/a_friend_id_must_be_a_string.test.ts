// `POST /v1/bots/{id}/grants` names the friend in its body: `friend_bot_id` picks one of the friend's Bots and
// `friend_owner_id` names the friend's account. `grantBotToFriend` reads both with
// `typeof x === "string" ? x.trim() : ""`, so a wrong-typed name is neither refused nor read — it is treated as
// "nothing named". With a valid `friend_owner_id` beside it the door then picks the friend's Bot off the
// friendship edge and writes a live share of a Bot the caller never named: name Bob's non-friended `surf` Bot
// with an array, and Alice's Bot is shared with Bob's other Bot instead. A wrong-typed `friend_owner_id` alone
// is answered `400 friend_owner_id or friend_bot_id required`, which names the wrong problem, and one sent
// beside a real `friend_bot_id` is silently dropped where a string naming another owner is refused.
// A name the code cannot read is a 400 that names the field, before the friendship is read and before anything
// is written; absent and explicit `null` keep their meaning.
import assert from "node:assert/strict";
import { test } from "node:test";
import { generateEd25519 } from "../src/crypto.js";
import { startServer, ownerWithBot, bulkAuth } from "./helpers.js";

const post = async (base: string, path: string, token: string, body: unknown) => {
  const r = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as any };
};

function counts(s: any) {
  const n = (db: any, table: string) => (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as any).n as number;
  return {
    relationships: n(s.platform.db, "relationships"),
    grants: n(s.platform.db, "grants"),
    events: n(s.platform.db, "events"),
    audit: n(s.platform.audit.db, "audit_events"),
  };
}

/** Alice (owner A) is friends with Bob (owner B) through Alice's default Bot and Bob's default Bot. Bob also owns
 *  `surf`, a Bot Alice is NOT friends with, so "the Bot the caller named" and "the Bot the door picks off the
 *  friendship" are two different Bots. `revokeLive` clears the grant an accepted friendship writes, leaving the
 *  door on its writing path (the state a lapsed or revoked share leaves). */
async function fixture(t: any, opts: { revokeLive?: boolean } = {}) {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "alice");
  const B = await ownerWithBot(s.base, "bob");
  const kp = generateEd25519();
  const surf = await B.owner.req("POST", "/v1/bots", {
    handle: "surf.bob.bot",
    public_key: { alg: "Ed25519", kid: "k1", value: kp.publicKey },
  });
  const rel = await A.owner.req("POST", "/v1/relationships", {
    from_bot_id: A.bot.id, target_handle: B.handle, message: "hi", requested_capabilities: ["chat.public"],
  });
  await B.owner.req("POST", `/v1/relationships/${rel.relationship_id}/consent`, { decision: "accept", grant_capabilities: [] });
  assert.notEqual(B.bot.id, surf.bot_id, "the fixture needs the named Bot to be a different Bot");
  if (opts.revokeLive) {
    const live = s.platform.db.prepare(
      "SELECT id FROM grants WHERE relationship_id = ? AND grantor_owner = ? AND status = 'active'",
    ).all(rel.relationship_id, A.owner_id) as any[];
    for (const g of live) {
      try { await A.owner.req("DELETE", `/v1/bots/${A.bot.id}/grants/${g.id}`); } catch { /* the bundle is gone after the first revoke */ }
    }
    const left = s.platform.db.prepare(
      "SELECT COUNT(*) n FROM grants WHERE relationship_id = ? AND grantor_owner = ? AND status = 'active'",
    ).get(rel.relationship_id, A.owner_id) as any;
    assert.equal(left.n, 0, "the fixture needs no live grant so the door walks its writing path");
  }
  const liveGrantees = () => (s.platform.db.prepare(
    "SELECT DISTINCT grantee_bot FROM grants WHERE status = 'active' AND grantor_owner = ? AND reply_only = 0",
  ).all(A.owner_id) as any[]).map((row) => (s.platform as any).bot(row.grantee_bot).handle);
  return { s, A, B, surf, surfBotId: surf.bot_id as string, liveGrantees };
}

test("a wrong-typed friend_bot_id is refused, not answered as another Bot", async (t) => {
  const { s, A, B, surfBotId, liveGrantees } = await fixture(t, { revokeLive: true });
  const grantPath = `/v1/bots/${A.bot.id}/grants`;
  for (const [label, value] of [
    ["an array holding a real Bot id", [surfBotId]],
    ["an array holding an empty string", [""]],
    ["an object", {}],
    ["a boolean", true],
    ["a fraction", 1.5],
    ["zero", 0],
  ] as [string, unknown][]) {
    const before = counts(s);
    const r = await post(s.base, grantPath, A.owner.token, { friend_owner_id: B.owner_id, friend_bot_id: value });
    assert.equal(r.status, 400, `${label} friend_bot_id is refused, not answered as another Bot`);
    assert.equal(r.body.error.code, "invalid_request");
    assert.equal(r.body.error.message, "friend_bot_id must be a string", `${label} friend_bot_id names the field`);
    assert.deepEqual(counts(s), before, `${label} friend_bot_id writes nothing`);
    assert.deepEqual(liveGrantees(), [], `${label} friend_bot_id shares no Bot`);
  }
});

test("a wrong-typed friend_owner_id is refused by name", async (t) => {
  const { s, A, B } = await fixture(t, { revokeLive: true });
  const grantPath = `/v1/bots/${A.bot.id}/grants`;
  for (const [label, value] of [
    ["a number", 42],
    ["an object", {}],
    ["an array holding the owner id", [B.owner_id]],
    ["a boolean", true],
  ] as [string, unknown][]) {
    const before = counts(s);
    const r = await post(s.base, grantPath, A.owner.token, { friend_owner_id: value });
    assert.equal(r.status, 400, `${label} friend_owner_id is refused`);
    assert.equal(r.body.error.message, "friend_owner_id must be a string", `${label} friend_owner_id names the field`);
    assert.deepEqual(counts(s), before, `${label} friend_owner_id writes nothing`);
  }
});

test("a wrong-typed friend_owner_id is not silently dropped beside a real friend_bot_id", async (t) => {
  const { s, A, B } = await fixture(t, { revokeLive: true });
  const grantPath = `/v1/bots/${A.bot.id}/grants`;
  for (const [label, value] of [["a number", 42], ["an object", {}]] as [string, unknown][]) {
    const before = counts(s);
    const r = await post(s.base, grantPath, A.owner.token, { friend_owner_id: value, friend_bot_id: B.bot.id });
    assert.equal(r.status, 400, `${label} friend_owner_id is refused even when a Bot is named`);
    assert.equal(r.body.error.message, "friend_owner_id must be a string", `${label} friend_owner_id names the field`);
    assert.deepEqual(counts(s), before, `${label} friend_owner_id writes nothing`);
  }
});

test("the string and absent forms keep their answers", async (t) => {
  const { s, A, B, surfBotId } = await fixture(t, { revokeLive: true });
  const grantPath = `/v1/bots/${A.bot.id}/grants`;

  const named = await post(s.base, grantPath, A.owner.token, { friend_owner_id: B.owner_id, friend_bot_id: B.bot.id });
  assert.equal(named.status, 201, "a string friend_bot_id still shares that Bot");
  assert.equal(named.body.grantee_bot, B.bot.id);

  const byOwner = await post(s.base, grantPath, A.owner.token, { friend_owner_id: B.owner_id });
  assert.equal(byOwner.status, 201, "an owner-only string still picks the friend's Bot");

  const notFriended = await post(s.base, grantPath, A.owner.token, { friend_owner_id: B.owner_id, friend_bot_id: surfBotId });
  assert.equal(notFriended.status, 404, "a string naming a non-friend Bot keeps its 404");
  assert.equal(notFriended.body.error.code, "friend_not_found");

  for (const [label, body] of [
    ["both absent", {}],
    ["both null", { friend_owner_id: null, friend_bot_id: null }],
  ] as [string, any][]) {
    const r = await post(s.base, grantPath, A.owner.token, body);
    assert.equal(r.status, 400, `${label} still means "nothing named"`);
    assert.equal(r.body.error.message, "friend_owner_id or friend_bot_id required", `${label} keeps its wording`);
  }

  const mismatch = await post(s.base, grantPath, A.owner.token, { friend_owner_id: A.owner_id, friend_bot_id: B.bot.id });
  assert.equal(mismatch.status, 400, "a string owner naming another owner is still refused");
  assert.equal(mismatch.body.error.message, "friend_owner_id and friend_bot_id name different owners");
});

test("the idempotent answer keeps its shape and a wrong-typed name still refuses", async (t) => {
  const { s, A, B, surfBotId, liveGrantees } = await fixture(t);
  const grantPath = `/v1/bots/${A.bot.id}/grants`;

  const before = counts(s);
  const idem = await post(s.base, grantPath, A.owner.token, { friend_owner_id: B.owner_id, friend_bot_id: B.bot.id });
  assert.equal(idem.status, 201, "a live share still answers 201");
  assert.equal(idem.body.idempotent, true, "a live share still answers idempotent");
  assert.equal(idem.body.grantee_bot, B.bot.id);
  assert.deepEqual(counts(s), before, "the idempotent answer writes nothing");

  const beforeBad = counts(s);
  const bad = await post(s.base, grantPath, A.owner.token, { friend_owner_id: B.owner_id, friend_bot_id: [surfBotId] });
  assert.equal(bad.status, 400, "a wrong-typed name is refused on the idempotent path too");
  assert.equal(bad.body.error.message, "friend_bot_id must be a string");
  assert.deepEqual(counts(s), beforeBad, "the refusal writes nothing");
  assert.deepEqual(liveGrantees(), [B.bot.id].map((id) => (s.platform as any).bot(id).handle));
});
