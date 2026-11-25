// The platform holds a custodial bot's signing key (`bot_custody.kid`) and signs the owner's own sends with it
// (POST /v1/homes/{id}/send). That key is not the caller's to retire: `retire_others_in_days` sweeps every active
// key already on the Bot, so a rotation — 0 days or the default week — used to date the platform's own key, and
// every owner-side send then answered 401 invalid_signature ("unknown, revoked or expired kid"). The explicit key
// door has the same edge: revoking the custody kid through DELETE /v1/bots/{id}/keys/{kid} left the Bot mute.
//
// The rule pinned here: a key the platform signs with is excluded from the retirement sweep (it is the platform's
// signing identity, not an old key of the caller's) and cannot be revoked from the key door, which answers 409 and
// names `enable_custody` in rotate mode — moving custody to a fresh key is the reachable way to take the old one
// back. Everything a bot whose
// key the platform does NOT hold could do stays exactly as it was: both the positive and the negative cases are
// below, because the exclusion must not widen the door for anyone else.
import assert from "node:assert/strict";
import { test } from "node:test";
import { generateEd25519 } from "../src/crypto.js";
import { friends, ownerWithBot, startServer } from "./helpers.js";

const DAY = 86400e3;
const owner = (o: any) => ({ kind: "owner" as const, ownerId: o.owner_id });
const token = (o: any) => o.owner.token;
const daysUntil = (iso: string) => (Date.parse(iso) - Date.now()) / DAY;

async function req(base: string, method: string, path: string, tok: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${tok}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  const json = text ? JSON.parse(text) : {};
  return { status: r.status, body: json.error ? json.error : json };
}

/** The owner's own send from the Bot's home page — the action that signs with the platform-held key. */
let line = 0;
const sendAsOwner = (base: string, A: any, B: any) =>
  req(base, "POST", `/v1/homes/${A.bot.id}/send`, token(A), { from_bot_id: A.bot.id, to: B.bot.id, text: `from the home page, line ${++line}` });

/** A signed call the Bot's own key makes: proof that the key on the row can still be used, or that it cannot. */
const signs = (a: any, b: any) => a.bot.startConversation(b.bot.id, { type: "general_chat", summary: "a signed call" });

const keyRows = (s: any, botId: string) =>
  (s.platform.db.prepare("SELECT kid, status, expires_at FROM bot_keys WHERE bot_id = ? ORDER BY created_at").all(botId) as any[]);

test("a rotation of 0 days does not date the key the platform signs with", async () => {
  const s = await startServer();
  try {
    const { A, B } = await friends(s.base);
    const custody = s.platform.enableCustody(owner(A), A.bot.id, { private_key_pem: A.kp.privateKeyPem });
    assert.equal((await sendAsOwner(s.base, A, B)).status, 202, "the owner-side send signs with the platform-held key");

    const added = await req(s.base, "POST", `/v1/bots/${A.bot.id}/keys`, token(A), { kid: "k-two", value: generateEd25519().publicKey, retire_others_in_days: 0 });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    const after = await sendAsOwner(s.base, A, B);
    assert.equal(after.status, 202, `the connector still signs after the rotation: ${JSON.stringify(after.body)}`);
    const held = keyRows(s, A.bot.id).find((r) => r.kid === custody.kid);
    assert.ok(held, "the key the platform signs with is still a row");
    assert.equal(held.status, "active", "it is not revoked");
    assert.equal(held.expires_at, null, "and the sweep does not date the platform's own signing key");
  } finally { await s.stop(); }
});

test("the default week does not date the key the platform signs with either", async () => {
  const s = await startServer();
  try {
    const { A, B } = await friends(s.base);
    const custody = s.platform.enableCustody(owner(A), A.bot.id, { private_key_pem: A.kp.privateKeyPem });
    // The rotation that runs when an owner adds a key and says nothing: the old default is one week.
    const added = await req(s.base, "POST", `/v1/bots/${A.bot.id}/keys`, token(A), { kid: "k-two", value: generateEd25519().publicKey });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    const held = keyRows(s, A.bot.id).find((r) => r.kid === custody.kid);
    assert.equal(held.expires_at, null, "the platform's own key is not put on a week-long clock");
    assert.equal((await sendAsOwner(s.base, A, B)).status, 202);
  } finally { await s.stop(); }
});

