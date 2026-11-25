/**
 * A leave names one room, so it settles one room — and it settles it only after the caller is judged a member.
 *
 * `leaveFaceRoom` used to sweep before it judged the room, with the caller's whole seat set: leaving room Y also
 * promoted another home's lapsed candidate X the caller happened to sit in — X went `candidate` → `open`, its number
 * was voided, its code rows deleted, a `room.started` event and an audit row written and its members woken. And a
 * caller the door then refused (a stranger, answered 404) had already settled its own lapsed rooms before the refusal,
 * so a write nobody performed still moved rooms.
 *
 * The door now expires lapsed shares first (a share's own clock is not the room's business, #739), then judges the
 * caller a member, then promotes the one room the request names. Each case below pins one link of that chain:
 *
 *   (a) a member's leave of Y leaves X — another home's lapsed candidate the member sits in — exactly as it was;
 *   (b) a refused leave settles no room: neither the caller's own lapsed room nor the room it named;
 *   (c) control: a member's leave still settles the room it names, and leaves another home's lapsed room alone;
 *   (d) a refused leave still records the lapsed share it declares, exactly once (#739's shape);
 *   (e) a Bot token's leave settles only the room it names.
 *
 * Dropping the sweep to pass (a)/(b) fails (c); widening the scope back to `faceSeatRooms` fails (a); running the
 * promotion before the member gate fails (b).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { bulkAuth, ownerWithBot, startServer } from "./helpers.js";

const PAST = "2020-01-01T00:00:00.000Z";
const PUSH = "https://push.test/leave-door";

type S = Awaited<ReturnType<typeof startServer>>;

/** A server whose webhook POSTs are captured instead of sent, so "0 pushes" and "1 push" are counted, not guessed. */
async function server() {
  const calls: { url: string; body: string }[] = [];
  const fetchImpl = (async (url: string, init: any) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  const s = await startServer({
    ...bulkAuth,
    faceRooms: { attemptsPerAccount: 200, attemptsPerIp: 200, createsPerAccount: 200, createsPerIp: 200 },
    fetchImpl,
  });
  return { s, calls };
}

const req = async (s: S, method: string, path: string, token: string, body?: unknown) => {
  const r = await fetch(s.base + path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
};

type Owner = Awaited<ReturnType<typeof ownerWithBot>>;

const roomRow = (s: S, id: string) => s.platform.db.prepare("SELECT * FROM face_rooms WHERE id = ?").get(id) as any;
const codeRows = (s: S, id: string) => (s.platform.db.prepare("SELECT COUNT(*) n FROM face_room_codes WHERE room_id = ?").get(id) as any).n as number;
const startedEvents = (s: S, id: string) => (s.platform.db.prepare("SELECT COUNT(*) n FROM face_room_events WHERE room_id = ? AND type = 'room.started'").get(id) as any).n as number;
const startedAudits = (s: S, id: string) => ((s.platform.audit as any).db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action = 'face_room.started' AND subject = ?").get(id) as any).n as number;
const pushesFor = (calls: { body: string }[], roomId: string) => calls.filter((c) => c.body.includes(roomId) && c.body.includes("room.started")).length;

/** Create a candidate room: one join mints it, the second home joins the same number without starting it. */
async function candidate(s: S, creator: Owner, guest: Owner, code: string) {
  const made = await req(s, "POST", "/v1/face-rooms/join", creator.owner.token, { code, bots: [creator.bot.id] });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const roomId = made.body.room_id as string;
  const joined = await req(s, "POST", "/v1/face-rooms/join", guest.owner.token, { code, bots: [guest.bot.id] });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  assert.equal(joined.body.room_id, roomId);
  assert.equal(roomRow(s, roomId).status, "candidate", "a second join does not start the room");
  return roomId;
}

/** Let the matching window lapse: the same row `advanceFaceRooms` promotes once it is due. */
function lapse(s: S, roomId: string) {
  s.platform.db.prepare("UPDATE face_rooms SET expires_at = ? WHERE id = ?").run(PAST, roomId);
}

/** The giver shares a capability with the taker's Bot, then the clock runs out on that share. */
async function lapsedShare(s: S, giver: Owner, taker: Owner) {
  const rel = await taker.owner.req("POST", "/v1/relationships", { from_bot_id: taker.bot.id, target_handle: giver.handle, message: "hi", requested_capabilities: ["chat.public"] });
  await giver.owner.req("POST", `/v1/relationships/${rel.relationship_id}/consent`, { decision: "accept", grant_capabilities: [] });
  const created = await giver.owner.req("POST", `/v1/relationships/${rel.relationship_id}/grants`, { capability: "chat.public", expires_in_days: 30 });
  const grantId = created.grant_id as string;
  s.platform.db.prepare("UPDATE grants SET expires_at = ? WHERE id = ?").run(PAST, grantId);
  const row = () => s.platform.db.prepare("SELECT * FROM grants WHERE id = ?").get(grantId) as any;
  const expiredAudits = () =>
    (s.platform.auditEvents({ kind: "owner", ownerId: taker.owner_id }, { limit: 500 }).events as any[]).filter(
      (e: any) => e.action === "grant.expired" && e.subject === grantId,
    );
  const expiredAnnouncements = () =>
    (s.platform.db.prepare("SELECT * FROM events WHERE bot_id = ? AND type = 'grant.changed'").all(taker.bot.id) as any[])
      .map((e: any) => JSON.parse(e.data) as any)
      .filter((e: any) => e.status === "expired");
  return { grantId, row, expiredAudits, expiredAnnouncements };
}

/** Drain the deliveries the setup itself queued, so a count is the door's own. */
async function quiet(s: S, calls: { url: string; body: string }[]) {
  await s.platform.flushWebhooks();
  calls.length = 0;
}

/** The facts a settled room would change, read together. */
function settledFacts(s: S, id: string) {
  const row = roomRow(s, id);
  return {
    status: row.status,
    code: row.code,
    expires_at: row.expires_at,
    started_at: row.started_at,
    codeRows: codeRows(s, id),
    startedEvents: startedEvents(s, id),
    startedAudits: startedAudits(s, id),
  };
}

test("(a) a member's leave of one room does not start another home's lapsed candidate it sits in", async (t) => {
  const { s, calls } = await server();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "lva", PUSH);
  const B = await ownerWithBot(s.base, "lvb", PUSH);
  const X = await candidate(s, B, A, "710001"); // B's room; A sits in it
  const Y = await candidate(s, A, B, "710002"); // A's room
  lapse(s, X);
  lapse(s, Y);
  await quiet(s, calls);

  const before = settledFacts(s, X);
  assert.equal(before.status, "candidate");
  assert.equal(before.code, "710001", "control: the other home's room still carries its number");

  const answer = await req(s, "POST", `/v1/face-rooms/${Y}/leave`, A.owner.token);
  await s.platform.flushWebhooks();
  assert.equal(answer.status, 200, JSON.stringify(answer.body));

  assert.deepEqual(settledFacts(s, X), before, "the room the request never named is untouched in all five facts");
  assert.equal(pushesFor(calls, X), 0, "the other home's members are not woken by this leave");
});

test("(b) a refused leave settles no room, not the caller's own lapsed room and not the room it named", async (t) => {
  const { s, calls } = await server();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "lvc", PUSH);
  const B = await ownerWithBot(s.base, "lvd", PUSH);
  const C = await ownerWithBot(s.base, "lve", PUSH);
  const X = await candidate(s, A, B, "710003"); // a room C is not in
  const Z = await candidate(s, C, A, "710004"); // C's own room, the only room C sits in
  lapse(s, X);
  lapse(s, Z);
  await quiet(s, calls);

  const beforeZ = settledFacts(s, Z);
  const beforeX = settledFacts(s, X);

  const answer = await req(s, "POST", `/v1/face-rooms/${X}/leave`, C.owner.token);
  await s.platform.flushWebhooks();
  assert.equal(answer.status, 404, JSON.stringify(answer.body));
  assert.equal(answer.body.error.code, "face_room_not_found");

  assert.deepEqual(settledFacts(s, Z), beforeZ, "the caller's own lapsed room is not settled by a refused leave");
  assert.deepEqual(settledFacts(s, X), beforeX, "the room a refused leave names is not settled either");
  assert.equal(pushesFor(calls, Z), 0, "a refused leave wakes nobody in the caller's room");
  assert.equal(pushesFor(calls, X), 0, "a refused leave wakes nobody in the room it named");
});

test("(c) control: a member's leave still settles the room it names, and leaves another home's lapsed room alone", async (t) => {
  const { s, calls } = await server();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "lvf", PUSH);
  const B = await ownerWithBot(s.base, "lvg", PUSH);
  const C = await ownerWithBot(s.base, "lvh", PUSH);
  const D = await ownerWithBot(s.base, "lvi", PUSH);
  const Y = await candidate(s, A, B, "710005"); // A leaves this one; B stays, so the room survives
  const neighbour = await candidate(s, C, D, "710006"); // A sits in neither side of it
  lapse(s, Y);
  lapse(s, neighbour);
  await quiet(s, calls);
  const beforeNeighbour = settledFacts(s, neighbour);

  const answer = await req(s, "POST", `/v1/face-rooms/${Y}/leave`, A.owner.token);
  await s.platform.flushWebhooks();
  assert.equal(answer.status, 200, JSON.stringify(answer.body));

  assert.equal(roomRow(s, Y).status, "open", "the named room is promoted, not left as a lapsed candidate");
  assert.equal(roomRow(s, Y).code, null, "its number is voided");
  assert.equal(codeRows(s, Y), 0, "the number's rows are gone");
  assert.equal(startedEvents(s, Y), 1, "its members are woken once");
  assert.equal(startedAudits(s, Y), 1, "the chain records the start");
  assert.ok(pushesFor(calls, Y) >= 1, "the seated Bot with a webhook is pushed");

  assert.deepEqual(settledFacts(s, neighbour), beforeNeighbour, "another home's lapsed room is untouched");
  assert.equal(pushesFor(calls, neighbour), 0, "and nobody there is woken");
});

