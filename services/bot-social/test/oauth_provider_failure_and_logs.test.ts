// Provider failure is quiet and closed; the callback URL never reaches the log.
import test from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { Platform } from "../src/platform.js";
import { buildServer } from "../src/server.js";
import { AddressInfo } from "node:net";
import { oauthServer, githubStub, register, startLink, callback, stateOf, linkGithub, call } from "./oauth_helpers.js";
import { ownerWithBot } from "./helpers.js";

test("37. a failing token endpoint is provider_unavailable with no row; the rest of the console still loads", async () => {
  for (const mode of ["500", "timeout"] as const) {
    const s = await oauthServer();
    try {
      const { owner } = await register(s.base);
      s.stub.setTokenMode(mode);
      const { cb } = await linkGithub(s, owner.token, "secret-pw", `code-${mode}`);
      assert.equal(cb.status, 302, mode);
      assert.match(String(cb.headers.get("location")), /oauth=provider_unavailable$/, mode);
      assert.equal((s.platform.db.prepare("SELECT COUNT(*) n FROM oauth_identities").get() as any).n, 0);
      const home = await fetch(`${s.base}/`, { redirect: "manual" });
      assert.equal(home.status, 302);
      assert.equal(home.headers.get("location"), "/ui");
      assert.equal((await fetch(`${s.base}/ui`)).status, 200);
    } finally { await s.stop(); }
  }
});

test("38. the callback is absent from the log output", async () => {
  const chunks: string[] = [];
  const stream = new Writable({ write(c, _e, cb) { chunks.push(String(c)); cb(); } });
  const stub = githubStub();
  const platform = new Platform({ oauth: { clientId: "cid", clientSecret: "cs", publicBaseUrl: "https://bots.example.com" }, fetchImpl: stub.fetchImpl });
  // buildServer takes a boolean in production; a pino options object is passed through a cast here
  // rather than widening that signature.
  const app = buildServer(platform, { logger: { level: "info", stream } as any });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  try {
    const { owner } = await register(base);
    const start = await startLink(base, owner.token, "secret-pw");
    await fetch(`${base}/healthz`);
    const res = await callback(base, { code: "SECRET-CODE-38", state: stateOf(start.json.authorize_url), cookie: start.cookie });
    assert.equal(res.status, 302);
    await new Promise((r) => setTimeout(r, 50));
    const log = chunks.join("");
    assert.ok(log.includes("healthz"), "the logger is on");
    assert.ok(!log.includes("SECRET-CODE-38"), "no code in the log");
    assert.ok(!log.includes(stateOf(start.json.authorize_url)), "no state in the log");
    assert.ok(!log.includes("bs_oauth"), "no binding cookie in the log");
  } finally { await app.close(); platform.close(); }
});

test("39. start refuses connector and bot tokens", async () => {
  const s = await oauthServer();
  try {
    const { owner } = await register(s.base);
    const conn = await owner.req("POST", "/v1/connector-tokens", { label: "flybot" });
    const asConnector = await call(s.base, "POST", "/v1/auth/oauth/github/start", { token: conn.token, body: { current_password: "secret-pw" } });
    assert.equal(asConnector.res.status, 403);
    const { bot } = await ownerWithBot(s.base, "startguard");
    const asBot = await call(s.base, "POST", "/v1/auth/oauth/github/start", { token: bot.cred.token, body: { current_password: "secret-pw" } });
    assert.equal(asBot.res.status, 403);
    assert.equal(asBot.json.error.code, "owner_only");
  } finally { await s.stop(); }
});
