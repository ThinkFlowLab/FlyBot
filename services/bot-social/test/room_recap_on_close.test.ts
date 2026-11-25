/**
 * A room that ends leaves a recap behind.
 *
 * A face room is closed by the same door that empties it: the last seat out runs `faceCloseIfEmpty`, which flips the
 * row to `closed` and hands the group's numbers back. Afterwards nobody can read the room — a closed room is not in
 * `GET /v1/face-rooms` (`status != 'closed'`) and its transcript is behind the join floor — so there was no way to
 * learn what a room decided, who was in it, or why it ended.
 *
 * The close now writes one recap: `face_rooms.recap` (JSON) and one `face_room.recap` inbox event to every Bot that
 * sat in the room. It carries counts and names only — the reason the room ended, its window, its members, its note
 * and one number per decision — never a line's text, so a Bot that was in the room is told what it decided without
 * the transcript being replayed to anyone. The same payload goes to every member: nothing is trimmed by join floor
 * and nothing is specialised per recipient, so the members cannot disagree about what the room decided.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { friends, ownerWithBot, startServer } from "./helpers.js";

async function req(base: string, method: string, path: string, token: string, body?: unknown) {
  const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}

const ROOM_NOTE = "Plan the May trip and nothing else.";
const APPROVED_LINE = "Let us meet on the 12th of May.";
const REJECTED_LINE = "Bring the dog to the meeting.";
const PENDING_LINE = "This line is still waiting when the room ends.";

/** The room row's recap, parsed; null when the row carries none. */
const recapOf = (s: any, roomId: string) => {
  const row = s.platform.db.prepare("SELECT * FROM face_rooms WHERE id = ?").get(roomId) as any;
  return { row, recap: row?.recap ? JSON.parse(row.recap) : null };
};

/** The `face_room.recap` events this Bot can still read from its own inbox after the room is gone. */
const recapEvents = async (base: string, botToken: string) => {
  const r = await req(base, "GET", "/v1/events", botToken);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return (r.body.events as any[]).filter((e) => e.event_type === "face_room.recap");
};

/** Two homes, each with its own Bot seated in one open room, and the room's note written by its lead. */
async function twoHomesInRoom(code: string) {
  const clock = { now: Date.parse("2026-05-01T09:00:00.000Z") };
  const s = await startServer({ now: () => clock.now });
  const { A, B } = await friends(s.base);
  const opened = await req(s.base, "POST", "/v1/face-rooms/join", A.owner.token, { code, bots: [A.bot.id] });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  const roomId = opened.body.room_id as string;
  const joined = await req(s.base, "POST", "/v1/face-rooms/join", B.owner.token, { code, bots: [B.bot.id] });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  assert.equal(joined.body.room_id, roomId);
  const started = await req(s.base, "POST", `/v1/face-rooms/${roomId}/start`, A.owner.token);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const note = await req(s.base, "POST", `/v1/face-rooms/${roomId}/note`, A.owner.token, { note: ROOM_NOTE });
  assert.equal(note.status, 200, JSON.stringify(note.body));
  clock.now += 20 * 60e3;
  return { s, clock, A, B, roomId };
}

/** Draft one room line as this home's own Bot and decide it. */
async function decidedLine(s: any, o: any, roomId: string, text: string, decision: "approved" | "rejected") {
  const sent = await req(s.base, "POST", `/v1/face-rooms/${roomId}/messages`, o.owner.token, { text, bot_id: o.bot.id });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  assert.equal(sent.body.status, "pending_approval", JSON.stringify(sent.body));
  const decided = await req(s.base, "POST", `/v1/approvals/${sent.body.approval_id}/decision`, o.owner.token, { decision });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  return sent.body;
}

