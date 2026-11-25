// `PUT /v1/presence` reads its `to` and `room_id` with `String(...)` before it judges their type, and the Bot token
// branch of `presenceBot` reads `bot_id` the same way. `String()` rewrites a value the caller never wrote: an array
// wrapping a real handle or room id becomes that string, so the call silently lands a real presence line; `{}` and
// `true` and `1.5` become `"[object Object]"`, `"true"` and `"1.5"`, which are then looked up as names and answered
// `bot_not_found` / `face_room_not_found` — the wrong problem, named for a value nobody sent; and an object whose
// `toString` is not a function makes the read throw, so the caller is answered 500 `internal_error`.
//
// The doors judge the type first: a `to` or `room_id` that is neither absent nor a string is a 400 `invalid_request`
// naming the field, before any read, any presence entry, any rate-limit write, any database row and any room sweep.
// A Bot token is the one exception: it can only ever act as itself, so any `bot_id` it cannot read is that same 403,
// which is what #611's test already pins for an object; an array and an unreadable object now take the same answer
// instead of landing a line in the account's name or throwing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { friends, ownerWithBot, startServer } from "./helpers.js";

type S = Awaited<ReturnType<typeof startServer>>;

async function req(base: string, method: string, path: string, token: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}

const TABLES = ["audit_events", "messages", "approvals", "events", "face_room_events"] as const;

/** Ann and Ben are friends and share chat.public; they hold one open room. Carol and Dave hold a candidate room. */
async function world(t: any) {
  const s = await startServer();
  t.after(s.stop);
  const { A, B, relId } = await friends(s.base);
  await B.owner.req("POST", `/v1/relationships/${relId}/grants`, { capability: "chat.public", expires_in_days: 30 });
  const C = await ownerWithBot(s.base, "carol");
  const D = await ownerWithBot(s.base, "dave");

  const first = await A.owner.req("POST", "/v1/face-rooms/join", { code: "919191", bots: [A.bot.id] });
  const roomId = first.room_id as string;
  assert.equal((await B.owner.req("POST", "/v1/face-rooms/join", { code: "919191", bots: [B.bot.id] })).room_id, roomId);
  assert.equal((await A.owner.req("POST", `/v1/face-rooms/${roomId}/start`, {})).status, "open", "the room is started");

  const started = await C.owner.req("POST", "/v1/face-rooms/join", { code: "929292", bots: [C.bot.id] });
  const candidateRoom = started.room_id as string;
  assert.equal((await D.owner.req("POST", "/v1/face-rooms/join", { code: "929292", bots: [D.bot.id] })).room_id, candidateRoom);

  const count = (sql: string) => (s.platform.db.prepare(sql).get() as any).n as number;
  const auditCount = (sql: string) => (s.platform.audit.db.prepare(sql).get() as any).n as number;
  /** Every row a presence write could touch; the audit chain lives in its own database. */
  const snap = () => ({
    ...Object.fromEntries(TABLES.filter((t) => t !== "audit_events").map((t) => [t, count(`SELECT COUNT(*) n FROM ${t}`)])),
    audit_events: auditCount("SELECT COUNT(*) n FROM audit_events"),
  });
  const entries = () => s.platform.presence.live(Date.now()) as any[];
  const allowCalls: string[] = [];
  const store: any = s.platform.presence;
  const realAllow = store.allow.bind(store);
  store.allow = (botId: string, now: number) => { allowCalls.push(botId); return realAllow(botId, now); };

  const put = (token: string, body: unknown) => req(s.base, "PUT", "/v1/presence", token, body);
  const ownerPut = (body: unknown) => put(A.owner.token, body);
  const botPut = (body: unknown) => put(B.bot.cred.token, body);

  return { s, A, B, C, D, roomId, candidateRoom, snap, entries, allowCalls, put, ownerPut, botPut };
}

