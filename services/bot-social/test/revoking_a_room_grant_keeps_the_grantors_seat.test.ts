/**
 * A room-scoped grant is addressed to the room's other members — `ensurePairRoomGrant` writes one per default
 * capability for the pair — so ending it must not walk the owner's own Bot out of the room. Only a guest seat is
 * given back by the share that brought it in: the seat record says who added it, and the room's own rows have to be
 * judged by the same rule the per-bot share rows already use. The room's contract is unchanged: a room-scoped
 * grant "ends when you leave or the room closes", and revoking one ends the grant, not the seat it does not own.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

async function req(base: string, method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}

/** The holder asks, the sharer consents with the defaults plus a calendar window: the bundle a room pair grant is
 *  written from. */
async function shareWithHolder(base: string, sharer: any, holder: any) {
  const rel = await req(base, "POST", "/v1/relationships", holder.owner.token, {
    from_bot_id: holder.bot.id, target_handle: sharer.handle, message: "hi", requested_capabilities: ["chat.public"],
  });
  assert.ok(rel.status < 300, JSON.stringify(rel.body));
  const c = await req(base, "POST", `/v1/relationships/${rel.body.relationship_id}/consent`, sharer.owner.token, {
    decision: "accept", grant_capabilities: [{ capability: "calendar.freebusy.read", scope: { window_days: 14, hours: "09:00-18:00" } }],
  });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  return rel.body.relationship_id as string;
}

/** The host opens a room with its own Bot and brings the sharer's Bot in on the chat share it holds. */
async function roomWithGuest(s: any, code: string) {
  const A = await ownerWithBot(s.base, "ann");
  const F = await ownerWithBot(s.base, "fay");
  for (const o of [A, F]) s.platform.enableCustody({ kind: "owner" as const, ownerId: o.owner_id }, o.bot.id, { private_key_pem: o.kp.privateKeyPem });
  const relId = await shareWithHolder(s.base, F, A);
  const join = await req(s.base, "POST", "/v1/face-rooms/join", A.owner.token, { code, bots: [A.bot.id, F.bot.id] });
  assert.equal(join.status, 200, JSON.stringify(join.body));
  return { A, F, relId, roomId: join.body.room_id as string };
}

const seatOf = (db: any, roomId: string, botId: string) =>
  db.prepare("SELECT left_at FROM face_room_members WHERE room_id = ? AND bot_id = ?").get(roomId, botId) as any;

const activeRoomGrants = (db: any, roomId: string) =>
  (db.prepare("SELECT COUNT(*) n FROM grants WHERE room_id = ? AND status = 'active'").get(roomId) as any).n as number;

const roomRowOf = async (s: any, owner: any, botId: string, roomId: string) => {
  const listed = await req(s.base, "GET", `/v1/bots/${botId}/grants`, owner.token);
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  return listed.body.grants.find((g: any) => g.scope === "room" && g.room?.room_id === roomId) as any;
};

test("revoking the room chat grant the host wrote keeps the host's own seat", async (t) => {
  const s: any = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  t.after(s.stop);
  const { A, F, roomId } = await roomWithGuest(s, "741001");
  const db = s.platform.db;

  const row = await roomRowOf(s, A.owner, A.bot.id, roomId);
  assert.ok(row, "the host's own room grant is listed for their Bot");
  assert.deepEqual([...row.capabilities].sort(), ["chat.public", "profile.read"], "the room wrote both default capabilities");
  assert.equal(row.grantee.bot_id, F.bot.id, "the room grant is addressed to the other member, not to the host's own Bot");

  const revoked = await req(s.base, "DELETE", `/v1/grants/${row.grant_id}`, A.owner.token);
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));

  const hostSeat = seatOf(db, roomId, A.bot.id);
  assert.ok(hostSeat && hostSeat.left_at == null, "the host keeps its own seat: the room grant did not bring that Bot in");
  const guestSeat = seatOf(db, roomId, F.bot.id);
  assert.ok(guestSeat && guestSeat.left_at == null, "the guest the host brought in is still seated");
  const read = await req(s.base, "GET", `/v1/face-rooms/${roomId}`, A.owner.token);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(activeRoomGrants(db, roomId), 3, "only the ended row is gone; the other three room grants are still active");
  const after = await roomRowOf(s, A.owner, A.bot.id, roomId);
  assert.deepEqual(after?.capabilities, ["profile.read"], "the chat row ended and the profile row stayed");
  const send = await req(s.base, "POST", `/v1/homes/${A.bot.id}/send`, A.owner.token, { from_bot_id: A.bot.id, to: F.bot.id, text: "still here", room_id: roomId });
  assert.equal(send.status, 202, JSON.stringify(send.body));
});

test("revoking the guest's room chat grant takes the guest's seat", async (t) => {
  const s: any = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  t.after(s.stop);
  const { A, F, roomId } = await roomWithGuest(s, "741002");
  const db = s.platform.db;

  const row = await roomRowOf(s, F.owner, F.bot.id, roomId);
  assert.ok(row, "the guest's side of the pair grant is listed for the guest's Bot");
  const revoked = await req(s.base, "DELETE", `/v1/grants/${row.grant_id}`, F.owner.token);
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));

  const guestSeat = seatOf(db, roomId, F.bot.id);
  assert.ok(guestSeat && guestSeat.left_at != null, "the guest seat is given back when the share that brought it in ends");
  const hostSeat = seatOf(db, roomId, A.bot.id);
  assert.ok(hostSeat && hostSeat.left_at == null, "the host stays seated");
  assert.equal(activeRoomGrants(db, roomId), 0, "no room grant of that pair is left active");
  const read = await req(s.base, "GET", `/v1/face-rooms/${roomId}`, A.owner.token);
  assert.equal(read.status, 200, JSON.stringify(read.body));
});

