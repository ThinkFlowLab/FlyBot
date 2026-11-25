// `PUT /v1/presence` names the Bot that is thinking in `bot_id`. `presenceBot` reads that value with `String(...)`,
// so `String([])` and `String([""])` are the empty string and an array reads as "nobody named": the call answers 200
// and publishes the "thinking" line as the account's home Bot instead of the Bot the caller named — or, on an
// `idle` write, clears the home Bot's live line. `String(["<a Bot id>"])` is that id, so an array wrapping a real
// id acts as that Bot too: the declared type is not enforced at all. Objects, booleans and numbers take the other
// old path and are answered 404 `bot_not_found`, naming the wrong problem. An object whose `toString` is not a
// function makes the `String(...)` read itself throw, so the caller used to get a 500 `internal_error` instead of
// any answer about the field. A wrong-typed `bot_id` is a 400 that names the field, and it publishes, clears and
// writes nothing.
//
// The refusal belongs in the owner branch of `presenceBot` only: a Bot token speaks only for itself, and its own
// 403 for a `bot_id` that is not itself must stay a 403.
import assert from "node:assert/strict";
import { test } from "node:test";
import { expectApiError, ownerWithBot, startServer } from "./helpers.js";

async function req(base: string, method: string, path: string, token: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}
type Who = Awaited<ReturnType<typeof ownerWithBot>>;

/** Ann owns two Bots (the home Bot and a writer) and both are seated; Ben owns one. The room is open. */
async function room(t: any, code: string) {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const w = await A.owner.req("POST", "/v1/bots", { handle: "ann-writer.bot", display_name: "writer" });
  const writerId = w.bot_id as string;
  const a = await req(s.base, "POST", "/v1/face-rooms/join", A.owner.token, { code, bots: [A.bot.id, writerId] });
  assert.equal(a.status, 200);
  assert.equal((await req(s.base, "POST", "/v1/face-rooms/join", B.owner.token, { code, bots: [B.bot.id] })).status, 200);
  const roomId = a.body.room_id as string;
  assert.equal((await req(s.base, "POST", `/v1/face-rooms/${roomId}/start`, A.owner.token, {})).status, 200);
  const p: any = s.platform;
  const home = p.get("SELECT * FROM bots WHERE owner_id = ? AND status = 'active' ORDER BY created_at LIMIT 1", A.owner_id);
  const entries = () => (p.presence.live(Date.now()) as any[]).filter((e) => e.roomId === roomId).map((e) => e.botId as string);
  const audits = () => (p.audit.db.prepare("SELECT COUNT(*) n FROM audit_events").get() as any).n as number;
  const events = () => (p.get("SELECT COUNT(*) n FROM face_room_events WHERE room_id = ?", roomId) as any).n as number;
  const put = (body: unknown, who: Who = A) => req(s.base, "PUT", "/v1/presence", who.owner.token, body);
  const readAsB = () => req(s.base, "GET", `/v1/presence?room_id=${roomId}`, B.owner.token);
  const homeHandle = "@" + String(home.handle).replace(/^@/, "");
  return { s, p, A, B, home, homeHandle, writerId, writerHandle: `@ann-writer.bot`, roomId, entries, audits, events, put, readAsB };
}

