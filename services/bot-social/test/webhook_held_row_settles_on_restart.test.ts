// A push the hourly cap held back gets a row that says "Rate limited · retrying later", and while the
// server that queued it is running that is true: the batch sits in memory and its retry is on a timer.
// Once that server is gone the promise cannot be kept — the batch died with the process, nothing will
// ever retry it — so the row must settle like any other orphan instead of announcing a retry forever.
// The constructor already settles a 'sending' row left by a stopped server for exactly this reason; a
// held row is the same orphan, and the console reads both: `public/ui.js` renders 'rate_limited' as
// "Rate limited · retrying later", which is the one thing that will never happen.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { Platform } from "../src/platform.js";
import { ownerWithBot, startServer } from "./helpers.js";

const INSERT = "INSERT INTO webhook_deliveries (id, bot_id, kind, status, event_count, event_types, url_redacted, attempts, response_status, error, created_at, sent_at, finished_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)";

/** A server whose push budget is already spent: the seeded delivery is 60s from ageing out, so anything
 *  queued now is held for about a minute — long enough to stop the server while it waits. */
async function cappedServer(dbPath: string, calls: any[]) {
  const fetchImpl = (async (_url: string, init: any) => { calls.push(JSON.parse(init.body)); return new Response("ok", { status: 200 }); }) as unknown as typeof fetch;
  const S = await startServer({ dbPath, fetchImpl, webhooks: { debounceMs: 0, maxPerHour: 1, retryBaseMs: 1 } });
  return S;
}

test("a held row left by a stopped server settles instead of promising a retry that cannot come", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wh-held-restart-"));
  const dbPath = join(dir, "db.sqlite");
  const calls: any[] = [];
  const S = await cappedServer(dbPath, calls);
  let stopped = false;
  try {
    const A = await ownerWithBot(S.base, "orphan", "https://orphan.test/hook");
    const db = new Database(dbPath);
    const at = new Date(Date.now() - (3600e3 - 60_000)).toISOString();
    db.prepare(INSERT).run("whd_seed", A.bot.id, "events", "delivered", 1, "{}", "https://orphan.test/hook", 1, 200, null, at, at, at);
    db.close();

    S.platform.emit(A.bot.id, "system.notice", { i: 0 });
    await S.platform.flushWebhooks();
    const own = () => S.platform.webhooks.deliveries(A.bot.id, 10).filter((d) => d.delivery_id !== "whd_seed");
    const held = own();
    assert.deepEqual(held.map((d) => d.status), ["rate_limited"], "the push is held, and the row says so");
    assert.equal(held[0].finished_at, null, "a row still waiting has no finish time");
    assert.match(held[0].error ?? "", /will retry in/, "the row announces a retry the queue is still going to make");
    const heldId = held[0].delivery_id;

    // The process stops while the batch still waits for its retry.
    await S.stop();
    stopped = true;
    assert.equal(calls.length, 0, "nothing went out while the budget was spent");

    const reopened = new Platform({ dbPath });
    try {
      const row = reopened.db.prepare("SELECT * FROM webhook_deliveries WHERE id = ?").get(heldId) as any;
      assert.equal(row.status, "failed", "a held row left by a stopped server does not stay 'retrying later'");
      assert.ok(row.finished_at, "a settled delivery has finished_at");
      assert.equal(row.attempts, 0, "no attempt was made, so none is invented");
      assert.equal(row.error, "interrupted before the retry went out", "the row names what actually happened, not a retry that cannot come");
      assert.equal(row.event_count, 1, "the batch the row recorded is kept");

      const again = new Platform({ dbPath });
      try {
        const after = again.db.prepare("SELECT * FROM webhook_deliveries WHERE id = ?").get(heldId) as any;
        assert.deepEqual(after, row, "a second construction changes nothing");
      } finally { again.close(); }
    } finally { reopened.close(); }
  } finally {
    if (!stopped) await S.stop();
  }
});

