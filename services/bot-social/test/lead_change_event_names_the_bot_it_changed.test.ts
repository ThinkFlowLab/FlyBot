// A `room.lead_changed` event names the Bot whose lead state actually changed. The creator's pick may be any of
// their own Bots or the other home's, and it need not be the seat that happens to come first for the caller, so an
// event that carries "the caller's first seat" points every reader at the wrong Bot.
import assert from "node:assert/strict";
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
const view = (base: string, o: Who, roomId: string) => req(base, "GET", `/v1/face-rooms/${roomId}`, o.owner.token);
const setLead = (base: string, o: Who, roomId: string, bot: string | null) => req(base, "POST", `/v1/face-rooms/${roomId}/lead`, o.owner.token, { bot });
const second = async (o: Who, name: string) => {
  const local = o.handle.replace(/^@/, "").replace(/\.bot$/, "");
  const r = await o.owner.req("POST", "/v1/bots", { handle: `${local}-${name}.bot`, display_name: name });
  return { id: r.bot_id as string, handle: `@${local}-${name}.bot` };
};
const leadEvents = (body: any) => body.events.filter((e: any) => e.type === "room.lead_changed");

/** Ann creates the room with her first Bot, Ben joins, then Ann seats a second Bot after him. */
async function room(t: any) {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const a2 = await second(A, "two");
  const a = await join(s.base, A, "515151");
  assert.equal(a.status, 200);
  assert.equal((await join(s.base, B, "515151")).status, 200);
  assert.equal((await join(s.base, A, "515151", [a2.id])).status, 200);
  return { s, A, B, a2, roomId: a.body.room_id as string };
}

/** Two homes, one Bot each, in a room Ann created. */
async function twoHomeRoom(t: any) {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const a = await join(s.base, A, "616161");
  assert.equal(a.status, 200);
  assert.equal((await join(s.base, B, "616161")).status, 200);
  return { s, A, B, roomId: a.body.room_id as string };
}

test("a pick names the Bot that became the lead, not the caller's first seat", async (t) => {
  const { s, A, B, a2, roomId } = await room(t);
  // The caller's seats are Ann's own Bot first and `a2` second, and Ben's Bot is another home's.
  assert.equal((await setLead(s.base, A, roomId, B.handle)).status, 200);
  let ev = leadEvents((await view(s.base, A, roomId)).body).at(-1);
  assert.equal(ev.reason, "set");
  assert.equal(ev.lead.bot_id, B.bot.id);
  assert.equal(ev.actor_bot, B.bot.id);

  // Picking the caller's own second seat names that Bot too, not the seat that comes first.
  assert.equal((await setLead(s.base, A, roomId, a2.id)).status, 200);
  ev = leadEvents((await view(s.base, A, roomId)).body).at(-1);
  assert.equal(ev.reason, "set");
  assert.equal(ev.lead.handle, a2.handle);
  assert.equal(ev.actor_bot, a2.id);
});

test("clearing the lead names the Bot it was taken from", async (t) => {
  const { s, A, B, roomId } = await room(t);
  assert.equal((await setLead(s.base, A, roomId, B.handle)).status, 200);
  assert.equal((await setLead(s.base, A, roomId, null)).status, 200);
  const ev = leadEvents((await view(s.base, A, roomId)).body).at(-1);
  assert.equal(ev.reason, "cleared");
  assert.equal(ev.actor_bot, B.bot.id);
});

test("nothing else moves: same pick writes no event, a stranger is refused, lead_left and handover keep their actor", async (t) => {
  const { s, A, B, roomId } = await room(t);
  assert.equal((await setLead(s.base, A, roomId, B.handle)).status, 200);
  const before = leadEvents((await view(s.base, A, roomId)).body).length;
  assert.equal((await setLead(s.base, A, roomId, B.handle)).status, 200);
  assert.equal(leadEvents((await view(s.base, A, roomId)).body).length, before);

  const outside = await second(A, "out");
  const bad = await setLead(s.base, A, roomId, outside.handle);
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, "bot_not_in_room");
  assert.equal(leadEvents((await view(s.base, A, roomId)).body).length, before);

  // The picked lead leaving still names the Bot that left.
  assert.equal((await req(s.base, "POST", `/v1/face-rooms/${roomId}/leave`, B.owner.token, {})).status, 200);
  const reset = leadEvents((await view(s.base, A, roomId)).body).at(-1);
  assert.equal(reset.reason, "lead_left");
  assert.equal(reset.actor_bot, B.bot.id);

  // A default-lead handover names no Bot, because no Bot's pick changed.
  const h = await twoHomeRoom(t);
  assert.equal((await req(h.s.base, "POST", `/v1/face-rooms/${h.roomId}/leave`, h.A.owner.token, {})).status, 200);
  const handover = leadEvents((await view(h.s.base, h.B, h.roomId)).body).at(-1);
  assert.equal(handover.reason, "handover");
  assert.equal(handover.actor_bot, null);
});
