/**
 * Starting a room voids its matching window, so the room must stop carrying that deadline.
 *
 * A six-digit code opens a `candidate` room with a short `expires_at`. Entering it or starting the room turns it into
 * an `open` group and voids the number (`docs/FACE_ROOMS.md`: `open` = "number void; normal group"), and from then on
 * the room ends when the last member leaves, not when the matching window ran out. The row kept the candidate
 * `expires_at` anyway (`faceStartRoom` rewrote only `status`, `started_at` and `code`), so the detail and the list of
 * an `open` room reported a time that was already in the past minutes after it started.
 *
 * A reader of `GET /v1/face-rooms/{id}` and `GET /v1/face-rooms` must see `expires_at: null` once the room has
 * started; a `candidate` keeps the closing time of its matching window, and a `closed` room's row is left as it was.
 * The sweep (`advanceFaceRooms`) must keep judging only `candidate` rows: an `open` row whose old window time has
 * passed is neither closed nor started again, and a candidate whose window has passed is still promoted.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

const req = async (base: string, method: string, path: string, token: string, body?: unknown) => {
  const r = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
};

type Owner = Awaited<ReturnType<typeof ownerWithBot>>;
const join = (base: string, o: Owner, code: string) => req(base, "POST", "/v1/face-rooms/join", o.owner.token, { code, bots: [o.bot.id] });
const start = (base: string, o: Owner, roomId: string) => req(base, "POST", `/v1/face-rooms/${roomId}/start`, o.owner.token);
const roomDetail = (base: string, o: Owner, roomId: string) => req(base, "GET", `/v1/face-rooms/${roomId}`, o.owner.token);
const roomList = (base: string, o: Owner) => req(base, "GET", "/v1/face-rooms", o.owner.token);

let S: Awaited<ReturnType<typeof startServer>>; // short matching window, movable clock
let L: Awaited<ReturnType<typeof startServer>>; // default window
let clock = Date.now();
let n = 0;
const freshCode = () => String(400000 + (++n));

before(async () => {
  S = await startServer({ now: () => clock, faceRooms: { ttlMs: 60_000 } });
  L = await startServer();
});
after(async () => {
  await S.stop();
  await L.stop();
});

async function candidateIn(server: Awaited<ReturnType<typeof startServer>>, code: string, first: Owner, second?: Owner) {
  const a = await join(server.base, first, code);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const roomId = a.body.room_id as string;
  if (second) {
    const b = await join(server.base, second, code);
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.equal(b.body.room_id, roomId);
  }
  return roomId;
}

test("(a) starting a room drops the matching-window deadline it was created with", async () => {
  const A = await ownerWithBot(S.base, "deada");
  const B = await ownerWithBot(S.base, "deadb");
  const code = freshCode();
  const roomId = await candidateIn(S, code, A);
  await candidateIn(S, code, B);

  const waiting = await roomDetail(S.base, A, roomId);
  assert.equal(waiting.body.status, "candidate");
  assert.equal(typeof waiting.body.expires_at, "string", "a candidate still says when its matching window closes");
  assert.ok(Date.parse(waiting.body.expires_at) > clock, `the candidate window is in the future, got ${waiting.body.expires_at}`);

  const started = await start(S.base, A, roomId);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.status, "open");

  // The window runs out while the room keeps going: it was never the room's deadline.
  clock += 120_000;
  const after = await roomDetail(S.base, A, roomId);
  assert.equal(after.body.status, "open", "the room is still open once the matching window has passed");
  assert.equal(after.body.expires_at, null, `an open room carries no matching-window deadline, got ${after.body.expires_at}`);
  assert.equal(started.body.expires_at, null, `starting the room voids its matching window, got ${started.body.expires_at}`);
});

test("(b) the rooms list carries no matching-window deadline for a started room", async () => {
  const A = await ownerWithBot(S.base, "deadc");
  const B = await ownerWithBot(S.base, "deadd");
  const code = freshCode();
  const roomId = await candidateIn(S, code, A);
  await candidateIn(S, code, B);
  const started = await start(S.base, A, roomId);
  assert.equal(started.body.status, "open");

  clock += 120_000; // the matching window has been over for a while
  const list = await roomList(S.base, A);
  const row = (list.body.rooms as any[]).find((r) => r.room_id === roomId);
  assert.ok(row, "the started room is still listed");
  assert.equal(row.status, "open");
  assert.equal(row.expires_at, null, `the list row of a started room carries no deadline, got ${row.expires_at}`);
});

test("(c) a candidate room keeps its matching window and still accepts the code", async () => {
  const A = await ownerWithBot(L.base, "deade"); // shaped like a normal handle
  const B = await ownerWithBot(L.base, "deadf");
  const code = freshCode();
  const roomId = await candidateIn(L, code, A);

  const detail = await roomDetail(L.base, A, roomId);
  assert.equal(detail.body.status, "candidate");
  assert.equal(typeof detail.body.expires_at, "string", "a candidate still reports its matching-window deadline");
  assert.ok(Date.parse(detail.body.expires_at) > Date.now(), `the candidate window is in the future, got ${detail.body.expires_at}`);

  const list = await roomList(L.base, A);
  const row = (list.body.rooms as any[]).find((r) => r.room_id === roomId);
  assert.ok(row);
  assert.equal(row.expires_at, detail.body.expires_at, "the list and the detail report the same candidate window");

  const joined = await join(L.base, B, code);
  assert.equal(joined.status, 200, "a live matching window still seats the second owner");
  assert.equal(joined.body.room_id, roomId);
  assert.equal(joined.body.status, "candidate");
});

test("(d) the sweep judges only candidates: an old deadline on an open room neither closes nor reopens it", async () => {
  const A = await ownerWithBot(L.base, "deadg");
  const B = await ownerWithBot(L.base, "deadh");
  const code = freshCode();
  const roomId = await candidateIn(L, code, A, B);

  // A room started before this fix still has its candidate deadline in the past, with status `open`.
  const stale = new Date(Date.now() - 3600_000).toISOString();
  const startedAt = new Date(Date.now() - 7200_000).toISOString();
  L.platform.db.prepare("UPDATE face_rooms SET status = 'open', started_at = ?, code = NULL, expires_at = ? WHERE id = ?").run(startedAt, stale, roomId);
  L.platform.db.prepare("DELETE FROM face_room_codes WHERE room_id = ?").run(roomId);

  L.platform.advanceFaceRooms();
  const kept = L.platform.db.prepare("SELECT status, started_at, expires_at FROM face_rooms WHERE id = ?").get(roomId) as any;
  assert.equal(kept.status, "open", "a passed matching window must not close a started room");
  assert.equal(kept.started_at, startedAt, "and must not start it a second time");
  assert.equal(kept.expires_at, stale, "the sweep does not rewrite a row it is not responsible for");

  // The other half of the same judgement: a candidate whose window passed is still promoted.
  const code2 = freshCode();
  const other = await candidateIn(L, code2, A, B);
  L.platform.db.prepare("UPDATE face_rooms SET expires_at = ? WHERE id = ?").run(stale, other);
  L.platform.advanceFaceRooms();
  const promoted = L.platform.db.prepare("SELECT status FROM face_rooms WHERE id = ?").get(other) as any;
  assert.equal(promoted.status, "open", "an expired candidate is still turned into an open room");
});

test("(e) a closed room keeps its own row: neither the sweep nor a later start rewrites its deadline", async () => {
  const A = await ownerWithBot(L.base, "deadi");
  const B = await ownerWithBot(L.base, "deadj");
  const code = freshCode();
  const roomId = await candidateIn(L, code, A, B);
  const original = (L.platform.db.prepare("SELECT expires_at FROM face_rooms WHERE id = ?").get(roomId) as any).expires_at;

  // The last member leaving closes the room; its row is not the sweep's business any more.
  const closedAt = new Date().toISOString();
  L.platform.db.prepare("UPDATE face_rooms SET status = 'closed', closed_at = ?, code = NULL WHERE id = ?").run(closedAt, roomId);
  L.platform.advanceFaceRooms();
  const row = L.platform.db.prepare("SELECT status, expires_at FROM face_rooms WHERE id = ?").get(roomId) as any;
  assert.equal(row.status, "closed", "a closed room stays closed");
  assert.equal(row.expires_at, original, "and keeps the deadline its row was written with");
});
