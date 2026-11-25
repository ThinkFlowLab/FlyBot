// bot-social: a role label is read by every member of a face room, so relabelling a Bot changes what the other
// principals' consoles show — but the write leaves only an audit row (#675) and no room event, so a member polling
// `GET /v1/face-rooms/{id}?after=<cursor>` learns nothing and keeps rendering the old label until it re-pulls the
// whole room view. The lead change next door already reaches every seated member as `room.lead_changed` /
// `face_room.lead_changed`; a role label change has to do the same.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
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
const join = (base: string, o: Who, code: string, bots: string[] = [o.bot.id]) => req(base, "POST", "/v1/face-rooms/join", o.owner.token, { code, bots });
const view = (base: string, o: Who, roomId: string, after?: number) => req(base, "GET", `/v1/face-rooms/${roomId}${after !== undefined ? `?after=${after}` : ""}`, o.owner.token);
const setRoles = (base: string, o: Who, roomId: string, roles: unknown) => req(base, "PUT", `/v1/face-rooms/${roomId}/roles`, o.owner.token, { roles });

/** The room's events and the pushes this Bot was sent, read the same way a console sees them. */
const eventsOf = (s: any, roomId: string) => (s.platform.db.prepare("SELECT type FROM face_room_events WHERE room_id = ? ORDER BY seq").all(roomId) as any[]).map((e) => e.type);
const queuedOf = (s: any, botId: string) => (s.platform.db.prepare("SELECT type FROM events WHERE bot_id = ? ORDER BY created_at, rowid").all(botId) as any[]).map((e) => e.type);
const deliveriesOf = (s: any, botId: string) => s.platform.db.prepare("SELECT status, event_count, event_types FROM webhook_deliveries WHERE bot_id = ? ORDER BY created_at, rowid").all(botId) as any[];

/** A stand-in webhook endpoint, so a push is observed on the wire and not only in the delivery row. */
async function receiver() {
  const got: any[] = [];
  const hook = createServer((r, res) => { let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => { got.push(JSON.parse(b)); res.writeHead(200).end(); }); });
  await new Promise<void>((ready) => hook.listen(0, "127.0.0.1", ready));
  return { got, url: `http://127.0.0.1:${(hook.address() as AddressInfo).port}/`, close: () => hook.close() };
}

/** Ann creates the room (her Bot is the default lead), Ben joins the same code with his own Bot. */
async function twoHomes(t: any, code: string) {
  const webhook = await receiver();
  const s = await startServer();
  t.after(async () => { await s.stop(); webhook.close(); });
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben", webhook.url);
  const a = await join(s.base, A, code);
  assert.equal(a.status, 200);
  assert.equal((await join(s.base, B, code)).status, 200);
  // Everything before the first assertion is settled history: what the test watches starts from here.
  await s.platform.flushWebhooks();
  webhook.got.length = 0;
  return { s, A, B, webhook, roomId: a.body.room_id as string };
}

test("a role label written by one home reaches the other member as a room event and one push", async (t) => {
  const { s, A, B, webhook, roomId } = await twoHomes(t, "727272");
  const before = (await view(s.base, B, roomId)).body;
  assert.equal(before.members.find((m: any) => m.handle === A.handle).role, null, "nothing said about Ann's Bot yet");
  const deliveriesBefore = deliveriesOf(s, B.bot.id).length;

  const put = await setRoles(s.base, A, roomId, { [A.handle]: "Writer" });
  assert.equal(put.status, 200);
  assert.equal(put.body.members.find((m: any) => m.handle === A.handle).role, "Writer");

  // The writer's own answer moved: the label is not room metadata that leaves the event stream alone.
  assert.equal(put.body.event_cursor, before.event_cursor + 1, "the write appends exactly one event");
  assert.equal(put.body.events.at(-1).type, "room.role_changed");

  // Ben's poll from the cursor he already had: exactly one event, and it is the label change.
  const vb = (await view(s.base, B, roomId, before.event_cursor)).body;
  assert.equal(vb.event_cursor, before.event_cursor + 1, "Ben's cursor advances by exactly one");
  assert.equal(vb.events.length, 1, "one change, one event");
  const ev = vb.events[0];
  assert.equal(ev.type, "room.role_changed");
  assert.equal(ev.event_cursor, before.event_cursor + 1);
  assert.match(String(ev.event_id), /^fev_/);
  assert.equal(ev.actor_bot, A.bot.id, "the label belongs to Ann's Bot's owner");
  assert.equal(ev.trust, "platform");
  assert.deepEqual(Object.keys(ev).sort(), ["actor_bot", "created_at", "event_cursor", "event_id", "text", "trust", "type"], "the lead event's field set, and nothing carried over from the label");
  assert.ok(!JSON.stringify(ev).includes("Writer"), "the label itself stays out of the platform event; the view carries it as peer data");

  // Ben's console re-reads the view with the note-free event and now sees the label.
  assert.equal(vb.members.find((m: any) => m.handle === A.handle).role, "Writer");

  // One push, on the wire, naming the event and carrying no copy of the label.
  await s.platform.flushWebhooks();
  assert.equal(webhook.got.length, 1, "exactly one push");
  const body = webhook.got[0];
  assert.equal(body.type, "botsocial.wake");
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].type, "face_room.role_changed");
  // The push names the member's own inbox event; its body points back at the room event and cursor.
  const queuedRow = s.platform.db.prepare("SELECT id, data FROM events WHERE bot_id = ? AND type = 'face_room.role_changed'").get(B.bot.id) as any;
  assert.ok(queuedRow, "the member's inbox carries the change");
  assert.equal(body.items[0].event_id, queuedRow.id);
  const inboxData = JSON.parse(queuedRow.data);
  assert.equal(inboxData.event_id, ev.event_id, "the inbox event points at the room event");
  assert.equal(inboxData.event_cursor, ev.event_cursor);
  assert.equal(body.items[0].room_id, roomId);
  assert.match(String(body.items[0].summary), /role label/);
  assert.ok(!JSON.stringify(body).includes("Writer"), "no peer text in the push");
  const deliveries = deliveriesOf(s, B.bot.id);
  assert.equal(deliveries.length, deliveriesBefore + 1, "one delivery row, not one per event type");
  assert.equal(deliveries.at(-1).status, "delivered");
  assert.deepEqual(JSON.parse(deliveries.at(-1).event_types), { "face_room.role_changed": 1 });

  // The member's own inbox carries it too, which is what a connector polls.
  assert.deepEqual(queuedOf(s, B.bot.id).filter((x: string) => x === "face_room.role_changed"), ["face_room.role_changed"]);
});

