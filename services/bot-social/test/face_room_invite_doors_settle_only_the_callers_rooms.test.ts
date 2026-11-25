// The three invite doors used to settle the whole server before they said anything about the ticket:
// `mintFaceRoomInvite` and `revokeFaceRoomInvite` opened with an unscoped `advanceFaceRooms()` and only then checked
// that the caller holds a seat (and is the room's lead), and `joinFaceRoomByInvite` ran the same sweep as the first
// statement of its transaction, before it had even read the ticket. Promotion is not a private act - it flips the
// room to `open`, voids its 6-digit number, deletes the `face_room_codes` rows, writes a `room.started` event, wakes
// every member and appends an audit row - so a stranger with a token and no seat could start another home's lapsed
// room by asking for a ticket it will not get, or by presenting one that is already dead.
//
// The mint and revoke doors now settle after the caller is authorized, and only the room they act on; the join door
// settles the rooms the Bots it brings are already seated in, the same seat rule the 6-digit door adopted (#724). A
// caller with no seat settles nothing. The tests below pin both halves: the stranger's call leaves the other home's
// room exactly as it was, and the room's own doors keep settling the caller's own lapsed room.
import assert from "node:assert/strict";
import { test } from "node:test";
import { generateEd25519 } from "../src/crypto.js";
import { expectApiError, ownerWithBot, startServer } from "./helpers.js";

const PAST = "2020-01-01T00:00:00.000Z";
const PUSH = "https://push.test/invite-doors";

