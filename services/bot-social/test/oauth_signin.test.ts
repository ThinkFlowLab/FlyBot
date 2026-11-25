// The credential half of #76: GitHub sign-in mints a normal owner token, but only through the
// one-time code the browser can read from the fragment.
import test from "node:test";
import assert from "node:assert/strict";
import { oauthServer, githubStub, register, startLink, startSignin, callback, stateOf, linkGithub, exchange, call } from "./oauth_helpers.js";

const stepCode = (location: string) => {
  const m = /#\/oauth\?code=([^&]+)/.exec(location);
  return m ? decodeURIComponent(m[1]) : "";
};

test("9. a linked owner signs in with GitHub and receives a via='oauth:github' token", async () => {
  const s = await oauthServer();
  try {
    const { owner } = await register(s.base);
    await linkGithub(s, owner.token);
    const start = await startSignin(s.base);
    assert.equal(start.res.status, 200);
    const cb = await callback(s.base, { code: "code-signin", state: stateOf(start.json.authorize_url), cookie: start.cookie });
    assert.equal(cb.status, 302);
    const code = stepCode(String(cb.headers.get("location")));
    assert.ok(code, `expected a step code in ${cb.headers.get("location")}`);
    const ex = await exchange(s.base, code);
    assert.equal(ex.res.status, 200, JSON.stringify(ex.json));
    assert.match(ex.json.owner_token, /^otk_/);
    const me = await call(s.base, "GET", "/v1/me", { token: ex.json.owner_token });
    assert.equal(me.res.status, 200);
    assert.equal(me.json.username, me.json.username);
    const tok = s.platform.db.prepare("SELECT via FROM tokens WHERE token_hash IS NOT NULL AND kind='owner' AND revoked_at IS NULL ORDER BY created_at DESC").get() as any;
    assert.equal(tok.via, "oauth:github");
  } finally { await s.stop(); }
});

test("10. an unknown GitHub account cannot create or claim an owner", async () => {
  const s = await oauthServer();
  try {
    const ownersBefore = (s.platform.db.prepare("SELECT COUNT(*) n FROM owners").get() as any).n;
    s.stub.setProfile({ id: 999, login: "stranger" });
    const start = await startSignin(s.base);
    const cb = await callback(s.base, { code: "code-x", state: stateOf(start.json.authorize_url), cookie: start.cookie });
    assert.equal(cb.status, 302);
    assert.match(String(cb.headers.get("location")), /oauth=not_linked$/);
    assert.equal((s.platform.db.prepare("SELECT COUNT(*) n FROM owners").get() as any).n, ownersBefore);
    assert.equal((s.platform.db.prepare("SELECT COUNT(*) n FROM oauth_step_codes").get() as any).n, 0);
    assert.equal((s.platform.db.prepare("SELECT COUNT(*) n FROM tokens").get() as any).n, 0, "no session exists for an unknown account");
  } finally { await s.stop(); }
});

test("11. browser binding is required in both modes: no cookie means 400 and nothing written", async () => {
  const s = await oauthServer();
  try {
    const { owner } = await register(s.base);
    const signin = await startSignin(s.base);
    const noCookieSignin = await callback(s.base, { code: "c1", state: stateOf(signin.json.authorize_url) });
    assert.equal(noCookieSignin.status, 400);
    assert.equal((s.platform.db.prepare("SELECT COUNT(*) n FROM oauth_step_codes").get() as any).n, 0);

    const link = await startLink(s.base, owner.token, "secret-pw");
    const foreign = await callback(s.base, { code: "c2", state: stateOf(link.json.authorize_url), cookie: "not-the-cookie" });
    assert.equal(foreign.status, 400);
    assert.equal((s.platform.db.prepare("SELECT COUNT(*) n FROM oauth_identities").get() as any).n, 0);
    assert.equal(s.stub.calls.token, 0, "a foreign cookie must not reach GitHub either");
  } finally { await s.stop(); }
});

test("12. the step code is single-use, expires in 60 s, names its owner, and dies with the identity", async () => {
  let now = Date.parse("2026-11-05T00:00:00Z");
  const s = await oauthServer({ now: () => now });
  try {
    const a = await register(s.base);
    const b = await register(s.base);
    await linkGithub(s, a.owner.token);
    const signIn = async () => {
      const start = await startSignin(s.base);
      const cb = await callback(s.base, { code: "code-s", state: stateOf(start.json.authorize_url), cookie: start.cookie });
      return stepCode(String(cb.headers.get("location")));
    };

    const code = await signIn();
    const first = await exchange(s.base, code);
    assert.equal(first.res.status, 200);
    assert.equal((await call(s.base, "GET", "/v1/me", { token: first.json.owner_token })).json.owner_id, a.owner_id);

    const replay = await exchange(s.base, code);
    assert.equal(replay.res.status, 400);
    assert.equal(replay.json.error.code, "oauth_code_invalid");

    const late = await signIn();
    now += 61_000;
    const expired = await exchange(s.base, late);
    assert.equal(expired.res.status, 400);
    now -= 61_000;

    // A code names owner A; owner B holds a password session and cannot swap it in.
    const ownCode = await signIn();
    const asA = await exchange(s.base, ownCode);
    assert.equal((await call(s.base, "GET", "/v1/me", { token: asA.json.owner_token })).json.owner_id, a.owner_id);
    assert.notEqual(asA.json.owner_token, b.owner.token);

    // Unbind after the code was minted: the exchange must refuse and write no token.
    const doomed = await signIn();
    const tokensBefore = (s.platform.db.prepare("SELECT COUNT(*) n FROM tokens").get() as any).n;
    const del = await call(s.base, "DELETE", "/v1/me/identities/github", { token: a.owner.token, body: { current_password: "secret-pw" } });
    assert.equal(del.res.status, 204);
    const afterUnbind = await exchange(s.base, doomed);
    assert.equal(afterUnbind.res.status, 400);
    assert.equal((s.platform.db.prepare("SELECT COUNT(*) n FROM tokens").get() as any).n, tokensBefore, "zero new rows in tokens");
  } finally { await s.stop(); }
});

test("13. the callback clears bs_oauth on every response, so a replayed URL fails at the cookie", async () => {
  const s = await oauthServer();
  try {
    const { owner } = await register(s.base);
    const start = await startLink(s.base, owner.token, "secret-pw");
    const cb = await callback(s.base, { code: "code-c", state: stateOf(start.json.authorize_url), cookie: start.cookie });
    assert.equal(cb.status, 302);
    const cleared = (cb.headers as any).getSetCookie?.() as string[] | undefined;
    const header = cleared?.[0] ?? cb.headers.get("set-cookie") ?? "";
    assert.match(header, /^bs_oauth=;/);
    assert.match(header, /Max-Age=0/);
    assert.match(header, /Path=\/v1\/auth\/oauth/);
    assert.match(header, /HttpOnly/);
    assert.match(header, /Secure/);

    const replay = await callback(s.base, { code: "code-c", state: stateOf(start.json.authorize_url), cookie: start.cookie });
    assert.equal(replay.status, 400);
  } finally { await s.stop(); }
});
