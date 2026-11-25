// `POST /v1/face-rooms/join` entered its transaction with an unscoped `advanceFaceRooms()` and only then read the
// number. The sweep is the room's own act - it flips a lapsed candidate to `open`, voids its 6-digit number, deletes
// its `face_room_codes` rows, writes a `room.started` event, wakes every member and appends an audit row - so a
// stranger holding a token, seated in no room at all and typing a six-digit number nobody ever minted, started
// another home's room before the door had even looked at the code. Registration is open, so "stranger" is any
// registered account.
//
// The sweep now runs over the seats the request itself brings: a caller with no seat settles no room, a caller whose
// Bot already sits in the lapsed room still settles it, and the refusals the door already gave (an ill-shaped code,
// a number whose room is gone) keep their answers. The call count on this door does not move: one sweep, now scoped.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

const PAST = "2020-01-01T00:00:00.000Z";
const PUSH = "https://push.test/join-door";

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

/** Drain the deliveries the setup itself queued (the joins push their own events), so a later count is the door's. */
async function quiet(s: S, calls: { url: string; body: string }[]) {
  await s.platform.flushWebhooks();
  calls.length = 0;
}

/** Record every sweep the door performs: how many, and over which seats. */
function spySweeps(s: S) {
  const seen: (ReadonlySet<string> | undefined)[] = [];
  const real = s.platform.advanceFaceRooms.bind(s.platform);
  (s.platform as any).advanceFaceRooms = (onlyRoomIds?: ReadonlySet<string>) => {
    seen.push(onlyRoomIds);
    return real(onlyRoomIds);
  };
  return seen;
}

test("a stranger's join with a made-up number leaves another home's candidate room alone", async (t) => {
  const { s, calls } = await server();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann", PUSH);
  const B = await ownerWithBot(s.base, "ben");
  const stranger = await ownerWithBot(s.base, "sam");
  const roomId = await candidate(s, A, B, "515151");
  lapse(s, roomId);
  await quiet(s, calls);
  const sweeps = spySweeps(s);

  const answer = await stranger.owner.req("POST", "/v1/face-rooms/join", { code: "909090", bots: [stranger.bot.id] });
  await s.platform.flushWebhooks();

  assert.equal(roomRow(s, roomId).status, "candidate", "the room the caller is not in is still a candidate");
  assert.equal(roomRow(s, roomId).code, "515151", "its number is not voided");
  assert.equal(codeRows(s, roomId), 1, "the number's row is still there");
  assert.equal(startedEvents(s, roomId), 0, "nobody was woken");
  assert.equal(startedAudits(s, roomId), 0, "the chain records no start");
  assert.equal(pushes(calls), 0, "no push went out for that room");
  assert.equal(seats(s, roomId), 2, "the seats the setup took are the only ones");

  // The other half: the door still does its own job for the caller who knocked. The number was nobody's, so the
  // caller gets their own candidate room, and every sweep the door performed is scoped - none names the other
  // home's room, so no global sweep was smuggled in through the answer either.
  assert.equal(answer.status, "candidate", "a made-up number still opens the caller's own candidate room");
  assert.notEqual(answer.room_id, roomId, "and the room is the caller's, not the other home's");
  assert.equal(roomRow(s, answer.room_id).code, "909090", "the caller's own number was minted as asked");
  assert.ok(sweeps.length >= 1, "the join door still sweeps, as before");
  assert.equal(sweeps.filter((scope) => !(scope instanceof Set)).length, 0, "no sweep is left unscoped on this door");
  assert.equal(sweeps.some((scope) => (scope as ReadonlySet<string>).has(roomId)), false, "and none names the other home's room");
});

test("the same join still settles the lapsed room its caller already sits in", async (t) => {
  const { s, calls } = await server();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann", PUSH);
  const B = await ownerWithBot(s.base, "ben");
  const roomId = await candidate(s, A, B, "525252");
  lapse(s, roomId);
  await quiet(s, calls);
  const sweeps = spySweeps(s);

  // A's Bot holds a seat in the lapsed room, so this is the room's own door as far as the sweep is concerned.
  const answer = await A.owner.req("POST", "/v1/face-rooms/join", { code: "525252", bots: [A.bot.id] });
  await s.platform.flushWebhooks();

  assert.equal(roomRow(s, roomId).status, "open", "a candidate whose window lapsed is started by its own member");
  assert.equal(roomRow(s, roomId).code, null, "its number is voided");
  assert.equal(codeRows(s, roomId), 0, "the number's rows are gone");
  assert.equal(startedEvents(s, roomId), 1, "the members are woken");
  assert.equal(startedAudits(s, roomId), 1, "the chain records the start");
  assert.ok(pushes(calls) >= 1, "the seated Bot with a webhook is pushed");
  assert.ok(sweeps.length >= 1, "the door still sweeps");
  assert.ok(sweeps.every((scope) => scope instanceof Set), "no sweep on this door is left unscoped");
  assert.ok(sweeps.some((scope) => (scope as ReadonlySet<string>).has(roomId)), "one of them names the caller's room");
  // The number was voided under it, so the same code mints the caller a fresh room - the answer this door gave.
  assert.equal(answer.status, "candidate", "the voided number mints a new candidate for its caller");
  assert.notEqual(answer.room_id, roomId, "and the old room is not the one answered with");
});