test("(d) a refused leave still records the lapsed share it declares, exactly once", async (t) => {
  const { s, calls } = await server();
  t.after(s.stop);
  const giver = await ownerWithBot(s.base, "lvj", PUSH);
  const taker = await ownerWithBot(s.base, "lvk");
  const stranger = await ownerWithBot(s.base, "lvl", PUSH);
  const roomOwner = await ownerWithBot(s.base, "lvm", PUSH);
  const opened = await req(s, "POST", "/v1/face-rooms/join", roomOwner.owner.token, { code: "710007", bots: [roomOwner.bot.id] });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  const roomId = opened.body.room_id as string;
  // The room is open, so a sweep over it could promote nothing: what this case measures is only the share half.
  const started = await req(s, "POST", `/v1/face-rooms/${roomId}/start`, roomOwner.owner.token);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const share = await lapsedShare(s, giver, taker);
  await quiet(s, calls);
  const before = settledFacts(s, roomId);

  const answer = await req(s, "POST", `/v1/face-rooms/${roomId}/leave`, stranger.owner.token);
  await s.platform.flushWebhooks();
  assert.equal(answer.status, 404, JSON.stringify(answer.body));
  assert.equal(answer.body.error.code, "face_room_not_found");

  assert.equal(share.row().status, "expired", "the lapsed share is settled by the refused leave");
  assert.ok(share.row().revoked_at, "and its end is written down");
  assert.equal(share.expiredAudits().length, 1, "the chain records the lapse exactly once");
  assert.equal(share.expiredAnnouncements().length, 1, "the peer Bot is told exactly once");
  assert.deepEqual(settledFacts(s, roomId), before, "and the room itself is not moved by the refusal");
});

test("(e) a Bot token's leave settles only the room it names", async (t) => {
  const { s, calls } = await server();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "lvn", PUSH);
  const B = await ownerWithBot(s.base, "lvo", PUSH);
  const X = await candidate(s, B, A, "710008"); // A's Bot sits in B's room
  const Y = await candidate(s, A, B, "710009"); // A's Bot leaves this one
  lapse(s, X);
  lapse(s, Y);
  await quiet(s, calls);
  const before = settledFacts(s, X);

  const answer = await req(s, "POST", `/v1/face-rooms/${Y}/leave`, A.bot.cred.token);
  await s.platform.flushWebhooks();
  assert.equal(answer.status, 200, JSON.stringify(answer.body));

  assert.deepEqual(settledFacts(s, X), before, "a Bot's leave of its own room does not open the other home's room it sits in");
  assert.equal(pushesFor(calls, X), 0, "and does not wake that room");
});
