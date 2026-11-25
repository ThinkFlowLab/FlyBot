// The deployment gate: PUBLIC_BASE_URL is normalized once, at startup, and no request header can
// move the redirect_uri (§11.1, §12 T6).
import test from "node:test";
import assert from "node:assert/strict";
import { oauthConfigFrom } from "../src/oauth.js";
import { oauthServer, register, startLink, callback, stateOf, call } from "./oauth_helpers.js";

const IDS = { BOTSOCIAL_GITHUB_CLIENT_ID: "cid", BOTSOCIAL_GITHUB_CLIENT_SECRET: "csecret" };
const cfg = (publicBaseUrl: string | undefined) => oauthConfigFrom({ ...IDS, PUBLIC_BASE_URL: publicBaseUrl });

test("21. the feature needs an https PUBLIC_BASE_URL, and an empty one disables it even with id+secret", async () => {
  assert.equal(oauthConfigFrom({}).enabled, false, "nothing set");
  assert.equal(cfg("").enabled, false, "empty base URL");
  assert.equal(cfg(undefined).enabled, false, "unset base URL");
  assert.equal(cfg("http://bots.example.com").enabled, false, "plain http off loopback");
  assert.equal(cfg("http://localhost:8787").enabled, true, "loopback http is allowed for local runs");
  assert.equal(cfg("https://bots.example.com").enabled, true);
  assert.equal(cfg("https://bots.example.com")!.redirectUri, "https://bots.example.com/v1/auth/oauth/github/callback");
});

test("22. a hostile Host header cannot move the authorize redirect_uri", async () => {
  const s = await oauthServer();
  try {
    const { owner } = await register(s.base);
    const hostile = { host: "evil.example", "x-forwarded-proto": "http", "x-forwarded-host": "evil.example" };
    const start = await startLinkWith(s.base, owner.token, hostile);
    const redirect = new URL(start.json.authorize_url).searchParams.get("redirect_uri");
    assert.equal(redirect, "https://bots.example.com/v1/auth/oauth/github/callback");
    assert.match(start.setCookie, /Secure/, "Secure follows the configured origin, not req.protocol");
    assert.ok(!start.setCookie.includes("evil.example"));
  } finally { await s.stop(); }
});

test("23. a trailing slash yields exactly one slash in the redirect_uri, both legs", async () => {
  assert.equal(cfg("https://x/")!.redirectUri, "https://x/v1/auth/oauth/github/callback");
  const s = await oauthServer({ oauth: { clientId: "cid", clientSecret: "csecret", publicBaseUrl: "https://x/" } });
  try {
    const { owner } = await register(s.base);
    const start = await startLink(s.base, owner.token, "secret-pw");
    const redirect = new URL(start.json.authorize_url).searchParams.get("redirect_uri");
    assert.equal(redirect, "https://x/v1/auth/oauth/github/callback");
    await callback(s.base, { code: "code-23", state: stateOf(start.json.authorize_url), cookie: start.cookie });
    assert.equal(s.stub.tokenBodies[0].get("redirect_uri"), "https://x/v1/auth/oauth/github/callback");
  } finally { await s.stop(); }
});

test("24. a path is refused, not stripped, and the warning carries no value", async () => {
  const c = cfg("https://bots.example.com/prefix");
  assert.equal(c.enabled, false);
  assert.ok(c.warning && /PUBLIC_BASE_URL/.test(c.warning));
  assert.ok(!c.warning!.includes("bots.example.com"));
  assert.ok(!c.warning!.includes("prefix"));
  const s = await oauthServer({ oauth: { clientId: "cid", clientSecret: "csecret", publicBaseUrl: "https://bots.example.com/prefix" } });
  try {
    for (const [method, path] of [["GET", "/v1/auth/oauth/providers"], ["POST", "/v1/auth/oauth/github/signin"], ["GET", "/v1/me/identities"]] as [string, string][]) {
      const r = await call(s.base, method, path, { body: method === "GET" ? undefined : {} });
      assert.equal(r.res.status, 404);
      assert.equal(r.json.error.code, "oauth_not_configured");
    }
  } finally { await s.stop(); }
});

test("25. userinfo, query and fragment are each refused, silently about their values", async () => {
  for (const [raw, needle] of [["https://u:p@bots.example.com", "bots.example.com"], ["https://bots.example.com/?a=1", "a=1"], ["https://bots.example.com/#f", "#f"]] as [string, string][]) {
    const c = cfg(raw);
    assert.equal(c.enabled, false, raw);
    assert.ok(c.warning, raw);
    assert.ok(!c.warning!.includes(needle), `${raw}: the warning must not echo the value`);
  }
  const s = await oauthServer({ oauth: { clientId: "cid", clientSecret: "csecret", publicBaseUrl: "https://u:p@bots.example.com" } });
  try {
    const r = await call(s.base, "POST", "/v1/auth/oauth/github/signin", { body: {} });
    assert.equal(r.res.status, 404);
  } finally { await s.stop(); }
});

test("26. Host + X-Forwarded-Proto cannot move the exchange redirect_uri either", async () => {
  const s = await oauthServer();
  try {
    const { owner } = await register(s.base);
    const hostile = { host: "evil.example", "x-forwarded-proto": "http" };
    const start = await startLinkWith(s.base, owner.token, hostile);
    const cb = await callback(s.base, { code: "code-26", state: stateOf(start.json.authorize_url), cookie: start.cookie, headers: hostile });
    assert.equal(cb.status, 302);
    assert.equal(s.stub.tokenBodies[0].get("redirect_uri"), "https://bots.example.com/v1/auth/oauth/github/callback");
    assert.match(start.setCookie, /Secure/);
  } finally { await s.stop(); }
});

async function startLinkWith(base: string, token: string, headers: Record<string, string>) {
  const res = await fetch(`${base}/v1/auth/oauth/github/start`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    body: JSON.stringify({ current_password: "secret-pw" }),
  });
  const json = await res.json().catch(() => ({}));
  const many = (res.headers as any).getSetCookie?.() as string[] | undefined;
  const setCookie = many?.[0] ?? res.headers.get("set-cookie") ?? "";
  const pair = setCookie.split(";")[0];
  return { res, json, setCookie, cookie: pair.slice(pair.indexOf("=") + 1) };
}
