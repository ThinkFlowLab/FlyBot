// `PUT /v1/presence` with a `room_id` settles candidate rooms when its window lapses. The write door used to sweep
// the whole platform before it looked at the room or the caller's seat: a stranger, or a member naming a room they
// are not in, promoted every lapsed candidate room on the server (the room flipped to `open`, its number was voided,
// its `face_room_codes` rows deleted, a `room.started` event written, the members woken and an audit row appended)
// and only then answered 404.
//
// The door now checks the room and the caller's seat first, settles only the rooms the caller's own Bot is seated
// in, and answers 409 only after that settlement - so a lapsed room the caller sits in still starts, a candidate
// room whose window has not lapsed still answers `room_not_started`, and a refused write settles nothing at all.
import assert from "node:assert/strict";
import { test } from "node:test";
import { expectApiError, ownerWithBot, startServer } from "./helpers.js";

const PAST = "2020-01-01T00:00:00.000Z";
const PUSH = "https://push.test/presence-write";

type S = Awaited<ReturnType<typeof startServer>>;

/** A server whose webhook POSTs are captured instead of sent, so "0 pushes" and "1 push" are counted, not guessed. */
async function server() {
  const calls: { url: string; body: string }[] = [];
  const fetchImpl = (async (url: string, init: any) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  const s = await startServer({ fetchImpl });
  return { s, calls };
}

const roomRow = (s: S, id: string) => s.platform.db.prepare("SELECT * FROM face_rooms WHERE id = ?").get(id) as any;
const codeRows = (s: S, id: string) => (s.platform.db.prepare("SELECT COUNT(*) n FROM face_room_codes WHERE room_id = ?").get(id) as any).n as number;
const startedEvents = (s: S, id: string) => (s.platform.db.prepare("SELECT COUNT(*) n FROM face_room_events WHERE room_id = ? AND type = 'room.started'").get(id) as any).n as number;
const startedAudits = (s: S, id: string) => ((s.platform.audit as any).db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action = 'face_room.started' AND subject = ?").get(id) as any).n as number;
const pushes = (calls: { url: string }[]) => calls.filter((c) => c.url.startsWith(PUSH)).length;

/** Create a candidate room: the first join mints it, the second home joins the same number without starting it. */
async function candidate(s: S, creator: any, guest: any, code: string) {
  const made = await creator.owner.req("POST", "/v1/face-rooms/join", { code, bots: [creator.bot.id] });
  const roomId = made.room_id as string;
  assert.ok(roomId, JSON.stringify(made));
  const joined = await guest.owner.req("POST", "/v1/face-rooms/join", { code, bots: [guest.bot.id] });
  assert.equal(joined.room_id, roomId);
  assert.equal(roomRow(s, roomId).status, "candidate", "a second join does not start the room");
  return roomId as string;
}

/** Let the matching window lapse: the same row `advanceFaceRooms` promotes once it is due. */
function lapse(s: S, roomId: string) {
  s.platform.db.prepare("UPDATE face_rooms SET expires_at = ? WHERE id = ?").run(PAST, roomId);
}

/** Drain the deliveries the setup itself queued (the joins push their own events), so a later count is the write's. */
async function quiet(s: S, calls: { url: string; body: string }[]) {
  await s.platform.flushWebhooks();
  calls.length = 0;
}

/** The room row still looks untouched: no start, no voided number, no wake, no audit. */
function assertRoomUntouched(s: S, roomId: string, code: string) {
  assert.equal(roomRow(s, roomId).status, "candidate", "the room is still a candidate");
  assert.equal(roomRow(s, roomId).code, code, "its number is not voided");
  assert.equal(codeRows(s, roomId), 1, "the number's row is still there");
  assert.equal(startedEvents(s, roomId), 0, "nobody was woken");
  assert.equal(startedAudits(s, roomId), 0, "the chain records no start");
}

/** A refused write changed nothing at all: the room row is as it was and no push went out. */
function assertUntouched(s: S, roomId: string, code: string, calls: { url: string }[]) {
  assertRoomUntouched(s, roomId, code);
  assert.equal(pushes(calls), 0, "no push went out");
}

test("a stranger's presence write leaves another home's candidate room and its number alone", async (t) => {
  const { s, calls } = await server();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann", PUSH);
  const B = await ownerWithBot(s.base, "ben");
  const stranger = await ownerWithBot(s.base, "sam");
  const roomId = await candidate(s, A, B, "717171");
  lapse(s, roomId);
  await quiet(s, calls);

  await expectApiError(stranger.owner.req("PUT", "/v1/presence", { room_id: roomId, state: "thinking", ttl_seconds: 60 }), 404, "face_room_not_found");
  await s.platform.flushWebhooks();

  assertUntouched(s, roomId, "717171", calls);
});

test("a write naming a room the caller is not in settles nothing, not even the caller's own lapsed room", async (t) => {
  const { s, calls } = await server();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann", PUSH);
  const B = await ownerWithBot(s.base, "ben");
  const other = await ownerWithBot(s.base, "sid");
  const mine = await candidate(s, A, B, "727272");
  const theirs = await candidate(s, other, B, "737373");
  lapse(s, mine);
  lapse(s, theirs);
  await quiet(s, calls);

  await expectApiError(A.owner.req("PUT", "/v1/presence", { room_id: theirs, state: "thinking", ttl_seconds: 60 }), 404, "face_room_not_found");
  await s.platform.flushWebhooks();

  assertUntouched(s, theirs, "737373", calls);
  assertUntouched(s, mine, "727272", calls);
});

test("a write naming a room that does not exist settles nothing", async (t) => {
  const { s, calls } = await server();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann", PUSH);
  const B = await ownerWithBot(s.base, "ben");
  const roomId = await candidate(s, A, B, "747474");
  lapse(s, roomId);
  await quiet(s, calls);

  await expectApiError(A.owner.req("PUT", "/v1/presence", { room_id: "room_missing_for_this_test", state: "thinking", ttl_seconds: 60 }), 404, "face_room_not_found");
  await s.platform.flushWebhooks();

  assertUntouched(s, roomId, "747474", calls);
});

test("a seated member still starts their own lapsed room by setting presence in it", async (t) => {
  const { s, calls } = await server();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann", PUSH);
  const B = await ownerWithBot(s.base, "ben");
  const other = await ownerWithBot(s.base, "sid");
  const mine = await candidate(s, A, B, "757575");
  const theirs = await candidate(s, other, B, "767676");
  lapse(s, mine);
  lapse(s, theirs);
  await quiet(s, calls);

  const wrote = await A.owner.req("PUT", "/v1/presence", { room_id: mine, state: "thinking", ttl_seconds: 60 });
  assert.equal(wrote.ok, true, JSON.stringify(wrote));
  assert.equal(wrote.state, "thinking");
  await s.platform.flushWebhooks();

  assert.equal(roomRow(s, mine).status, "open", "a candidate whose window lapsed is started");
  assert.equal(roomRow(s, mine).code, null, "its number is voided");
  assert.equal(codeRows(s, mine), 0, "the number's rows are gone");
  assert.equal(startedEvents(s, mine), 1, "the members are woken");
  assert.equal(startedAudits(s, mine), 1, "the chain records the start");
  assert.equal(pushes(calls), 1, "the seated Bot with a webhook is pushed once");

  assertRoomUntouched(s, theirs, "767676");
});

test("a candidate room whose window has not lapsed still answers room_not_started", async (t) => {
  const { s, calls } = await server();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann", PUSH);
  const B = await ownerWithBot(s.base, "ben");
  const roomId = await candidate(s, A, B, "777777");
  await quiet(s, calls);

  await expectApiError(A.owner.req("PUT", "/v1/presence", { room_id: roomId, state: "thinking", ttl_seconds: 60 }), 409, "room_not_started");
  await s.platform.flushWebhooks();

  assert.equal(roomRow(s, roomId).status, "candidate", "an unexpired candidate is not started by the write");
  assert.equal(roomRow(s, roomId).code, "777777", "and keeps its number");
  assert.equal(codeRows(s, roomId), 1);
  assert.equal(startedEvents(s, roomId), 0);
  assert.equal(startedAudits(s, roomId), 0);
  assert.equal(pushes(calls), 0);
});
