/**
 * Five write doors were settling a room the request never named.
 *
 * `startFaceRoom`, `setFaceRoomLead`, `setFaceRoomNote`, `setFaceRoomRoles` and `draftFaceRoomMessage` each opened
 * with `this.advanceFaceRooms(this.faceSeatRooms(p))`: the sweep was narrowed to the caller's own rooms by #741, but
 * it is still every candidate room that caller sits in, so one write against room X promoted the caller's OTHER
 * lapsed candidate room Y - `candidate` to `open`, its number voided, its code row deleted, a `room.started` event
 * written, its members woken and an audit row appended. Nothing in the request named Y.
 *
 * `startFaceRoom` is worse than that: its sweep predicate is `faceSeatRooms`, which also counts a home that only
 * brought a guest (no seat of its own), while its own gate `faceRequireOwnSeat` does not. A bringer with no own seat
 * was answered 404 `face_room_not_found` and still settled the room it was refused on.
 *
 * Each door now reads the caller's seat first and then hands the sweep the one room the request names. The refusals
 * keep their answers and their order, a caller refused before the seat check writes nothing at all, and the door that
 * names the room still settles it - the control below is what proves the sweep was narrowed, not dropped.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

const PAST = "2020-01-01T00:00:00.000Z";
const PUSH = "https://push.test/write-door-scope";

type S = Awaited<ReturnType<typeof startServer>>;

/** A server whose webhook POSTs are captured instead of sent, so a push is counted, not guessed. */
async function server() {
  const calls: { url: string; body: string }[] = [];
  const fetchImpl = (async (url: string, init: any) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  const s = await startServer({
    faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200, createsPerAccount: 50, createsPerIp: 50 },
    fetchImpl,
  });
  return { s, calls };
}

