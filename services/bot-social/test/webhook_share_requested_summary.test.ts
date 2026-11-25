// A `share.requested` event is the one push a Bot's owner gets when someone tries to reach a Bot that is not shared
// with them. Every other event type gets a written summary in the push, and the console shows its own label; this one
// used to fall through to the bare type name, so the push said `share.requested` and nothing else. The test pins the
// written summary for every door the platform writes (a started chat, a drafted message, a face-room join) and for a
// value this build does not know, plus a control that the other types still summarise the way they did.
import assert from "node:assert/strict";
import { AddressInfo } from "node:net";
import { test } from "node:test";
import { Platform } from "../src/platform.js";
import { buildServer } from "../src/server.js";
import { expectApiError, ownerWithBot } from "./helpers.js";

async function setup() {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  const fetchImpl = (async (url: string, init: any) => {
    calls.push({ url, headers: init.headers, body: init.body });
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  const platform = new Platform({ fetchImpl, webhooks: { debounceMs: 60_000, retryBaseMs: 5 } });
  const app = buildServer(platform);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  return { platform, base, calls, stop: async () => { await app.close(); platform.close(); } };
}

/** Send whatever is queued now and hand back the push items in the order they were queued. */
async function pushed(S: Awaited<ReturnType<typeof setup>>) {
  await S.platform.flushWebhooks();
  return S.calls.flatMap((c) => JSON.parse(c.body).items ?? []) as any[];
}
const item = (items: any[], type = "share.requested") => {
  const found = items.filter((i) => i.type === type);
  assert.ok(found.length > 0, `the owner got a push for ${type}`);
  return found[found.length - 1];
};
const setHook = async (S: Awaited<ReturnType<typeof setup>>, owner: { req(m: string, p: string, b?: unknown): Promise<any> }, botId: string) => {
  const hook = await owner.req("PUT", `/v1/bots/${botId}/webhook`, { url: "https://example.com/hook" });
  assert.equal(hook.configured, true);
};

/** Alice invites Bob's Bot to her Bot; Bob joins, so Alice's Bot holds only the reply-only grant Bob's owner added. */
async function joined(base: string) {
  const A = await ownerWithBot(base, "shr");
  const B = await ownerWithBot(base, "shj");
  const inv = await A.owner.req("POST", "/v1/invites", { bot_id: A.bot.id, offered_capabilities: ["chat.public"] });
  const j = await B.owner.req("POST", `/v1/invites/${inv.code}/join`, { from_bot_id: B.bot.id });
  assert.equal(j.status, "active");
  return { A, B };
}

test("a refused chat says who tried to start a conversation, not the event name", async () => {
  const S = await setup();
  try {
    const { A, B } = await joined(S.base);
    await setHook(S, B.owner, B.bot.id);

    // Alice's Bot may not start a chat with Bob's Bot: only the reply-only grant Bob's owner added exists, so the
    // refusal is real and the notice lands on Bob's Bot.
    await expectApiError(A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "hello" }), 403, "bot_not_shared");

    const summary = String(item(await pushed(S)).summary);
    assert.notEqual(summary, "share.requested", "the push names the type instead of describing it");
    assert.match(summary, /not shared/, "and says why nothing arrived");
    assert.match(summary, /@shr\d*\.bot/i, "and which Bot asked");
    assert.match(summary, /start a chat/, "and what it tried");
    assert.equal(summary.includes("hello"), false, "the refused content is never repeated in the push");
  } finally {
    await S.stop();
  }
});

test("a refused draft says the sender tried to send a message", async () => {
  const S = await setup();
  try {
    const O = await ownerWithBot(S.base, "dft");
    await setHook(S, O.owner, O.bot.id);
    S.platform.emit(O.bot.id, "share.requested", { from: { handle: "@drafting.bot" }, attempted: "message.draft", trust: "platform" });

    const summary = String(item(await pushed(S)).summary);
    assert.notEqual(summary, "share.requested", "the push names the type instead of describing it");
    assert.match(summary, /@drafting\.bot/);
    assert.match(summary, /send you a message/);
    assert.match(summary, /not shared/);
  } finally {
    await S.stop();
  }
});

test("a refused room join says the sender tried to bring you into a face-to-face room", async () => {
  const S = await setup();
  try {
    const O = await ownerWithBot(S.base, "rmj");
    await setHook(S, O.owner, O.bot.id);
    S.platform.emit(O.bot.id, "share.requested", { from: { handle: "@roomy.bot" }, attempted: "face_room.join", trust: "platform" });

    const summary = String(item(await pushed(S)).summary);
    assert.notEqual(summary, "share.requested", "the push names the type instead of describing it");
    assert.match(summary, /@roomy\.bot/);
    assert.match(summary, /face-to-face room/);
    assert.match(summary, /not shared/);
  } finally {
    await S.stop();
  }
});

test("a door this build does not know still gets a sentence, never the raw code", async () => {
  const S = await setup();
  try {
    const O = await ownerWithBot(S.base, "unk");
    await setHook(S, O.owner, O.bot.id);
    S.platform.emit(O.bot.id, "share.requested", { from: { handle: "@future.bot" }, attempted: "grant.request", trust: "platform" });

    const summary = String(item(await pushed(S)).summary);
    assert.notEqual(summary, "share.requested", "the push names the type instead of describing it");
    assert.match(summary, /@future\.bot/);
    assert.match(summary, /reach you/, "a value this build does not know is described, not echoed");
    assert.equal(summary.includes("grant.request"), false, "the raw attempted code never reaches the owner");
    assert.match(summary, /not shared/);
  } finally {
    await S.stop();
  }
});

test("control: the neighbouring event types summarise exactly as they did", async () => {
  const S = await setup();
  try {
    const O = await ownerWithBot(S.base, "ctl");
    await setHook(S, O.owner, O.bot.id);
    S.platform.emit(O.bot.id, "message.received", { from: { handle: "@peer.bot" }, conversation_id: "conv_x", expects_reply: true });
    S.platform.emit(O.bot.id, "relationship.changed", { relationship_id: "rel_x", status: "active" });
    const items = await pushed(S);
    assert.equal(item(items, "message.received").summary, "New message from @peer.bot (conv_x) — may need a reply");
    assert.equal(item(items, "relationship.changed").summary, "Friendship rel_x is now active");
  } finally {
    await S.stop();
  }
});
