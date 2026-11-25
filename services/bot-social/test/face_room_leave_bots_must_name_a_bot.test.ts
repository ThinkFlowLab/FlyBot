// `POST /v1/face-rooms/:id/leave` names the seats to end in `bots`. On master c5f9d4a the door never judged that
// list's shape: it went through `normalizeBotRefs`, whose `filter(Boolean)` turns an explicit empty list (and a list
// of blanks) into "nothing named", and "nothing named" means "every seat this owner holds in the room". A caller who
// named no one was answered 200 and lost every seat, the room's grants for those seats were revoked, and the room's
// other members got `face_room.left` events and an audit row — for a leave the caller never asked for. When that
// owner was the room's last member the room closed and its number was released.
//
// The join door fixed the same read in #609 and states the rule: `bots` is a list of names, so an explicit empty
// list names nobody and is refused, and an element that is not a non-empty string is refused rather than coerced.
// This door reuses that one gate. A missing field (or an explicit null) keeps its documented meaning — all of the
// caller's own seats leave — a single string is still a name, and a leave that names one Bot still ends only that
// one, so the fix must not turn an ordinary leave into a refusal.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

const roomOpts = { attemptsPerAccount: 50, attemptsPerIp: 200, createsPerAccount: 50, createsPerIp: 200, invitesPerAccount: 50, invitesPerIp: 200 };

async function req(base: string, method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}

/** Alice seats two of her own Bots, Bob one, and Alice starts the room: three seats, two owners. */
async function roomWithSeats(s: any, code: string) {
  const A = await ownerWithBot(s.base, "leava");
  const B = await ownerWithBot(s.base, "leavb");
  const extra = (await A.owner.req("POST", "/v1/bots", { handle: "leava.second.bot" })).bot_id as string;
  let roomId = "";
  for (const [o, bots] of [[A, [A.bot.id, extra]], [B, [B.bot.id]]] as [any, string[]][]) {
    const r = await req(s.base, "POST", "/v1/face-rooms/join", o.owner.token, { code, bots });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    roomId = r.body.room_id as string;
  }
  const started = await req(s.base, "POST", `/v1/face-rooms/${roomId}/start`, A.owner.token);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  return { A, B, extra, roomId };
}

