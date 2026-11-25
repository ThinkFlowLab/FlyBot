// A role write is announced to the whole room, so what it announces has to be a change: the door compares each
// entry of `roles` against the label the seat carried, which is not the same question as whether any seat ends the
// write with a different label. A body that names one seat twice — by handle and by bot id — can walk a label away
// and back in one call: every entry differs from the stored value, nothing differs when the write ends, and the room
// still gets a `room.role_changed` event and a push per member. Members are told a label changed when it did not.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { generateEd25519 } from "../src/crypto.js";
import { ownerWithBot, startServer } from "./helpers.js";

async function req(base: string, method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}
type Who = Awaited<ReturnType<typeof ownerWithBot>>;
const join = (base: string, o: Who, code: string, bots: string[]) => req(base, "POST", "/v1/face-rooms/join", o.owner.token, { code, bots });
const view = (base: string, o: Who, roomId: string, after?: number) => req(base, "GET", `/v1/face-rooms/${roomId}${after !== undefined ? `?after=${after}` : ""}`, o.owner.token);
const setRoles = (base: string, o: Who, roomId: string, roles: unknown) => req(base, "PUT", `/v1/face-rooms/${roomId}/roles`, o.owner.token, { roles });

const eventsOf = (s: any, roomId: string) => (s.platform.db.prepare("SELECT type FROM face_room_events WHERE room_id = ? ORDER BY seq").all(roomId) as any[]).map((e) => e.type);
const queuedOf = (s: any, botId: string) => (s.platform.db.prepare("SELECT type FROM events WHERE bot_id = ? ORDER BY created_at, rowid").all(botId) as any[]).map((e) => e.type);
const deliveriesOf = (s: any, botId: string) => s.platform.db.prepare("SELECT status, event_types FROM webhook_deliveries WHERE bot_id = ? ORDER BY created_at, rowid").all(botId) as any[];
const roleAuditRows = (s: any, roomId: string) => (s.platform.audit.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action = 'face_room.role_changed' AND subject = ?").get(roomId) as any).n as number;

/** A stand-in webhook endpoint, so a push is observed on the wire and not only in the delivery row. */
async function receiver() {
  const got: any[] = [];
  const hook = createServer((r, res) => { let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => { got.push(JSON.parse(b)); res.writeHead(200).end(); }); });
  await new Promise<void>((ready) => hook.listen(0, "127.0.0.1", ready));
  return { got, url: `http://127.0.0.1:${(hook.address() as AddressInfo).port}/`, close: () => hook.close() };
}

/** Ann brings two of her own Bots into the room; Ben brings one and takes the pushes. */
async function twoHomesWithTwoSeats(t: any, code: string) {
  const webhook = await receiver();
  const s = await startServer();
  t.after(async () => { await s.stop(); webhook.close(); });
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben", webhook.url);
  const kp = generateEd25519();
  const second = await A.owner.req("POST", "/v1/bots", { handle: `${A.handle.replace(/^@/, "").replace(/\.bot$/, "")}2.bot`, public_key: { alg: "Ed25519", kid: "k1", value: kp.publicKey } });
  const a = await join(s.base, A, code, [A.bot.id, second.bot_id as string]);
  assert.equal(a.status, 200);
  assert.equal((await join(s.base, B, code, [B.bot.id])).status, 200);
  await s.platform.flushWebhooks();
  webhook.got.length = 0;
  return { s, A, B, webhook, roomId: a.body.room_id as string, secondBotId: second.bot_id as string, secondHandle: `@${A.handle.replace(/^@/, "").replace(/\.bot$/, "")}2.bot` };
}

