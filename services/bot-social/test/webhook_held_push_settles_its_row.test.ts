// A push the hourly cap held back is one delivery, not two. The row that records the hold says
// "Rate limited · retrying later"; once the window clears and the held batch actually goes out, that
// same row must end the way the delivery did, carry the batch that was really sent, and count against
// the hour it went out in.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { ownerWithBot, startServer } from "./helpers.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A server whose push budget is already spent: delivered rows sit `windowLeftMs` from ageing out. */
async function cappedServer(t: any, windowLeftMs: number, maxPerHour = 1) {
  const dir = mkdtempSync(join(tmpdir(), "wh-held-"));
  const dbPath = join(dir, "db.sqlite");
  const calls: any[] = [];
  const fetchImpl = (async (_url: string, init: any) => {
    calls.push(JSON.parse(init.body));
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  const S = await startServer({ dbPath, fetchImpl, webhooks: { debounceMs: 0, maxPerHour, retryBaseMs: 1 } });
  t.after(S.stop);
  const A = await ownerWithBot(S.base, "held", "https://held.test/hook");
  const db = new Database(dbPath);
  const at = new Date(Date.now() - (3600e3 - windowLeftMs)).toISOString();
  db.prepare("INSERT INTO webhook_deliveries (id, bot_id, kind, status, event_count, event_types, created_at, finished_at) VALUES (?,?,?,?,?,?,?,?)")
    .run("whd_seed", A.bot.id, "events", "delivered", 1, "{}", at, at);
  db.close();
  /** The delivery rows this test's own pushes left, without the seeded one that spends the budget. */
  const own = () => S.platform.webhooks.deliveries(A.bot.id, 10).filter((d) => d.delivery_id !== "whd_seed");
  return { S, A, calls, own };
}

test("a held push is one row, it settles as delivered, and it names the batch that went out", async (t) => {
  // 1.2s left in the spent window: the retry the cap scheduled is due about 1.7s out.
  const { S, A, calls, own } = await cappedServer(t, 1200);

  S.platform.emit(A.bot.id, "system.notice", { i: 0 });
  S.platform.emit(A.bot.id, "system.notice", { i: 1 });
  await S.platform.flushWebhooks();
  assert.equal(calls.length, 0, "the cap is full, so nothing goes out yet");
  const held = own();
  assert.deepEqual(held.map((d) => d.status), ["rate_limited"], "the held push is one row, and it says it is waiting");
  assert.equal(held[0].event_count, 2, "the held row carries the batch as it stood when the push was held");

  // More events join the wait: the row must end up naming the batch that is finally sent, not the one it saw first.
  S.platform.emit(A.bot.id, "system.notice", { i: 2 });
  S.platform.emit(A.bot.id, "system.notice", { i: 3 });
  S.platform.emit(A.bot.id, "system.notice", { i: 4 });
  await S.platform.flushWebhooks();
  assert.equal(own().length, 1, "waiting longer does not add a second row");

  await sleep(2600);
  assert.equal(calls.length, 1, "the held push goes out once the window clears");
  const rows = own();
  assert.deepEqual(rows.map((d) => d.status), ["delivered"], "the push has one row, and it settled as delivered");
  assert.ok(rows[0].finished_at, "a settled row carries finished_at");
  assert.equal(rows[0].attempts, 1);
  assert.equal(rows[0].event_count, 5, "the row names the batch that actually went out");
  assert.equal(calls[0].delivery_id, rows[0].delivery_id, "the push named the row it settled");
  assert.equal(calls[0].event_count, 5);
});

test("the taken-over delivery counts against the hour it went out in", async (t) => {
  const { S, A, calls, own } = await cappedServer(t, 1200);

  S.platform.emit(A.bot.id, "system.notice", { i: 0 });
  await S.platform.flushWebhooks();
  const held = own();
  assert.deepEqual(held.map((d) => d.status), ["rate_limited"]);
  const heldAt = Date.parse(held[0].created_at);

  await sleep(2600);
  assert.equal(calls.length, 1, "the held batch went out");
  const settled = own().find((d) => d.delivery_id === held[0].delivery_id);
  assert.ok(settled, "the row that recorded the hold is still the push's row");
  assert.equal(settled!.status, "delivered");
  // The queue time is not the send time: the slot this delivery spends is the hour it went out in, so a batch
  // held across the window's edge cannot slip out of the count (and let an extra batch through) the moment it lands.
  assert.ok(Date.parse(settled!.created_at) >= heldAt + 1000, "the row's created_at moved to when it was sent");

  // Its hour is the one it was sent in: one slot of one is spent again, so the next batch waits.
  S.platform.emit(A.bot.id, "system.notice", { i: 1 });
  await S.platform.flushWebhooks();
  assert.equal(calls.length, 1, "a batch queued right after the delivery is still limited by the hour it used");
  assert.deepEqual(own().map((d) => d.status).sort(), ["delivered", "rate_limited"]);
});

test("while the window is still full the held row stays put and the batch grows", async (t) => {
  const { S, A, calls, own } = await cappedServer(t, 60_000);

  S.platform.emit(A.bot.id, "system.notice", { i: 0 });
  await S.platform.flushWebhooks();
  S.platform.emit(A.bot.id, "system.notice", { i: 1 });
  await S.platform.flushWebhooks();

  assert.equal(calls.length, 0, "nothing goes out while the budget is spent");
  assert.equal(S.platform.webhooks.queued(A.bot.id), 2, "the second event joins the held batch");
  const held = own();
  assert.deepEqual(held.map((d) => d.status), ["rate_limited"], "the wait is still one row, not one per event");
  assert.equal(held[0].finished_at, null, "a row still waiting has no finish time");
});
