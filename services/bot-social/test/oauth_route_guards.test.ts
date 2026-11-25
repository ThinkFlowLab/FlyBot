// Who may call what: the four owner routes are login-token only (no connector, no bot), and the
// three public legs stay tokenless.
import test from "node:test";
import assert from "node:assert/strict";
import { oauthServer, register, startLink, startSignin, callback, exchange, call } from "./oauth_helpers.js";
import { ownerWithBot } from "./helpers.js";

test("27. a connector token is refused with 403 on each of the four owner routes", async () => {
  const s = await oauthServer();
  try {
    const { owner } = await register(s.base);
    const conn = await owner.req("POST", "/v1/connector-tokens", { label: "flybot" });
    const token = conn.token as string;
    const cases: [string, string][] = [
      ["GET", "/v1/auth/oauth/providers"],
      ["POST", "/v1/auth/oauth/github/start"],
      ["GET", "/v1/me/identities"],
      ["DELETE", "/v1/me/identities/github"],
    ];
    for (const [method, path] of cases) {
      const r = await call(s.base, method, path, { token, body: method === "GET" ? undefined : { current_password: "secret-pw" } });
      assert.equal(r.res.status, 403, `${method} ${path}`);
      assert.equal(r.json.error.code, "connector_token_rest_forbidden");
    }
  } finally { await s.stop(); }
});

test("28. a bot token is owner_only on the same four; no token on providers is 401", async () => {
  const s = await oauthServer();
  try {
    const { bot } = await ownerWithBot(s.base, "guard");
    const cases: [string, string][] = [
      ["GET", "/v1/auth/oauth/providers"],
      ["POST", "/v1/auth/oauth/github/start"],
      ["GET", "/v1/me/identities"],
      ["DELETE", "/v1/me/identities/github"],
    ];
    for (const [method, path] of cases) {
      const r = await call(s.base, method, path, { token: bot.cred.token, body: method === "GET" ? undefined : {} });
      assert.equal(r.res.status, 403, `${method} ${path}`);
      assert.equal(r.json.error.code, "owner_only");
    }
    const none = await call(s.base, "GET", "/v1/auth/oauth/providers");
    assert.equal(none.res.status, 401);
  } finally { await s.stop(); }
});

test("29. callback, signin and exchange answer without any token", async () => {
  const s = await oauthServer();
  try {
    const signin = await startSignin(s.base);
    assert.equal(signin.res.status, 200);
    const cb = await callback(s.base, { code: "c", state: "not-a-real-state", cookie: "nope" });
    assert.equal(cb.status, 400);
    assert.equal(cb.headers.get("content-type")?.startsWith("text/html"), true);
    const ex = await exchange(s.base, "not-a-real-code");
    assert.equal(ex.res.status, 400);
    assert.equal(ex.json.error.code, "oauth_code_invalid");
  } finally { await s.stop(); }
});