test("the owner's console reads the settled row as a failure, not as a retry still coming", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wh-held-console-"));
  const dbPath = join(dir, "db.sqlite");
  const calls: any[] = [];
  const S = await cappedServer(dbPath, calls);
  let stopped = false;
  try {
    const A = await ownerWithBot(S.base, "console", "https://console.test/hook");
    const db = new Database(dbPath);
    const at = new Date(Date.now() - (3600e3 - 60_000)).toISOString();
    db.prepare(INSERT).run("whd_seed", A.bot.id, "events", "delivered", 1, "{}", "https://console.test/hook", 1, 200, null, at, at, at);
    db.close();
    S.platform.emit(A.bot.id, "system.notice", { i: 0 });
    await S.platform.flushWebhooks();
    const held = S.platform.webhooks.deliveries(A.bot.id, 10).find((d) => d.status === "rate_limited");
    assert.ok(held, "the push is held while this process is up");
    await S.stop();
    stopped = true;

    // A new process on the same file: the constructor settles the orphan, and the deliveries route is what the
    // console renders (`WH_ST` maps `rate_limited` to "Rate limited · retrying later", a sentence that is only true
    // while the process that queued the batch is running).
    const S2 = await startServer({ dbPath, fetchImpl: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch, webhooks: { debounceMs: 0, maxPerHour: 1, retryBaseMs: 1 } });
    try {
      const r = await fetch(`${S2.base}/v1/bots/${A.bot.id}/webhook/deliveries`, { headers: { authorization: `Bearer ${A.owner.token}` } });
      assert.equal(r.status, 200);
      const body = (await r.json()) as any;
      const row = body.deliveries.find((d: any) => d.delivery_id === held!.delivery_id);
      assert.ok(row, "the row is still in the log the console reads");
      assert.equal(row.status, "failed", "the console renders this row as a failure");
      assert.equal(row.error, "interrupted before the retry went out", "and names what happened");
      assert.ok(!String(row.error).includes("will retry in"), "nothing left promises a retry that cannot come");
    } finally { await S2.stop(); }
  } finally {
    if (!stopped) await S.stop();
  }
});

test("the settle leaves every row that already reached its outcome alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "wh-held-control-"));
  const dbPath = join(dir, "db.sqlite");
  const at = "2026-01-02T03:04:05.000Z";
  const seed = new Platform({ dbPath });
  let seeded: any[] = [];
  try {
    const ins = seed.db.prepare(INSERT);
    ins.run("whd_delivered", "bot_probe", "events", "delivered", 2, '{"message.received":2}', "https://routine.test/h", 1, 200, null, at, at, at);
    ins.run("whd_failed", "bot_probe", "events", "failed", 1, '{"message.received":1}', "https://routine.test/h", 4, 503, "HTTP 503", at, null, at);
    ins.run("whd_cancelled", "bot_probe", "events", "cancelled", 1, '{"message.received":1}', null, 0, null, "webhook removed", at, null, at);
    ins.run("whd_sending", "bot_probe", "events", "sending", 1, '{"message.received":1}', "https://routine.test/h", 2, null, null, at, null, null);
    seeded = seed.db.prepare("SELECT * FROM webhook_deliveries ORDER BY id").all() as any[];
  } finally { seed.close(); }

  const p = new Platform({ dbPath });
  try {
    const rows = p.db.prepare("SELECT * FROM webhook_deliveries ORDER BY id").all() as any[];
    assert.equal(rows.length, 4, "no row is added or removed");
    for (const id of ["whd_delivered", "whd_failed", "whd_cancelled"]) {
      assert.deepEqual(rows.find((r) => r.id === id), seeded.find((r) => r.id === id), `${id} is untouched`);
    }
    const sending = rows.find((r) => r.id === "whd_sending");
    assert.equal(sending.status, "failed", "an interrupted delivery still settles as failed");
    assert.equal(sending.error, "interrupted before the delivery finished", "and keeps the reason it always had");
  } finally { p.close(); }
});
