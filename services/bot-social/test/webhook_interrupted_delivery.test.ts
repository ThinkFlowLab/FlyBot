import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, test } from "node:test";
import { Platform } from "../src/platform.js";
import { ownerWithBot, startServer } from "./helpers.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const INSERT = "INSERT INTO webhook_deliveries (id, bot_id, kind, status, event_count, event_types, url_redacted, attempts, response_status, error, created_at, sent_at, finished_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)";

describe("webhook delivery interrupted by shutdown", () => {
  let dir: string;
  before(() => { dir = mkdtempSync(join(tmpdir(), "wh-int-")); });

  test("a push interrupted mid-attempt settles as failed and keeps what the attempts recorded", async () => {
    const dbPath = join(dir, "x.db");
    let release: ((r: Response) => void) | undefined;
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) return new Response("nope", { status: 503 });
      return new Promise<Response>((res) => { release = res; });
    }) as unknown as typeof fetch;
    const S = await startServer({ dbPath, fetchImpl, webhooks: { debounceMs: 5, retryBaseMs: 5 } });
    let deliveryId = "";
    try {
      const A = await ownerWithBot(S.base, "int", "https://routine.test/i");
      S.platform.emit(A.bot.id, "system.notice", { reason: "probe" });
      const latest = () => S.platform.db.prepare("SELECT id, status, attempts FROM webhook_deliveries WHERE bot_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(A.bot.id) as any;
      // the second attempt is in flight; the first one already wrote its 503 and its attempt count
      for (let i = 0; i < 400 && !(calls >= 2 && latest()?.status === "sending" && latest()?.attempts === 1); i++) await sleep(5);
      assert.equal(latest()?.status, "sending", "the push is in flight");
      assert.equal(latest()?.attempts, 1, "the first attempt is on record");
      deliveryId = latest().id;
    } finally {
      // the SIGTERM path: the HTTP server and the platform close while the push is still in flight
      await S.stop();
    }
    release?.(new Response("ok", { status: 200 }));
    await sleep(30);

    const reopened = new Platform({ dbPath });
    try {
      const row = reopened.db.prepare("SELECT * FROM webhook_deliveries WHERE id = ?").get(deliveryId) as any;
      assert.equal(row.status, "failed", "an interrupted delivery must not stay 'sending' forever");
      assert.ok(row.finished_at, "a settled delivery has finished_at");
      assert.equal(row.attempts, 1, "attempts is kept as the attempts recorded it");
      assert.equal(row.response_status, 503, "response_status is kept");
      assert.equal(row.error, "HTTP 503", "a recorded error is kept");
    } finally { reopened.close(); }
  });

  test("an interrupted delivery or a held row is settled; every settled row and a second construction are untouched", () => {
    const dbPath = join(dir, "y.db");
    const at = "2026-01-02T03:04:05.000Z";
    const seed = new Platform({ dbPath });
    let seeded: any[] = [];
    try {
      const ins = seed.db.prepare(INSERT);
      ins.run("whd_delivered", "bot_probe", "events", "delivered", 2, '{"message.received":2}', "https://routine.test/h", 1, 200, null, at, at, at);
      ins.run("whd_failed", "bot_probe", "events", "failed", 1, '{"message.received":1}', "https://routine.test/h", 4, 503, "HTTP 503", at, null, at);
      ins.run("whd_cancelled", "bot_probe", "events", "cancelled", 1, '{"message.received":1}', null, 0, null, "webhook removed", at, null, at);
      ins.run("whd_limited", "bot_probe", "events", "rate_limited", 3, '{"message.received":3}', "https://routine.test/h", 0, null, "cap 2/h reached; will retry in 60s", at, null, null);
      ins.run("whd_sending", "bot_probe", "events", "sending", 1, '{"message.received":1}', "https://routine.test/h", 2, null, null, at, null, null);
      seeded = seed.db.prepare("SELECT * FROM webhook_deliveries ORDER BY id").all() as any[];
      assert.deepEqual(seeded.find((r) => r.id === "whd_sending").status, "sending");
    } finally { seed.close(); }

    const all = (p: Platform) => p.db.prepare("SELECT * FROM webhook_deliveries ORDER BY id").all() as any[];
    const p1 = new Platform({ dbPath });
    let first: any[];
    try {
      first = all(p1);
      assert.equal(first.length, 5, "no row is added or removed");
      assert.deepEqual(first.map((r) => r.id), ["whd_cancelled", "whd_delivered", "whd_failed", "whd_limited", "whd_sending"]);
      for (const settled of ["whd_cancelled", "whd_delivered", "whd_failed"]) {
        assert.deepEqual(first.find((r) => r.id === settled), seeded.find((r) => r.id === settled), `${settled} is untouched`);
      }
      const sending = first.find((r) => r.id === "whd_sending");
      assert.equal(sending.status, "failed");
      assert.ok(sending.finished_at, "the settled row has finished_at");
      assert.equal(sending.attempts, 2, "attempts is kept");
      assert.equal(sending.sent_at, null, "sent_at is not invented");
      assert.equal(sending.error, "interrupted before the delivery finished", "an absent error gets a stable reason");
      // A row left waiting by a stopped server is the same orphan: its batch lived in that process's memory, so the
      // retry it announced will never come, and it settles with the reason that is actually true.
      const limited = first.find((r) => r.id === "whd_limited");
      assert.equal(limited.status, "failed", "a held row left by a stopped server does not keep announcing a retry");
      assert.ok(limited.finished_at, "the settled held row has finished_at");
      assert.equal(limited.attempts, 0, "no attempt was made, so none is invented");
      assert.equal(limited.event_count, 3, "the batch the row recorded is kept");
      assert.equal(limited.error, "interrupted before the retry went out", "the announced wait is replaced by what happened");
    } finally { p1.close(); }

    const p2 = new Platform({ dbPath });
    try { assert.deepEqual(all(p2), first!, "a second construction changes nothing"); } finally { p2.close(); }
  });
});
