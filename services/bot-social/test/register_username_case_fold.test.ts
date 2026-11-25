// A username is one account whatever its spelling. Registration compared the exact string, while the sign-in
// budget folds every spelling onto one lowercased key — so "frank" and "Frank" could both register and then share
// one account budget: five wrong passwords against "Frank" answer 429 for "frank".
import assert from "node:assert/strict";
import { test } from "node:test";
import { bulkAuth, startServer } from "./helpers.js";

async function postRaw(base: string, path: string, body: unknown) {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, text, body: text ? JSON.parse(text) : {} };
}

async function post(base: string, path: string, body: unknown) {
  const { status, body: parsed } = await postRaw(base, path, body);
  return { status, body: parsed };
}

const reg = (base: string, username: string, extra: Record<string, unknown> = {}) =>
  post(base, "/v1/owners", { username, password: "secret-pw", ...extra });

const regRaw = (base: string, username: string) =>
  postRaw(base, "/v1/owners", { username, password: "secret-pw" });

test("a spelling that folds onto an existing name is taken, not a second account", async (t) => {
  const S = await startServer(bulkAuth);
  t.after(S.stop);

  const first = await reg(S.base, "frank");
  assert.equal(first.status, 201, JSON.stringify(first.body));

  // The refusal an exact repeat has always produced: a folding spelling must answer with this same body, so the
  // reply cannot be used to tell "already taken" from "taken under another spelling" (an enumeration oracle).
  const exact = await regRaw(S.base, "frank");
  assert.equal(exact.status, 409, exact.text);
  assert.equal(exact.body.error?.code, "username_taken");

  for (const spelling of ["Frank", "FRANK", "fRaNk"]) {
    const again = await regRaw(S.base, spelling);
    assert.equal(again.status, 409, `${spelling} must not open a second account: ${again.text}`);
    assert.equal(again.body.error?.code, "username_taken", `${spelling} names the refusal`);
    assert.equal(again.text, exact.text, `${spelling} answers byte for byte as an exact repeat does`);
  }
});

test("the check does not refuse names that only look alike", async (t) => {
  const S = await startServer(bulkAuth);
  t.after(S.stop);

  const taken = await reg(S.base, "grace");
  assert.equal(taken.status, 201, JSON.stringify(taken.body));

  // Same spelling again: the refusal it always gave.
  const exact = await reg(S.base, "grace");
  assert.equal(exact.status, 409, JSON.stringify(exact.body));
  assert.equal(exact.body.error?.code, "username_taken");

  // Another word, another mixed-case name, and a name whose display label carries spaces: all still free.
  assert.equal((await reg(S.base, "gracie")).status, 201);
  assert.equal((await reg(S.base, "Ivy.Wu")).status, 201, "a mixed-case name with no twin registers");
  const spaced = await reg(S.base, "zoe_q", { display_name: "Zoe Q Public" });
  assert.equal(spaced.status, 201, JSON.stringify(spaced.body));

  // The mixed-case account signs in with its own spelling, exactly as it always did.
  const login = await post(S.base, "/v1/auth/login", { username: "Ivy.Wu", password: "secret-pw" });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  assert.ok(login.body.owner_token, "the exact spelling still signs in");
});