/** A refused write changes nothing at all: no entry, no row, no rate-limit spend. */
async function refusedNothing(f: Awaited<ReturnType<typeof world>>, r: { status: number; body: any }, before: Record<string, number>, allowBefore: number) {
  assert.deepEqual(f.snap(), before, "a refused write touches no row");
  assert.equal(f.entries().length, 0, "a refused write publishes no presence entry");
  assert.equal(f.allowCalls.length, allowBefore, "a refused write spends no rate-limit budget");
}

test("to given an object whose toString is not a function is a 400, not a 500", async (t) => {
  const f = await world(t);
  const before = f.snap();
  const r = await f.ownerPut({ state: "thinking", to: { toString: null } });
  assert.equal(r.status, 400, `an unreadable to must be refused, not answered ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body.error?.code, "invalid_request");
  assert.equal(r.body.error?.message, "to must be a string");
  await refusedNothing(f, r, before, 0);
});

test("to given a plain object is a 400 naming the field, not a 404 naming a Bot", async (t) => {
  const f = await world(t);
  const before = f.snap();
  const r = await f.ownerPut({ state: "thinking", to: {} });
  assert.equal(r.status, 400, `a to of {} must be refused, not answered ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body.error?.code, "invalid_request");
  assert.equal(r.body.error?.message, "to must be a string");
  await refusedNothing(f, r, before, 0);
});

test("to given an array wrapping a real handle lands no line", async (t) => {
  const f = await world(t);
  const before = f.snap();
  const r = await f.ownerPut({ state: "thinking", to: [f.B.handle] });
  assert.equal(r.status, 400, `to given an array must be refused, not answered ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body.error?.code, "invalid_request");
  assert.equal(r.body.error?.message, "to must be a string");
  await refusedNothing(f, r, before, 0);
});

test("room_id given an object whose toString is not a function is a 400, not a 500", async (t) => {
  const f = await world(t);
  const before = f.snap();
  const r = await f.ownerPut({ state: "thinking", room_id: { toString: null } });
  assert.equal(r.status, 400, `an unreadable room_id must be refused, not answered ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body.error?.code, "invalid_request");
  assert.equal(r.body.error?.message, "room_id must be a string");
  await refusedNothing(f, r, before, 0);
});

test("room_id given an array wrapping the room lands no line", async (t) => {
  const f = await world(t);
  const before = f.snap();
  const r = await f.ownerPut({ state: "thinking", room_id: [f.roomId] });
  assert.equal(r.status, 400, `room_id given an array must be refused, not answered ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body.error?.code, "invalid_request");
  assert.equal(r.body.error?.message, "room_id must be a string");
  await refusedNothing(f, r, before, 0);
});

test("a Bot token given an unreadable bot_id is the same 403, not a 500", async (t) => {
  const f = await world(t);
  const before = f.snap();
  const r = await f.botPut({ state: "thinking", room_id: f.roomId, bot_id: { toString: null } });
  assert.equal(r.status, 403, `a bot token with an unreadable bot_id must be refused, not answered ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body.error?.code, "forbidden");
  assert.equal(r.body.error?.message, "a bot token can only act as itself");
  await refusedNothing(f, r, before, 0);
});

test("a Bot token given an array bot_id lands no line in its own name", async (t) => {
  const f = await world(t);
  const before = f.snap();
  const r = await f.botPut({ state: "thinking", room_id: f.roomId, bot_id: [] });
  assert.equal(r.status, 403, `a bot token with an array bot_id must be refused, not answered ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body.error?.code, "forbidden");
  assert.equal(r.body.error?.message, "a bot token can only act as itself");
  await refusedNothing(f, r, before, 0);
});

test("an owner still names no Bot, null, or one of their own Bots", async (t) => {
  const f = await world(t);
  for (const [label, body] of [
    ["omitted", { state: "thinking", room_id: f.roomId }],
    ["null", { state: "thinking", room_id: f.roomId, bot_id: null }],
    ["an id", { state: "thinking", room_id: f.roomId, bot_id: f.A.bot.id }],
    ["a handle", { state: "thinking", room_id: f.roomId, bot_id: f.A.handle }],
  ] as [string, any][]) {
    const r = await f.ownerPut(body);
    assert.equal(r.status, 200, `bot_id given ${label} still publishes: ${JSON.stringify(r.body)}`);
    assert.deepEqual(f.entries().map((e: any) => e.botId), [f.A.bot.id], `bot_id given ${label} still means the owner's Bot`);
    assert.equal((await f.ownerPut({ state: "idle", room_id: f.roomId, bot_id: f.A.bot.id })).status, 200);
  }
});

