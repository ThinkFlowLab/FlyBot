// The room list is the last read door that settled the whole platform. `listFaceRooms` called the unscoped
// `advanceFaceRooms()`, so a caller who sits in no room at all started every lapsed candidate room on the server by
// asking for their own list: the room flipped to `open`, its 6-digit number was voided, its `face_room_codes` rows
// deleted, a `room.started` event written, the members woken and an audit row appended.
//
// The list now settles only the rooms it is about to answer with - the ones this caller is in, by the same seat rule
// the query already uses - so the seats a read talks about and the rooms it writes to are one set. The second test
// keeps the other half: a caller whose own Bot sits in a lapsed candidate room still gets it started. The third pins
// the narrower scope a Bot's own token gets: its sibling Bots' rooms are not its read to settle.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BotClient } from "../src/client.js";
import { generateEd25519 } from "../src/crypto.js";
import { ownerWithBot, startServer } from "./helpers.js";

const PAST = "2020-01-01T00:00:00.000Z";
const PUSH = "https://push.test/room-list";

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

/** Drain the deliveries the setup itself queued (the joins push their own events), so a later count is the read's. */
async function quiet(s: S, calls: { url: string; body: string }[]) {
  await s.platform.flushWebhooks();
  calls.length = 0;
}

/** A second Bot on the same owner: the token the caller holds, not the home it belongs to, is what scopes a read. */
async function siblingBot(A: any, handle: string) {
  const kp = generateEd25519();
  const made = await A.owner.req("POST", "/v1/bots", {
    handle,
    public_key: { alg: "Ed25519", kid: "k1", value: kp.publicKey },
  });
  assert.ok(made.bot_id, JSON.stringify(made));
  return new BotClient({ base: A.bot.cred.base, botId: made.bot_id, token: made.bot_token, kid: "k1", privateKeyPem: kp.privateKeyPem });
}

test("a stranger's room list leaves another home's candidate room and its number alone", async (t) => {
  const { s, calls } = await server();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann", PUSH);
  const B = await ownerWithBot(s.base, "ben");
  const stranger = await ownerWithBot(s.base, "sam");
  const roomId = await candidate(s, A, B, "616161");
  lapse(s, roomId);
  await quiet(s, calls);

  const seen = await stranger.owner.req("GET", "/v1/face-rooms");
  await s.platform.flushWebhooks();

  assert.deepEqual(seen.rooms, [], "a caller with no seat anywhere is listed no room");
  assert.equal(roomRow(s, roomId).status, "candidate", "the room the caller is not in is still a candidate");
  assert.equal(roomRow(s, roomId).code, "616161", "its number is not voided");
  assert.equal(codeRows(s, roomId), 1, "the number's row is still there");
  assert.equal(startedEvents(s, roomId), 0, "nobody was woken");
  assert.equal(startedAudits(s, roomId), 0, "the chain records no start");
  assert.equal(pushes(calls), 0, "no push went out");
});

test("the same list still starts the candidate room the caller's own Bot sits in", async (t) => {
  const { s, calls } = await server();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann", PUSH);
  const B = await ownerWithBot(s.base, "ben");
  const other = await ownerWithBot(s.base, "sid");
  const mine = await candidate(s, A, B, "626262");
  const theirs = await candidate(s, other, B, "636363");
  lapse(s, mine);
  lapse(s, theirs);
  await quiet(s, calls);

  const seen = await A.owner.req("GET", "/v1/face-rooms");
  await s.platform.flushWebhooks();

  assert.equal(roomRow(s, mine).status, "open", "a candidate whose window lapsed is started");
  assert.equal(roomRow(s, mine).code, null, "its number is voided");
  assert.equal(codeRows(s, mine), 0, "the number's rows are gone");
  assert.equal(startedEvents(s, mine), 1, "the members are woken");
  assert.equal(startedAudits(s, mine), 1, "the chain records the start");
  assert.equal(pushes(calls), 1, "the seated Bot with a webhook is pushed once");
  assert.equal((seen.rooms.find((r: any) => r.room_id === mine) as any)?.status, "open", "the list answers the settled row");

  assert.equal(roomRow(s, theirs).status, "candidate", "a lapsed room the caller has no seat in is left alone");
  assert.equal(roomRow(s, theirs).code, "636363", "and keeps its number");
  assert.equal(codeRows(s, theirs), 1);
  assert.equal(startedEvents(s, theirs), 0);
  assert.equal(startedAudits(s, theirs), 0);
  assert.ok(!seen.rooms.some((r: any) => r.room_id === theirs), "and is not in the list either");
});

test("a Bot's room list settles only the rooms that Bot sits in", async (t) => {
  const { s, calls } = await server();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann", PUSH);
  const B = await ownerWithBot(s.base, "ben");
  const other = await ownerWithBot(s.base, "sid");
  const sib = await siblingBot(A, `sib.${A.owner_id.slice(0, 8)}.bot`);
  const mine = await candidate(s, A, B, "646464");
  const theirs = await candidate(s, other, B, "656565");
  lapse(s, mine);
  lapse(s, theirs);
  await quiet(s, calls);

  const sibSeen = await sib.faceRooms();
  await s.platform.flushWebhooks();

  assert.deepEqual(sibSeen.rooms, [], "the sibling Bot holds no seat and is listed no room");
  assert.equal(roomRow(s, mine).status, "candidate", "its home's room is not its read to settle");
  assert.equal(roomRow(s, mine).code, "646464", "so the number stands");
  assert.equal(codeRows(s, mine), 1);
  assert.equal(startedEvents(s, mine), 0);
  assert.equal(startedAudits(s, mine), 0);
  assert.equal(pushes(calls), 0);

  const mineSeen = await A.bot.faceRooms();
  await s.platform.flushWebhooks();

  assert.equal(roomRow(s, mine).status, "open", "the Bot seated in the room does settle it");
  assert.equal(roomRow(s, mine).code, null, "its number is voided");
  assert.equal(codeRows(s, mine), 0);
  assert.equal(startedEvents(s, mine), 1);
  assert.equal(startedAudits(s, mine), 1);
  assert.equal(pushes(calls), 1);
  assert.equal((mineSeen.rooms.find((r: any) => r.room_id === mine) as any)?.status, "open", "and the list answers the settled row");
  assert.equal(roomRow(s, theirs).status, "candidate", "a room it has no seat in is still left alone");
  assert.equal(codeRows(s, theirs), 1);
});