async function leave(s: any, o: any, roomId: string) {
  const r = await req(s.base, "POST", `/v1/face-rooms/${roomId}/leave`, o.owner.token, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r;
}

const bare = (handle: string) => String(handle).replace(/^@/, "");
/** The recap an inbox event carries, without the row's own cursor, id and timestamp. */
const payloadOf = (e: any) => { const { cursor, event_id, created_at, ...rest } = e; return rest; };
/** Every key anywhere in the recap, so a field that should never travel can be named. */
const keysOf = (value: any, out: Set<string> = new Set()) => {
  if (Array.isArray(value)) for (const v of value) keysOf(v, out);
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { out.add(k); keysOf(v, out); }
  return out;
};

test("a closed room hands every member's Bot the same recap", async () => {
  const { s, A, B, roomId } = await twoHomesInRoom("820001");
  try {
    await decidedLine(s, A, roomId, APPROVED_LINE, "approved");
    await decidedLine(s, B, roomId, REJECTED_LINE, "rejected");
    await leave(s, A, roomId);
    await leave(s, B, roomId);
    const { row, recap } = recapOf(s, roomId);
    assert.ok(recap, "the room row carries a recap once the room is closed");
    assert.equal(row.status, "closed");
    assert.equal(recap.reason, "room_left", "the last seat left on its own");
    assert.deepEqual(recap.decisions, { approved: 1, rejected: 1, cancelled: 0, expired: 0 }, "one number per decision");
    assert.equal(recap.note, ROOM_NOTE, "the room's note travels with the recap");
    assert.ok(recap.started_at, "the recap names when the room opened");
    assert.equal(recap.closed_at, row.closed_at, "the recap names when the room closed");
    assert.deepEqual(recap.members.map((m: any) => bare(m.handle)).sort(), [bare(A.handle), bare(B.handle)].sort(), "both seats are named");
    for (const m of recap.members) assert.ok(m.owner_name, "each seat names its home");

    // The room is gone from the list, and each Bot still reads the recap from its own inbox afterwards.
    const list = await req(s.base, "GET", "/v1/face-rooms", A.owner.token);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.ok(!(list.body.rooms as any[]).some((r) => r.room_id === roomId), "a closed room is not listed");
    const aEvents = await recapEvents(s.base, A.reg.bot_token);
    const bEvents = await recapEvents(s.base, B.reg.bot_token);
    assert.equal(aEvents.length, 1, "one recap per member Bot");
    assert.equal(bEvents.length, 1, "one recap per member Bot");
    assert.deepEqual(payloadOf(aEvents[0]), payloadOf(bEvents[0]), "both members read the same recap");
    assert.equal(aEvents[0].room_id, roomId);
    assert.equal(aEvents[0].reason, "room_left");
    assert.deepEqual(aEvents[0].decisions, recap.decisions);
  } finally { await s.stop(); }
});

test("closing the room again sends no second recap", async () => {
  const { s, A, B, roomId } = await twoHomesInRoom("820002");
  try {
    await decidedLine(s, A, roomId, APPROVED_LINE, "approved");
    await leave(s, A, roomId);
    await leave(s, B, roomId);
    const first = recapOf(s, roomId).recap;
    assert.ok(first, "the room closed once and recapped");
    const recapsInDb = () => (s.platform.db.prepare("SELECT COUNT(*) n FROM events WHERE type = 'face_room.recap'").get() as any).n as number;
    const before = recapsInDb();
    assert.equal(before, 2, "one recap per member Bot");
    const close = (s.platform as any).faceCloseIfEmpty.bind(s.platform);
    close(roomId, "room_left");
    close(roomId, "room_left");
    const after = recapsInDb();
    assert.equal(after, before, "a second close writes no second recap");
    assert.deepEqual(recapOf(s, roomId).recap, first, "the first recap stands");
  } finally { await s.stop(); }
});

test("a room that is still open has no recap", async () => {
  const { s, A, B, roomId } = await twoHomesInRoom("820003");
  try {
    const open = recapOf(s, roomId);
    assert.equal(open.row.status, "open");
    assert.equal(open.recap, null, "an open room carries no recap");
    assert.equal((await recapEvents(s.base, A.reg.bot_token)).length, 0, "an open room sends no recap");
    assert.equal((await recapEvents(s.base, B.reg.bot_token)).length, 0, "an open room sends no recap");
    // One seat out does not end the room: the other home is still sitting in it.
    await leave(s, A, roomId);
    assert.equal(recapOf(s, roomId).row.status, "open");
    assert.equal(recapOf(s, roomId).recap, null, "a room with a seat left carries no recap");
    assert.equal((await recapEvents(s.base, B.reg.bot_token)).length, 0, "a room with a seat left sends no recap");
  } finally { await s.stop(); }
});

test("the recap carries counts and names, never a line's text", async () => {
  const { s, A, B, roomId } = await twoHomesInRoom("820004");
  try {
    await decidedLine(s, A, roomId, APPROVED_LINE, "approved");
    await decidedLine(s, B, roomId, REJECTED_LINE, "rejected");
    // A line that is still waiting when the room ends: closing cancels it, and the recap counts it.
    const held = await req(s.base, "POST", `/v1/face-rooms/${roomId}/messages`, A.owner.token, { text: PENDING_LINE, bot_id: A.bot.id });
    assert.equal(held.status, 202, JSON.stringify(held.body));
    await leave(s, A, roomId);
    await leave(s, B, roomId);
    const recap = recapOf(s, roomId).recap;
    assert.ok(recap, "the room closed");
    assert.equal(recap.decisions.cancelled, 1, "the line the closure dropped is counted");
    const blob = JSON.stringify(recap);
    for (const text of [APPROVED_LINE, REJECTED_LINE, PENDING_LINE, ROOM_NOTE]) {
      if (text === ROOM_NOTE) continue;
      assert.ok(!blob.includes(text), `the recap never carries a line's text: ${text}`);
    }
    const keys = keysOf(recap);
    for (const forbidden of ["text", "untrusted_content", "transcript", "lines", "events", "payload", "messages"]) {
      assert.ok(!keys.has(forbidden), `the recap has no ${forbidden} field`);
    }
    // The shape is fixed, not merely free of the names above: a later field cannot smuggle a line in. The note is the
    // one free-form string the recap carries, and it is room metadata every member already reads, not a transcript.
    assert.deepEqual(Object.keys(recap).sort(),
      ["closed_at", "decisions", "members", "note", "reason", "recap_version", "room_id", "started_at"],
      "the recap is exactly these fields");
    assert.deepEqual(Object.keys(recap.decisions).sort(), ["approved", "cancelled", "expired", "rejected"],
      "one number per decision and nothing else");
    for (const m of recap.members) assert.deepEqual(Object.keys(m).sort(), ["handle", "owner_name"],
      "a seat is a handle and its home, nothing else");
    const events = await recapEvents(s.base, B.reg.bot_token);
    assert.equal(events.length, 1);
    const wire = JSON.stringify(events[0]);
    for (const text of [APPROVED_LINE, REJECTED_LINE, PENDING_LINE]) assert.ok(!wire.includes(text), "the inbox event carries no line either");
  } finally { await s.stop(); }
});

test("the recap says why the room ended: a share taken back, or a share that lapsed", async () => {
  const clock = { now: Date.parse("2026-05-01T09:00:00.000Z") };
  const s = await startServer({ now: () => clock.now });
  try {
    const { A, B } = await friends(s.base);
    const share = await req(s.base, "POST", `/v1/bots/${B.bot.id}/grants`, B.owner.token, { friend_owner_id: A.owner_id, friend_bot_id: A.bot.id });
    assert.equal(share.status, 201, JSON.stringify(share.body));
    // A room whose only seat is a guest A brought in on B's share.
    const revokedRoom = "820005";
    const opened = await req(s.base, "POST", "/v1/face-rooms/join", A.owner.token, { code: revokedRoom, bots: [B.bot.id] });
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    const revoked = await req(s.base, "DELETE", `/v1/bots/${B.bot.id}/grants/${share.body.grant_id}`, B.owner.token);
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    const revokedRecap = recapOf(s, opened.body.room_id).recap;
    assert.ok(revokedRecap, "taking the share back emptied the room");
    assert.equal(revokedRecap.reason, "room_closed", "a seat taken back closes the room on someone's behalf");

    const lapsed = await req(s.base, "POST", `/v1/bots/${B.bot.id}/grants`, B.owner.token, { friend_owner_id: A.owner_id, friend_bot_id: A.bot.id });
    assert.equal(lapsed.status, 201, JSON.stringify(lapsed.body));
    const lapsedRoom = "820006";
    const second = await req(s.base, "POST", "/v1/face-rooms/join", A.owner.token, { code: lapsedRoom, bots: [B.bot.id] });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    // The share lapses by time; the next face-room door gives the seat back and the room ends with it. The expiry is
    // written from the host clock, so move the room clock past the row's own value instead of guessing a span.
    const expiresAt = s.platform.db.prepare("SELECT expires_at FROM grants WHERE id = ?").get(lapsed.body.grant_id) as any;
    assert.ok(expiresAt?.expires_at, "the share carries an expiry");
    clock.now = Date.parse(expiresAt.expires_at) + 1000;
    const list = await req(s.base, "GET", "/v1/face-rooms", A.owner.token);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const lapsedRecap = recapOf(s, second.body.room_id).recap;
    assert.ok(lapsedRecap, "the lapsed share emptied the room");
    assert.equal(lapsedRecap.reason, "expired", "a share that lapsed by time says so");
  } finally { await s.stop(); }
});

test("a member who joined late cannot read the transcript but reads the same recap", async () => {
  const clock = { now: Date.parse("2026-05-01T09:00:00.000Z") };
  const s = await startServer({ now: () => clock.now });
  try {
    const { A, B } = await friends(s.base);
    const opened = await req(s.base, "POST", "/v1/face-rooms/join", A.owner.token, { code: "820007", bots: [A.bot.id] });
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    const roomId = opened.body.room_id as string;
    const joined = await req(s.base, "POST", "/v1/face-rooms/join", B.owner.token, { code: "820007", bots: [B.bot.id] });
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    // A line is decided before the late member arrives, so it sits behind that member's join floor.
    await decidedLine(s, A, roomId, APPROVED_LINE, "approved");
    const C = await ownerWithBot(s.base, "carol");
    const late = await req(s.base, "POST", "/v1/face-rooms/join", C.owner.token, { code: "820007", bots: [C.bot.id] });
    assert.equal(late.status, 200, JSON.stringify(late.body));
    const started = await req(s.base, "POST", `/v1/face-rooms/${roomId}/start`, A.owner.token);
    assert.equal(started.status, 200, JSON.stringify(started.body));
    // The room is readable, and the line from before the join is not in what the late member reads.
    const early = await req(s.base, "GET", `/v1/face-rooms/${roomId}`, C.owner.token);
    assert.equal(early.status, 200, JSON.stringify(early.body));
    assert.ok(!JSON.stringify(early.body.events).includes(APPROVED_LINE), "a line from before the join stays behind the floor");

    // Everyone leaves; the last seat out closes the room.
    await leave(s, A, roomId);
    await leave(s, B, roomId);
    await leave(s, C, roomId);
    // The room read door is shut for the late member, and the refusal carries no transcript line.
    const closed = await req(s.base, "GET", `/v1/face-rooms/${roomId}`, C.owner.token);
    assert.equal(closed.status, 404, "a closed room is shut to the read door");
    assert.equal(closed.body.error?.code, "face_room_not_found");
    assert.ok(!JSON.stringify(closed.body).includes(APPROVED_LINE), "no line comes back with the refusal");

    // The recap still reaches that member, whole: the same payload as a member who did see the line.
    const aEvents = await recapEvents(s.base, A.reg.bot_token);
    const cEvents = await recapEvents(s.base, C.reg.bot_token);
    assert.equal(cEvents.length, 1, "the late member's Bot gets the recap");
    assert.equal(aEvents[0].room_id, roomId);
    assert.deepEqual(payloadOf(cEvents[0]), payloadOf(aEvents[0]), "the same recap field for field, not trimmed by arrival");
    assert.equal(cEvents[0].decisions.approved, 1, "the line that member never saw is still counted");
    assert.ok(!JSON.stringify(cEvents[0]).includes(APPROVED_LINE), "the recap it reads carries no line either");
  } finally { await s.stop(); }
});
