// `GET /v1/face-rooms/:id` opened with a platform-wide `advanceFaceRooms()` and only then asked whether the caller
// may read the room. That sweep is the room's own act — it flips a lapsed candidate to `open`, voids its 6-digit
// number, deletes its `face_room_codes` rows, writes a `room.started` event, wakes every member and appends an audit
// row — so a home with no seat at all could start another home's room by reading it, and was answered 404 only
// afterwards. Registration is open, so "a home with no seat" is any registered account.
//
// A read still keeps the sweep's share half, and keeps it first: `expireLapsedShares` writes down a share whose own
// clock ran out, which takes the seat that share made back with it, so a guest whose share just lapsed is refused by
// the membership check instead of being handed the room one last time (the shape `share_lapse_releases_guest_seat`
// pins, and the same split a merged read-door fix already made for the six non-room reads). What moves is the room
// half: it is not run by this door at all, and the answer comes from `faceRoomView`, whose `faceSettledRoom` settles
// exactly the room this call read, after the caller was checked.
//
// Both halves are asserted together. A change that stops the room start by dropping the whole sweep would pass a
// room-only reading while losing the lapse the read declares; a change that only checks the caller after settling
// still starts another home's room. So each read below is judged on both: another home's lapsed candidate keeps its
// status, its number, its rows, its chain, its members' quiet — and the lapsed share is still recorded.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bulkAuth, ownerWithBot, startServer } from "./helpers.js";

const PAST = "2020-01-01T00:00:00.000Z";
const PUSH = "https://push.test/room-read";

type S = Awaited<ReturnType<typeof startServer>>;

