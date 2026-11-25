// Error hygiene, query shapes, provider response bounds and the storage-level reverse-proofs.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Platform } from "../src/platform.js";
import { oauthServer, register, startLink, startSignin, callback, stateOf, linkGithub, call } from "./oauth_helpers.js";

test("30. a stale state is a 400 page: html, no-store, no envelope, no echoed values", async () => {
  const s = await oauthServer();
  try {
    const res = await callback(s.base, { code: "SECRET-CODE", state: "SECRET-STATE", cookie: "nope" });
    assert.equal(res.status, 400);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.text();
    assert.ok(!body.includes("SECRET-CODE"));
    assert.ok(!body.includes("SECRET-STATE"));
    assert.ok(!body.includes('"error"'), "the JSON envelope belongs to the API, not to a page");
    assert.ok(body.includes('data-error="oauth_state_invalid"'), "the API code is pinned");
    assert.ok(body.includes("oauth=state_invalid"), "the console namespace is pinned separately");
  } finally { await s.stop(); }
});

test("31. query parameters are single strings when present; a cancellation is a normal shape", async () => {
  const s = await oauthServer();
  try {
    const { owner } = await register(s.base);
    const start = await startLink(s.base, owner.token, "secret-pw");
    const state = stateOf(start.json.authorize_url);
    for (const query of [`code=a&code=b&state=${state}`, `code[]=a&state=${state}`, `code=a&state=x&state=${state}`]) {
      const res = await callback(s.base, { query, cookie: start.cookie });
      assert.equal(res.status, 400, query);
    }
    assert.equal(s.stub.calls.token, 0, "nothing reached GitHub");

    const cancel = await callback(s.base, { error: "access_denied", state, cookie: start.cookie });
    assert.equal(cancel.status, 302);
    assert.match(String(cancel.headers.get("location")), /oauth=cancelled$/);
    assert.equal(s.stub.calls.token, 0);
  } finally { await s.stop(); }
});

test("32. an oversized or non-JSON /user answer is a 502 and writes no identity", async () => {
  const s = await oauthServer();
  try {
    const { owner } = await register(s.base);
    s.stub.setUserMode("huge");
    const first = await linkGithub(s, owner.token, "secret-pw", "code-huge");
    assert.equal(first.cb.status, 502);
    s.stub.setUserMode("html");
    const second = await linkGithub(s, owner.token, "secret-pw", "code-html");
    assert.equal(second.cb.status, 502);
    assert.equal((s.platform.db.prepare("SELECT COUNT(*) n FROM oauth_identities").get() as any).n, 0);
  } finally { await s.stop(); }
});

test("33. the subject must be GitHub's numeric id", async () => {
  const s = await oauthServer();
  try {
    const { owner } = await register(s.base);
    for (const [i, id] of [0, "007", -1, "12345678901234567", "octocat"].entries()) {
      s.stub.setProfile({ id, login: "weird" });
      const { cb } = await linkGithub(s, owner.token, "secret-pw", `code-bad-${i}`);
      assert.equal(cb.status, 502, `id ${String(id)}`);
    }
    assert.equal((s.platform.db.prepare("SELECT COUNT(*) n FROM oauth_identities").get() as any).n, 0);
    s.stub.setProfile({ id: 42, login: "octocat" });
    const good = await linkGithub(s, owner.token, "secret-pw", "code-good");
    assert.equal(good.cb.status, 302);
    assert.equal((s.platform.db.prepare("SELECT COUNT(*) n FROM oauth_identities").get() as any).n, 1);
  } finally { await s.stop(); }
});