test("clearing a label with null is the same change, and the whole room hears it", async (t) => {
  const { s, A, B, roomId } = await twoHomes(t, "737373");
  assert.equal((await setRoles(s.base, A, roomId, { [A.handle]: "Writer" })).status, 200);
  const beforeB = (await view(s.base, B, roomId)).body;
  assert.equal(beforeB.members.find((m: any) => m.handle === A.handle).role, "Writer");

  assert.equal((await setRoles(s.base, A, roomId, { [A.handle]: null })).status, 200);
  const vb = (await view(s.base, B, roomId, beforeB.event_cursor)).body;
  assert.deepEqual(vb.events.map((e: any) => e.type), ["room.role_changed"], "a cleared label is a change like any other");
  assert.equal(vb.members.find((m: any) => m.handle === A.handle).role, null);
  // The writer is a member too: the lead change next door tells every seat, and this one follows the same rule.
  const va = (await view(s.base, A, roomId, beforeB.event_cursor)).body;
  assert.deepEqual(va.events.map((e: any) => e.type), ["room.role_changed"]);
});

test("a refused role write emits no event and no push", async (t) => {
  const { s, A, B, webhook, roomId } = await twoHomes(t, "747474");
  const types = eventsOf(s, roomId);
  const queued = queuedOf(s, B.bot.id);
  const deliveries = deliveriesOf(s, B.bot.id).length;
  const beforeB = (await view(s.base, B, roomId)).body;

  const notMine = await setRoles(s.base, A, roomId, { [B.handle]: "Boss" });
  assert.equal(notMine.status, 404, "Ann cannot relabel Ben's Bot");
  assert.equal((await setRoles(s.base, A, roomId, { [A.handle]: 5 })).status, 400);
  assert.equal((await setRoles(s.base, A, roomId, { [A.handle]: true })).status, 400);
  assert.equal((await setRoles(s.base, A, roomId, {})).status, 400);
  assert.equal((await setRoles(s.base, A, roomId, [])).status, 400);
  const stranger = await ownerWithBot(s.base, "cy");
  assert.equal((await setRoles(s.base, stranger, roomId, { [A.handle]: "Boss" })).status, 404, "a non-member is not in this room");
  await s.platform.flushWebhooks();

  assert.deepEqual(eventsOf(s, roomId), types, "no event for a refusal");
  assert.deepEqual(queuedOf(s, B.bot.id), queued, "nothing queued to the other member");
  assert.equal(deliveriesOf(s, B.bot.id).length, deliveries, "nothing pushed");
  assert.equal(webhook.got.length, 0);
  const after = (await view(s.base, B, roomId, beforeB.event_cursor)).body;
  assert.deepEqual(after.events, [], "Ben's poll stays empty");
  assert.equal(after.event_cursor, beforeB.event_cursor);
  assert.equal(after.members.find((m: any) => m.handle === A.handle).role, null, "and no label was written");
});

test("rewriting the label a Bot already carries announces nothing, while the audit row still records the write", async (t) => {
  const { s, A, B, webhook, roomId } = await twoHomes(t, "757575");
  assert.equal((await setRoles(s.base, A, roomId, { [A.handle]: "Writer" })).status, 200);
  await s.platform.flushWebhooks();
  webhook.got.length = 0;
  const before = (await view(s.base, B, roomId)).body;
  const deliveries = deliveriesOf(s, B.bot.id).length;

  const again = await setRoles(s.base, A, roomId, { [A.handle]: "Writer" });
  assert.equal(again.status, 200);
  assert.equal(again.body.event_cursor, before.event_cursor, "the same label is not a change, so no event");
  const vb = (await view(s.base, B, roomId, before.event_cursor)).body;
  assert.deepEqual(vb.events, [], "the other member is not woken for a write that changed nothing");
  await s.platform.flushWebhooks();
  assert.equal(webhook.got.length, 0, "and no push");
  assert.equal(deliveriesOf(s, B.bot.id).length, deliveries);
  // The lead change sets the same precedent ("setting the same lead again does nothing"), while #675's audit row
  // records the write either way.
  const rows = s.platform.audit.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action = 'face_room.role_changed' AND subject = ?").get(roomId) as any;
  assert.equal(rows.n, 2, "both writes are on the audit chain, as #675 wrote them");
  assert.equal(vb.members.find((m: any) => m.handle === A.handle).role, "Writer");
});
