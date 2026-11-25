import assert from "node:assert/strict";
import { AddressInfo } from "node:net";
import { test } from "node:test";
import { Platform } from "../src/platform.js";
import { buildServer } from "../src/server.js";
import { expectApiError, friends } from "./helpers.js";

/**
 * #139 ② candidate C: a pending card tells the owner through a Bot they already run.
 * The owner designates ONE of their own Bots as the notification outlet by pointing that Bot's
 * existing webhook at their receiver; no new endpoint, no mail, no push service.
 * The payload is content-free: the card's id, its kind, how many cards wait and when it expires.
 */

type Call = { url: string; headers: Record<string, string>; body: string };

async function setup() {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: any) => {
    calls.push({ url, headers: init.headers, body: init.body });
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  const platform = new Platform({ fetchImpl, webhooks: { debounceMs: 30, retryBaseMs: 5 } });
  const app = buildServer(platform);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  return { platform, base, calls, stop: async () => { await app.close(); platform.close(); } };
}

const bodies = (calls: Call[]) => calls.map((c) => JSON.parse(c.body));
const createdItems = (calls: Call[]) => bodies(calls).flatMap((b: any) => b.items ?? []).filter((i: any) => i.type === "approval.created");
const createdEvents = (platform: Platform) => platform.db.prepare("SELECT data FROM events WHERE type = 'approval.created'").all() as { data: string }[];

/** Wait for the push the platform schedules itself; nothing here forces a flush or opens a page. */
async function waitFor<T>(f: () => T | null | undefined, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = f();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`nothing arrived within ${ms} ms`);
}

/** Owner turns one of their Bots into the outlet: existing webhook + existing PATCH /v1/me. */
async function designate(owner: any, botId: string) {
  await owner.req("PUT", `/v1/bots/${botId}/webhook`, { url: "https://owner-notify.test/hook" });
  return owner.req("PATCH", "/v1/me", { notify_bot_id: botId });
}

test("a pending card reaches the owner's designated Bot inside the push window", async (t) => {
  const S = await setup();
  t.after(S.stop);
  const { A, B } = await friends(S.base);
  const me = await designate(A.owner, A.bot.id);
  assert.equal(me.notify_bot_id, A.bot.id, "GET shaped response says which Bot is the outlet");
  const conv = await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "hello" });
  const draft = await A.bot.draftMessage(conv.conversation_id, { text: "please check the numbers" });
  assert.equal(draft.status, "pending_approval");
  const items = await waitFor(() => { const i = createdItems(S.calls); return i.length ? i : null; });
  assert.equal(items.length, 1, "exactly one approval.created push");
  assert.deepEqual(Object.keys(items[0].approval).sort(), ["approval_id", "expires_at", "kind", "pending_count"]);
  assert.equal(items[0].approval.approval_id, draft.approval_id);
  assert.equal(items[0].approval.kind, "outbound_message");
  assert.equal(items[0].approval.pending_count, 1);
  assert.ok(Date.parse(items[0].approval.expires_at) > Date.now(), "expires_at is in the future");
});

test("the default push window keeps an announcement inside the 60 s budget", () => {
  const p = new Platform({ fetchImpl: (async () => new Response("ok")) as unknown as typeof fetch });
  try {
    assert.ok(p.webhooks.opts.debounceMs > 0 && p.webhooks.opts.debounceMs <= 60_000, `debounce window is ${p.webhooks.opts.debounceMs} ms`);
  } finally { p.close(); }
});

test("the push carries no text from the card, only ids, kind, count and expiry", async (t) => {
  const S = await setup();
  t.after(S.stop);
  const { A, B } = await friends(S.base);
  await designate(A.owner, A.bot.id);
  const conv = await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "hello" });
  const text = "SECRET-BODY-MARKER-7411 ring the bank";
  const draft = await A.bot.draftMessage(conv.conversation_id, { text });
  await S.platform.flushWebhooks();
  const raw = S.calls.map((c) => c.body).join("\n");
  assert.ok(raw.includes(draft.approval_id), "the card is identified");
  assert.ok(!raw.includes("SECRET-BODY-MARKER-7411"), "the draft text never leaves in the push");
  assert.ok(!raw.includes("ring the bank"), "not even a fragment of it");
  assert.ok(!raw.includes("To @"), "not the card summary either");
  // The card itself does carry the text, so the assertion above is about the payload, not a harmless draft.
  const pending = (await A.owner.req("GET", "/v1/approvals?status=pending")).approvals;
  assert.match(pending[0].summary, /SECRET-BODY-MARKER-7411/);
  const events = createdEvents(S.platform);
  assert.equal(events.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(events[0].data)).sort(), ["approval_id", "expires_at", "kind", "pending_count"]);
});

test("the same card is announced once, even when the announcement runs again", async (t) => {
  const S = await setup();
  t.after(S.stop);
  const { A, B } = await friends(S.base);
  await designate(A.owner, A.bot.id);
  const conv = await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "hello" });
  const draft = await A.bot.draftMessage(conv.conversation_id, { text: "one card" });
  await S.platform.flushWebhooks();
  assert.equal(createdEvents(S.platform).length, 1);
  const before = S.calls.length;
  assert.equal(S.platform.notifyOwnerOfApproval(draft.approval_id), false, "a second announcement is a no-op");
  await S.platform.flushWebhooks();
  assert.equal(createdEvents(S.platform).length, 1);
  assert.equal(S.calls.length, before, "nothing new is pushed");
});

test("no outlet designated, no announcement", async (t) => {
  const S = await setup();
  t.after(S.stop);
  const { A, B } = await friends(S.base);
  const conv = await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "hello" });
  await A.bot.draftMessage(conv.conversation_id, { text: "one card" });
  await S.platform.flushWebhooks();
  assert.equal(createdEvents(S.platform).length, 0);
  assert.equal(createdItems(S.calls).length, 0);
});

test("only the owner's own Bot may be the outlet, and the choice can be cleared", async (t) => {
  const S = await setup();
  t.after(S.stop);
  const { A, B } = await friends(S.base);
  const other = await (async () => { const x = await friends(S.base); return x.A; })();
  assert.equal((await A.owner.req("GET", "/v1/me")).notify_bot_id, null, "unset by default");
  await expectApiError(A.owner.req("PATCH", "/v1/me", { notify_bot_id: other.bot.id }), 400, "invalid_request");
  await expectApiError(A.owner.req("PATCH", "/v1/me", { notify_bot_id: "bot_does_not_exist" }), 400, "invalid_request");
  assert.equal((await A.owner.req("GET", "/v1/me")).notify_bot_id, null, "a refused Bot leaves the setting untouched");
  await designate(A.owner, A.bot.id);
  const cleared = await A.owner.req("PATCH", "/v1/me", { notify_bot_id: null });
  assert.equal(cleared.notify_bot_id, null);
  const conv = await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "hello" });
  await A.bot.draftMessage(conv.conversation_id, { text: "one card" });
  await S.platform.flushWebhooks();
  assert.equal(createdEvents(S.platform).length, 0);
});
