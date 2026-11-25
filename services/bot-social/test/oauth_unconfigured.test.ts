// An instance with no GitHub client id/secret must be exactly today's instance: the same /ui bytes
// and 404 on every new route, before any auth check.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { oauthServer, call } from "./oauth_helpers.js";
import { register } from "./oauth_helpers.js";

const ROUTES: [string, string][] = [
  ["GET", "/v1/auth/oauth/providers"],
  ["POST", "/v1/auth/oauth/github/start"],
  ["POST", "/v1/auth/oauth/github/signin"],
  ["GET", "/v1/auth/oauth/github/callback"],
  ["POST", "/v1/auth/oauth/signin/exchange"],
  ["GET", "/v1/me/identities"],
  ["DELETE", "/v1/me/identities/github"],
];

test("18. unconfigured: all seven routes answer 404 oauth_not_configured, with and without a token", async () => {
  const s = await oauthServer({ oauth: {} });
  try {
    const { owner } = await register(s.base);
    for (const [method, path] of ROUTES) {
      const bare = await call(s.base, method, path, { body: method === "GET" ? undefined : {} });
      assert.equal(bare.res.status, 404, `${method} ${path} without a token`);
      assert.equal(bare.json.error.code, "oauth_not_configured");
      const withToken = await call(s.base, method, path, { token: owner.token, body: method === "GET" ? undefined : {} });
      assert.equal(withToken.res.status, 404, `${method} ${path} with a token`);
      assert.equal(withToken.json.error.code, "oauth_not_configured");
    }
  } finally { await s.stop(); }
});

test("19. /ui is byte-identical when unconfigured; enabled it differs by exactly one meta tag", async () => {
  const baseline = readFileSync(join(process.cwd(), "public", "index.html"), "utf8");
  const off = await oauthServer({ oauth: {} });
  try {
    const res = await fetch(`${off.base}/ui`);
    const body = await res.text();
    assert.equal(body, baseline, "the unconfigured page is the file itself, byte for byte");
    assert.ok(!body.includes("bs-oauth"));
    assert.equal(body.split("</head>").length - 1, 1);
  } finally { await off.stop(); }

  const on = await oauthServer();
  try {
    const body = await (await fetch(`${on.base}/ui`)).text();
    const tag = '<meta name="bs-oauth" content="github">';
    const idx = baseline.indexOf("</head>");
    const expected = baseline.slice(0, idx) + tag + baseline.slice(idx);
    assert.equal(body, expected, "enabled: one tag inserted before </head>, everything else untouched");
    assert.equal(body.split(tag).length - 1, 1);
    assert.ok(!body.includes("test-client-id"));
    assert.ok(!body.includes("test-client-secret"));
    assert.ok(!body.includes("bots.example.com"));
  } finally { await on.stop(); }
});

test("20. one of the two env values is not enough: still disabled", async () => {
  const s = await oauthServer({ oauth: { clientId: "only-id", clientSecret: "", publicBaseUrl: "https://bots.example.com" } });
  try {
    const r = await call(s.base, "POST", "/v1/auth/oauth/github/signin", { body: {} });
    assert.equal(r.res.status, 404);
    assert.equal(r.json.error.code, "oauth_not_configured");
    const page = await (await fetch(`${s.base}/ui`)).text();
    assert.ok(!page.includes("bs-oauth"));
  } finally { await s.stop(); }
});
