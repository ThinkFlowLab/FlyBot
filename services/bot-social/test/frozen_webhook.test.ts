import assert from "node:assert/strict";
import { AddressInfo } from "node:net";
import { test } from "node:test";
import { Platform } from "../src/platform.js";
import { buildServer } from "../src/server.js";
import { ownerWithBot } from "./helpers.js";

// The kill switch stops a Bot's outbound side, and a webhook wake-up push is exactly that: the `botsocial.wake`
// signal is what brings a connector or routine back to life outside the platform. A stop keeps the URL (resume must
// not require re-hanging it), so the URL alone cannot mean "deliver"; the Bot's status has to be asked as well.
//
// Two moments matter. An event emitted while the Bot is frozen is never queued, and a batch queued before the stop
// is settled with a terminal row instead of going out after it — including a push already waiting out a retry
// backoff, which must re-read the status before its next attempt. A dropped batch is never replayed: resume pushes
// only what happens afterwards, and the events stay readable in the Bot's inbox.

async function setup(opts: Record<string, unknown> = {}) {
  const calls: { url: string; body: string }[] = [];
  let responder: (n: number) => number = () => 200;
  const fetchImpl = (async (url: string, init: any) => {
    calls.push({ url, body: init.body });
    return new Response("ok", { status: responder(calls.length) });
  }) as unknown as typeof fetch;
  const platform = new Platform({ fetchImpl, webhooks: { debounceMs: 5_000, retryBaseMs: 20, ...opts } });
  const app = buildServer(platform);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  return { platform, base, calls, respond: (f: typeof responder) => { responder = f; }, stop: async () => { await app.close(); platform.close(); } };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const deliveries = (s: Awaited<ReturnType<typeof setup>>, botId: string) =>
  s.platform.db.prepare("SELECT * FROM webhook_deliveries WHERE bot_id = ? ORDER BY created_at DESC, rowid DESC").all(botId) as any[];
const stillSending = (s: Awaited<ReturnType<typeof setup>>) =>
  (s.platform.db.prepare("SELECT COUNT(*) n FROM webhook_deliveries WHERE status = 'sending'").get() as any).n as number;
const eventStatus = (s: Awaited<ReturnType<typeof setup>>, id: string) =>
  (s.platform.db.prepare("SELECT webhook_status FROM events WHERE id = ?").get(id) as any)?.webhook_status ?? null;

test("a batch queued before a stop is settled with a terminal row, and resume pushes only new events", async (t) => {
  const s = await setup();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "frzwh");
  const w = await A.owner.req("PUT", `/v1/bots/${A.bot.id}/webhook`, { url: "https://routine.test/frozen" });
  assert.equal(w.configured, true);
  const dropped = s.platform.emit(A.bot.id, "system.notice", { i: 1 });
  assert.equal((await A.owner.req("GET", `/v1/bots/${A.bot.id}/webhook`)).queued_events, 1);

  assert.equal((await A.owner.req("POST", "/v1/emergency-stop", { bot_id: A.bot.id })).status, "frozen");
  await s.platform.flushWebhooks();

  // Nothing left the machine, and the batch did not stay in the queue as a promise the stop has already broken.
  assert.equal(s.calls.length, 0, "a batch queued before the stop must not go out after it");
  const row = deliveries(s, A.bot.id)[0];
  assert.equal(row.status, "cancelled");
  assert.equal(row.event_count, 1);
  assert.match(row.error, /frozen \(emergency stop\)/);
  assert.match(row.url_redacted, /routine\.test\/frozen/, "the URL is kept for resume, only the push is refused");
  assert.equal(stillSending(s), 0);
  assert.notEqual(eventStatus(s, dropped), "delivered", "an event that never went out is not delivered");
  // The owner's view is unchanged: the webhook is still configured, and the log names why the push was skipped.
  const view = await A.owner.req("GET", `/v1/bots/${A.bot.id}/webhook`);
  assert.equal(view.configured, true);
  assert.equal(view.queued_events, 0);
  assert.equal(view.recent_deliveries[0].status, "cancelled");
  assert.match(view.recent_deliveries[0].error, /frozen/);

  // Resume pushes what happens next; the dropped batch is not replayed.
  assert.equal((await A.owner.req("POST", `/v1/bots/${A.bot.id}/resume`, {})).status, "active");
  const fresh = s.platform.emit(A.bot.id, "system.notice", { i: 2 });
  await s.platform.flushWebhooks();
  assert.equal(s.calls.length, 1, "one push for the new event only");
  const body = JSON.parse(s.calls[0].body);
  assert.deepEqual(body.items.map((i: any) => i.event_id), [fresh]);
  assert.ok(!body.items.some((i: any) => i.event_id === dropped), "the dropped batch must not be sent on resume");
  const after = deliveries(s, A.bot.id);
  assert.equal(after[0].status, "delivered");
  assert.equal(after[0].event_count, 1);
  assert.equal(after[1].status, "cancelled", "the dropped batch keeps its terminal row");
});

test("a push waiting out a retry does not go out after a stop", async (t) => {
  const s = await setup({ retryBaseMs: 400 });
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "frzretry");
  await A.owner.req("PUT", `/v1/bots/${A.bot.id}/webhook`, { url: "https://routine.test/retry" });
  s.respond(() => 503);
  const ev = s.platform.emit(A.bot.id, "system.notice", { i: 1 });
  const flushing = s.platform.flushWebhooks();
  while (s.calls.length === 0) await sleep(5);
  assert.equal((await A.owner.req("POST", "/v1/emergency-stop", { bot_id: A.bot.id })).status, "frozen");
  // A retry the stop happened to be waited out for must not reach the target, even if it would now succeed.
  s.respond(() => 200);
  await flushing;
  assert.equal(s.calls.length, 1, "only the attempt that started before the stop went out");
  const row = deliveries(s, A.bot.id)[0];
  assert.equal(row.status, "cancelled");
  assert.equal(row.attempts, 1);
  assert.match(row.error, /frozen \(emergency stop\)/);
  assert.notEqual(eventStatus(s, ev), "delivered");
});

test("an event emitted while frozen is never queued", async (t) => {
  const s = await setup();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "frzemit");
  await A.owner.req("PUT", `/v1/bots/${A.bot.id}/webhook`, { url: "https://routine.test/idle" });
  assert.equal((await A.owner.req("POST", "/v1/emergency-stop", { bot_id: A.bot.id })).status, "frozen");
  const ev = s.platform.emit(A.bot.id, "system.notice", { i: 1 });
  await s.platform.flushWebhooks();
  assert.equal(s.calls.length, 0);
  assert.equal(deliveries(s, A.bot.id).length, 0, "nothing was queued, so there is no batch to record");
  assert.equal((await A.owner.req("GET", `/v1/bots/${A.bot.id}/webhook`)).queued_events, 0);
  assert.equal(eventStatus(s, ev), null, "the event row itself stays readable in the inbox");
});

test("the owner's explicit test push still works while the Bot is frozen", async (t) => {
  const s = await setup();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "frztst");
  await A.owner.req("PUT", `/v1/bots/${A.bot.id}/webhook`, { url: "https://routine.test/test" });
  assert.equal((await A.owner.req("POST", "/v1/emergency-stop", { bot_id: A.bot.id })).status, "frozen");
  const d = await A.owner.req("POST", `/v1/bots/${A.bot.id}/webhook/test`);
  assert.equal(d.status, "delivered");
  assert.equal(s.calls.length, 1);
  assert.equal(JSON.parse(s.calls[0].body).test, true);
  assert.equal((await A.owner.req("GET", `/v1/bots/${A.bot.id}/webhook`)).configured, true);
});
