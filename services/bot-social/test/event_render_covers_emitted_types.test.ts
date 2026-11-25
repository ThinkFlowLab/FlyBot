/**
 * Three event types the platform emits itself reached every reader as the bare identifier: a webhook push said
 * `approval.digest`, the console's delivery table printed `message.not_delivered`, and `botctl pending` fell through to
 * its default line. The push is the one that matters most: a Bot woken by a type name has to fetch the details before
 * it knows whether a card waited overnight, whether the message it wrote arrived, or why a room ended.
 *
 * Each test below drives the real flow that emits the type and reads the push it produced. Summaries stay content-free:
 * counts, platform ids and reason codes only — the quiet-hours approval ids, the peer behind an undelivered message and
 * the room's note (which the peer wrote) never travel in a push.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AddressInfo } from "node:net";
import { Platform } from "../src/platform.js";
import { buildServer } from "../src/server.js";
import { approveAll, friends } from "./helpers.js";
import { req } from "./flybot_helpers.js";
import { loadConsole } from "./ui_helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Call = { url: string; headers: Record<string, string>; body: string };

/** Platform + HTTP server with a fetch that records every webhook push and answers 200. */
async function setup(now?: () => number) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: any) => {
    calls.push({ url, headers: init.headers, body: init.body });
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  const platform = new Platform({ ...(now ? { now } : {}), fetchImpl, webhooks: { debounceMs: 60, retryBaseMs: 5 } });
  const app = buildServer(platform);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  return { platform, base, calls, stop: async () => { await app.close(); platform.close(); } };
}

/** The one push of this run that carries `type`, and that item inside it. */
async function pushed(s: { platform: Platform; calls: Call[] }, type: string) {
  await sleep(150);
  await s.platform.flushWebhooks();
  const bodies = s.calls.map((c) => JSON.parse(c.body)).filter((b: any) => (b.items ?? []).some((i: any) => i.type === type));
  assert.equal(bodies.length, 1, `one push carries ${type}`);
  const bodies0 = bodies[0];
  return { body: bodies0, item: bodies0.items.find((i: any) => i.type === type) as any };
}

/** No item of any type is allowed to read as its own identifier. */
const assertSentences = (body: any) => {
  for (const i of body.items) {
    assert.notEqual(i.summary, i.type, `push item ${i.type} reads as its type, not a sentence`);
    assert.ok(String(i.summary).length > i.type.length, `push item ${i.type} has a real sentence`);
  }
};

test("a quiet-hours approval digest is pushed as a sentence, not as its type", async (t) => {
  const box = { t: Date.UTC(2026, 10, 6, 23, 30) };
  const s = await setup(() => box.t);
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  await A.owner.req("PUT", `/v1/bots/${A.bot.id}/webhook`, { url: "https://routine.test/digest" });
  await A.owner.req("PATCH", "/v1/me", { timezone: "UTC", notify_bot_id: A.bot.id, quiet_start: "22:00", quiet_end: "07:00" });
  const c = await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "a line held overnight" });
  const d = await A.bot.draftMessage(c.conversation_id, { text: "a line that waits for morning" });
  assert.equal(d.status, "pending_approval", "the card is held inside the window");

  // Morning: opening the queue is a delivery moment, so the held batch leaves as one digest.
  box.t = Date.UTC(2026, 10, 7, 7, 30);
  await A.owner.req("GET", "/v1/approvals");

  const { body, item } = await pushed(s, "approval.digest");
  assert.match(item.summary, /approval/i, `digest summary: ${item.summary}`);
  assert.ok(!item.summary.includes(d.approval_id), "the push does not name the cards it summarises");
  assertSentences(body);
});

test("a message reported not delivered is pushed as a sentence, without the peer behind it", async (t) => {
  const s = await setup();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  await A.owner.req("PUT", `/v1/bots/${A.bot.id}/webhook`, { url: "https://routine.test/not-delivered" });
  const c = await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "a message that arrives late" });
  await A.bot.draftMessage(c.conversation_id, { text: "PEER-TEXT-ONLY-IN-THE-ROOM" });
  await approveAll(A.owner);
  const m = s.platform.db.prepare("SELECT id FROM messages WHERE conversation_id = ? AND status = 'delivered'").get(c.conversation_id) as any;
  assert.ok(m?.id, "the message reached the recipient's home");

  // The recipient's owner reports that its Bot never got it (#442); the sender's Bot hears about it instead.
  s.platform.reportNotDelivered({ kind: "owner", ownerId: B.owner_id }, { message_id: m.id, reason: "not_shared_yet" });

  const { body, item } = await pushed(s, "message.not_delivered");
  assert.match(item.summary, /not delivered|could not be delivered/i, `summary: ${item.summary}`);
  assert.ok(item.summary.includes("not_shared_yet"), "the reason code is what the sender can act on");
  assert.ok(!item.summary.includes(B.handle), "the peer behind the message is not named in the push");
  assert.ok(!body.items.some((i: any) => String(i.summary).includes("PEER-TEXT-ONLY-IN-THE-ROOM")));
  assertSentences(body);
});

test("a room recap is pushed as a sentence and never carries the note a peer wrote", async (t) => {
  const s = await setup();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  await A.owner.req("PUT", `/v1/bots/${A.bot.id}/webhook`, { url: "https://routine.test/recap" });
  const NOTE = "SECRET-ROOM-NOTE-WRITTEN-BY-A-PEER";
  const opened = await req(s.base, "POST", "/v1/face-rooms/join", A.owner.token, { code: "830001", bots: [A.bot.id] });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  const roomId = opened.body.room_id as string;
  const joined = await req(s.base, "POST", "/v1/face-rooms/join", B.owner.token, { code: "830001", bots: [B.bot.id] });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  assert.equal(joined.body.room_id, roomId);
  assert.equal((await req(s.base, "POST", `/v1/face-rooms/${roomId}/start`, A.owner.token)).status, 200);
  assert.equal((await req(s.base, "POST", `/v1/face-rooms/${roomId}/note`, A.owner.token, { note: NOTE })).status, 200);

  // Everyone leaves; the last seat out closes the room and hands every member its recap.
  assert.equal((await req(s.base, "POST", `/v1/face-rooms/${roomId}/leave`, A.owner.token, {})).status, 200);
  assert.equal((await req(s.base, "POST", `/v1/face-rooms/${roomId}/leave`, B.owner.token, {})).status, 200);

  const { body, item } = await pushed(s, "face_room.recap");
  assert.match(item.summary, /room/i, `summary: ${item.summary}`);
  assert.match(item.summary, new RegExp(roomId), "the room it recaps is named");
  assert.ok(!JSON.stringify(body).includes(NOTE), "the peer's note never travels in a push");
  assertSentences(body);
});

test("the console and botctl name the three emitted types", () => {
  const { TYPE_LABEL } = loadConsole(["TYPE_LABEL"]);
  assert.equal(TYPE_LABEL["message.not_delivered"], "Not sent", "the delivery table says what happened");
  assert.ok(TYPE_LABEL["approval.digest"] && TYPE_LABEL["approval.digest"] !== "approval.digest", "a digest has a label");
  assert.ok(TYPE_LABEL["face_room.recap"] && TYPE_LABEL["face_room.recap"] !== "face_room.recap", "a recap has a label");
  const botctl = readFileSync(join(here, "..", "scripts", "botctl.ts"), "utf8");
  for (const type of ["approval.digest", "message.not_delivered", "face_room.recap"]) {
    assert.ok(botctl.includes(`case "${type}":`), `botctl prints ${type} instead of falling through to its default line`);
  }
});
