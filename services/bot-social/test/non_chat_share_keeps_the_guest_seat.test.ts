/**
 * A guest seat in a face room is paid for by the chat share that let the Bot in — never by the calendar or profile
 * rows of the same bundle. `syncFaceRoomAccess` recorded a `grant_rooms` usage for every sibling share of the
 * bringer, so ending any one of them (`revokeGrant`, `expireLapsedShares`) walked the guest out of the room while
 * `chat.public` was still live: the seat, its room-scoped grants and its room door all outlived nothing.
 * The seat record now names the chat share only, and `endGrantRooms` decides a seat from the grant itself, so a
 * `grant_rooms` row written before that fix cannot take a seat either. The room's own grant rows (`room_id` set,
 * written by `ensurePairRoomGrant` for every default capability) are the same door: ending the room's profile row
 * must not walk the guest out while the room's chat row is live.
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

/** The holder asks, the sharer consents: the sharer's Bot is shared with the holder's Bot with the defaults
 *  (`chat.public`, `profile.read`) plus the calendar window, which is the three-row bundle the bug wrote three
 *  `grant_rooms` usages for. */
async function shareAll(base: string, sharer: any, holder: any) {
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

/** Holder opens a room and brings the sharer's Bot in on the chat share; returns the pair and the seat. */
async function roomWithGuest(s: any, code: string) {
  const A = await ownerWithBot(s.base, "ann");
  const F = await ownerWithBot(s.base, "fay");
  s.platform.enableCustody({ kind: "owner" as const, ownerId: F.owner_id }, F.bot.id, { private_key_pem: F.kp.privateKeyPem });
  const relId = await shareAll(s.base, F, A);
  const join = await req(s.base, "POST", "/v1/face-rooms/join", A.owner.token, { code, bots: [A.bot.id, F.bot.id] });
  assert.equal(join.status, 200, JSON.stringify(join.body));
  return { A, F, relId, roomId: join.body.room_id as string };
}

const shareRow = (db: any, cap: string, grantor: string, grantee: string) =>
  db.prepare("SELECT * FROM grants WHERE grantor_owner = ? AND grantee_bot = ? AND capability = ? AND room_id IS NULL AND status = 'active'")
    .get(grantor, grantee, cap) as any;

/** The room's own row for one capability: `ensurePairRoomGrant` writes one per default capability for the pair. */
const roomGrant = (db: any, roomId: string, cap: string, grantor: string) =>
  db.prepare("SELECT * FROM grants WHERE room_id = ? AND capability = ? AND grantor_owner = ? AND status = 'active'")
    .get(roomId, cap, grantor) as any;

const seatOf = (db: any, roomId: string, botId: string) =>
  db.prepare("SELECT left_at, added_by_owner_id FROM face_room_members WHERE room_id = ? AND bot_id = ?").get(roomId, botId) as any;

const activeRoomGrants = (db: any, roomId: string) =>
  (db.prepare("SELECT COUNT(*) n FROM grants WHERE room_id = ? AND status = 'active'").get(roomId) as any).n as number;

const openUsages = (db: any, roomId: string) =>
  db.prepare(`SELECT g.capability FROM grant_rooms u JOIN grants g ON g.id = u.grant_id
    WHERE u.room_id = ? AND u.ended_at IS NULL ORDER BY g.capability`).all(roomId).map((x: any) => x.capability) as string[];

const sendInRoom = (s: any, F: any, A: any, roomId: string, text: string) =>
  req(s.base, "POST", `/v1/homes/${F.bot.id}/send`, F.owner.token, { from_bot_id: F.bot.id, to: A.bot.id, text, room_id: roomId });

test("revoking a calendar share leaves the guest seat its chat share made", async (t) => {
  const s: any = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  t.after(s.stop);
  const { A, F, roomId } = await roomWithGuest(s, "731001");
  const db = s.platform.db;
  assert.deepEqual(openUsages(db, roomId), ["chat.public"], "the seat record names the chat share, not every sibling");

  const calendar = shareRow(db, "calendar.freebusy.read", F.owner_id, A.bot.id);
  assert.ok(calendar, "the sharer's calendar row exists");
  const revoked = await req(s.base, "DELETE", `/v1/grants/${calendar.id}`, F.owner.token);
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));

  const seat = seatOf(db, roomId, F.bot.id);
  assert.ok(seat && seat.left_at == null, "the guest is still seated: the calendar share never paid for that seat");
  assert.equal(seat.added_by_owner_id, A.owner_id);
  assert.ok(activeRoomGrants(db, roomId) > 0, "the room-level grant that lets the pair talk is still active");
  assert.deepEqual(openUsages(db, roomId), ["chat.public"], "the ended calendar row left the seat record alone");
  const send = await sendInRoom(s, F, A, roomId, "still here");
  assert.equal(send.status, 202, JSON.stringify(send.body));
});

