/**
 * A `DELETE /v1/grants/{id}` ends the row it names. A `superseded` row is history: renewing a share marks the old
 * row `superseded` and writes a fresh `active` one, and the seat the guest holds was paid for by the old row's
 * usage. Naming that old row must be refused; it must not end the live share's seat while the live row still says
 * `active`. Control: naming the live row still takes back the seat that row made.
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
  const json = text ? JSON.parse(text) : {};
  return { status: r.status, body: json.error ? { ...json.error, error: undefined } : json };
}

async function shareWith(base: string, from: any, to: any) {
  const rel = await req(base, "POST", "/v1/relationships", to.owner.token, { from_bot_id: to.bot.id, target_handle: from.handle, message: "hi", requested_capabilities: ["chat.public"] });
  assert.ok(rel.status < 300, JSON.stringify(rel.body));
  const consent = await req(base, "POST", `/v1/relationships/${rel.body.relationship_id}/consent`, from.owner.token, { decision: "accept", grant_capabilities: [{ capability: "chat.public" }] });
  assert.equal(consent.status, 200, JSON.stringify(consent.body));
  return rel.body.relationship_id as string;
}

const shares = (db: any, grantorOwner: string, granteeBot: string) =>
  db.prepare("SELECT id, status FROM grants WHERE capability = 'chat.public' AND grantor_owner = ? AND grantee_bot = ? AND room_id IS NULL ORDER BY created_at, id").all(grantorOwner, granteeBot) as any[];
const seatOf = (db: any, room: string, botId: string) =>
  db.prepare("SELECT left_at FROM face_room_members WHERE room_id = ? AND bot_id = ?").get(room, botId) as any;
const usageOf = (db: any, grantId: string, room: string) =>
  db.prepare("SELECT ended_at FROM grant_rooms WHERE grant_id = ? AND room_id = ?").get(grantId, room) as any;
const statusOf = (rows: any[], id: string) => rows.find((r) => r.id === id)?.status;

function sendIntoRoom(s: any, from: any, toHandle: string, room: string) {
  try { s.platform.sendAsMember({ kind: "owner", ownerId: from.owner_id }, { from_bot_id: from.bot.id, to: toHandle, text: "still in the room", room_id: room }); return "202"; } catch (e: any) { return e.code ?? e.message; }
}

async function sharedRoom(t: any) {
  const s: any = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const F = await ownerWithBot(s.base, "fay");
  for (const o of [A, B, F]) s.platform.enableCustody({ kind: "owner", ownerId: o.owner_id }, o.bot.id, { private_key_pem: o.kp.privateKeyPem });
  const relId = await shareWith(s.base, F, A);
  const db = s.platform.db;
  const join = (o: any, code: string, bots: string[]) => req(s.base, "POST", "/v1/face-rooms/join", o.owner.token, { code, bots });
  return { s, A, B, F, relId, db, join };
}

test("a superseded grant id is refused, and the live share keeps the seat its usage made", async (t) => {
  const { s, A, B, F, relId, db, join } = await sharedRoom(t);
  const room = (await join(A, "818181", [A.bot.id, F.bot.id])).body.room_id;
  assert.ok(room);
  assert.equal((await join(B, "818181", [B.bot.id])).status, 200);

  const first = shares(db, F.owner_id, A.bot.id);
  assert.equal(first.length, 1, JSON.stringify(first));
  const oldId = first[0].id;
  assert.equal(usageOf(db, oldId, room)?.ended_at, null, "the seat is open on the row that was active when it was made");

  const renewed = await req(s.base, "POST", `/v1/relationships/${relId}/grants`, F.owner.token, { capability: "chat.public" });
  assert.equal(renewed.status, 201, JSON.stringify(renewed.body));
  const liveId = renewed.body.grant_id as string;
  assert.equal(statusOf(shares(db, F.owner_id, A.bot.id), oldId), "superseded");

  const del = await req(s.base, "DELETE", `/v1/grants/${oldId}`, F.owner.token);
  const rows = shares(db, F.owner_id, A.bot.id);
  const seat = seatOf(db, room, F.bot.id);
  const send = sendIntoRoom(s, F, B.handle, room);
  console.log(`SHAPE_A delete=${del.status}/${del.body.code ?? ""} old=${statusOf(rows, oldId)} live=${statusOf(rows, liveId)} seat_left_at=${seat?.left_at ? "set" : "null"} send=${send}`);

  assert.equal(del.status, 409, `revoking a superseded row must be refused; got ${del.status} ${JSON.stringify(del.body)}`);
  assert.equal(del.body.code, "invalid_state", JSON.stringify(del.body));
  assert.equal(statusOf(rows, oldId), "superseded", "the superseded row must not be written to revoked");
  assert.equal(statusOf(rows, liveId), "active", "the live row is untouched");
  assert.equal(seat?.left_at, null, "the live share still seats the guest");
  assert.equal(send, "202", `a guest the live share seats must still reach the room; got ${send}`);
});

test("a superseded grant id is refused even when the live row re-brought the guest into the same room", async (t) => {
  const { s, A, B, F, relId, db, join } = await sharedRoom(t);
  const room = (await join(A, "717171", [A.bot.id, F.bot.id])).body.room_id;
  assert.ok(room);
  assert.equal((await join(B, "717171", [B.bot.id])).status, 200);
  const oldId = shares(db, F.owner_id, A.bot.id)[0].id;

  // The guest walks itself out, so the room sweep ends the old usage; the seat is gone for now.
  assert.equal((await req(s.base, "POST", `/v1/face-rooms/${room}/leave`, F.owner.token, { bots: [F.bot.id] })).status, 200);
  assert.notEqual(usageOf(db, oldId, room)?.ended_at, null, "leaving the room ends the old usage");
  const renewed = await req(s.base, "POST", `/v1/relationships/${relId}/grants`, F.owner.token, { capability: "chat.public" });
  assert.equal(renewed.status, 201, JSON.stringify(renewed.body));
  const liveId = renewed.body.grant_id as string;
  // The bringer brings the same guest back with the live row: that usage is open and the seat is the live row's.
  assert.equal((await join(A, "717171", [F.bot.id])).status, 200);
  assert.equal(seatOf(db, room, F.bot.id)?.left_at, null);
  assert.equal(usageOf(db, liveId, room)?.ended_at, null, "the live row has the open usage");

  const del = await req(s.base, "DELETE", `/v1/grants/${oldId}`, F.owner.token);
  const rows = shares(db, F.owner_id, A.bot.id);
  const seat = seatOf(db, room, F.bot.id);
  const send = sendIntoRoom(s, F, B.handle, room);
  console.log(`SHAPE_B delete=${del.status}/${del.body.code ?? ""} old=${statusOf(rows, oldId)} live=${statusOf(rows, liveId)} seat_left_at=${seat?.left_at ? "set" : "null"} send=${send}`);

  assert.equal(del.status, 409, `revoking a superseded row must be refused; got ${del.status} ${JSON.stringify(del.body)}`);
  assert.equal(del.body.code, "invalid_state", JSON.stringify(del.body));
  assert.equal(statusOf(rows, oldId), "superseded", "the superseded row must not be written to revoked");
  assert.equal(statusOf(rows, liveId), "active", "the live row is untouched");
  assert.equal(seat?.left_at, null, "the live share still seats the guest");
  assert.equal(send, "202", `a guest the live share seats must still reach the room; got ${send}`);
});

test("control: revoking the live row still takes back the seat that row made", async (t) => {
  const { s, A, B, F, relId, db, join } = await sharedRoom(t);
  const room = (await join(A, "616161", [A.bot.id, F.bot.id])).body.room_id;
  assert.ok(room);
  assert.equal((await join(B, "616161", [B.bot.id])).status, 200);
  assert.equal((await req(s.base, "POST", `/v1/face-rooms/${room}/leave`, F.owner.token, { bots: [F.bot.id] })).status, 200);
  const renewed = await req(s.base, "POST", `/v1/relationships/${relId}/grants`, F.owner.token, { capability: "chat.public" });
  assert.equal(renewed.status, 201, JSON.stringify(renewed.body));
  const liveId = renewed.body.grant_id as string;
  assert.equal((await join(A, "616161", [F.bot.id])).status, 200);

  const del = await req(s.base, "DELETE", `/v1/grants/${liveId}`, F.owner.token);
  const seat = seatOf(db, room, F.bot.id);
  const send = sendIntoRoom(s, F, B.handle, room);
  console.log(`CONTROL_LIVE delete=${del.status}/${del.body.code ?? ""} seat_left_at=${seat?.left_at ? "set" : "null"} send=${send}`);
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.notEqual(seat?.left_at, null, "the live row's own seat is given back");
  assert.equal(send, "room_not_shared", `a guest whose live share was revoked must not reach the room; got ${send}`);
});

test("control: an unknown grant id is still 404 and another owner's grant is still 403", async (t) => {
  const { s, A, B, F, db } = await sharedRoom(t);
  const missing = await req(s.base, "DELETE", "/v1/grants/grt_does_not_exist", F.owner.token);
  assert.equal(missing.status, 404, JSON.stringify(missing.body));
  assert.equal(missing.body.code, "grant_not_found");

  await shareWith(s.base, A, B); // A shares its Bot with B: this row's grantor is A, not F
  const foreignId = shares(db, A.owner_id, B.bot.id)[0].id;
  const foreign = await req(s.base, "DELETE", `/v1/grants/${foreignId}`, F.owner.token);
  console.log(`CONTROL_EDGES missing=${missing.status}/${missing.body.code} foreign=${foreign.status}/${foreign.body.code}`);
  assert.equal(foreign.status, 403, JSON.stringify(foreign.body));
  assert.equal(foreign.body.code, "forbidden");
  assert.equal(statusOf(shares(db, A.owner_id, B.bot.id), foreignId), "active");
});
