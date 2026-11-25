import assert from "node:assert/strict";
import { AddressInfo } from "node:net";
import { describe, test } from "node:test";
import { Platform } from "../src/platform.js";
import { buildServer } from "../src/server.js";
import { ownerWithBot } from "./helpers.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Platform + HTTP server with a fake fetch that records every webhook push. */
async function setup(webhooks: Record<string, unknown>) {
  const calls: { body: string }[] = [];
  const fetchImpl = (async (_url: string, init: any) => {
    calls.push({ body: init.body });
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  const platform = new Platform({ fetchImpl, webhooks: { retryBaseMs: 1, ...webhooks } });
  const app = buildServer(platform);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  return { platform, base, calls, stop: async () => { await app.close(); platform.close(); } };
}

/** One event per push (flush bypasses the debounce), so each event counts as its own push. */
async function pushSeparately(platform: Platform, botId: string, n: number) {
  for (let i = 0; i < n; i++) { platform.emit(botId, "system.notice", { i }); await platform.flushWebhooks(); }
}

const CAP = 30;

/** Shape the pusher must produce with a valid 30/hour cap: 30 delivered, the 31st held back. */
async function assertHourlyCap(webhooks: Record<string, unknown>, label: string) {
  const S = await setup({ debounceMs: 0, ...webhooks });
  try {
    const A = await ownerWithBot(S.base, "cap", "https://cap.test/hook");
    await pushSeparately(S.platform, A.bot.id, CAP + 1);
    assert.equal(S.calls.length, CAP, `${label}: ${CAP} pushes delivered inside the hour`);
    const log = S.platform.webhooks.deliveries(A.bot.id, 100);
    assert.equal(log.filter((d) => d.status === "delivered").length, CAP, `${label}: ${CAP} delivered records`);
    assert.equal(log.filter((d) => d.status === "rate_limited").length, 1, `${label}: the ${CAP + 1}st push is held back, not sent`);
  } finally { await S.stop(); }
}

describe("webhook option sanitising", () => {
  test("invalid WEBHOOK_MAX_PER_HOUR (NaN) does not delete the hourly cap", async () => {
    await assertHourlyCap({ maxPerHour: 30 }, "valid 30");
    await assertHourlyCap({ maxPerHour: NaN }, "NaN");
  });

  test("invalid WEBHOOK_DEBOUNCE_SECONDS (NaN) does not disable coalescing", async () => {
    const S = await setup({ debounceMs: NaN, maxPerHour: 100 });
    try {
      const A = await ownerWithBot(S.base, "deb", "https://debounce.test/hook");
      S.platform.emit(A.bot.id, "system.notice", { i: 0 });
      S.platform.emit(A.bot.id, "system.notice", { i: 1 });
      S.platform.emit(A.bot.id, "system.notice", { i: 2 });
      await sleep(400);
      assert.equal(S.calls.length, 0, "the push waits for the 20s coalescing window");
      await S.platform.flushWebhooks();
      assert.equal(S.calls.length, 1, "the three events inside the window collapse into one push");
      assert.equal(JSON.parse(S.calls[0].body).event_count, 3);
    } finally { await S.stop(); }
  });

  test("the webhook view reports the documented defaults for an invalid config", async () => {
    const S = await setup({ debounceMs: NaN, maxPerHour: NaN });
    try {
      const A = await ownerWithBot(S.base, "view", "https://view.test/hook");
      const w = await A.owner.req("GET", `/v1/bots/${A.bot.id}/webhook`);
      assert.equal(w.policy.debounce_seconds, 20, "20s is the documented default");
      assert.equal(w.policy.max_pushes_per_hour, 30, "30/hour is the documented default");
    } finally { await S.stop(); }
  });

  test("other invalid shapes fall back; valid values keep their current meaning", async () => {
    // A negative cap would rate-limit every push forever on the old code.
    {
      const S = await setup({ debounceMs: 0, maxPerHour: -5 });
      try {
        const A = await ownerWithBot(S.base, "neg", "https://neg.test/hook");
        S.platform.emit(A.bot.id, "system.notice", {});
        await S.platform.flushWebhooks();
        assert.equal(S.calls.length, 1, "a negative cap falls back to 30, so the first push is delivered");
        const w = await A.owner.req("GET", `/v1/bots/${A.bot.id}/webhook`);
        assert.equal(w.policy.max_pushes_per_hour, 30);
        assert.equal(w.policy.debounce_seconds, 0, "an explicit 0 is a valid debounce and is kept");
      } finally { await S.stop(); }
    }

    // Infinity would remove the cap entirely.
    await assertHourlyCap({ maxPerHour: Infinity }, "Infinity");

    // A negative debounce would fire immediately instead of coalescing.
    {
      const S = await setup({ debounceMs: -1_000, maxPerHour: 100 });
      try {
        const A = await ownerWithBot(S.base, "negdeb", "https://negdeb.test/hook");
        S.platform.emit(A.bot.id, "system.notice", { i: 0 });
        S.platform.emit(A.bot.id, "system.notice", { i: 1 });
        await sleep(400);
        assert.equal(S.calls.length, 0, "a negative debounce falls back to the 20s window");
        await S.platform.flushWebhooks();
        assert.equal(S.calls.length, 1);
        const w = await A.owner.req("GET", `/v1/bots/${A.bot.id}/webhook`);
        assert.equal(w.policy.debounce_seconds, 20);
      } finally { await S.stop(); }
    }

    // A valid cap still limits on the third push.
    {
      const S = await setup({ debounceMs: 0, maxPerHour: 2 });
      try {
        const A = await ownerWithBot(S.base, "two", "https://two.test/hook");
        await pushSeparately(S.platform, A.bot.id, 3);
        assert.equal(S.calls.length, 2, "a valid cap of 2 delivers exactly two pushes");
        assert.equal(S.platform.webhooks.deliveries(A.bot.id, 10).filter((d) => d.status === "rate_limited").length, 1);
      } finally { await S.stop(); }
    }

    // debounceMs: 0 still means "no coalescing" — it must not turn into 20s.
    {
      const S = await setup({ debounceMs: 0, maxPerHour: 100 });
      try {
        const A = await ownerWithBot(S.base, "zero", "https://zero.test/hook");
        S.platform.emit(A.bot.id, "system.notice", {});
        await sleep(100);
        assert.equal(S.calls.length, 1, "debounce 0 pushes immediately");
      } finally { await S.stop(); }
    }
  });
});
