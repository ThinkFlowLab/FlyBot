import assert from "node:assert/strict";
import { AddressInfo } from "node:net";
import { test } from "node:test";
import { Platform } from "../src/platform.js";
import { buildServer } from "../src/server.js";

// #177 closed the doors that would hand a removed home member (status `revoked`) a working token, its event queue or
// its role in a relationship. Its webhook was meant to be closed with them: `removeHomeMember` clears the URL and its
// own comment says "a revoked identity must not keep receiving metadata through its webhook". But the two webhook
// write doors never look at `status`, so an owner token can hang a fresh URL on the revoked identity after the
// removal, and its events are then pushed to that URL. This test pins the door shut: the URL write and the test push
// answer 403 `bot_revoked`, while the read, the clear and the delivery log keep answering as before.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Platform + HTTP server with a fake fetch that records every webhook call. */
async function setup() {
  const calls: { url: string }[] = [];
  const fetchImpl = (async (url: unknown) => {
    calls.push({ url: String(url) });
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  const platform = new Platform({ fetchImpl, webhooks: { debounceMs: 30, retryBaseMs: 5 } });
  const app = buildServer(platform);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  return { platform, base, calls, stop: async () => { await app.close(); platform.close(); } };
}

async function req(base: string, method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(base + path, { method, headers: { ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}

test("a revoked home member cannot hang a webhook again, and none of its events is pushed", async (t) => {
  const s = await setup();
  t.after(s.stop);

  // A home with one member Bot that has its own token and a working webhook while it is still active.
  const fly = s.platform.onboardFlybot({ display_name: "Rivet" });
  const login = await req(s.base, "POST", "/v1/auth/login", undefined, { username: fly.username, password: fly.generated_password });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const ownerToken = login.body.owner_token as string;
  const added = await req(s.base, "POST", `/v1/homes/${fly.home.bot_id}/members`, ownerToken, { name: "gone", display_name: "gone" });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const botId = added.body.bot_id as string;

  // Positive control: while the identity is active, both write doors answer and the push reaches the URL.
  const hung = await req(s.base, "PUT", `/v1/bots/${botId}/webhook`, ownerToken, { url: "https://revoked.test/hook" });
  assert.equal(hung.status, 200, JSON.stringify(hung.body));
  assert.equal(hung.body.configured, true);
  assert.equal((await req(s.base, "POST", `/v1/bots/${botId}/webhook/test`, ownerToken)).status, 200, "an active identity can send its test push");
  s.platform.emit(botId, "approval.created", { approval_id: "apr_before" });
  await sleep(150);
  assert.ok(s.calls.some((c) => c.url.includes("revoked.test/hook")), "while active, its events are pushed");

  // The removal revokes the identity and clears the URL (the transaction's own comment says it must stop the push).
  const removed = await req(s.base, "DELETE", `/v1/homes/${fly.home.bot_id}/members/${botId}`, ownerToken);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.status, "revoked");
  const readAfterRemoval = await req(s.base, "GET", `/v1/bots/${botId}/webhook`, ownerToken);
  assert.equal(readAfterRemoval.status, 200, "reading the webhook stays open");
  assert.equal(readAfterRemoval.body.configured, false, "the removal cleared the URL");

  // ① The URL write must be refused: the revoked identity must not be handed a fresh outlet.
  const rehang = await req(s.base, "PUT", `/v1/bots/${botId}/webhook`, ownerToken, { url: "https://revoked.test/hook" });
  assert.equal(rehang.status, 403, `hanging a webhook on a revoked identity must be refused, got ${rehang.status} ${JSON.stringify(rehang.body)}`);
  assert.equal(rehang.body.error?.code, "bot_revoked");
  assert.match(String(rehang.body.error?.message), /revoked/);
  assert.equal((await req(s.base, "GET", `/v1/bots/${botId}/webhook`, ownerToken)).body.configured, false, "the refused write leaves no URL behind");

  // ② The test push must be refused too: it is the same write door with an immediate delivery.
  const testPush = await req(s.base, "POST", `/v1/bots/${botId}/webhook/test`, ownerToken);
  assert.equal(testPush.status, 403, `a test push for a revoked identity must be refused, got ${testPush.status} ${JSON.stringify(testPush.body)}`);
  assert.equal(testPush.body.error?.code, "bot_revoked");

  // ③ With no URL hanging on it, an event for this identity is not pushed anywhere: the calls are unchanged.
  const before = s.calls.length;
  s.platform.emit(botId, "approval.created", { approval_id: "apr_after" });
  await sleep(200);
  assert.equal(s.calls.length, before, "a revoked identity's event is not pushed");
  assert.ok(!s.calls.slice(before).some((c) => c.url.includes("revoked.test/hook")));

  // ④ The clear and the delivery log keep answering as before: they only take reach away or tell the owner what
  //    already happened, and both were reachable on a revoked identity before this change.
  const cleared = await req(s.base, "DELETE", `/v1/bots/${botId}/webhook`, ownerToken);
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.equal(cleared.body.configured, false);
  const deliveries = await req(s.base, "GET", `/v1/bots/${botId}/webhook/deliveries`, ownerToken);
  assert.equal(deliveries.status, 200, JSON.stringify(deliveries.body));
});