test("a write that names one seat twice and ends on its old label announces nothing", async (t) => {
  const { s, A, B, webhook, roomId } = await twoHomesWithTwoSeats(t, "818181");
  assert.equal((await setRoles(s.base, A, roomId, { [A.handle]: "Reviewer" })).status, 200);
  await s.platform.flushWebhooks();
  webhook.got.length = 0;

  const before = (await view(s.base, B, roomId)).body;
  assert.equal(before.members.find((m: any) => m.handle === A.handle).role, "Reviewer");
  const eventsBefore = eventsOf(s, roomId);
  const queuedBefore = queuedOf(s, B.bot.id);
  const deliveriesBefore = deliveriesOf(s, B.bot.id).length;
  const auditBefore = roleAuditRows(s, roomId);

  // The same seat, named by handle and by id: away to "Phantom", then back to the label it already carries.
  const phantom = await setRoles(s.base, A, roomId, { [A.handle]: "Phantom", [A.bot.id]: "Reviewer" });
  assert.equal(phantom.status, 200, JSON.stringify(phantom.body));
  assert.equal(phantom.body.members.find((m: any) => m.handle === A.handle).role, "Reviewer", "the seat ends where it started");

  // Nothing changed, so there is nothing to announce: no room event, no cursor move, no inbox event, no push.
  assert.equal(phantom.body.event_cursor, before.event_cursor, "a write that leaves every label as it was appends no event");
  assert.deepEqual(eventsOf(s, roomId), eventsBefore, "the room's event stream is untouched");
  const vb = (await view(s.base, B, roomId, before.event_cursor)).body;
  assert.deepEqual(vb.events, [], "the other member's poll stays empty");
  await s.platform.flushWebhooks();
  assert.equal(webhook.got.length, 0, "no member is woken");
  assert.deepEqual(queuedOf(s, B.bot.id), queuedBefore, "nothing is queued to the other member");
  assert.equal(deliveriesOf(s, B.bot.id).length, deliveriesBefore, "and nothing is pushed");

  // The write itself is still recorded, as every role write is: the audit row is about the write, not the change.
  assert.equal(roleAuditRows(s, roomId), auditBefore + 1, "the write is still on the audit chain");
});

test("a label that really changes still reaches every member, and a repeated value still says nothing", async (t) => {
  const { s, A, B, webhook, roomId } = await twoHomesWithTwoSeats(t, "828282");
  const before = (await view(s.base, B, roomId)).body;
  const deliveriesBefore = deliveriesOf(s, B.bot.id).length;

  const real = await setRoles(s.base, A, roomId, { [A.handle]: "Writer" });
  assert.equal(real.status, 200);
  assert.equal(real.body.event_cursor, before.event_cursor + 1, "a real change appends exactly one event");
  assert.equal(real.body.members.find((m: any) => m.handle === A.handle).role, "Writer");
  await s.platform.flushWebhooks();
  assert.equal(webhook.got.length, 1, "the other member hears it once");
  assert.equal(webhook.got[0].items.filter((i: any) => i.type === "face_room.role_changed").length, 1);

  // Same value again: the existing contract — a write that changes nothing announces nothing, and the audit row
  // still records it.
  const quiet = await setRoles(s.base, A, roomId, { [A.handle]: "Writer" });
  assert.equal(quiet.status, 200);
  assert.equal(quiet.body.event_cursor, before.event_cursor + 1, "rewriting the same label appends nothing");
  await s.platform.flushWebhooks();
  assert.equal(webhook.got.length, 1, "and pushes nothing");
  assert.equal(deliveriesOf(s, B.bot.id).length, deliveriesBefore + 1, "one push for the one change, none for the replay");
});

test("two of my seats changing in one call is still one event and one push", async (t) => {
  const { s, A, B, webhook, roomId, secondBotId, secondHandle } = await twoHomesWithTwoSeats(t, "838383");
  const before = (await view(s.base, B, roomId)).body;
  const eventsBefore = eventsOf(s, roomId).length;

  const both = await setRoles(s.base, A, roomId, { [A.handle]: "Writer", [secondHandle]: "Reviewer" });
  assert.equal(both.status, 200);
  assert.equal(both.body.members.find((m: any) => m.handle === A.handle).role, "Writer");
  assert.equal(both.body.members.find((m: any) => m.handle === secondHandle).role, "Reviewer");
  // One call is one change to announce, however many seats it moves: members re-read the view, not one event per seat.
  assert.equal(eventsOf(s, roomId).length, eventsBefore + 1, "exactly one event for the call");
  assert.equal(both.body.event_cursor, before.event_cursor + 1);
  await s.platform.flushWebhooks();
  assert.equal(webhook.got.length, 1, "one push per member, not one per seat");
  assert.equal(webhook.got[0].items.filter((i: any) => i.type === "face_room.role_changed").length, 1);

  // Only the second seat moves this time: the event credits the Bot that was relabelled, not the first seat the body
  // happens to name, which is the shape this door already has.
  const onlySecond = await setRoles(s.base, A, roomId, { [A.handle]: "Writer", [secondHandle]: "Editor" });
  assert.equal(onlySecond.status, 200);
  const last = (await view(s.base, B, roomId, before.event_cursor)).body.events.at(-1);
  assert.equal(last.type, "room.role_changed");
  assert.equal(last.actor_bot, secondBotId, "the event names the seat whose label moved");
});
