// `registerOwner` and `login` hand `body.username` straight to a bound SQL parameter. A body that is well-formed JSON
// but names the field with an object or a boolean never reached a type gate: login returned a 500 `internal_error`
// (better-sqlite3 read the object as a named-parameter bag, and refused the boolean), and registration accepted an
// array because `/…/.test(["ab"])` stringifies it, so `{"username":["ab"]}` created an owner named "ab". A username is
// a string; anything else is a 400 `invalid_request` refused before a statement is prepared, and before anything is
// written.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startServer } from "./helpers.js";

async function call(base: string, path: string, body: unknown) {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, text, json: JSON.parse(text) as any };
}

const isStringRefusal = (r: { status: number; json: any }) =>
  r.status === 400 && r.json?.error?.code === "invalid_request" && r.json?.error?.message === "username must be a string";

/** Nothing a refused request echoes back: the envelope carries a code and a sentence, never the sent value or a stack. */
function assertPlainRefusal(r: { text: string }) {
  assert.doesNotMatch(r.text, /stack|internal_error|Too few parameter|SQLite3/i, r.text);
}

function counts(platform: any) {
  const one = (sql: string) => (platform.db.prepare(sql).get() as any).n as number;
  return {
    owners: one("SELECT COUNT(*) n FROM owners"),
    tokens: one("SELECT COUNT(*) n FROM tokens"),
    audit: (platform.audit.db.prepare("SELECT COUNT(*) n FROM audit_events").get() as any).n as number,
  };
}

test("a login naming the username with an object is a 400, not a 500", async (t) => {
  const s = await startServer();
  t.after(s.stop);

  const r = await call(s.base, "/v1/auth/login", { username: {}, password: "x" });
  assert.equal(r.status, 400, r.text);
  assert.ok(isStringRefusal(r), r.text);
  assertPlainRefusal(r);
  assert.deepEqual(Object.keys(r.json.error), ["code", "message"], "the ordinary error envelope, nothing else");
});

test("a login naming the username with a boolean is a 400, not a 500", async (t) => {
  const s = await startServer();
  t.after(s.stop);

  const r = await call(s.base, "/v1/auth/login", { username: true, password: "x" });
  assert.equal(r.status, 400, r.text);
  assert.ok(isStringRefusal(r), r.text);
  assertPlainRefusal(r);
});

test("registering with a boolean username is a 400 and writes nothing", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const before = counts(s.platform);

  const r = await call(s.base, "/v1/owners", { username: true, password: "secret-pw", display_name: "T" });
  assert.equal(r.status, 400, r.text);
  assert.ok(isStringRefusal(r), r.text);
  assertPlainRefusal(r);
  assert.deepEqual(counts(s.platform), before, "no owner, token or audit row from a refused registration");
});

test("registering with an array username is a 400 and does not register the coerced name", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const before = counts(s.platform);

  const r = await call(s.base, "/v1/owners", { username: ["ab"], password: "secret-pw", display_name: "T" });
  assert.equal(r.status, 400, r.text);
  assert.ok(isStringRefusal(r), r.text);
  assertPlainRefusal(r);
  assert.equal((s.platform.db.prepare("SELECT COUNT(*) n FROM owners WHERE username = 'ab'").get() as any).n, 0, 'no owner was created under the stringified name "ab"');
  assert.deepEqual(counts(s.platform), before, "no owner, token or audit row from a refused registration");
});

test("a normal registration still registers and logs in", async (t) => {
  const s = await startServer();
  t.after(s.stop);

  const reg = await call(s.base, "/v1/owners", { username: "ok-user", password: "secret-pw", display_name: "Ok" });
  assert.equal(reg.status, 201, reg.text);
  const login = await call(s.base, "/v1/auth/login", { username: "ok-user", password: "secret-pw" });
  assert.equal(login.status, 200, login.text);
  assert.equal(login.json.owner_id, reg.json.owner_id);

  const me = await fetch(`${s.base}/v1/me`, { headers: { authorization: `Bearer ${login.json.owner_token}` } });
  assert.equal(me.status, 200);
  assert.equal(((await me.json()) as any).username, "ok-user");
});

test("the refusals that predate this gate keep their status, code and message", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const before = counts(s.platform);

  const taken = await call(s.base, "/v1/owners", { username: "ok-user", password: "secret-pw" });
  assert.equal(taken.status, 201, taken.text);

  const cases: Array<[string, unknown, string]> = [
    ["{}", {}, "username: 2-32 chars [a-z0-9._-]"],
    ['{"username":"x"}', { username: "x" }, "username: 2-32 chars [a-z0-9._-]"],
    ['{"username":"ok-user"}', { username: "ok-user" }, "password must be >= 6 chars"],
    ['{"username":"ok-user","password":123456}', { username: "ok-user", password: 123456 }, "password must be >= 6 chars"],
  ];
  const afterValidRegistration = counts(s.platform);
  for (const [label, body, message] of cases) {
    const r = await call(s.base, "/v1/owners", body);
    assert.equal(r.status, 400, `${label} -> ${r.text}`);
    assert.deepEqual(r.json, { error: { code: "invalid_request", message } }, label);
  }
  assert.deepEqual(counts(s.platform), afterValidRegistration, "none of the refused bodies wrote a row");
  assert.ok(afterValidRegistration.owners > before.owners, "the one expected registration did land");
});

test("a missing username, a bad password and an unknown user are still 401, not a bad request", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const before = counts(s.platform);

  await call(s.base, "/v1/owners", { username: "pw-owner", password: "secret-pw" });
  // An absent username is a missing field, not a wrongly typed one: the login answers the 401 it always did.
  for (const body of [{}, { username: "pw-owner", password: "nope" }, { username: "no-such-owner", password: "secret-pw" }]) {
    const r = await call(s.base, "/v1/auth/login", body);
    assert.equal(r.status, 401, `${JSON.stringify(body)} -> ${r.text}`);
    assert.equal(r.json.error.code, "invalid_credentials");
  }
  assert.equal(counts(s.platform).owners, before.owners + 1, "the failed logins wrote no owner");
});

test("an existing session and /v1/me keep working after refused attempts", async (t) => {
  const s = await startServer();
  t.after(s.stop);

  const reg = await call(s.base, "/v1/owners", { username: "session-owner", password: "secret-pw" });
  assert.equal(reg.status, 201, reg.text);
  const token = reg.json.owner_token as string;

  for (const body of [{ username: {}, password: "x" }, { username: true, password: "x" }, { username: ["ab"], password: "secret-pw" }]) {
    const r = await call(s.base, "/v1/auth/login", body);
    assert.notEqual(r.status, 200, "a refused body never mints a token");
    assert.equal(r.json.owner_token, undefined);
  }

  const me = await fetch(`${s.base}/v1/me`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(me.status, 200, "the session issued before the refusals still works");
  assert.equal(((await me.json()) as any).username, "session-owner");
  const again = await call(s.base, "/v1/auth/login", { username: "session-owner", password: "secret-pw" });
  assert.equal(again.status, 200, "and the account still logs in normally");
});
