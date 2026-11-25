// `/v1/onboard` and `/v1/onboard/flybot` declare `bot_handle` as a string, but the value reaches
// `handleKey` (`String(ref ?? "")`) through `body.bot_handle || <default>`: `true` is registered as `@true`,
// `1.5` as `@1.5` and `["xy"]` as `@xy`, so the owner's first Bot — the handle every friend, grant and room
// list reads back — is one nobody named. `0` and `false` are falsy, so the same line answers with the default
// instead, without saying so. A handle is a string: anything else is a 400 `invalid_request`
// "bot_handle must be a string", refused before the owner row, the Bot, its key, the custody row, the tokens
// and the audit lines; an absent, `null` or empty handle keeps the default it always had — `<username>.bot`
// on /v1/onboard, `<base>.home` on /v1/onboard/flybot.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bulkAuth, startServer } from "./helpers.js";

const bad: [string, unknown][] = [
  ["a boolean true", true],
  ["a fraction", 1.5],
  ["an object", {}],
  ["an empty array", []],
  ["an array holding a handle", ["xy"]],
  ["an array holding an empty string", [""]],
  ["zero", 0],
  ["false", false],
];

/** Every row a refused onboarding must not write: the owner, the Bot, its signing key, the tokens, the custody
 *  row and the audit lines. */
function rows(p: any) {
  const one = (db: any, sql: string) => (db.prepare(sql).get() as any).n as number;
  return {
    owners: one(p.db, "SELECT COUNT(*) n FROM owners"),
    bots: one(p.db, "SELECT COUNT(*) n FROM bots"),
    botKeys: one(p.db, "SELECT COUNT(*) n FROM bot_keys"),
    tokens: one(p.db, "SELECT COUNT(*) n FROM tokens"),
    custody: one(p.db, "SELECT COUNT(*) n FROM bot_custody"),
    audit: one(p.audit.db, "SELECT COUNT(*) n FROM audit_events"),
  };
}

const isHandleRefusal = (r: { status: number; body: any }) =>
  r.status === 400 && r.body?.error?.code === "invalid_request" && r.body?.error?.message === "bot_handle must be a string";

async function post(base: string, path: string, body: unknown) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: (await res.json()) as any };
}

for (const [label, value] of bad) {
  test(`/v1/onboard refuses a bot_handle given as ${label}`, async (t) => {
    const s = await startServer(bulkAuth);
    t.after(s.stop);
    const before = rows(s.platform);
    const r = await post(s.base, "/v1/onboard", { display_name: "Wes", password: "secret-pw", bot_handle: value });
    assert.ok(isHandleRefusal(r), `expected 400 bot_handle must be a string, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.deepEqual(rows(s.platform), before, "a refused onboarding writes no owner, Bot, key, token, custody or audit row");
  });
}

test("/v1/onboard/flybot refuses the same non-string shapes", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  for (const [label, value] of bad) {
    const before = rows(s.platform);
    const r = await post(s.base, "/v1/onboard/flybot", { display_name: "Wes", password: "secret-pw", bot_handle: value });
    assert.ok(isHandleRefusal(r), `${label}: expected 400 bot_handle must be a string, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.deepEqual(rows(s.platform), before, `${label}: a refused onboarding writes no owner, Bot, key, token, custody or audit row`);
  }
});

test("an absent, null or empty bot_handle keeps the default on both routes", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const absent = await post(s.base, "/v1/onboard", { username: "deffault1", password: "secret-pw" });
  assert.equal(absent.status, 201);
  assert.equal(absent.body.bot.handle, "@deffault1.bot");
  const nul = await post(s.base, "/v1/onboard", { username: "deffault2", password: "secret-pw", bot_handle: null });
  assert.equal(nul.status, 201);
  assert.equal(nul.body.bot.handle, "@deffault2.bot");
  const empty = await post(s.base, "/v1/onboard", { username: "deffault3", password: "secret-pw", bot_handle: "" });
  assert.equal(empty.status, 201);
  assert.equal(empty.body.bot.handle, "@deffault3.bot");
  // The flybot route's default is the home `<base>.home`, derived from display_name or username.
  const home = await post(s.base, "/v1/onboard/flybot", { display_name: "HomeOne", password: "secret-pw" });
  assert.equal(home.status, 201);
  assert.equal(home.body.home.handle, "@homeone.home");
  const homeNull = await post(s.base, "/v1/onboard/flybot", { display_name: "HomeTwo", password: "secret-pw", bot_handle: null });
  assert.equal(homeNull.status, 201);
  assert.equal(homeNull.body.home.handle, "@hometwo.home");
  const homeEmpty = await post(s.base, "/v1/onboard/flybot", { display_name: "HomeThree", password: "secret-pw", bot_handle: "" });
  assert.equal(homeEmpty.status, 201);
  assert.equal(homeEmpty.body.home.handle, "@homethree.home");
});

test("a string bot_handle still registers exactly that handle on both routes", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const local = await post(s.base, "/v1/onboard", { username: "okname1", password: "secret-pw", bot_handle: "@MiXed.Handle" });
  assert.equal(local.status, 201, JSON.stringify(local.body));
  assert.equal(local.body.bot.handle, "@mixed.handle");
  const home = await post(s.base, "/v1/onboard/flybot", { display_name: "Wes", password: "secret-pw", bot_handle: "named.home" });
  assert.equal(home.status, 201, JSON.stringify(home.body));
  assert.equal(home.body.home.handle, "@named.home", "a named string still beats the <base>.home default");
});

test("a taken handle is still a 409 on /v1/onboard and writes nothing", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const first = await post(s.base, "/v1/onboard", { username: "takenone", password: "secret-pw", bot_handle: "taken.one" });
  assert.equal(first.status, 201);
  assert.equal(first.body.bot.handle, "@taken.one");
  const before = rows(s.platform);
  const second = await post(s.base, "/v1/onboard", { username: "takentwo", password: "secret-pw", bot_handle: "TAKEN.ONE" });
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, "handle_taken");
  assert.deepEqual(rows(s.platform), before, "the refused onboarding writes no owner, Bot, key, token, custody or audit row");
});

test("a string handle's own format gate is unchanged", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  for (const value of ["a".repeat(41), "bad handle", "x"]) {
    const before = rows(s.platform);
    const r = await post(s.base, "/v1/onboard", { display_name: "Wes", password: "secret-pw", bot_handle: value });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.error.message, "bot handle: 2-40 chars [a-z0-9._-]");
    assert.deepEqual(rows(s.platform), before, "a refused format writes nothing");
  }
});