test("a refused number is refused before anything is settled", async (t) => {
  const { s, calls } = await server();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann", PUSH);
  const B = await ownerWithBot(s.base, "ben");
  const C = await ownerWithBot(s.base, "carl");
  const stranger = await ownerWithBot(s.base, "sam");
  const roomId = await candidate(s, A, B, "535353");
  lapse(s, roomId);
  await quiet(s, calls);

  // An ill-shaped number is the door's own 400, and it must not be the reason another home's room starts.
  await assert.rejects(
    () => stranger.owner.req("POST", "/v1/face-rooms/join", { code: "12345", bots: [stranger.bot.id] }),
    (e: any) => e.status === 400 && e.code === "invalid_code",
    "an ill-shaped code keeps its 400 invalid_code",
  );
  assert.equal(roomRow(s, roomId).status, "candidate", "a refused shape settles nothing");
  assert.equal(codeRows(s, roomId), 1, "its number rows are untouched");
  assert.equal(startedEvents(s, roomId), 0);
  assert.equal(startedAudits(s, roomId), 0);
  assert.equal(pushes(calls), 0);

  // A number whose room is gone keeps its 409 `code_void`, and that refusal settles nothing either.
  const dead = await C.owner.req("POST", "/v1/face-rooms/join", { code: "545454", bots: [C.bot.id] });
  s.platform.db.prepare("UPDATE face_rooms SET status = 'closed', closed_at = ? WHERE id = ?").run(new Date().toISOString(), dead.room_id);
  await assert.rejects(
    () => stranger.owner.req("POST", "/v1/face-rooms/join", { code: "545454", bots: [stranger.bot.id] }),
    (e: any) => e.status === 409 && e.code === "code_void",
    "a dead number keeps its 409 code_void",
  );
  await s.platform.flushWebhooks();
  assert.equal(roomRow(s, roomId).status, "candidate", "a dead number settles nothing else");
  assert.equal(codeRows(s, roomId), 1);
  assert.equal(startedEvents(s, roomId), 0);
  assert.equal(startedAudits(s, roomId), 0);
  assert.equal(pushes(calls), 0);
});

test("the room's own read door still starts a lapsed candidate", async (t) => {
  const { s, calls } = await server();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann", PUSH);
  const B = await ownerWithBot(s.base, "ben");
  const roomId = await candidate(s, A, B, "555555");
  lapse(s, roomId);
  await quiet(s, calls);

  await A.owner.req("GET", `/v1/face-rooms/${roomId}`);
  await s.platform.flushWebhooks();

  assert.equal(roomRow(s, roomId).status, "open", "the room's own read still settles its lapsed window");
  assert.equal(codeRows(s, roomId), 0, "and voids its number");
  assert.equal(startedEvents(s, roomId), 1);
  assert.equal(startedAudits(s, roomId), 1);
  assert.ok(pushes(calls) >= 1);
});

test("the join path settles no room but the caller's own, so a global sweep anywhere on it shows up here", async (t) => {
  // The door settles a lapsed room through the two calls it always made - the one inside its transaction and the one
  // behind the room view it answers with. Narrowing them must not be done by slipping a new global sweep onto this
  // path, so this test asks the behaviour instead of counting call sites: two other homes each hold a lapsed
  // candidate room, a caller with no seat anywhere knocks with a number nobody minted, and neither room may move.
  // A global sweep added anywhere on the path would start both of them and be caught here; it also fails when a door
  // elsewhere in the file legitimately adds or removes its own sweep, which is what a file-wide count could not say.
  const { s, calls } = await server();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann", PUSH);
  const B = await ownerWithBot(s.base, "ben");
  const C = await ownerWithBot(s.base, "carl");
  const D = await ownerWithBot(s.base, "dee");
  const stranger = await ownerWithBot(s.base, "sam");
  const first = await candidate(s, A, B, "545454");
  const second = await candidate(s, C, D, "565656");
  lapse(s, first);
  lapse(s, second);
  await quiet(s, calls);
  const sweeps = spySweeps(s);

  const answer = await stranger.owner.req("POST", "/v1/face-rooms/join", { code: "979797", bots: [stranger.bot.id] });
  await s.platform.flushWebhooks();

  for (const [who, roomId] of [["the first home's", first], ["the second home's", second]] as const) {
    assert.equal(roomRow(s, roomId).status, "candidate", `${who} room is still a candidate`);
    assert.equal(roomRow(s, roomId).code, roomId === first ? "545454" : "565656", `${who} room keeps its number`);
    assert.equal(codeRows(s, roomId), 1, `${who} room keeps its number row`);
    assert.equal(startedEvents(s, roomId), 0, `${who} room wakes nobody`);
    assert.equal(startedAudits(s, roomId), 0, `${who} room records no start`);
  }
  assert.equal(pushes(calls), 0, "no push went out for either room");
  assert.ok(sweeps.length >= 1, "the door still sweeps, as before");
  assert.equal(sweeps.filter((scope) => !(scope instanceof Set)).length, 0, "no sweep on this path is left unscoped");
  assert.equal(
    sweeps.some((scope) => (scope as ReadonlySet<string>).has(first) || (scope as ReadonlySet<string>).has(second)),
    false,
    "and none of them names either other home's room",
  );
  assert.equal(answer.status, "candidate", "the caller still gets their own candidate room for the made-up number");
});
