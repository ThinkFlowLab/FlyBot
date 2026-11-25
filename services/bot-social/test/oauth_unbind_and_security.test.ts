// Unbind semantics (D4) and the two failure buckets. Test 16 is the only one that opens its own
// database: production `owners.password_hash` is TEXT NOT NULL, so a password-less owner cannot be
// seeded through the real schema. That file-local DDL verifies the last-method predicate only — it is
// not the production schema.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Platform } from "../src/platform.js";
import { buildServer } from "../src/server.js";
import { AddressInfo } from "node:net";
import { hashToken } from "../src/crypto.js";
import { oauthServer, register, startLink, startSignin, callback, stateOf, linkGithub, exchange, call } from "./oauth_helpers.js";

const unlink = (base: string, token: string, body: unknown) => call(base, "DELETE", "/v1/me/identities/github", { token, body });
const stepCode = (location: string) => decodeURIComponent(/#\/oauth\?code=([^&]+)/.exec(location)![1]);

test("14. DELETE without or with a wrong password is 401 and changes nothing; five tries lock it", async () => {
  const s = await oauthServer();
  try {
    const { owner } = await register(s.base);
    await linkGithub(s, owner.token);
    const none = await unlink(s.base, owner.token, {});
    assert.equal(none.res.status, 401);
    assert.equal(none.json.error.code, "invalid_credentials");
    const wrong = await unlink(s.base, owner.token, { current_password: "nope" });
    assert.equal(wrong.res.status, 401);
    assert.equal((s.platform.db.prepare("SELECT COUNT(*) n FROM oauth_identities").get() as any).n, 1);
    for (let i = 0; i < 4; i++) await unlink(s.base, owner.token, { current_password: "nope" });
    const locked = await unlink(s.base, owner.token, { current_password: "secret-pw" });
    assert.equal(locked.res.status, 429);
    assert.equal(locked.json.error.code, "too_many_attempts");
  } finally { await s.stop(); }
});

test("15. DELETE with the password removes the row, revokes oauth sessions, keeps the password session", async () => {
  const s = await oauthServer();
  try {
    const { owner } = await register(s.base);
    await linkGithub(s, owner.token);
    const start = await startSignin(s.base);
    const cb = await callback(s.base, { code: "code-15", state: stateOf(start.json.authorize_url), cookie: start.cookie });
    const oauthToken = (await exchange(s.base, stepCode(String(cb.headers.get("location"))))).json.owner_token as string;
    assert.equal((await call(s.base, "GET", "/v1/me", { token: oauthToken })).res.status, 200);

    const del = await unlink(s.base, owner.token, { current_password: "secret-pw" });
    assert.equal(del.res.status, 204);
    assert.equal((s.platform.db.prepare("SELECT COUNT(*) n FROM oauth_identities").get() as any).n, 0);
    const oauthRow = s.platform.db.prepare("SELECT revoked_at FROM tokens WHERE token_hash = ?").get(hashToken(oauthToken)) as any;
    assert.ok(oauthRow.revoked_at, "the GitHub session ended with the identity");
    assert.equal((await call(s.base, "GET", "/v1/me", { token: oauthToken })).res.status, 401);
    const still = await call(s.base, "GET", "/v1/me", { token: owner.token });
    assert.equal(still.res.status, 200);
    assert.equal(still.json.owner_id, (s.platform.db.prepare("SELECT subject_id FROM tokens WHERE token_hash = ?").get(hashToken(owner.token)) as any).subject_id);
  } finally { await s.stop(); }
});

test("16. the last sign-in method is refused (test-only owners DDL with a nullable password_hash)", async () => {
  // TEST-ONLY SCHEMA. src/db.ts declares owners.password_hash TEXT NOT NULL; this test is about the
  // route's defensive predicate for a password-less account, so it opens a database whose owners
  // table allows NULL there. It does not describe production, and v1 cannot reach this state.
  const dir = mkdtempSync(join(tmpdir(), "oauth-last-method-"));
  const dbPath = join(dir, "test.db");
  try {
    const raw = new Database(dbPath);
    raw.exec(`CREATE TABLE owners (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
      password_hash TEXT, timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
      sensitive_terms TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL);`);
    raw.close();

    const platform = new Platform({ dbPath, oauth: { clientId: "cid", clientSecret: "cs", publicBaseUrl: "https://bots.example.com" } });
    const now = new Date().toISOString();
    platform.db.prepare("INSERT INTO owners (id, username, display_name, password_hash, created_at) VALUES (?,?,?,?,?)").run("own_ghost", "ghost", "Ghost", null, now);
    platform.db.prepare("INSERT INTO oauth_identities (provider, subject, owner_id, login, created_at) VALUES (?,?,?,?,?)").run("github", "42", "own_ghost", "octocat", now);
    platform.db.prepare("INSERT INTO tokens (token_hash, kind, subject_id, created_at, via) VALUES (?,?,?,?,?)").run(hashToken("otk_ghost"), "owner", "own_ghost", now, "password");
    const app = buildServer(platform);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    try {
      const r = await call(base, "DELETE", "/v1/me/identities/github", { token: "otk_ghost", body: {} });
      assert.equal(r.res.status, 409);
      assert.equal(r.json.error.code, "last_signin_method");
      assert.equal((platform.db.prepare("SELECT COUNT(*) n FROM oauth_identities").get() as any).n, 1);
    } finally { await app.close(); platform.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("17. the connect and unbind buckets are independent in both directions", async () => {
  let now = Date.parse("2026-11-05T00:00:00Z");
  const s = await oauthServer({ now: () => now });
  try {
    const { owner } = await register(s.base);
    await linkGithub(s, owner.token);
    for (let i = 0; i < 5; i++) await startLink(s.base, owner.token, "wrong");
    assert.equal((await startLink(s.base, owner.token, "secret-pw")).res.status, 429);
    now += 16 * 60_000; // the connect lockout window passes; the rows themselves are still there
    const first = await unlink(s.base, owner.token, { current_password: "secret-pw" });
    assert.equal(first.res.status, 204, "connect failures must not lock unbind");

    // Reverse: a fresh identity, then five wrong DELETE passwords, then start must still mint a state.
    await linkGithub(s, owner.token, "secret-pw", "code-17");
    for (let i = 0; i < 5; i++) await unlink(s.base, owner.token, { current_password: "wrong" });
    assert.equal((await unlink(s.base, owner.token, { current_password: "secret-pw" })).res.status, 429);
    const start = await startLink(s.base, owner.token, "secret-pw");
    assert.equal(start.res.status, 200, "unbind failures must not lock connect");
  } finally { await s.stop(); }
});