const roomRow = (s: S, id: string) => s.platform.db.prepare("SELECT * FROM face_rooms WHERE id = ?").get(id) as any;
const codeRows = (s: S, id: string) => (s.platform.db.prepare("SELECT COUNT(*) n FROM face_room_codes WHERE room_id = ?").get(id) as any).n as number;
const startedEvents = (s: S, id: string) => (s.platform.db.prepare("SELECT COUNT(*) n FROM face_room_events WHERE room_id = ? AND type = 'room.started'").get(id) as any).n as number;
const startedAudits = (s: S, id: string) => ((s.platform.audit as any).db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action = 'face_room.started' AND subject = ?").get(id) as any).n as number;
const roomPushes = (calls: { body: string }[], id: string) => calls.filter((c) => c.body.includes(id) && c.body.includes("face_room.started")).length;

/** Everything a promotion of a room changes, read in one place so "untouched" is one comparison. */
function facts(s: S, id: string) {
  const row = roomRow(s, id);
  return {
    status: row.status as string,
    code: row.code as string | null,
    expires_at: row.expires_at as string,
    started_at: row.started_at as string | null,
    codeRows: codeRows(s, id),
    startedEvents: startedEvents(s, id),
    startedAudits: startedAudits(s, id),
  };
}

async function answerOf(call: () => Promise<any>) {
  try {
    const body = await call();
    return { status: 200, code: null as string | null, message: null as string | null, body };
  } catch (e: any) {
    return { status: e?.status ?? 0, code: e?.code ?? null, message: e?.message ?? null, body: e };
  }
}

/**
 * A's own lapsed candidate room Y (A and B both seated) and B's open room X with A seated in it. Y is the room no
 * request below names, X the room every request below names.
 */
async function scene(s: S) {
  const a = await ownerWithBot(s.base, "scopea", PUSH);
  const b = await ownerWithBot(s.base, "scopeb", PUSH);
  const yCode = String(720000 + Math.floor(Math.random() * 70000));
  await a.owner.req("POST", "/v1/face-rooms/join", { code: yCode, bots: [a.bot.id] });
  const yJoined = await b.owner.req("POST", "/v1/face-rooms/join", { code: yCode, bots: [b.bot.id] });
  const yId = yJoined.room_id as string;
  const xCode = String(730000 + Math.floor(Math.random() * 60000));
  await b.owner.req("POST", "/v1/face-rooms/join", { code: xCode, bots: [b.bot.id] });
  const xJoined = await a.owner.req("POST", "/v1/face-rooms/join", { code: xCode, bots: [a.bot.id] });
  const xId = xJoined.room_id as string;
  await b.owner.req("POST", `/v1/face-rooms/${xId}/start`, {});
  s.platform.db.prepare("UPDATE face_rooms SET expires_at = ? WHERE id = ?").run(PAST, yId);
  await s.platform.flushWebhooks();
  return { a, b, yId, xId };
}

/** The answer each door gives when the caller is a member of the room it names but may not take this action. */
const DOORS = [
  { name: "start", method: "POST", path: (id: string) => `/v1/face-rooms/${id}/start`, body: (_a: any) => ({}) },
  { name: "lead", method: "POST", path: (id: string) => `/v1/face-rooms/${id}/lead`, body: (a: any) => ({ bot: a.bot.id }) },
  { name: "note", method: "POST", path: (id: string) => `/v1/face-rooms/${id}/note`, body: (_a: any) => ({ note: "a room note" }) },
  { name: "roles", method: "PUT", path: (id: string) => `/v1/face-rooms/${id}/roles`, body: (a: any) => ({ roles: { [a.bot.id]: "Writer" } }) },
  { name: "messages", method: "POST", path: (id: string) => `/v1/face-rooms/${id}/messages`, body: (_a: any) => ({ text: "hello" }) },
] as const;

for (const door of DOORS) {
  test(`a ${door.name} on another home's room leaves the caller's own lapsed room alone`, async () => {
    const { s, calls } = await server();
    try {
      const { a, yId, xId } = await scene(s);
      calls.length = 0;
      const before = facts(s, yId);
      assert.equal(before.status, "candidate", "Y is a candidate room before the write");
      assert.ok(before.code, "and it still holds its number");

      const answered = await answerOf(() => (a.owner as any).req(door.method, door.path(xId), door.body(a)));
      await s.platform.flushWebhooks();
      // The first half is the defect: the write against X must not promote Y - the room the request never named keeps
      // its status, its number, its window, its code row, its transcript, its audit chain and its members' silence.
      assert.deepEqual(facts(s, yId), before, `${door.name} on another home's room settled a room it never named`);
      assert.equal(roomPushes(calls, yId), 0, `the ${door.name} wrote to a room it never named and woke its members`);
      // The second half: the door's own answer on X is unchanged by this lane.
      if (door.name === "lead") assert.deepEqual([answered.status, answered.code], [403, "not_room_creator"], "a member who did not create the room still cannot pick its lead");
      if (door.name === "note") assert.deepEqual([answered.status, answered.code], [403, "not_lead"], "a member who is not the lead still cannot set the note");
      if (door.name !== "lead" && door.name !== "note") assert.equal(answered.status, 200, `${door.name} by a seated member still answers 200: ${answered.status}`);
    } finally {
      await s.stop();
    }
  });
}

test("a room id that does not exist settles nothing, not even the caller's own lapsed room", async () => {
  const { s, calls } = await server();
  try {
    const { a, yId } = await scene(s);
    calls.length = 0;
    const before = facts(s, yId);
    const madeUp = "00000000-0000-4000-8000-000000000000";
    for (const door of DOORS) {
      const answered = await answerOf(() => (a.owner as any).req(door.method, door.path(madeUp), door.body(a)));
      assert.deepEqual([answered.status, answered.code], [404, "face_room_not_found"], `${door.name} still answers a made-up id with 404`);
    }
    await s.platform.flushWebhooks();
    assert.deepEqual(facts(s, yId), before, "a refused call on an unknown room settled the caller's own room");
    assert.equal(roomPushes(calls, yId), 0, "and woke its members");
  } finally {
    await s.stop();
  }
});

test("a bringer with no seat of its own is refused the start and the room it is refused on is untouched", async () => {
  // `startFaceRoom`'s sweep reads `faceSeatRooms`, which counts a home that only brought a guest; its gate
  // `faceRequireOwnSeat` does not. So a bringer with no seat of its own used to be answered 404 and settle the room
  // it was refused on: the number was voided and the room opened without its own member ever asking.
  const { s, calls } = await server();
  try {
    const b = await ownerWithBot(s.base, "guesthost", PUSH);
    const bringer = await ownerWithBot(s.base, "guestbringer", PUSH);
    const shared = await ownerWithBot(s.base, "guestbot", PUSH);
    const custody = (o: any) => s.platform.enableCustody({ kind: "owner" as const, ownerId: o.owner_id }, o.bot.id, { private_key_pem: o.kp.privateKeyPem });
    custody(b);
    custody(bringer);
    custody(shared);
    const rel = await bringer.owner.req("POST", "/v1/relationships", {
      from_bot_id: bringer.bot.id, target_handle: shared.handle, message: "hi", requested_capabilities: ["chat.public"],
    });
    const consent = await shared.owner.req("POST", `/v1/relationships/${rel.relationship_id}/consent`, { decision: "accept", grant_capabilities: [{ capability: "chat.public" }] });
    assert.equal(consent.status, "active", "the shared Bot's owner accepts the share");
    const code = String(740000 + Math.floor(Math.random() * 50000));
    const host = await b.owner.req("POST", "/v1/face-rooms/join", { code, bots: [b.bot.id] });
    const roomId = host.room_id as string;
    const brought = await bringer.owner.req("POST", "/v1/face-rooms/join", { code, bots: [shared.bot.id] });
    assert.equal(brought.room_id, roomId, "the bringer puts the shared Bot into the host's room");
    const ownSeats = (s.platform.db.prepare("SELECT COUNT(*) n FROM face_room_members WHERE room_id = ? AND left_at IS NULL AND owner_id = ?").get(roomId, bringer.owner_id) as any).n;
    assert.equal(ownSeats, 0, "the bringer holds no seat of its own there");
    s.platform.db.prepare("UPDATE face_rooms SET expires_at = ? WHERE id = ?").run(PAST, roomId);
    await s.platform.flushWebhooks();
    calls.length = 0;
    const before = facts(s, roomId);
    assert.equal(before.status, "candidate", "the host's room is a lapsed candidate");
    const refused = await answerOf(() => bringer.owner.req("POST", `/v1/face-rooms/${roomId}/start`, {}));
    await s.platform.flushWebhooks();
    assert.deepEqual([refused.status, refused.code], [404, "face_room_not_found"], "a bringer with no seat of its own cannot start the room");
    assert.deepEqual(facts(s, roomId), before, "and the refusal settled the room it was refused on");
    assert.equal(roomPushes(calls, roomId), 0, "and woke its members");
  } finally {
    await s.stop();
  }
});

test("each door still settles the room the request names", async () => {
  // The control: the sweep was narrowed to the named room, not dropped. A caller's own lapsed candidate is promoted
  // by the same call that leaves the other room alone above.
  const { s, calls } = await server();
  try {
    const a = await ownerWithBot(s.base, "controla", PUSH);
    const b = await ownerWithBot(s.base, "controlb", PUSH);
    for (const [index, door] of DOORS.entries()) {
      const code = String(750000 + index);
      await a.owner.req("POST", "/v1/face-rooms/join", { code, bots: [a.bot.id] });
      const joined = await b.owner.req("POST", "/v1/face-rooms/join", { code, bots: [b.bot.id] });
      const roomId = joined.room_id as string;
      s.platform.db.prepare("UPDATE face_rooms SET expires_at = ? WHERE id = ?").run(PAST, roomId);
      await s.platform.flushWebhooks();
      calls.length = 0;
      const answered = await answerOf(() => (a.owner as any).req(door.method, door.path(roomId), door.body(a)));
      assert.ok(answered.status < 400, `${door.name} on the caller's own room is not refused: ${answered.status} ${answered.code ?? ""}`);
      await s.platform.flushWebhooks();
      const after = facts(s, roomId);
      assert.equal(after.status, "open", `${door.name} on the room it names still starts it`);
      assert.equal(after.code, null, "and voids the number");
      assert.equal(after.expires_at, "", "the window is gone with the number");
      assert.equal(after.codeRows, 0, "the code row is deleted");
      assert.equal(after.startedEvents, 1, "one room.started event");
      assert.equal(after.startedAudits, 1, "one audit row");
      assert.ok(roomPushes(calls, roomId) >= 1, "and the members are woken");
    }
  } finally {
    await s.stop();
  }
});