test("revoking a profile share leaves the guest seat its chat share made", async (t) => {
  const s: any = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  t.after(s.stop);
  const { A, F, roomId } = await roomWithGuest(s, "731002");
  const db = s.platform.db;

  const profile = shareRow(db, "profile.read", F.owner_id, A.bot.id);
  assert.ok(profile, "the sharer's profile row exists");
  const revoked = await req(s.base, "DELETE", `/v1/grants/${profile.id}`, F.owner.token);
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));

  const seat = seatOf(db, roomId, F.bot.id);
  assert.ok(seat && seat.left_at == null, "the guest is still seated: the profile share never paid for that seat");
  assert.ok(activeRoomGrants(db, roomId) > 0, "the room-level grant that lets the pair talk is still active");
  const send = await sendInRoom(s, F, A, roomId, "still here");
  assert.equal(send.status, 202, JSON.stringify(send.body));
});

test("a lapsed calendar share leaves the guest seat the chat share still pays for", async (t) => {
  const s: any = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  t.after(s.stop);
  const { A, F, roomId } = await roomWithGuest(s, "731003");
  const db = s.platform.db;

  const calendar = shareRow(db, "calendar.freebusy.read", F.owner_id, A.bot.id);
  assert.ok(calendar, "the sharer's calendar row exists");
  db.prepare("UPDATE grants SET expires_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", calendar.id);
  // Any face-room read settles lapsed shares; this is the sweep, not the revoke door.
  await req(s.base, "GET", "/v1/face-rooms", A.owner.token);

  assert.equal((db.prepare("SELECT status FROM grants WHERE id = ?").get(calendar.id) as any).status, "expired", "the clock ended the calendar row");
  const seat = seatOf(db, roomId, F.bot.id);
  assert.ok(seat && seat.left_at == null, "a lapsed calendar share does not take a seat it never paid for");
  assert.ok(activeRoomGrants(db, roomId) > 0, "the room-level grant that lets the pair talk is still active");
  const send = await sendInRoom(s, F, A, roomId, "still here after the other clock ran out");
  assert.equal(send.status, 202, JSON.stringify(send.body));
});

test("a grant_rooms row written before this rule cannot take the guest seat", async (t) => {
  const s: any = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  t.after(s.stop);
  const { A, F, roomId } = await roomWithGuest(s, "731004");
  const db = s.platform.db;

  // Rebuild the pre-fix record for one non-chat share: a usage row on the calendar grant, exactly what the old
  // sibling loop wrote. The row is what the fix has to judge, not the code that no longer writes it.
  const calendar = shareRow(db, "calendar.freebusy.read", F.owner_id, A.bot.id);
  assert.ok(calendar, "the sharer's calendar row exists");
  db.prepare("DELETE FROM grant_rooms WHERE grant_id = ?").run(calendar.id);
  db.prepare("INSERT INTO grant_rooms (grant_id, room_id, created_at) VALUES (?,?,?)").run(calendar.id, roomId, new Date().toISOString());

  const revoked = await req(s.base, "DELETE", `/v1/grants/${calendar.id}`, F.owner.token);
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));

  const seat = seatOf(db, roomId, F.bot.id);
  assert.ok(seat && seat.left_at == null, "an old usage row on a calendar share is not a claim on the seat");
  const legacy = db.prepare("SELECT ended_at FROM grant_rooms WHERE grant_id = ? AND room_id = ?").get(calendar.id, roomId) as any;
  assert.ok(legacy && legacy.ended_at, "the stale usage row is closed when its share ends");
  const send = await sendInRoom(s, F, A, roomId, "still here");
  assert.equal(send.status, 202, JSON.stringify(send.body));
});