test("string to and room_id keep every answer they have today", async (t) => {
  const f = await world(t);
  // 200 by handle and by id: a peer that may talk, and a room the Bot is seated in.
  for (const to of [f.B.handle, f.B.bot.id]) {
    const r = await f.ownerPut({ state: "thinking", to });
    assert.equal(r.status, 200, `to a live peer by ${to} still publishes: ${JSON.stringify(r.body)}`);
    assert.deepEqual(f.entries().map((e: any) => e.toBot), [f.B.bot.id]);
    assert.equal((await f.ownerPut({ state: "idle", to })).status, 200);
  }
  const room = await f.ownerPut({ state: "thinking", room_id: f.roomId });
  assert.equal(room.status, 200, JSON.stringify(room.body));
  assert.deepEqual(f.entries().map((e: any) => e.roomId), [f.roomId]);
  assert.equal((await f.ownerPut({ state: "idle", room_id: f.roomId })).status, 200);

  // 404 for a name nobody has, with the same code and message as today.
  const nobody = await f.ownerPut({ state: "thinking", to: "@nobody.here" });
  assert.equal(nobody.status, 404);
  assert.equal(nobody.body.error?.code, "bot_not_found");
  assert.equal(nobody.body.error?.message, "no such remote bot");
  // 403 for a Bot there is no relationship with.
  const stranger = await f.ownerPut({ state: "thinking", to: f.C.handle });
  assert.equal(stranger.status, 403);
  assert.equal(stranger.body.error?.code, "no_relationship");
  assert.equal(stranger.body.error?.message, "no active relationship between these bots");
  // 404 for a room that does not exist, and for one the Bot holds no seat in.
  const noRoom = await f.ownerPut({ state: "thinking", room_id: "no-such-room" });
  assert.equal(noRoom.status, 404);
  assert.equal(noRoom.body.error?.code, "face_room_not_found");
  assert.equal(noRoom.body.error?.message, "no such room");
  const noSeat = await f.ownerPut({ state: "thinking", room_id: f.candidateRoom });
  assert.equal(noSeat.status, 404);
  assert.equal(noSeat.body.error?.code, "face_room_not_found");
  // 409 for a room whose window has not been started.
  const notStarted = await f.put(f.C.owner.token, { state: "thinking", room_id: f.candidateRoom });
  assert.equal(notStarted.status, 409);
  assert.equal(notStarted.body.error?.code, "room_not_started");
  assert.equal(f.entries().length, 0, "no refused string write left a line");
});

test("a Bot token's refusals stay 403 with one sentence", async (t) => {
  const f = await world(t);
  for (const [label, botId] of [["an object", {}], ["another Bot's id", f.A.bot.id]] as [string, unknown][]) {
    const r = await f.botPut({ state: "thinking", room_id: f.roomId, bot_id: botId });
    assert.equal(r.status, 403, `a bot token naming ${label} is refused: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error?.code, "forbidden");
    assert.equal(r.body.error?.message, "a bot token can only act as itself");
  }
  const ok = await f.botPut({ state: "thinking", room_id: f.roomId });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(f.entries().map((e: any) => e.botId), [f.B.bot.id], "a bot token still publishes as itself");
});
