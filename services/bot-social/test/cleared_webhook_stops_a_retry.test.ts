// A webhook batch waiting out a retry backoff must read its target again before every attempt, not only the Bot's
// status: an owner who clears or replaces the webhook while that batch waits must not have the next attempt POST the
// old URL and be recorded `delivered`, with its events marked delivered too. The URL is read for every kind here; the
// Bot's status stays the `events`-only rule (#478 keeps an owner's test push working while the Bot is frozen).
//
// A URL that did not change is still a live target: a header or secret the owner changed in the meantime is used as
// it stands now, so the retry is signed with what the owner sees rather than with what was read when the batch queued.
import assert from "node:assert/strict";
import { AddressInfo } from "node:net";
import { test } from "node:test";
import { Platform } from "../src/platform.js";
import { buildServer } from "../src/server.js";
import { ownerWithBot } from "./helpers.js";

async function setup(opts: Record<string, unknown> = {}) {
  const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
  let responder: (n: number) => number = () => 200;
  const fetchImpl = (async (url: string, init: any) => {
    calls.push({ url, body: init.body, headers: init.headers as Record<string, string> });
    return new Response("ok", { status: responder(calls.length) });
  }) as unknown as typeof fetch;
  const platform = new Platform({ fetchImpl, webhooks: { debounceMs: 5_000, retryBaseMs: 400, ...opts } });
  const app = buildServer(platform);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  return { platform, base, calls, respond: (f: typeof responder) => { responder = f; }, stop: async () => { await app.close(); platform.close(); } };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const deliveries = (s: Awaited<ReturnType<typeof setup>>, botId: string) =>
  s.platform.db.prepare("SELECT * FROM webhook_deliveries WHERE bot_id = ? ORDER BY created_at DESC, rowid DESC").all(botId) as any[];
const eventStatus = (s: Awaited<ReturnType<typeof setup>>, id: string) =>
  (s.platform.db.prepare("SELECT webhook_status FROM events WHERE id = ?").get(id) as any)?.webhook_status ?? null;
const stillSending = (s: Awaited<ReturnType<typeof setup>>) =>
  (s.platform.db.prepare("SELECT COUNT(*) n FROM webhook_deliveries WHERE status = 'sending'").get() as any).n as number;

test("a cleared webhook stops the retry, and the batch is not recorded as delivered", async (t) => {
  const s = await setup();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "clrretry");
  await A.owner.req("PUT", `/v1/bots/${A.bot.id}/webhook`, { url: "https://routine.test/cleared" });
  s.respond(() => 500);
  const ev = s.platform.emit(A.bot.id, "system.notice", { i: 1 });
  const flushing = s.platform.flushWebhooks();
  while (s.calls.length === 0) await sleep(5);

  const cleared = await A.owner.req("DELETE", `/v1/bots/${A.bot.id}/webhook`);
  assert.equal(cleared.configured, false, "the owner cleared the webhook");
  // The next attempt would succeed: a batch that still went out would be recorded delivered, which is the bug.
  s.respond(() => 200);
  await flushing;

  assert.equal(s.calls.length, 1, "the retry must not POST the URL that was cleared");
  const row = deliveries(s, A.bot.id)[0];
  assert.equal(row.status, "cancelled");
  assert.match(row.error, /webhook removed/);
  assert.equal(row.attempts, 1);
  assert.equal(stillSending(s), 0);
  assert.notEqual(eventStatus(s, ev), "delivered", "an event that never went out is not delivered");
  assert.equal((await A.owner.req("GET", `/v1/bots/${A.bot.id}/webhook`)).configured, false);
});

test("a replaced webhook stops the retry instead of reaching the old URL", async (t) => {
  const s = await setup();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "replretry");
  await A.owner.req("PUT", `/v1/bots/${A.bot.id}/webhook`, { url: "https://routine.test/old" });
  s.respond(() => 500);
  const ev = s.platform.emit(A.bot.id, "system.notice", { i: 1 });
  const flushing = s.platform.flushWebhooks();
  while (s.calls.length === 0) await sleep(5);

  await A.owner.req("PUT", `/v1/bots/${A.bot.id}/webhook`, { url: "https://routine.test/new" });
  s.respond(() => 200);
  await flushing;

  assert.equal(s.calls.length, 1, "the retry must not POST the replaced URL");
  assert.equal(s.calls[0].url, "https://routine.test/old", "only the attempt that started before the replace went out");
  const row = deliveries(s, A.bot.id)[0];
  assert.equal(row.status, "cancelled");
  assert.match(row.error, /webhook replaced/);
  assert.equal(row.attempts, 1);
  assert.equal(stillSending(s), 0);
  assert.notEqual(eventStatus(s, ev), "delivered");
});

test("a retry carries the headers the webhook has now", async (t) => {
  const s = await setup();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "hdrretry");
  await A.owner.req("PUT", `/v1/bots/${A.bot.id}/webhook`, { url: "https://routine.test/headers" });
  s.respond((n) => (n === 1 ? 500 : 200));
  const ev = s.platform.emit(A.bot.id, "system.notice", { i: 1 });
  const flushing = s.platform.flushWebhooks();
  while (s.calls.length === 0) await sleep(5);

  await A.owner.req("PUT", `/v1/bots/${A.bot.id}/webhook`, {
    url: "https://routine.test/headers",
    headers: [{ name: "x-run-id", value: "v2" }],
  });
  await flushing;

  assert.equal(s.calls.length, 2, "the URL did not change, so the retry still goes out");
  assert.equal(s.calls[1].url, "https://routine.test/headers");
  assert.equal(s.calls[1].headers["x-run-id"], "v2", "the retry is signed and sent with the header the owner set now");
  const row = deliveries(s, A.bot.id)[0];
  assert.equal(row.status, "delivered");
  assert.equal(row.attempts, 2);
  assert.equal(eventStatus(s, ev), "delivered");
});
