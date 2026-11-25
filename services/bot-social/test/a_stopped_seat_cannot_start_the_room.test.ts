/**
 * Starting a room is the lead's outbound act for the whole room, so a seat the platform has stopped must not start
 * one.
 *
 * The start door was the one outbound act in a room that never asked `assertInvitable`: the note door refuses a
 * stopped lead and the role-label door refuses a stopped seat, both with the sentence every outbound door gives
 * (#196), but `POST /v1/face-rooms/:id/start` read the caller's own seat and promoted the room anyway. Its writes are
 * the widest of any room door - it voids the number for everyone, pushes every member, writes a platform-trusted
 * `room.started` line and leaves a `face_room.started` audit row - so a frozen identity could still void a live code
 * in front of other owners.
 *
 * The guard belongs on the seat the door signs with (`viewer.botIds[0]`, the same seat `actor_bot` names), placed
 * before the sweep and the promotion, so a refused call leaves the room `candidate` with its `expires_at`, its code,
 * its events, its members' quiet and its chain untouched. Controls keep the door itself: an active seat still starts
 * the room, the peer's seat still starts it while the other home's Bot is stopped, and the same owner starts it after
 * a resume.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

type S = Awaited<ReturnType<typeof startServer>>;
type Who = Awaited<ReturnType<typeof ownerWithBot>>;

async function req(base: string, method: string, path: string, token: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}

const join = (base: string, o: Who, code: string) => req(base, "POST", "/v1/face-rooms/join", o.owner.token, { code, bots: [o.bot.id] });
const start = (base: string, o: Who, roomId: string) => req(base, "POST", `/v1/face-rooms/${roomId}/start`, o.owner.token);
const stopBot = (base: string, o: Who) => req(base, "POST", "/v1/emergency-stop", o.owner.token, { bot_id: o.bot.id });
const resumeBot = (base: string, o: Who) => req(base, "POST", `/v1/bots/${o.bot.id}/resume`, o.owner.token);

const roomRow = (s: S, roomId: string) => s.platform.db.prepare("SELECT * FROM face_rooms WHERE id = ?").get(roomId) as any;
const codeRows = (s: S, roomId: string) => (s.platform.db.prepare("SELECT COUNT(*) n FROM face_room_codes WHERE room_id = ?").get(roomId) as any).n as number;
const startedEvents = (s: S, roomId: string) => (s.platform.db.prepare("SELECT COUNT(*) n FROM face_room_events WHERE room_id = ? AND type = 'room.started'").get(roomId) as any).n as number;
const startedAudits = (s: S, roomId: string) => ((s.platform.audit as any).db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action = 'face_room.started' AND subject = ?").get(roomId) as any).n as number;
const memberStartedEvents = (s: S, roomId: string, who: Who[]) =>
  (s.platform.db.prepare(`SELECT COUNT(*) n FROM events WHERE type = 'face_room.started' AND bot_id IN (${who.map(() => "?").join(",")})`
  ).get(...who.map((o) => o.bot.id)) as any).n as number;

/** Two homes in one `candidate` room: Ann's Bot mints the number, Ben's Bot joins it without starting it. */
async function candidateRoom(t: any, code: string) {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "stopa");
  const B = await ownerWithBot(s.base, "stopb");
  const a = await join(s.base, A, code);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const roomId = a.body.room_id as string;
  const b = await join(s.base, B, code);
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.equal(b.body.room_id, roomId);
  assert.equal(roomRow(s, roomId).status, "candidate", "a second join does not start the room");
  return { s, A, B, roomId };
}

test("a stopped seat cannot start the room it sits in", async (t) => {
  const { s, A, B, roomId } = await candidateRoom(t, "783111");
  const before = roomRow(s, roomId);
  assert.equal(typeof before.expires_at, "string", "a candidate carries its matching-window deadline");
  assert.equal(codeRows(s, roomId), 1, "the number is live before the start");

  assert.equal((await stopBot(s.base, A)).body.status, "frozen");
  const refused: any = await start(s.base, A, roomId);
  assert.equal(refused.status, 403, "a stopped seat is refused, not answered with an open room");
  assert.equal(refused.body.error?.code, "bot_frozen", "the refusal names the stop");

  const after = roomRow(s, roomId);
  assert.equal(after.status, "candidate", "the refused start left the room waiting");
  assert.equal(after.expires_at, before.expires_at, "the matching window was not voided by the refusal");
  assert.equal(after.code, before.code, "the number the refusal could not use is still the room's");
  assert.equal(codeRows(s, roomId), 1, "the refused start deleted no code row");
  assert.equal(startedEvents(s, roomId), 0, "no room.started line was written for the room");
  assert.equal(startedAudits(s, roomId), 0, "no face_room.started audit row was written");
  assert.equal(memberStartedEvents(s, roomId, [A, B]), 0, "neither member heard a start");
});

test("a removed seat that is still listed on the room cannot start it either", async (t) => {
  const { s, A, roomId } = await candidateRoom(t, "783222");
  const before = roomRow(s, roomId);
  // A revoked Bot no longer holds a seat on this build, so the seat left behind is the torn state an older build
  // leaves: the identity is gone, the room still lists it. The door must refuse it by name, not start the room.
  s.platform.db.prepare("UPDATE bots SET status = 'revoked' WHERE id = ?").run(A.bot.id);

  const refused: any = await start(s.base, A, roomId);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error?.code, "bot_revoked", "the refusal names the removal");
  const after = roomRow(s, roomId);
  assert.equal(after.status, "candidate");
  assert.equal(after.expires_at, before.expires_at, "the matching window was not voided by the refusal");
  assert.equal(startedEvents(s, roomId), 0);
  assert.equal(startedAudits(s, roomId), 0);
});

test("control: the same owner starts the room after a resume", async (t) => {
  const { s, A, roomId } = await candidateRoom(t, "783333");
  assert.equal((await stopBot(s.base, A)).body.status, "frozen");
  assert.equal((await start(s.base, A, roomId)).status, 403, "the stop is what refuses the start");
  assert.equal((await resumeBot(s.base, A)).body.status, "active");

  const started: any = await start(s.base, A, roomId);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.status, "open", "a resumed seat starts the room");
  assert.equal(started.body.expires_at, null, "the start voids the matching window");
  assert.equal(startedEvents(s, roomId), 1, "the start is written down once");
  assert.equal(startedAudits(s, roomId), 1, "the start leaves one audit row");
});

test("control: an active seat still starts the room", async (t) => {
  const { s, A, roomId } = await candidateRoom(t, "783444");
  const started: any = await start(s.base, A, roomId);
  assert.equal(started.status, 200);
  assert.equal(started.body.status, "open");
  const ev = s.platform.db.prepare("SELECT actor_bot FROM face_room_events WHERE room_id = ? AND type = 'room.started'").get(roomId) as any;
  assert.equal(ev.actor_bot, A.bot.id, "the line names the seat the door signs with");
});

test("control: the peer's seat still starts a room whose other seat was stopped", async (t) => {
  const { s, A, B, roomId } = await candidateRoom(t, "783555");
  assert.equal((await stopBot(s.base, A)).body.status, "frozen");

  const started: any = await start(s.base, B, roomId);
  assert.equal(started.status, 200, "the stop on one home does not close the door for the other");
  assert.equal(started.body.status, "open");
  const ev = s.platform.db.prepare("SELECT actor_bot FROM face_room_events WHERE room_id = ? AND type = 'room.started'").get(roomId) as any;
  assert.equal(ev.actor_bot, B.bot.id, "the line names the seat that was active");
  assert.equal(startedEvents(s, roomId), 1);
});
