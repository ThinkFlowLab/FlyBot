import assert from "node:assert/strict";
import { test } from "node:test";
import { startServer } from "./helpers.js";

type S = Awaited<ReturnType<typeof startServer>>;

async function post(base: string, path: string, body: unknown) {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() as any };
}
const count = (s: S, table: "owners" | "bots" | "bot_keys" | "bot_custody" | "tokens") => (s.platform.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as any).n as number;
const actions = (s: S) => (s.platform.audit.db.prepare("SELECT action FROM audit_events").all() as any[]).map((r) => r.action as string);

// A webhook header the platform reserves for its own signature: setWebhook refuses it.
const RESERVED = ["X-BotSocial-Signature: sneaky"];
const signUp = (extra: Record<string, unknown> = {}) => ({
  username: "residueone", password: "secret-pw", display_name: "Residue One",
  webhook_url: "https://example.com/hook", ...extra,
});

test("a sign-up refused over its webhook headers leaves no owner, handle or token behind", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const r = await post(s.base, "/v1/onboard/flybot", signUp({ webhook_headers: RESERVED }));
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, "invalid_request");
  assert.match(r.body.error.message, /reserved/);
  // The refusal must land before the sign-up commits: nothing may be left to clean up.
  assert.equal(count(s, "owners"), 0, "a refused sign-up left an owner row");
  assert.equal(count(s, "bots"), 0, "a refused sign-up left a bot row holding a global handle");
  assert.equal(count(s, "bot_keys"), 0, "a refused sign-up left a bot key");
  assert.equal(count(s, "bot_custody"), 0, "a refused sign-up left a custody row");
  assert.equal(count(s, "tokens"), 0, "a refused sign-up left live tokens");
  const seen = actions(s);
  for (const a of ["owner.registered", "bot.registered", "connector_token.created"]) {
    assert.equal(seen.includes(a), false, `${a} was recorded for a sign-up that was refused`);
  }
});

test("the same sign-up goes through once its webhook headers are fixed", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const body = signUp({ webhook_headers: RESERVED });
  const refused = await post(s.base, "/v1/onboard/flybot", body);
  assert.equal(refused.status, 400);
  // The install corrects the header and retries the very same request: it has to succeed.
  const fixed = await post(s.base, "/v1/onboard/flybot", { ...body, webhook_headers: ["X-Install-Id: abc123"] });
  assert.equal(fixed.status, 201);
  assert.equal(fixed.body.username, "residueone");
  assert.equal(fixed.body.bot.handle, "@residueone.home");
  assert.match(fixed.body.connector.token, /.+/);
});

test("webhook headers at sign-up: bad url, no url, and the configured webhook view", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  // A bad url is still refused before anything is written.
  const badUrl = await post(s.base, "/v1/onboard/flybot", { username: "badurl", password: "secret-pw", webhook_url: "not a url", webhook_headers: ["X-Ok: 1"] });
  assert.equal(badUrl.status, 400);
  assert.equal(count(s, "owners"), 0);
  assert.equal(count(s, "bots"), 0);
  // Headers without a url are ignored, as before: the sign-up still succeeds with no webhook.
  const noUrl = await post(s.base, "/v1/onboard/flybot", { username: "headersnourl", password: "secret-pw", display_name: "Headers No Url", webhook_headers: RESERVED });
  assert.equal(noUrl.status, 201);
  assert.equal(noUrl.body.webhook, null);
  // A usable url plus headers: configured at sign-up, and the owner reads the header back by name only.
  const ok = await post(s.base, "/v1/onboard/flybot", signUp({ webhook_headers: ["X-Install-Id: super-secret-value"] }));
  assert.equal(ok.status, 201);
  assert.equal(ok.body.webhook.url, "https://example.com/hook");
  const login = await post(s.base, "/v1/auth/login", { username: "residueone", password: "secret-pw" });
  const wh = await fetch(`${s.base}/v1/bots/${ok.body.bot.bot_id}/webhook`, { headers: { authorization: `Bearer ${login.body.owner_token}` } }).then((r) => r.json()) as any;
  assert.deepEqual(wh.headers.map((h: any) => h.name), ["X-Install-Id"]);
  assert.equal(JSON.stringify(wh).includes("super-secret-value"), false);
});