test("34. the verifier is NULL after consume — and nullable did not become permissive", async () => {
  const s = await oauthServer();
  try {
    const { owner, owner_id } = await register(s.base);
    await linkGithub(s, owner.token);
    const row = s.platform.db.prepare("SELECT consumed_at, code_verifier FROM oauth_states").get() as any;
    assert.ok(row.consumed_at);
    assert.equal(row.code_verifier, null, "the consume UPDATE nulls it; a NOT NULL column would have thrown");

    const insert = (stateHash: string, verifier: string | null, consumed: string | null) =>
      s.platform.db.prepare(`INSERT INTO oauth_states (state_hash, provider, mode, owner_id, cookie_hash, code_verifier, redirect_uri, created_at, expires_at, consumed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(stateHash, "github", "link", owner_id, "c", verifier,
        "https://bots.example.com/v1/auth/oauth/github/callback", new Date().toISOString(), new Date(Date.now() + 600e3).toISOString(), consumed);
    assert.throws(() => insert("live-null", null, null), /CHECK/i, "a live row with no verifier is refused");
    assert.throws(() => insert("live-empty", "", null), /CHECK/i, "an empty verifier is refused");
    insert("consumed-null", null, new Date().toISOString()); // the only legal NULL: consumed
    assert.equal((s.platform.db.prepare("SELECT COUNT(*) n FROM oauth_states WHERE code_verifier IS NULL").get() as any).n, 2);

    // Unbind removes every state row for the owner+provider, consumed ones included.
    const del = await call(s.base, "DELETE", "/v1/me/identities/github", { token: owner.token, body: { current_password: "secret-pw" } });
    assert.equal(del.res.status, 204);
    assert.equal((s.platform.db.prepare("SELECT COUNT(*) n FROM oauth_states").get() as any).n, 0);
  } finally { await s.stop(); }
});

test("35. upgrading a v1 database adds only the four empty tables, three indexes and tokens.via", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oauth-v1-"));
  const dbPath = join(dir, "v1.db");
  try {
    const before = new Platform({ dbPath, oauth: {} });
    const reg = before.registerOwner({ username: "v1owner", password: "secret-pw", display_name: "V1" });
    const ownerCount = (before.db.prepare("SELECT COUNT(*) n FROM owners").get() as any).n;
    const tokenCount = (before.db.prepare("SELECT COUNT(*) n FROM tokens").get() as any).n;
    const tokenRows = before.db.prepare("SELECT token_hash, kind, subject_id, created_at, revoked_at FROM tokens ORDER BY token_hash").all() as any[];
    // Rebuild the pre-change shape: no OAuth tables/indexes, and a tokens table without `via`.
    before.db.exec(`CREATE TABLE tokens_v1 (token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('owner','bot')),
      subject_id TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT);`);
    before.db.exec("INSERT INTO tokens_v1 SELECT token_hash, kind, subject_id, created_at, revoked_at FROM tokens; DROP TABLE tokens; ALTER TABLE tokens_v1 RENAME TO tokens;");
    before.db.exec("DROP TABLE oauth_identities; DROP TABLE oauth_states; DROP TABLE oauth_step_codes; DROP TABLE oauth_attempts;");
    before.close();

    const after = new Platform({ dbPath, oauth: {} });
    try {
      for (const t of ["oauth_identities", "oauth_states", "oauth_step_codes", "oauth_attempts"]) {
        assert.equal((after.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as any).n, 0, t);
      }
      const names = (after.db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index')").all() as any[]).map((r) => r.name);
      for (const idx of ["oauth_identities_owner", "oauth_states_owner", "oauth_attempts_key"]) assert.ok(names.includes(idx), idx);
      assert.equal((after.db.prepare("SELECT COUNT(*) n FROM owners").get() as any).n, ownerCount);
      assert.equal((after.db.prepare("SELECT COUNT(*) n FROM tokens").get() as any).n, tokenCount);
      const rows = after.db.prepare("SELECT token_hash, kind, subject_id, created_at, revoked_at, via FROM tokens ORDER BY token_hash").all() as any[];
      assert.deepEqual(rows.map(({ via, ...rest }) => rest), tokenRows);
      assert.deepEqual(rows.map((r) => r.via), tokenRows.map(() => "password"));
      assert.ok(reg.owner_token);
    } finally { after.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("36. start and signin answers are no-store", async () => {
  const s = await oauthServer();
  try {
    const { owner } = await register(s.base);
    const start = await startLink(s.base, owner.token, "secret-pw");
    assert.equal(start.res.headers.get("cache-control"), "no-store");
    const signin = await startSignin(s.base);
    assert.equal(signin.res.headers.get("cache-control"), "no-store");
  } finally { await s.stop(); }
});
