// `addKey` stamps a seven-day verification window on every active key it replaces. A key that was rotated away
// from and then handed back through custody (`enable_custody` with `private_key_pem`) used to arrive carrying that
// deadline, and the platform signed every custodial request with it. The day that inherited date passed, envelope
// verification answered 401 for an expired kid on an identity whose private key the platform held: the owner could
// no longer rotate it, and the only lever left in the console was disabling custody, which replaces the identity.
//
// Adoption is the moment the platform takes over signing, so the window cannot outlive it: the single row adoption
// takes over is cleared of its deadline and stays valid until it is revoked or custody is disabled. The window
// itself does not move — an already-closed window is still refused with `400 key_not_registered`, the row keeps its
// date and the Bot stays non-custodial — and a key with no deadline is adopted exactly as it was.
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
  req(base, "POST", `/v1/homes/${A.bot.id}/send`, token(A), { from_bot_id: A.bot.id, to: B.bot.id, text: `adopted identity, line ${++line}` });

const keyRows = (s: any, botId: string) =>
  (s.platform.db.prepare("SELECT kid, status, expires_at FROM bot_keys WHERE bot_id = ? ORDER BY created_at").all(botId) as any[]);
const custodyRows = (s: any, botId: string) =>
  (s.platform.db.prepare("SELECT kid FROM bot_custody WHERE bot_id = ?").all(botId) as any[]);
const refusesWith = (fn: () => unknown, status: number, code: string) =>
  assert.throws(fn, (e: any) => {
    assert.equal(e.status, status, `status ${e.status}: ${e.message}`);
    assert.equal(e.code, code, `code ${e.code}: ${e.message}`);
    return true;
  });

test("adopting a key still inside its window clears the deadline it inherited from the rotation", async () => {
  const s = await startServer();
  try {
    const { A, B } = await friends(s.base);
    // The ordinary replacement: k1 is the key being replaced, so it gets the default week-long window.
    const added = await req(s.base, "POST", `/v1/bots/${A.bot.id}/keys`, token(A), { kid: "k-two", value: generateEd25519().publicKey });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    const dated = keyRows(s, A.bot.id).find((k) => k.kid === "k1");
    assert.equal(dated.status, "active", "the replaced key is not revoked, only dated");
    assert.ok(Math.abs(daysUntil(dated.expires_at) - 7) < 0.01, "it carries the seven-day window the sweep always stamped");

    const custody = s.platform.enableCustody(owner(A), A.bot.id, { private_key_pem: A.kp.privateKeyPem });
    assert.equal(custody.kid, "k1", "adoption took over the dated key");
    assert.equal(custody.mode, "uploaded");

    const adopted = keyRows(s, A.bot.id).find((k) => k.kid === custody.kid);
    assert.equal(adopted.expires_at, null, "the platform's signing identity carries no deadline once adopted");
    assert.equal(adopted.status, "active", "and it is still the active key");
    const fresh = keyRows(s, A.bot.id).find((k) => k.kid === "k-two");
    assert.equal(fresh.expires_at, null, "the key added after it is untouched: only the adopted row changes");

    const sent = await sendAsOwner(s.base, A, B);
    assert.equal(sent.status, 202, `the platform signs with the adopted identity: ${JSON.stringify(sent.body)}`);
  } finally { await s.stop(); }
});

test("a key whose window already closed is still refused, keeps its date and leaves the Bot non-custodial", async () => {
  const s = await startServer();
  try {
    const { A } = await friends(s.base);
    const added = await req(s.base, "POST", `/v1/bots/${A.bot.id}/keys`, token(A), { kid: "k-two", value: generateEd25519().publicKey, retire_others_in_days: 0 });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    // Put the window definitively in the past instead of racing the zero-day stamp.
    const closedAt = new Date(Date.now() - 60e3).toISOString();
    s.platform.db.prepare("UPDATE bot_keys SET expires_at = ? WHERE bot_id = ? AND kid = 'k1'").run(closedAt, A.bot.id);
    const closed = keyRows(s, A.bot.id).find((k) => k.kid === "k1");
    assert.equal(closed.expires_at, closedAt, "the closed window is on the row");

    refusesWith(() => s.platform.enableCustody(owner(A), A.bot.id, { private_key_pem: A.kp.privateKeyPem }), 400, "key_not_registered");

    assert.equal(keyRows(s, A.bot.id).find((k) => k.kid === "k1").expires_at, closedAt, "a refused adoption does not clear the date either");
    assert.deepEqual(custodyRows(s, A.bot.id), [], "the Bot is still not custodial: fail-closed");
  } finally { await s.stop(); }
});

test("a key with no deadline is adopted unchanged", async () => {
  const s = await startServer();
  try {
    const { A, B } = await friends(s.base);
    assert.equal(keyRows(s, A.bot.id).find((k) => k.kid === "k1").expires_at, null, "a freshly registered key has no window");
    const custody = s.platform.enableCustody(owner(A), A.bot.id, { private_key_pem: A.kp.privateKeyPem });
    assert.equal(custody.kid, "k1");
    assert.equal(keyRows(s, A.bot.id).find((k) => k.kid === custody.kid).expires_at, null, "adoption adds no deadline either");
    assert.equal((await sendAsOwner(s.base, A, B)).status, 202, "and the adopted identity signs");
  } finally { await s.stop(); }
});

test("a revoked key is still refused, and so is a key of the wrong Bot", async () => {
  const s = await startServer();
  try {
    const A = await ownerWithBot(s.base, "revoked");
    const elsewhere = await ownerWithBot(s.base, "elsewhere");
    const rev = await req(s.base, "DELETE", `/v1/bots/${A.bot.id}/keys/k1`, token(A));
    assert.equal(rev.status, 200, JSON.stringify(rev.body));
    assert.equal(keyRows(s, A.bot.id).find((k) => k.kid === "k1").status, "revoked");

    refusesWith(() => s.platform.enableCustody(owner(A), A.bot.id, { private_key_pem: A.kp.privateKeyPem }), 400, "key_not_registered");
    assert.deepEqual(custodyRows(s, A.bot.id), [], "a revoked key cannot become the platform's signing identity");

    // Another Bot's key never matches this Bot's row, so it is the same refusal.
    refusesWith(() => s.platform.enableCustody(owner(A), A.bot.id, { private_key_pem: elsewhere.kp.privateKeyPem }), 400, "key_not_registered");
    assert.deepEqual(custodyRows(s, A.bot.id), []);
  } finally { await s.stop(); }
});