test("the key the platform signs with cannot be revoked from the key door", async () => {
  const s = await startServer();
  try {
    const { A, B } = await friends(s.base);
    const custody = s.platform.enableCustody(owner(A), A.bot.id, { private_key_pem: A.kp.privateKeyPem });
    const rev = await req(s.base, "DELETE", `/v1/bots/${A.bot.id}/keys/${custody.kid}`, token(A));
    assert.equal(rev.status, 409, JSON.stringify(rev.body));
    assert.equal(rev.body.code, "custody_key_held", "the refusal names the state it conflicts with");
    assert.match(String(rev.body.message), /enable_custody/, "and names the door that can take the key back");
    assert.doesNotMatch(String(rev.body.message), /disable_custody/, "never a door that is not reachable today");
    assert.equal(keyRows(s, A.bot.id).find((r) => r.kid === custody.kid).status, "active", "the key was not touched");
    assert.equal((await sendAsOwner(s.base, A, B)).status, 202, "and the connector still signs");

    // The refusal is only for this bot's owner: nothing here may tell a stranger that a kid is a custody key.
    const other = await ownerWithBot(s.base, "stranger");
    const stranger = await req(s.base, "DELETE", `/v1/bots/${A.bot.id}/keys/${custody.kid}`, token(other));
    assert.equal(stranger.status, 403, JSON.stringify(stranger.body));
    assert.equal(stranger.body.code, "forbidden", "another owner still gets the ordinary ownership refusal");
    assert.match(String(stranger.body.message), /not your bot/);
    // The same owner naming the same kid on a Bot that does not hold it keeps the old answer.
    const kp2 = generateEd25519();
    const second = await A.owner.req("POST", "/v1/bots", { handle: "second.bot", public_key: { alg: "Ed25519", kid: "k9", value: kp2.publicKey } });
    const elsewhere = await req(s.base, "DELETE", `/v1/bots/${second.bot_id}/keys/${custody.kid}`, token(A));
    assert.equal(elsewhere.status, 404, JSON.stringify(elsewhere.body));
    assert.equal(elsewhere.body.code, "key_not_found", "a kid this Bot never had is still simply missing");

    // The reachable way out, in the order the refusal names: enable_custody in rotate mode moves custody to a fresh
    // key and leaves this one in place, so it is now an ordinary key and this door revokes it like any other.
    const moved = s.platform.enableCustody(owner(A), A.bot.id, {});
    assert.notEqual(moved.kid, custody.kid, "custody now names a different key");
    assert.equal(keyRows(s, A.bot.id).find((r) => r.kid === custody.kid).status, "active", "the move does not retire the key it leaves behind");
    const again = await req(s.base, "DELETE", `/v1/bots/${A.bot.id}/keys/${custody.kid}`, token(A));
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(keyRows(s, A.bot.id).find((r) => r.kid === custody.kid).status, "revoked");
    assert.equal((await sendAsOwner(s.base, A, B)).status, 202, "and the new custody key signs from here on");
  } finally { await s.stop(); }
});

test("a bot whose key the platform does not hold still retires its old key at once", async () => {
  const s = await startServer();
  try {
    const { A, B } = await friends(s.base);
    assert.ok((await signs(A, B)).conversation_id, "the key signs before the rotation");
    const added = await req(s.base, "POST", `/v1/bots/${A.bot.id}/keys`, token(A), { kid: "k-two", value: generateEd25519().publicKey, retire_others_in_days: 0 });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    const old = keyRows(s, A.bot.id).find((r) => r.kid === "k1");
    assert.equal(old.status, "active", "it is not revoked: only its window closed");
    assert.ok(old.expires_at, "it now carries an expiry");
    assert.ok(Date.parse(old.expires_at) <= Date.now() + 1000, "and that expiry is now");
    await assert.rejects(() => signs(A, B), (e: any) => {
      assert.equal(e.status, 401, "the next signed call is refused");
      assert.equal(e.code, "invalid_signature");
      assert.match(String(e.message), /unknown, revoked or expired kid/);
      return true;
    });
  } finally { await s.stop(); }
});

test("a bot whose key the platform does not hold still gets the default week and still revokes", async () => {
  const s = await startServer();
  try {
    const { A, B } = await friends(s.base);
    const added = await req(s.base, "POST", `/v1/bots/${A.bot.id}/keys`, token(A), { kid: "k-two", value: generateEd25519().publicKey });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    const old = keyRows(s, A.bot.id).find((r) => r.kid === "k1");
    assert.ok(old.expires_at, "the old key now carries an expiry");
    assert.ok(Math.abs(daysUntil(old.expires_at) - 7) < 0.01, "and it is the week the default always meant");
    assert.ok((await signs(A, B)).conversation_id, "the old key still signs inside its window");
    const rev = await req(s.base, "DELETE", `/v1/bots/${A.bot.id}/keys/k1`, token(A));
    assert.equal(rev.status, 200, JSON.stringify(rev.body));
    assert.equal(rev.body.status, "revoked");
    await assert.rejects(() => signs(A, B), (e: any) => { assert.equal(e.status, 401); return true; });
  } finally { await s.stop(); }
});

test("another Bot's custody key does not stop this Bot from retiring its own key of the same name", async () => {
  const s = await startServer();
  try {
    const { A, B } = await friends(s.base);
    // Every Bot is created with the same default kid, so a twin's custody key is called "k1" too. The sweep has to be
    // scoped to this Bot: an unscoped subquery would skip A's ordinary key and silently keep it alive.
    const twin = await ownerWithBot(s.base, "twin");
    const custodyB = s.platform.enableCustody(owner(twin), twin.bot.id, { private_key_pem: twin.kp.privateKeyPem });
    assert.equal(custodyB.kid, "k1", "the twin custody key really carries the same name");
    const added = await req(s.base, "POST", `/v1/bots/${A.bot.id}/keys`, token(A), { kid: "k-two", value: generateEd25519().publicKey, retire_others_in_days: 0 });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    const old = keyRows(s, A.bot.id).find((r) => r.kid === "k1");
    assert.ok(old.expires_at, "A's own key is retired even though another Bot's custody key shares its name");
    assert.ok(Date.parse(old.expires_at) <= Date.now() + 1000);
    await assert.rejects(() => signs(A, B), (e: any) => { assert.equal(e.status, 401, "and it stops signing"); return true; });
    const twinKid = keyRows(s, twin.bot.id).find((r) => r.kid === custodyB.kid);
    assert.equal(twinKid.status, "active", "the twin's custody key is not in this Bot's sweep");
    assert.equal(twinKid.expires_at, null);
  } finally { await s.stop(); }
});