/** Every row a leave can move: the seats still held, the live grants, the room's events and its audit entries. */
function snapshot(s: any, roomId: string) {
  const one = (sql: string) => (s.platform.db.prepare(sql).get(roomId) as any).n as number;
  return {
    seats: one("SELECT COUNT(*) n FROM face_room_members WHERE room_id = ? AND left_at IS NULL"),
    liveGrants: (s.platform.db.prepare("SELECT COUNT(*) n FROM grants WHERE status = 'active'").get() as any).n as number,
    events: (s.platform.db.prepare("SELECT COUNT(*) n FROM events").get() as any).n as number,
    roomAudits: (s.platform.audit.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action LIKE 'face_room.%'").get() as any).n as number,
    leftAudits: (s.platform.audit.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action = 'face_room.left'").get() as any).n as number,
  };
}

test("an explicit empty bots list is refused and ends no seat", async (t) => {
  const s = await startServer({ faceRooms: roomOpts });
  t.after(s.stop);
  const { A, roomId } = await roomWithSeats(s, "781001");
  const before = snapshot(s, roomId);

  const err = await req(s.base, "POST", `/v1/face-rooms/${roomId}/leave`, A.owner.token, { bots: [] });
  assert.equal(err.status, 400, `an empty bots list must be refused, not answered ${err.status} ${JSON.stringify(err.body)}`);
  assert.equal(err.body.error?.code, "invalid_request", JSON.stringify(err.body));
  assert.equal(err.body.error?.message, "bots must name at least one Bot");
  assert.deepEqual(snapshot(s, roomId), before, "a refused leave ends no seat, revokes no grant and writes no event or audit row");
});

test("a list whose elements are not non-empty strings is refused", async (t) => {
  const s = await startServer({ faceRooms: roomOpts });
  t.after(s.stop);
  const { A, roomId } = await roomWithSeats(s, "781002");
  const before = snapshot(s, roomId);

  for (const bots of [[""], ["   "], [{}], [0], [true], [[]]]) {
    const r = await req(s.base, "POST", `/v1/face-rooms/${roomId}/leave`, A.owner.token, { bots });
    assert.equal(r.status, 400, `bots ${JSON.stringify(bots)} must be refused, not answered ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error?.code, "invalid_request", JSON.stringify(r.body));
    assert.equal(r.body.error?.message, "bots must be an array of strings");
    assert.deepEqual(snapshot(s, roomId), before, `bots ${JSON.stringify(bots)} ended a seat, revoked a grant or wrote a row`);
  }
});

test("naming one Bot still ends only that seat", async (t) => {
  const s = await startServer({ faceRooms: roomOpts });
  t.after(s.stop);
  const { A, B, extra, roomId } = await roomWithSeats(s, "781003");
  assert.equal(snapshot(s, roomId).seats, 3, "three seats before the leave");

  const out = await req(s.base, "POST", `/v1/face-rooms/${roomId}/leave`, A.owner.token, { bots: [A.bot.id] });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  const row = (botId: string) => s.platform.db.prepare("SELECT left_at FROM face_room_members WHERE room_id = ? AND bot_id = ?").get(roomId, botId) as any;
  assert.ok(row(A.bot.id).left_at, "the named seat left");
  assert.equal(row(extra).left_at, null, "the unnamed seat of the same owner is still in the room");
  const bob = s.platform.db.prepare("SELECT left_at FROM face_room_members WHERE room_id = ? AND owner_id = ?").get(roomId, B.owner_id) as any;
  assert.equal(bob.left_at, null, "the other owner is untouched");
  assert.equal(snapshot(s, roomId).seats, 2, "the second seat of the same owner and the other owner's seat stay");
});

test("a missing field still means every seat of the caller leaves", async (t) => {
  const s = await startServer({ faceRooms: roomOpts });
  t.after(s.stop);
  const { A, B, roomId } = await roomWithSeats(s, "781004");

  const out = await req(s.base, "POST", `/v1/face-rooms/${roomId}/leave`, A.owner.token, {});
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal((out.body.left as string[]).length, 2, "both of the caller's own seats left");
  const after = snapshot(s, roomId);
  assert.equal(after.seats, 1, "the other owner's seat stays");
  const bob = s.platform.db.prepare("SELECT left_at FROM face_room_members WHERE room_id = ? AND owner_id = ?").get(roomId, B.owner_id) as any;
  assert.equal(bob.left_at, null, "the other owner is untouched");
});

test("a caller with no seat is answered 404 before the list is judged", async (t) => {
  const s = await startServer({ faceRooms: roomOpts });
  t.after(s.stop);
  const { roomId } = await roomWithSeats(s, "781005");
  const C = await ownerWithBot(s.base, "leavc");
  const before = snapshot(s, roomId);

  const r = await req(s.base, "POST", `/v1/face-rooms/${roomId}/leave`, C.owner.token, { bots: [] });
  assert.equal(r.status, 404, `a non-member keeps the member refusal, not ${r.status}`);
  assert.deepEqual(snapshot(s, roomId), before, "nothing was written");
});

test("a Bot token that leaves is answered with the summary, not a 404 for the read-back", async (t) => {
  const s = await startServer({ faceRooms: roomOpts });
  t.after(s.stop);
  const { A, extra, roomId } = await roomWithSeats(s, "781006");
  const before = snapshot(s, roomId);

  const out = await req(s.base, "POST", `/v1/face-rooms/${roomId}/leave`, A.bot.cred.token, {});
  assert.equal(out.status, 200, `the Bot's own seat left, so the leave must not be answered ${out.status} ${JSON.stringify(out.body)}`);
  const handle = (s.platform.db.prepare("SELECT handle FROM bots WHERE id = ?").get(A.bot.cred.botId || A.bot.id) as any).handle as string;
  assert.deepEqual(out.body.left, ["@" + handle.replace(/^@/, "")], "the summary names the seat that left");
  const row = (botId: string) => s.platform.db.prepare("SELECT left_at FROM face_room_members WHERE room_id = ? AND bot_id = ?").get(roomId, botId) as any;
  assert.ok(row(A.bot.cred.botId).left_at, "the Bot's own seat is gone");
  assert.equal(row(extra).left_at, null, "the owner's other seat stays");
  assert.equal(snapshot(s, roomId).seats, before.seats - 1, "exactly one seat ended");
});
