// `registerBot` is the door behind `POST /v1/bots`, the one call that mints a Bot's globally unique handle. The body
// declares `handle` as a string, but nothing checks it: `handleKey` runs `String(ref ?? "")`, so `true` becomes
// "true", `1.5` becomes "1.5" and `["xy"]` becomes "xy", the format check accepts those, and the call answers 201
// with a live Bot at a handle the caller never wrote — a handle every friend request, invite and room list reads
// back, and one that blocks the real `@true` from being registered later. A handle is a string; anything else is a
// 400 `invalid_request` "handle must be a string" refused before the format check, the handle claim, the bot row,
// the key and the audit line. An absent or `null` handle keeps the "2-40 chars" answer it always had, and a string
// handle keeps the `@` strip, the lowercasing and the `handle_taken` refusal unchanged.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startServer, bulkAuth } from "./helpers.js";

function counts(p: any) {
  const one = (db: any, sql: string) => (db.prepare(sql).get() as any).n as number;
  return {
    bots: one(p.db, "SELECT COUNT(*) n FROM bots"),
    botKeys: one(p.db, "SELECT COUNT(*) n FROM bot_keys"),
    botTokens: one(p.db, "SELECT COUNT(*) n FROM tokens WHERE kind = 'bot'"),
    custody: one(p.db, "SELECT COUNT(*) n FROM bot_custody"),
    registered: one(p.audit.db, "SELECT COUNT(*) n FROM audit_events WHERE action = 'bot.registered'"),
  };
}

/** One owner on a private server; the door only needs a login token and an empty shop. */
async function ownerOnServer(t: any) {
  const s = await startServer(bulkAuth as any);
  t.after(s.stop);
  const r = await fetch(s.base + "/v1/owners", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "probe", password: "secret-pw", display_name: "Probe" }),
  });
  const owner = (await r.json()) as any;
  const post = async (body: unknown) => {
    const res = await fetch(s.base + "/v1/bots", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.owner_token}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as any };
  };
  return { s, p: s.platform as any, post };
}

const err = (r: { body: any }) => r.body.error ?? {};
const isHandleTypeRefusal = (r: { status: number; body: any }) =>
  r.status === 400 && err(r).code === "invalid_request" && err(r).message === "handle must be a string";

// Every shape the type gate must stop. `true`, the fraction and the bare array are the ones the base accepted and
// wrote a Bot for; the object and the empty forms were already 400 through the format check, and now answer the type
// message before it.
const bad: [string, unknown][] = [
  ["an object", {}],
  ["an array", []],
  ["an array holding an empty string", [""]],
  ["a boolean", true],
  ["a fraction", 1.5],
  ["zero", 0],
  ["an array holding a valid one-letter handle", ["x"]],
  ["an array holding a valid two-letter handle", ["xy"]],
];

for (const [label, value] of bad) {
  test(`a Bot handle given as ${label} is a 400 and writes nothing`, async (t) => {
    const { p, post } = await ownerOnServer(t);
    const before = counts(p);

    const r = await post({ handle: value });
    assert.ok(isHandleTypeRefusal(r), `expected 400 handle must be a string, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.deepEqual(counts(p), before, "no bot, no key, no token, no custody and no audit");
    assert.deepEqual(p.all("SELECT handle FROM bots"), [], "the coerced handle is never claimed");
  });
}

test("a refused boolean handle does not take the handle it would have coerced to", async (t) => {
  const { p, post } = await ownerOnServer(t);

  const refused = await post({ handle: true });
  assert.ok(isHandleTypeRefusal(refused));

  const real = await post({ handle: "true" });
  assert.equal(real.status, 201, "a caller who writes the string still gets @true");
  assert.equal(real.body.handle, "@true");
  assert.equal(p.get("SELECT COUNT(*) n FROM bots").n, 1);
});

test("an absent or null handle keeps the required-handle answer", async (t) => {
  const { p, post } = await ownerOnServer(t);
  const before = counts(p);

  for (const body of [{}, { handle: null }] as unknown[]) {
    const r = await post(body);
    assert.equal(r.status, 400);
    assert.equal(err(r).code, "invalid_request");
    assert.equal(err(r).message, "handle: 2-40 chars [a-z0-9._-]", "unchanged: nothing was named at all");
  }
  assert.deepEqual(counts(p), before, "no bot, no key, no token, no custody and no audit");
});

test("a string handle still registers, with @ stripped and the case folded", async (t) => {
  const { p, post } = await ownerOnServer(t);

  const r = await post({ handle: "@ProbeHandle" });
  assert.equal(r.status, 201);
  assert.equal(r.body.handle, "@probehandle");
  assert.match(r.body.bot_id, /^bot_/);
  assert.ok(r.body.bot_token, "the bot token is still issued");
  assert.deepEqual(p.all("SELECT handle, display_name, integration_type FROM bots"), [
    { handle: "probehandle", display_name: "probehandle", integration_type: "rest" },
  ]);
  assert.equal((p.audit.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action = 'bot.registered'").get() as any).n, 1);
});

test("a taken handle still answers handle_taken", async (t) => {
  const { post } = await ownerOnServer(t);

  assert.equal((await post({ handle: "writer" })).status, 201);
  const again = await post({ handle: "WRITER" });
  assert.equal(again.status, 409);
  assert.equal(err(again).code, "handle_taken");
  assert.equal(err(again).message, "handle @writer is already taken");
});