/** A server whose webhook POSTs are captured instead of sent, so "0 pushes" and "1 push" are counted, not guessed. */
async function server() {
  const calls: { url: string; body: string }[] = [];
  const fetchImpl = (async (url: string, init: any) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  const s = await startServer({ ...bulkAuth, fetchImpl });
  return { s, calls };
}

const roomRow = (s: S, id: string) => s.platform.db.prepare("SELECT * FROM face_rooms WHERE id = ?").get(id) as any;
const codeRows = (s: S, id: string) => (s.platform.db.prepare("SELECT COUNT(*) n FROM face_room_codes WHERE room_id = ?").get(id) as any).n as number;
const startedEvents = (s: S, id: string) => (s.platform.db.prepare("SELECT COUNT(*) n FROM face_room_events WHERE room_id = ? AND type = 'room.started'").get(id) as any).n as number;
const startedAudits = (s: S, id: string) => ((s.platform.audit as any).db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action = 'face_room.started' AND subject = ?").get(id) as any).n as number;
const pushesFor = (calls: { body: string }[], roomId: string) => calls.filter((c) => c.body.includes(roomId) && c.body.includes("room.started")).length;
const seats = (s: S, roomId: string) => (s.platform.db.prepare("SELECT COUNT(*) n FROM face_room_members WHERE room_id = ? AND left_at IS NULL").get(roomId) as any).n as number;

/** Create a candidate room: one join mints it, the second home joins the same number without starting it. */
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

/** The giver shares a capability with the taker's Bot, then the clock runs out on that share. */
async function lapsedShare(s: S, giver: any, taker: any) {
  const rel = await taker.owner.req("POST", "/v1/relationships", { from_bot_id: taker.bot.id, target_handle: giver.handle, message: "hi", requested_capabilities: ["chat.public"] });
  await giver.owner.req("POST", `/v1/relationships/${rel.relationship_id}/consent`, { decision: "accept", grant_capabilities: [] });
  const created = await giver.owner.req("POST", `/v1/relationships/${rel.relationship_id}/grants`, { capability: "chat.public", expires_in_days: 30 });
  const grantId = created.grant_id as string;
  s.platform.db.prepare("UPDATE grants SET expires_at = ? WHERE id = ?").run(PAST, grantId);
  const row = () => s.platform.db.prepare("SELECT * FROM grants WHERE id = ?").get(grantId) as any;
  const expiredAudits = () => (s.platform.auditEvents({ kind: "owner", ownerId: taker.owner_id }, { limit: 500 }).events as any[])
    .filter((e: any) => e.action === "grant.expired" && e.subject === grantId);
  const expiredAnnouncements = () => (s.platform.db.prepare("SELECT * FROM events WHERE bot_id = ? AND type = 'grant.changed'").all(taker.bot.id) as any[])
    .map((e: any) => JSON.parse(e.data) as any)
    .filter((e: any) => e.status === "expired");
  return { grantId, row, expiredAudits, expiredAnnouncements };
}

/** Drain the deliveries the setup itself queued (the joins and the grant push their own events), so a count is the read's. */
async function quiet(s: S, calls: { url: string; body: string }[]) {
  await s.platform.flushWebhooks();
  calls.length = 0;
}

/** Record every room sweep the read performs: how many, and over which rooms. */
function spySweeps(s: S) {
  const seen: (ReadonlySet<string> | undefined)[] = [];
  const real = s.platform.advanceFaceRooms.bind(s.platform);
  (s.platform as any).advanceFaceRooms = (onlyRoomIds?: ReadonlySet<string>) => {
    seen.push(onlyRoomIds);
    return real(onlyRoomIds);
  };
  return seen;
}

test("a stranger's read of another home's lapsed candidate starts nothing and is refused", async (t) => {
  const { s, calls } = await server();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann", PUSH);
  const B = await ownerWithBot(s.base, "ben");
  const stranger = await ownerWithBot(s.base, "sam", PUSH);
  const roomId = await candidate(s, A, B, "616161");
  lapse(s, roomId);
  await quiet(s, calls);
  const sweeps = spySweeps(s);

  await assert.rejects(
    () => stranger.owner.req("GET", `/v1/face-rooms/${roomId}`),
    (e: any) => e.status === 404 && e.code === "face_room_not_found",
    "a home with no seat is still refused 404 face_room_not_found",
  );
  await s.platform.flushWebhooks();

  assert.equal(roomRow(s, roomId).status, "candidate", "the room the caller is not in is still a candidate");
  assert.equal(roomRow(s, roomId).code, "616161", "its number is not voided");
  assert.equal(codeRows(s, roomId), 1, "the number's row is still there");
  assert.equal(startedEvents(s, roomId), 0, "nobody was woken");
  assert.equal(startedAudits(s, roomId), 0, "the chain records no start");
  assert.equal(pushesFor(calls, roomId), 0, "no push went out for that room");
  assert.equal(seats(s, roomId), 2, "the seats the setup took are the only ones");
  assert.equal(sweeps.length, 0, "a read that is refused runs no room sweep at all");

  // The room is checked before it is settled, so the same holds for an id that names no room at all.
  await assert.rejects(
    () => stranger.owner.req("GET", "/v1/face-rooms/frm_does_not_exist"),
    (e: any) => e.status === 404 && e.code === "face_room_not_found",
    "a missing room is still 404 face_room_not_found",
  );
  assert.equal(sweeps.length, 0, "and naming a room that does not exist runs no room sweep either");
});

test("a member's read still starts the room it reads, and only that room", async (t) => {
  const { s, calls } = await server();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann", PUSH);
  const B = await ownerWithBot(s.base, "ben", PUSH);
  const C = await ownerWithBot(s.base, "carl", PUSH);
  const D = await ownerWithBot(s.base, "dee", PUSH);
  const roomId = await candidate(s, A, B, "626262");
  const neighbour = await candidate(s, C, D, "636363");
  lapse(s, roomId);
  lapse(s, neighbour);
  await quiet(s, calls);
  const sweeps = spySweeps(s);

  const answer = await A.owner.req("GET", `/v1/face-rooms/${roomId}`);
  await s.platform.flushWebhooks();

  assert.equal(answer.status, "open", "the member's read answers the room it started");
  assert.equal(roomRow(s, roomId).status, "open", "a candidate whose window lapsed is started by its own member");
  assert.equal(roomRow(s, roomId).code, null, "its number is voided");
  assert.equal(codeRows(s, roomId), 0, "the number's rows are gone");
  assert.equal(startedEvents(s, roomId), 1, "the members are woken");
  assert.equal(startedAudits(s, roomId), 1, "the chain records the start");
  assert.ok(pushesFor(calls, roomId) >= 1, "the seated Bot with a webhook is pushed");

  assert.equal(roomRow(s, neighbour).status, "candidate", "another home's lapsed room is not started by this read");
  assert.equal(roomRow(s, neighbour).code, "636363", "its number is not voided");
  assert.equal(codeRows(s, neighbour), 1, "its number's row is still there");
  assert.equal(startedEvents(s, neighbour), 0, "its members were not woken");
  assert.equal(startedAudits(s, neighbour), 0, "the chain records no start for it");
  assert.equal(pushesFor(calls, neighbour), 0, "no push went out for it");

  assert.ok(sweeps.length >= 1, "the read still settles the room it read");
  assert.equal(sweeps.filter((scope) => !(scope instanceof Set)).length, 0, "no sweep on this read is left unscoped");
  assert.ok(sweeps.some((scope) => (scope as ReadonlySet<string>).has(roomId)), "one of them names the room that was read");
  assert.equal(sweeps.some((scope) => (scope as ReadonlySet<string>).has(neighbour)), false, "and none names another home's room");
});

test("a Bot token with no seat is refused before anything is settled; its own seat still reads", async (t) => {
  const { s, calls } = await server();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann", PUSH);
  const B = await ownerWithBot(s.base, "ben");
  const stranger = await ownerWithBot(s.base, "sam", PUSH);
  const otherHome = await ownerWithBot(s.base, "kim", PUSH);
  const roomId = await candidate(s, A, B, "646464");
  const ownRoom = await candidate(s, otherHome, B, "656565");
  lapse(s, roomId);
  lapse(s, ownRoom);
  await quiet(s, calls);
  const sweeps = spySweeps(s);

  // A Bot token is narrowed to its own seat: this Bot sits in no room, so it may not read this one.
  await assert.rejects(
    () => stranger.bot.req("GET", `/v1/face-rooms/${roomId}`),
    (e: any) => e.status === 404 && e.code === "face_room_not_found",
    "a Bot with no seat in the room is still refused 404 face_room_not_found",
  );
  await s.platform.flushWebhooks();
  assert.equal(roomRow(s, roomId).status, "candidate", "the unseated Bot started no room");
  assert.equal(codeRows(s, roomId), 1);
  assert.equal(startedEvents(s, roomId), 0);
  assert.equal(startedAudits(s, roomId), 0);
  assert.equal(pushesFor(calls, roomId), 0);
  assert.equal(sweeps.length, 0, "a refused Bot read runs no room sweep");

  // The same door, from a Bot that does hold a seat: its room still starts, and no other room moves.
  const answer = await otherHome.bot.req("GET", `/v1/face-rooms/${ownRoom}`);
  await s.platform.flushWebhooks();
  assert.equal(answer.status, "open", "a seated Bot's read answers the room it started");
  assert.equal(roomRow(s, ownRoom).status, "open", "its own lapsed room is started");
  assert.equal(codeRows(s, ownRoom), 0);
  assert.equal(startedEvents(s, ownRoom), 1);
  assert.equal(roomRow(s, roomId).status, "candidate", "and the other home's lapsed room is not");
  assert.equal(startedEvents(s, roomId), 0);
});

test("a refused room read still records the lapsed share it declares", async (t) => {
  const { s, calls } = await server();
  t.after(s.stop);
  const giver = await ownerWithBot(s.base, "ann", PUSH);
  const taker = await ownerWithBot(s.base, "ben");
  const stranger = await ownerWithBot(s.base, "sam");
  const roomOwner = await ownerWithBot(s.base, "kim");
  const roomId = await candidate(s, roomOwner, taker, "666666");
  const share = await lapsedShare(s, giver, taker);
  await quiet(s, calls);

  // The stranger holds no seat, so the room read is refused and starts nothing - but the share that lapsed on its
  // own clock is still written down and announced exactly once: that half is a read's own business.
  await assert.rejects(
    () => stranger.owner.req("GET", `/v1/face-rooms/${roomId}`),
    (e: any) => e.status === 404 && e.code === "face_room_not_found",
  );
  await s.platform.flushWebhooks();

  assert.equal(roomRow(s, roomId).status, "candidate", "the room the stranger is not in is still a candidate");
  assert.equal(startedEvents(s, roomId), 0);
  assert.equal(share.row().status, "expired", "the lapsed share is settled by the read");
  assert.ok(share.row().revoked_at, "and its end is written down");
  assert.equal(share.expiredAudits().length, 1, "the chain records the lapse exactly once");
  assert.equal(share.expiredAnnouncements().length, 1, "the peer Bot is told exactly once");
});
