// `POST /v1/bots/:id/keys` takes `retire_others_in_days` from the caller and feeds it straight into a
// `new Date(...)` that re-dates every key already on the Bot. Garbage ("abc") reached `toISOString()` as an
// invalid date and answered 500 on a write path; 0 or -5 wrote an expiry in the past while the rows still read
// `active`, so every existing key stopped signing and nothing said why. These tests pin the door: the field is a
// whole number of days in [0, 365], or absent/null for the one-week default, refused with 400 before anything is
// written — and they check the consequence end to end (the old key still signs, or, for 0, no longer does), not
// merely the status code. 0 stays legal with its meaning: the other keys expire at once.
import assert from "node:assert/strict";
import { test } from "node:test";
import { generateEd25519 } from "../src/crypto.js";
import { friends, startServer } from "./helpers.js";

const DAY = 86400e3;
const token = (o: any) => o.owner.token;

/** The key-management route as the console and botctl call it: owner token, body only. */
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

/** The Bot's key rows as the platform stores them: kid, status and expiry. */
const keyRows = (s: any, botId: string) =>
  (s.platform.db.prepare("SELECT kid, status, expires_at FROM bot_keys WHERE bot_id = ? ORDER BY created_at").all(botId) as any[])
    .map((r) => ({ kid: r.kid, status: r.status, expires_at: r.expires_at }));

/** How many days from now a stored expiry is, so a window can be compared without pinning the clock. */
const daysUntil = (iso: string) => (Date.parse(iso) - Date.now()) / DAY;

/** A signed call the Bot's own key makes: proof that the key on the row can still be used, or that it cannot. */
const signs = (a: any, b: any, summary: string) => a.bot.startConversation(b.bot.id, { type: "general_chat", summary });

for (const [label, value] of [["a word", "abc"], ["a negative day count", -5], ["a fraction of a day", 1.5], ["a window past the date range", 1e15]] as const) {
  test(`a retirement window that is ${label} is refused with 400 before any key row changes`, async () => {
    const s = await startServer();
    try {
      const { A, B } = await friends(s.base);
      const before = keyRows(s, A.bot.id);
      const r = await req(s.base, "POST", `/v1/bots/${A.bot.id}/keys`, token(A), { kid: "k-two", value: generateEd25519().publicKey, retire_others_in_days: value });
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal(r.body.code, "invalid_request", "the refusal is an input error, not a server fault");
      assert.match(String(r.body.message), /retire_others_in_days/, "the refusal names the field to fix");
      assert.deepEqual(keyRows(s, A.bot.id), before, "no key row was written and no existing key was re-dated");
      assert.ok((await signs(A, B, "the old key still signs")).conversation_id, "the key already on the Bot still signs");
    } finally { await s.stop(); }
  });
}

test("a window of 0 is legal and means the keys already on the Bot expire at once", async () => {
  const s = await startServer();
  try {
    const { A, B } = await friends(s.base);
    assert.ok((await signs(A, B, "before the rotation")).conversation_id, "the old key signs before the rotation");
    const added = await req(s.base, "POST", `/v1/bots/${A.bot.id}/keys`, token(A), { kid: "k-two", value: generateEd25519().publicKey, retire_others_in_days: 0 });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    const old = keyRows(s, A.bot.id).find((r) => r.kid === "k1");
    assert.ok(old, "the key that was already on the Bot is still a row");
    assert.equal(old.status, "active", "it is not revoked: only its window closed");
    assert.ok(old.expires_at, "it now carries an expiry");
    assert.ok(Date.parse(old.expires_at) <= Date.now() + 1000, "and that expiry is now, not a week away");
    await assert.rejects(() => signs(A, B, "after the rotation"), (e: any) => {
      assert.equal(e.status, 401, "the next signed call is refused");
      assert.equal(e.code, "invalid_signature");
      assert.match(String(e.message), /unknown, revoked or expired kid/, "because the key is active but expired");
      return true;
    });
  } finally { await s.stop(); }
});

for (const [label, value, days] of [["left out", undefined, 7], ["null", null, 7], ["3", 3, 3]] as const) {
  test(`a retirement window of ${label} keeps the old key signable for ${days} day(s)`, async () => {
    const s = await startServer();
    try {
      const { A, B } = await friends(s.base);
      const added = await req(s.base, "POST", `/v1/bots/${A.bot.id}/keys`, token(A), {
        kid: "k-two", value: generateEd25519().publicKey, ...(value === undefined ? {} : { retire_others_in_days: value }),
      });
      assert.equal(added.status, 201, JSON.stringify(added.body));
      const old = keyRows(s, A.bot.id).find((r) => r.kid === "k1");
      assert.ok(old, "the key that was already on the Bot is still a row");
      assert.equal(old.status, "active");
      assert.ok(old.expires_at, "it now carries an expiry");
      const window = daysUntil(old.expires_at);
      assert.ok(Math.abs(window - days) < 0.01, `the old key's window is ${days} days, got ${window}`);
      assert.ok((await signs(A, B, "inside the window")).conversation_id, "the old key still signs inside its window");
    } finally { await s.stop(); }
  });
}