test("revoking the host's room profile grant keeps both seats", async (t) => {
  const s: any = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  t.after(s.stop);
  const { A, F, roomId } = await roomWithGuest(s, "741003");
  const db = s.platform.db;

  const profile = db.prepare("SELECT * FROM grants WHERE room_id = ? AND capability = 'profile.read' AND grantor_owner = ? AND status = 'active'")
    .get(roomId, A.owner_id) as any;
  assert.ok(profile, "the room wrote a profile row for the pair");
  const revoked = await req(s.base, "DELETE", `/v1/grants/${profile.id}`, A.owner.token);
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));

  const hostSeat = seatOf(db, roomId, A.bot.id);
  assert.ok(hostSeat && hostSeat.left_at == null, "a profile grant never pays for a seat");
  const guestSeat = seatOf(db, roomId, F.bot.id);
  assert.ok(guestSeat && guestSeat.left_at == null, "the guest is untouched as well");
  assert.equal(activeRoomGrants(db, roomId), 3, "the other three room grants are still active");
});

test("ending a person-scoped chat share does not touch the room seats", async (t) => {
  const s: any = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  t.after(s.stop);
  const { A, F, relId, roomId } = await roomWithGuest(s, "741004");
  const db = s.platform.db;

  const added = await req(s.base, "POST", `/v1/relationships/${relId}/grants`, A.owner.token, { capability: "chat.public" });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const revoked = await req(s.base, "DELETE", `/v1/grants/${added.body.grant_id}`, A.owner.token);
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));

  const hostSeat = seatOf(db, roomId, A.bot.id);
  assert.ok(hostSeat && hostSeat.left_at == null, "a person-scoped row is not a room seat");
  const guestSeat = seatOf(db, roomId, F.bot.id);
  assert.ok(guestSeat && guestSeat.left_at == null, "the guest is untouched as well");
  assert.equal(activeRoomGrants(db, roomId), 4, "the room's four pair grants are untouched");
  const read = await req(s.base, "GET", `/v1/face-rooms/${roomId}`, A.owner.token);
  assert.equal(read.status, 200, JSON.stringify(read.body));
});

test("revoking the room chat grant of a Bot that joined by number keeps that Bot's seat", async (t) => {
  const s: any = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const F = await ownerWithBot(s.base, "fay");
  const created = await req(s.base, "POST", "/v1/face-rooms/join", A.owner.token, { code: "741005", bots: [A.bot.id] });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const roomId = created.body.room_id as string;
  const joined = await req(s.base, "POST", "/v1/face-rooms/join", F.owner.token, { code: "741005", bots: [F.bot.id] });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  assert.equal(joined.body.room_id, roomId, "the second join seats the Bot in the same room");
  const db = s.platform.db;
  const seat = db.prepare("SELECT * FROM face_room_members WHERE room_id = ? AND bot_id = ?").get(roomId, F.bot.id) as any;
  assert.equal(seat?.added_by_owner_id, F.owner_id, "the Bot was seated by its own owner, not brought in by the other side");

  const row = await roomRowOf(s, F.owner, F.bot.id, roomId);
  assert.ok(row, "the joined Bot's side of the pair grant is listed for its owner");
  const revoked = await req(s.base, "DELETE", `/v1/grants/${row.grant_id}`, F.owner.token);
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));

  const seatAfter = seatOf(db, roomId, F.bot.id);
  assert.ok(seatAfter && seatAfter.left_at == null, "a Bot its own owner seated keeps the seat when that owner ends a room grant");
  const hostSeat = seatOf(db, roomId, A.bot.id);
  assert.ok(hostSeat && hostSeat.left_at == null, "the host is untouched");
  assert.equal(activeRoomGrants(db, roomId), 3, "only the ended row is gone");
  const read = await req(s.base, "GET", `/v1/face-rooms/${roomId}`, F.owner.token);
  assert.equal(read.status, 200, JSON.stringify(read.body));
});

test("the bot bundle door reports no rooms_removed when the host's own seat is kept", async (t) => {
  const s: any = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  t.after(s.stop);
  const { A, F, roomId } = await roomWithGuest(s, "741006");
  const db = s.platform.db;

  const row = await roomRowOf(s, A.owner, A.bot.id, roomId);
  assert.ok(row, "the host's own room grant is listed for their Bot");
  const revoked = await req(s.base, "DELETE", `/v1/bots/${A.bot.id}/grants/${row.grant_id}`, A.owner.token);
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  assert.equal(revoked.body.revoked?.length, 2, "the room pair's two rows ended together");
  assert.deepEqual(revoked.body.rooms_removed, [], "no seat is given back, so no room is reported");

  const hostSeat = seatOf(db, roomId, A.bot.id);
  assert.ok(hostSeat && hostSeat.left_at == null, "the host keeps its own seat");
  const guestSeat = seatOf(db, roomId, F.bot.id);
  assert.ok(guestSeat && guestSeat.left_at == null, "the guest the host brought in stays seated");
  assert.equal(activeRoomGrants(db, roomId), 2, "the host's two pair grants ended; the guest's two are still active");
});