test("revoking the chat share takes the guest seat back", async (t) => {
  const s: any = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  t.after(s.stop);
  const { A, F, roomId } = await roomWithGuest(s, "731005");
  const db = s.platform.db;

  const chat = shareRow(db, "chat.public", F.owner_id, A.bot.id);
  assert.ok(chat, "the sharer's chat row exists");
  const revoked = await req(s.base, "DELETE", `/v1/grants/${chat.id}`, F.owner.token);
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));

  const seat = seatOf(db, roomId, F.bot.id);
  assert.ok(seat && seat.left_at != null, "the share that seated the guest is gone, so the seat goes with it");
  assert.equal(activeRoomGrants(db, roomId), 0, "no room-scoped grant of that seat is left active");
  const send = await sendInRoom(s, F, A, roomId, "after the chat share ended");
  assert.equal(send.status, 403, "a send naming that room is refused");
  assert.equal(send.body?.error?.code, "room_not_shared");
});

test("without a chat share the Bot cannot be brought into a room at all", async (t) => {
  const s: any = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const F = await ownerWithBot(s.base, "fay");
  const db = s.platform.db;
  await shareAll(s.base, F, A);
  const chat = shareRow(db, "chat.public", F.owner_id, A.bot.id);
  assert.ok(chat, "the sharer's chat row exists");
  await req(s.base, "DELETE", `/v1/grants/${chat.id}`, F.owner.token);

  // The calendar and profile rows are still live; they are not a door into a room.
  assert.ok(shareRow(db, "calendar.freebusy.read", F.owner_id, A.bot.id), "the calendar row is still live");
  assert.ok(shareRow(db, "profile.read", F.owner_id, A.bot.id), "the profile row is still live");
  const refused = await req(s.base, "POST", "/v1/face-rooms/join", A.owner.token, { code: "731006", bots: [A.bot.id, F.bot.id] });
  assert.equal(refused.status, 404, JSON.stringify(refused.body));
  assert.equal(refused.body?.error?.code, "bot_not_found");
  assert.equal((db.prepare("SELECT COUNT(*) n FROM face_rooms").get() as any).n, 0, "no room was opened");
  assert.equal((db.prepare("SELECT COUNT(*) n FROM face_room_members").get() as any).n, 0, "no seat was taken");
});

test("revoking the room-scoped profile grant leaves the guest seat its chat grant paid for", async (t) => {
  const s: any = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  t.after(s.stop);
  const { A, F, roomId } = await roomWithGuest(s, "731007");
  const db = s.platform.db;

  const roomProfile = roomGrant(db, roomId, "profile.read", F.owner_id);
  assert.ok(roomProfile, "the room wrote its own profile grant for the pair");
  assert.ok(roomGrant(db, roomId, "chat.public", F.owner_id), "the room wrote its own chat grant for the pair");

  const revoked = await req(s.base, "DELETE", `/v1/grants/${roomProfile.id}`, F.owner.token);
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));

  const seat = seatOf(db, roomId, F.bot.id);
  assert.ok(seat && seat.left_at == null, "the room's profile grant does not pay for the seat, so ending it keeps the guest");
  assert.ok(roomGrant(db, roomId, "chat.public", F.owner_id), "the room's chat grant is still active");
  const send = await sendInRoom(s, F, A, roomId, "still here after the room profile grant ended");
  assert.equal(send.status, 202, JSON.stringify(send.body));
});

test("revoking the room-scoped chat grant takes the guest seat back", async (t) => {
  const s: any = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  t.after(s.stop);
  const { A, F, roomId } = await roomWithGuest(s, "731008");
  const db = s.platform.db;

  const roomChat = roomGrant(db, roomId, "chat.public", F.owner_id);
  assert.ok(roomChat, "the room wrote its own chat grant for the pair");
  const revoked = await req(s.base, "DELETE", `/v1/grants/${roomChat.id}`, F.owner.token);
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));

  const seat = seatOf(db, roomId, F.bot.id);
  assert.ok(seat && seat.left_at != null, "the room's chat grant paid for the seat, so ending it takes the guest out");
  assert.equal(activeRoomGrants(db, roomId), 0, "no room-scoped grant of that seat is left active");
  const send = await sendInRoom(s, F, A, roomId, "after the room chat grant ended");
  assert.equal(send.status, 403, "a send naming that room is refused");
  assert.equal(send.body?.error?.code, "room_not_shared");
});