test("a wrong-typed bot_id publishes no presence line", async (t) => {
  const f = await room(t, "818181");
  const wrong: [string, unknown][] = [
    ["an array", []],
    ["an array holding an empty string", [""]],
    ["an array holding a Bot id that is in the room", [f.writerId]],
    ["an object", {}],
    ["a boolean", true],
    ["a number", 1.5],
    ["zero", 0],
  ];
  for (const [label, value] of wrong) {
    const before = { audits: f.audits(), events: f.events() };
    const r = await f.put({ state: "thinking", room_id: f.roomId, bot_id: value });
    assert.equal(r.status, 400, `bot_id given ${label} must be refused, not answered ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error?.code, "invalid_request");
    assert.equal(r.body.error?.message, "bot_id must be a string");
    assert.deepEqual(f.entries(), [], `bot_id given ${label} published no line, in any Bot's name`);
    assert.deepEqual((await f.readAsB()).body.presence, [], `bot_id given ${label} published nothing a peer can read`);
    assert.equal(f.audits(), before.audits, `bot_id given ${label} wrote no audit row`);
    assert.equal(f.events(), before.events, `bot_id given ${label} wrote no room event`);
  }
});

test("a bot_id the code cannot even read is answered as a bad field, not a 500", async (t) => {
  const f = await room(t, "858585");
  const set = await f.put({ state: "thinking", room_id: f.roomId, bot_id: f.home.id });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.deepEqual(f.entries(), [f.home.id], "the home Bot has a live line that the bad write must leave alone");
  const before = { audits: f.audits(), events: f.events() };
  // `presenceBot` reads `bot_id` with `String(ref ?? "")` before any gate. An object whose own `toString` is not a
  // function makes that read throw a TypeError, and the caller is answered 500 `internal_error` — a server fault
  // named for a value the caller typed, with no field named. Both writes that name a Bot must be refused as the
  // bad field they are, before the read can throw.
  for (const state of ["thinking", "idle"]) {
    const r = await f.put({ state, room_id: f.roomId, bot_id: { toString: null } });
    assert.equal(r.status, 400, `a ${state} write with an unreadable bot_id must be refused, not answered ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error?.code, "invalid_request");
    assert.equal(r.body.error?.message, "bot_id must be a string");
    assert.deepEqual(f.entries(), [f.home.id], `a ${state} write with an unreadable bot_id changed no line`);
  }
  const seen = await f.readAsB();
  assert.equal(seen.status, 200);
  assert.deepEqual(seen.body.presence.map((e: any) => e.bot.handle), [f.homeHandle], "the peer still reads the one line");
  assert.equal(f.audits(), before.audits, "an unreadable bot_id wrote no audit row");
  assert.equal(f.events(), before.events, "an unreadable bot_id wrote no room event");
});

test("a wrong-typed bot_id cannot clear another Bot's line", async (t) => {
  const f = await room(t, "828282");
  const set = await f.put({ state: "thinking", room_id: f.roomId, bot_id: f.home.id });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.deepEqual(f.entries(), [f.home.id], "the home Bot has a live line to clear");

  const r = await f.put({ state: "idle", room_id: f.roomId, bot_id: [] });
  assert.equal(r.status, 400, `an idle write with an array bot_id must be refused, not answered ${r.status}`);
  assert.equal(r.body.error?.code, "invalid_request");
  assert.equal(r.body.error?.message, "bot_id must be a string");
  assert.deepEqual(f.entries(), [f.home.id], "the home Bot's line is still live");
});

test("the ways a presence write names its Bot still work", async (t) => {
  const f = await room(t, "838383");
  // An absent name and an explicit null still mean the account's home Bot.
  for (const [label, body] of [
    ["omitted", { state: "thinking", room_id: f.roomId }],
    ["null", { state: "thinking", room_id: f.roomId, bot_id: null }],
  ] as [string, any][]) {
    const r = await f.put(body);
    assert.equal(r.status, 200, `${label} bot_id still publishes: ${JSON.stringify(r.body)}`);
    assert.deepEqual(f.entries(), [f.home.id], `${label} bot_id still means the home Bot`);
    const seen = await f.readAsB();
    assert.equal(seen.status, 200);
    assert.deepEqual(seen.body.presence.map((e: any) => e.bot.handle), [f.homeHandle], `${label} bot_id still reaches the peer as the home Bot`);
    assert.equal((await f.put({ state: "idle", room_id: f.roomId, bot_id: f.home.id })).status, 200);
  }
  // A string still names a Bot, by id and by handle.
  for (const [label, value, handle] of [["id", f.writerId, f.writerHandle], ["handle", f.writerHandle, f.writerHandle]] as [string, string, string][]) {
    const r = await f.put({ state: "thinking", room_id: f.roomId, bot_id: value });
    assert.equal(r.status, 200, `a string ${label} still publishes: ${JSON.stringify(r.body)}`);
    assert.deepEqual(f.entries(), [f.writerId], `a string ${label} names the writer Bot`);
    const seen = await f.readAsB();
    assert.deepEqual(seen.body.presence.map((e: any) => e.bot.handle), [handle], `a string ${label} reaches the peer as the writer Bot`);
  }
});

test("a Bot token's own refusals are unchanged", async (t) => {
  const f = await room(t, "848484");
  // A Bot token names only itself: a body naming something else is a 403, and that stays a 403 rather than
  // becoming a 400 about the field.
  await expectApiError(f.B.bot.req("PUT", "/v1/presence", { state: "thinking", room_id: f.roomId, bot_id: {} }), 403, "forbidden");
  await expectApiError(f.B.bot.req("PUT", "/v1/presence", { state: "thinking", room_id: f.roomId, bot_id: f.A.bot.id }), 403, "forbidden");
  const ok = await f.B.bot.req("PUT", "/v1/presence", { state: "thinking", room_id: f.roomId });
  assert.equal(ok.state, "thinking");
  assert.deepEqual(f.entries(), [f.B.bot.id], "a Bot token still publishes as itself");
});
