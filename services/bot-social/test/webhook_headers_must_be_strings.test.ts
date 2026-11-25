import assert from "node:assert/strict";
import { test } from "node:test";
import { bulkAuth, ownerWithBot, startServer } from "./helpers.js";

/** One fresh server with a live webhook that already carries one custom header. */
async function liveWebhook(t: any) {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "alice");
  await A.owner.req("PUT", `/v1/bots/${A.bot.id}/webhook`, { url: "https://example.com/hook", headers: ["X-Keep: original"] });
  /** The stored row, so a refusal can be compared to it byte for byte. */
  const stored = () => s.platform.db.prepare("SELECT webhook_url, webhook_headers, webhook_updated_at FROM bots WHERE id = ?").get(A.bot.id) as any;
  const auditCount = () => (s.platform.audit.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action = 'bot.webhook_set'").get() as any).n as number;
  return { s, A, stored, auditCount };
}

/** A refusal as the door answered it: `200` stands for "accepted and written". */
async function answer(p: Promise<unknown>) {
  try {
    const r = (await p) as any;
    return { status: 200, code: "", message: "", body: r };
  } catch (e: any) {
    return { status: e.status as number, code: e.code as string, message: e.message as string, body: null };
  }
}

test("a headers value that is neither a list nor an object is refused, and the live webhook is untouched", async (t) => {
  for (const shape of [42, true, "abc", null]) {
    const { A, stored, auditCount } = await liveWebhook(t);
    const before = stored();
    const audits = auditCount();
    const r = await answer(A.owner.req("PUT", `/v1/bots/${A.bot.id}/webhook`, { url: "https://example.com/other", headers: shape }));
    assert.equal(r.status, 400, `headers=${JSON.stringify(shape)} must be refused`);
    assert.equal(r.code, "invalid_request");
    assert.match(r.message, /headers must be a list or an object of header values/);
    assert.deepEqual(stored(), before, `headers=${JSON.stringify(shape)} must not rewrite the stored webhook`);
    assert.equal(auditCount(), audits, "a refused write appends no bot.webhook_set row");
  }
});

test("an object-form header whose value is not a string is refused, and the live webhook is untouched", async (t) => {
  for (const value of [1, 1.5, true, null, [1, 2], { a: 1 }]) {
    const { A, stored } = await liveWebhook(t);
    const before = stored();
    const r = await answer(A.owner.req("PUT", `/v1/bots/${A.bot.id}/webhook`, { url: "https://example.com/hook", headers: { "X-Probe": value } }));
    assert.equal(r.status, 400, `an object value of ${JSON.stringify(value)} must be refused`);
    assert.equal(r.code, "invalid_request");
    assert.match(r.message, /bad value for header X-Probe/);
    assert.deepEqual(stored(), before, `an object value of ${JSON.stringify(value)} must not rewrite the stored webhook`);
    assert.deepEqual(JSON.parse(before.webhook_headers), [{ name: "X-Keep", value: "original" }]);
  }
});

test("the documented header shapes still work: strings, {name,value} pairs, the object form, omitted, and an explicit empty list", async (t) => {
  const { A, stored } = await liveWebhook(t);
  const set = async (headers: unknown) => (await A.owner.req("PUT", `/v1/bots/${A.bot.id}/webhook`, { url: "https://example.com/hook", headers })) as any;
  assert.deepEqual((await set(["X-A: 1", "X-B: 2"])).headers.map((h: any) => h.name), ["X-A", "X-B"]);
  assert.deepEqual(JSON.parse(stored().webhook_headers), [{ name: "X-A", value: "1" }, { name: "X-B", value: "2" }]);
  await set([{ name: "X-C", value: "3" }]);
  assert.deepEqual(JSON.parse(stored().webhook_headers), [{ name: "X-C", value: "3" }]);
  // The object form is the one docs/SETUP.md shows: {"Authorization": "Bearer …"}.
  await set({ Authorization: "Bearer abc" });
  assert.deepEqual(JSON.parse(stored().webhook_headers), [{ name: "Authorization", value: "Bearer abc" }]);
  // Omitting the field keeps what is stored; only an explicit empty list clears it.
  await A.owner.req("PUT", `/v1/bots/${A.bot.id}/webhook`, { url: "https://example.com/hook" });
  assert.deepEqual(JSON.parse(stored().webhook_headers), [{ name: "Authorization", value: "Bearer abc" }]);
  await set([]);
  assert.deepEqual(JSON.parse(stored().webhook_headers), []);
});

test("onboard refuses the same shapes before it creates anything, and still accepts the object form", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const count = (table: string) => (s.platform.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as any).n as number;
  const onboarding = (webhook_headers: unknown) => s.platform.onboardFlybot({
    username: "probe", display_name: "Probe", webhook_url: "https://example.com/onboard", webhook_headers,
  } as any);
  for (const shape of [42, true, "abc", null, { "X-A": 1 }, { "X-A": null }]) {
    const before = { owners: count("owners"), bots: count("bots") };
    const r = await answer(Promise.resolve().then(() => onboarding(shape)));
    assert.equal(r.status, 400, `onboard webhook_headers=${JSON.stringify(shape)} must be refused`);
    assert.equal(r.code, "invalid_request");
    assert.deepEqual({ owners: count("owners"), bots: count("bots") }, before, "a refused sign-up leaves no owner or bot behind");
  }
  const ok = onboarding({ Authorization: "Bearer abc" });
  const home = s.platform.db.prepare("SELECT webhook_headers FROM bots WHERE id = ?").get(ok.home.bot_id) as any;
  assert.deepEqual(JSON.parse(home.webhook_headers), [{ name: "Authorization", value: "Bearer abc" }]);
});