type S = Awaited<ReturnType<typeof startServer>>;
type Who = Awaited<ReturnType<typeof ownerWithBot>>;

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
async function candidate(s: S, creator: Who, guest: Who, code: string) {
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

/** Drain the deliveries the setup itself queued (the joins push their own events), so a later count is the call's. */
async function quiet(s: S, calls: { url: string; body: string }[]) {
  await s.platform.flushWebhooks();
  calls.length = 0;
}

const mint = (s: S, who: Who, roomId: string) => who.owner.req("POST", `/v1/face-rooms/${roomId}/invites`);
const revoke = (s: S, who: Who, roomId: string, ticket: string) => who.owner.req("DELETE", `/v1/face-rooms/${roomId}/invites/${encodeURIComponent(ticket)}`);
const joinInvite = (s: S, who: Who, ticket: string, bots?: string[]) => who.owner.req("POST", "/v1/face-rooms/join-invite", { ticket, bots: bots ?? [who.bot.id] });
const seats = (s: S, roomId: string) => (s.platform.db.prepare("SELECT COUNT(*) n FROM face_room_members WHERE room_id = ? AND left_at IS NULL").get(roomId) as any).n as number;
const inviteRow = (s: S, ticket: string) => s.platform.db.prepare("SELECT * FROM face_room_invites WHERE ticket = ?").get(ticket) as any;

/** A second Bot for one owner, so a home can knock with a Bot that is not the one already seated. */
async function anotherBot(s: S, who: Who, handle: string) {
  const kp = generateEd25519();
  const r = await who.owner.req("POST", "/v1/bots", { handle, public_key: { alg: "Ed25519", kid: "k1", value: kp.publicKey } });
  return r.bot_id as string;
}

/** Record every sweep a door performs: how many, and over which seats. */
function spySweeps(s: S) {
  const seen: (ReadonlySet<string> | undefined)[] = [];
  const real = s.platform.advanceFaceRooms.bind(s.platform);
  (s.platform as any).advanceFaceRooms = (onlyRoomIds?: ReadonlySet<string>) => {
    seen.push(onlyRoomIds);
    return real(onlyRoomIds);
  };
  return seen;
}

/** No sweep on the door may be global, and none may name a room the caller has no seat in. */
function assertNarrowed(sweeps: (ReadonlySet<string> | undefined)[], forbidden: string[]) {
  assert.equal(sweeps.filter((scope) => !(scope instanceof Set)).length, 0, "the door leaves no unscoped sweep");
  for (const roomId of forbidden) assert.equal(sweeps.some((scope) => (scope as ReadonlySet<string>).has(roomId)), false, `and none names ${roomId}`);
}


/** The room a stranger's call must leave exactly as it was: candidate, numbered, silent, no audit. */
function assertUntouched(s: S, roomId: string, code: string) {
  assert.equal(roomRow(s, roomId).status, "candidate", "the room the caller holds no seat in is still a candidate");
  assert.equal(roomRow(s, roomId).code, code, "its number is not voided");
  assert.equal(codeRows(s, roomId), 1, "the number's row is still there");
  assert.equal(startedEvents(s, roomId), 0, "nobody was woken");
  assert.equal(startedAudits(s, roomId), 0, "the chain records no start");
}

test("a stranger's mint leaves another home's lapsed candidate room and its number alone", async (t) => {
  const { s, calls } = await server();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann", PUSH);
  const B = await ownerWithBot(s.base, "ben");
  const stranger = await ownerWithBot(s.base, "sam");
  const roomId = await candidate(s, A, B, "717171");
  lapse(s, roomId);
  await quiet(s, calls);
  const sweeps = spySweeps(s);

  await expectApiError(mint(s, stranger, roomId), 404, "face_room_not_found");
  await s.platform.flushWebhooks();

  assertUntouched(s, roomId, "717171");
  assert.equal(pushes(calls), 0, "no push went out");
  assertNarrowed(sweeps, [roomId]);
});

test("a stranger's revoke leaves another home's lapsed candidate room and its number alone", async (t) => {
  const { s, calls } = await server();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann", PUSH);
  const B = await ownerWithBot(s.base, "ben");
  const stranger = await ownerWithBot(s.base, "sam");
  const roomId = await candidate(s, A, B, "727272");
  const made = await mint(s, A, roomId);
  assert.equal(made.room_id, roomId);
  lapse(s, roomId);
  await quiet(s, calls);
  const sweeps = spySweeps(s);

  await expectApiError(revoke(s, stranger, roomId, made.ticket as string), 404, "face_room_not_found");
  await s.platform.flushWebhooks();

  assertUntouched(s, roomId, "727272");
  assert.equal(pushes(calls), 0, "no push went out");
  assert.equal(inviteRow(s, made.ticket as string).revoked_at, null, "the other home's ticket is not revoked");
  assertNarrowed(sweeps, [roomId]);
});

test("a stranger's refused ticket leaves another home's lapsed candidate room and its number alone", async (t) => {
  const { s, calls } = await server();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann", PUSH);
  const B = await ownerWithBot(s.base, "ben");
  const stranger = await ownerWithBot(s.base, "sam");
  const roomId = await candidate(s, A, B, "737373");
  lapse(s, roomId);
  await quiet(s, calls);

  const sweeps = spySweeps(s);
  // Ticket-shaped but nobody's, then malformed: both are the same 404, and neither may start a room.
  await expectApiError(joinInvite(s, stranger, "A".repeat(43)), 404, "invite_not_found");
  await expectApiError(joinInvite(s, stranger, "not-a-ticket"), 404, "invite_not_found");
  await s.platform.flushWebhooks();

  assertUntouched(s, roomId, "737373");
  assert.equal(pushes(calls), 0, "no push went out");
  assert.equal(seats(s, roomId), 2, "the stranger took no seat");
  assertNarrowed(sweeps, [roomId]);
});

test("a member's mint still settles that member's own lapsed room, and only that one", async (t) => {
  const { s, calls } = await server();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann", PUSH);
  const B = await ownerWithBot(s.base, "ben");
  const C = await ownerWithBot(s.base, "cat");
  const D = await ownerWithBot(s.base, "dan");
  const mine = await candidate(s, A, B, "747474");
  const theirs = await candidate(s, C, D, "757575");
  lapse(s, mine);
  lapse(s, theirs);
  await quiet(s, calls);
  const sweeps = spySweeps(s);

  const made = await mint(s, A, mine);
  assert.equal(made.room_id, mine);
  await s.platform.flushWebhooks();

  assert.equal(roomRow(s, mine).status, "open", "a candidate whose window lapsed is started");
  assert.equal(roomRow(s, mine).code, null, "its number is voided");
  assert.equal(codeRows(s, mine), 0, "the number's rows are gone");
  assert.equal(startedEvents(s, mine), 1, "the members are woken");
  assert.equal(startedAudits(s, mine), 1, "the chain records the start");
  assert.equal(pushes(calls), 1, "the seated Bot with a webhook is pushed once");

  assert.equal(roomRow(s, theirs).status, "candidate", "a lapsed room the caller has no seat in is left alone");
  assert.equal(roomRow(s, theirs).code, "757575", "and keeps its number");
  assert.equal(codeRows(s, theirs), 1);
  assert.equal(startedEvents(s, theirs), 0);
  assert.equal(startedAudits(s, theirs), 0);
  assert.ok(sweeps.length >= 1, "the mint door still sweeps");
  assert.ok(sweeps.every((scope) => scope instanceof Set), "no sweep on this door is left unscoped");
  assert.ok(sweeps.some((scope) => (scope as ReadonlySet<string>).has(mine)), "and one names the room it acts on");
  assertNarrowed(sweeps, [theirs]);
});

test("the invite doors still honour a live ticket and still refuse a dead one", async (t) => {
  const { s } = await server();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const C = await ownerWithBot(s.base, "cat");
  const roomId = await candidate(s, A, B, "767676");

  const made = await mint(s, A, roomId);
  const joined = await joinInvite(s, C, made.ticket as string);
  assert.equal(joined.room_id, roomId, "a live ticket still seats the guest");
  assert.equal(roomRow(s, roomId).status, "candidate", "a join does not start the room");
  assert.equal(roomRow(s, roomId).code, "767676", "nor void its number");

  const revived = await revoke(s, A, roomId, made.ticket as string);
  assert.equal(revived.revoked, true);
  await expectApiError(joinInvite(s, B, made.ticket as string), 410, "revoked");
  await expectApiError(joinInvite(s, B, "B".repeat(43)), 404, "invite_not_found");
  assert.equal(roomRow(s, roomId).status, "candidate", "a refused ticket settles nothing either");
  assert.equal(codeRows(s, roomId), 1);
});

test("the lead's revoke still settles the lapsed room it acts on", async (t) => {
  const { s, calls } = await server();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann", PUSH);
  const B = await ownerWithBot(s.base, "ben");
  const roomId = await candidate(s, A, B, "777777");
  // The ticket is minted while the window is still live, so the revoke below is what meets the lapsed row.
  const ticket = (await mint(s, A, roomId)).ticket as string;
  lapse(s, roomId);
  await quiet(s, calls);
  const sweeps = spySweeps(s);

  const revoked = await revoke(s, A, roomId, ticket);
  await s.platform.flushWebhooks();

  assert.equal(revoked.revoked, true, "the lead still revokes the ticket");
  assert.ok(inviteRow(s, ticket).revoked_at, "the row is marked revoked");
  assert.equal(roomRow(s, roomId).status, "open", "a candidate whose window lapsed is started by its own lead");
  assert.equal(codeRows(s, roomId), 0, "the number's rows are gone");
  assert.equal(startedEvents(s, roomId), 1, "the members are woken");
  assert.equal(startedAudits(s, roomId), 1, "the chain records the start");
  assert.ok(pushes(calls) >= 1, "the seated Bot with a webhook is pushed");
  assert.ok(sweeps.length >= 1, "the revoke door still sweeps");
  assert.ok(sweeps.every((scope) => scope instanceof Set), "no sweep on this door is left unscoped");
  assert.ok(sweeps.some((scope) => (scope as ReadonlySet<string>).has(roomId)), "and one names the room it acts on");
});

test("a caller already seated in the lapsed room still settles it by joining with a ticket", async (t) => {
  const { s, calls } = await server();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann", PUSH);
  const B = await ownerWithBot(s.base, "ben");
  const roomId = await candidate(s, A, B, "787878");
  const ticket = (await mint(s, A, roomId)).ticket as string;
  const second = await anotherBot(s, A, "annsecond.bot");
  lapse(s, roomId);
  await quiet(s, calls);
  const sweeps = spySweeps(s);

  // A's first Bot is already seated, so this home's knock is the room's own door as far as the sweep is concerned;
  // the second Bot is the seat the join actually takes.
  const joined = await joinInvite(s, A, ticket, [second]);
  await s.platform.flushWebhooks();

  assert.equal(joined.room_id, roomId);
  assert.ok(joined.members.some((m: any) => m.bot_id === second), "the new seat is answered with the room");
  assert.equal(roomRow(s, roomId).status, "open", "a candidate whose window lapsed is started by its own member");
  assert.equal(codeRows(s, roomId), 0, "the number's rows are gone");
  assert.equal(startedEvents(s, roomId), 1);
  assert.equal(startedAudits(s, roomId), 1);
  assert.equal(seats(s, roomId), 3, "the join took its seat");
  assert.ok(sweeps.length >= 1, "the join door still sweeps");
  assert.ok(sweeps.every((scope) => scope instanceof Set), "no sweep on this door is left unscoped");
  assert.ok(sweeps.some((scope) => (scope as ReadonlySet<string>).has(roomId)), "and one names the caller's room");
});
