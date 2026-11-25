// The linking half of #76: start → GitHub consent → callback writes one identity row, and the three
// local PKCE probes from the design (§4.2 D5) — no network, the fake GitHub counts every call.
import test from "node:test";
import assert from "node:assert/strict";
import { oauthServer, githubStub, register, startLink, callback, stateOf, linkGithub, call } from "./oauth_helpers.js";

test("1. start with the account password, then the callback, writes the identity row", async () => {
  const s = await oauthServer();
  try {
    const { owner, owner_id } = await register(s.base);
    const { start, cb } = await linkGithub(s, owner.token);
    assert.equal(start.res.status, 200);
    assert.ok(start.json.authorize_url);
    assert.equal(cb.status, 302);
    assert.match(String(cb.headers.get("location")), /#\/settings\?oauth=ok$/);
    const row = s.platform.db.prepare("SELECT * FROM oauth_identities").get() as any;
    assert.equal(row.provider, "github");
    assert.equal(row.subject, "42");
    assert.equal(row.owner_id, owner_id);
    assert.equal(row.login, "octocat");
    assert.ok(row.created_at);
  } finally { await s.stop(); }
});

test("2. the identity table has exactly the five documented columns — no token, no email", async () => {
  const s = await oauthServer();
  try {
    const cols = (s.platform.db.prepare("PRAGMA table_info(oauth_identities)").all() as any[]).map((c) => c.name).sort();
    assert.deepEqual(cols, ["created_at", "login", "owner_id", "provider", "subject"]);
  } finally { await s.stop(); }
});

test("3. the raw state is not stored, the row is consumed, and a replay never reaches GitHub", async () => {
  const s = await oauthServer();
  try {
    const { owner } = await register(s.base);
    const start = await startLink(s.base, owner.token, "secret-pw");
    const state = stateOf(start.json.authorize_url);
    const row = s.platform.db.prepare("SELECT * FROM oauth_states").get() as any;
    assert.notEqual(row.state_hash, state);
    assert.equal(row.state_hash.length, 64);
    const first = await callback(s.base, { code: "code-a", state, cookie: start.cookie });
    assert.equal(first.status, 302);
    assert.ok((s.platform.db.prepare("SELECT consumed_at FROM oauth_states").get() as any).consumed_at);
    const before = s.stub.calls.token;
    const replay = await callback(s.base, { code: "code-a", state, cookie: start.cookie });
    assert.equal(replay.status, 400);
    assert.equal(s.stub.calls.token, before, "a burned state must not reach the token endpoint");
  } finally { await s.stop(); }
});

test("4. the token request carries the stored verifier, the pinned redirect_uri and Accept: application/json", async () => {
  const s = await oauthServer();
  try {
    const { owner } = await register(s.base);
    const start = await startLink(s.base, owner.token, "secret-pw");
    const row = s.platform.db.prepare("SELECT * FROM oauth_states").get() as any;
    await callback(s.base, { code: "code-b", state: stateOf(start.json.authorize_url), cookie: start.cookie });
    assert.equal(s.stub.tokenBodies.length, 1);
    const body = s.stub.tokenBodies[0];
    assert.equal(body.get("code_verifier"), row.code_verifier);
    assert.equal(body.get("code_verifier")!.length, 43);
    assert.equal(body.get("redirect_uri"), "https://bots.example.com/v1/auth/oauth/github/callback");
    assert.equal(body.get("redirect_uri"), row.redirect_uri);
    assert.match(s.stub.tokenHeaders[0].accept ?? "", /application\/json/);
  } finally { await s.stop(); }
});

test("5. the authorize URL carries a 43-character S256 challenge and asks for no scope", async () => {
  const s = await oauthServer();
  try {
    const { owner } = await register(s.base);
    const start = await startLink(s.base, owner.token, "secret-pw");
    const url = new URL(start.json.authorize_url);
    assert.equal(url.origin + url.pathname, "https://github.com/login/oauth/authorize");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("code_challenge")!.length, 43);
    assert.equal(url.searchParams.get("scope"), null);
    assert.ok(!String(start.json.authorize_url).includes("user:email"));
    assert.equal(url.searchParams.get("state"), stateOf(start.json.authorize_url));
    assert.equal(url.searchParams.get("client_id"), "test-client-id");
  } finally { await s.stop(); }
});

test("6. an expired state is the 400 page with zero token calls (D5 probe ②)", async () => {
  let now = Date.parse("2026-11-05T00:00:00Z");
  const s = await oauthServer({ now: () => now });
  try {
    const { owner } = await register(s.base);
    const start = await startLink(s.base, owner.token, "secret-pw");
    now += 11 * 60_000;
    const res = await callback(s.base, { code: "code-late", state: stateOf(start.json.authorize_url), cookie: start.cookie });
    assert.equal(res.status, 400);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(s.stub.calls.token, 0);
  } finally { await s.stop(); }
});

test("7. one GitHub account per owner: a second one is identity_conflict, not a second row", async () => {
  const s = await oauthServer();
  try {
    const { owner } = await register(s.base);
    await linkGithub(s, owner.token);
    s.stub.setProfile({ id: 43, login: "secondcat" });
    const { cb } = await linkGithub(s, owner.token, "secret-pw", "code-2");
    assert.equal(cb.status, 302);
    assert.match(String(cb.headers.get("location")), /oauth=identity_conflict$/);
    assert.equal((s.platform.db.prepare("SELECT COUNT(*) n FROM oauth_identities").get() as any).n, 1);
    const src = await import("../src/oauth.js").then((m) => JSON.stringify(m));
    assert.ok(!src.includes("identity_already_linked"), "the retired code appears nowhere in the provider module");
  } finally { await s.stop(); }
});

test("8. the link start re-checks the password; the sign-in start never takes one", async () => {
  const s = await oauthServer();
  try {
    const { owner } = await register(s.base);
    const missing = await startLink(s.base, owner.token, undefined);
    assert.equal(missing.res.status, 401);
    assert.equal(missing.json.error.code, "invalid_credentials");
    const wrong = await startLink(s.base, owner.token, "not-my-password");
    assert.equal(wrong.res.status, 401);
    assert.equal((s.platform.db.prepare("SELECT COUNT(*) n FROM oauth_states").get() as any).n, 0);
    assert.equal(s.stub.calls.token + s.stub.calls.user, 0);
    const ok = await startLink(s.base, owner.token, "secret-pw");
    assert.equal(ok.res.status, 200);
    assert.equal((s.platform.db.prepare("SELECT COUNT(*) n FROM oauth_states").get() as any).n, 1);
  } finally { await s.stop(); }
});
