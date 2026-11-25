/**
 * A guest seat belongs to the share that put it there. When the owner who brought the guest leaves the room
 * first, the room's sweep ends that share's `grant_rooms` usage — and the later revoke of the share finds no
 * open usage to give back, so the guest keeps its seat and its reach in the room after the share is gone.
 * Control: the same revoke, with the bringer still in the room, gives the seat back.
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
}

test("a guest keeps its seat after its bringer left, then the share that seated it was revoked", async (t) => {
  const s: any = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const F = await ownerWithBot(s.base, "fay");
  const G = await ownerWithBot(s.base, "gil");
  for (const o of [A, B, F, G]) s.platform.enableCustody({ kind: "owner", ownerId: o.owner_id }, o.bot.id, { private_key_pem: o.kp.privateKeyPem });

  await shareWith(s.base, F, A); // F shares its Bot with A, so A may bring it into a room
  await shareWith(s.base, G, A);

  const db = s.platform.db;
  const join = (o: any, code: string, bots: string[]) => req(s.base, "POST", "/v1/face-rooms/join", o.owner.token, { code, bots });
  const shareRow = (grantorOwner: string, granteeBot: string) => db.prepare("SELECT g.id, g.status, gr.ended_at FROM grants g LEFT JOIN grant_rooms gr ON gr.grant_id = g.id WHERE g.capability = 'chat.public' AND g.grantor_owner = ? AND g.grantee_bot = ? ORDER BY g.created_at").get(grantorOwner, granteeBot) as any;
  const memberOf = (room: string, botId: string) => db.prepare("SELECT left_at FROM face_room_members WHERE room_id = ? AND bot_id = ?").get(room, botId) as any;
  const pairGrants = (room: string, x: string, y: string) => (db.prepare(`SELECT COUNT(*) n FROM grants g JOIN relationships r ON r.id = g.relationship_id
    WHERE g.room_id = ? AND g.status = 'active' AND ((r.requester_bot = ? AND r.target_bot = ?) OR (r.requester_bot = ? AND r.target_bot = ?))`).get(room, x, y, y, x) as any).n;

  // Control room: the bringer stays, the share is revoked, the seat goes back.
  const control = (await join(A, "818181", [A.bot.id])).body.room_id;
  await join(A, "818181", [G.bot.id]);
  assert.equal((await req(s.base, "POST", `/v1/face-rooms/${control}/start`, A.owner.token, {})).status, 200);
  const gidControl = shareRow(G.owner_id, A.bot.id).id;
  assert.equal((await req(s.base, "DELETE", `/v1/grants/${gidControl}`, G.owner.token)).status, 200);
  console.log(`# control (bringer still seated): G.bot left_at ${memberOf(control, G.bot.id)?.left_at ? "set" : "null"} | G-B grants ${pairGrants(control, G.bot.id, A.bot.id)} | members ${(db.prepare("SELECT COUNT(*) n FROM face_room_members WHERE room_id = ? AND left_at IS NULL").get(control) as any).n}`);

  // Room under test: A brings F's Bot in, B joins, A leaves, then F revokes the share that seated F's Bot.
  const room = (await join(A, "717171", [A.bot.id, F.bot.id])).body.room_id;
  assert.ok(room);
  assert.equal((await join(B, "717171", [B.bot.id])).status, 200);
  assert.equal((await req(s.base, "POST", `/v1/face-rooms/${room}/start`, A.owner.token, {})).status, 200);
  const gid = shareRow(F.owner_id, A.bot.id).id;
  console.log(`# joined: F.bot left_at ${memberOf(room, F.bot.id)?.left_at ? "set" : "null"} | share ${JSON.stringify(shareRow(F.owner_id, A.bot.id))} | F-B grants ${pairGrants(room, F.bot.id, B.bot.id)}`);

  assert.equal((await req(s.base, "POST", `/v1/face-rooms/${room}/leave`, A.owner.token, {})).status, 200);
  console.log(`# after A left: F.bot left_at ${memberOf(room, F.bot.id)?.left_at ? "set" : "null"} | share ${JSON.stringify(shareRow(F.owner_id, A.bot.id))} | F-B grants ${pairGrants(room, F.bot.id, B.bot.id)}`);

  const usagesBefore = (db.prepare("SELECT COUNT(*) n FROM grant_rooms WHERE grant_id = ?").get(gid) as any).n;
  assert.equal((await req(s.base, "DELETE", `/v1/grants/${gid}`, F.owner.token)).status, 200);
  const after = memberOf(room, F.bot.id);
  let sendAfter = "delivered";
  try {
    s.platform.sendAsMember({ kind: "owner", ownerId: F.owner_id }, { from_bot_id: F.bot.id, to: B.handle, text: "the share that seated me is gone", room_id: room });
  } catch (e: any) { sendAfter = e.code ?? e.message; }
  console.log(`# after the share was revoked: F.bot left_at ${after?.left_at ? "set" : "null"} | share ${JSON.stringify(shareRow(F.owner_id, A.bot.id))} | F-B grants ${pairGrants(room, F.bot.id, B.bot.id)} | F send ${sendAfter} | open usages ${(db.prepare("SELECT COUNT(*) n FROM grant_rooms WHERE grant_id = ? AND ended_at IS NULL").get(gid) as any).n}`);

  assert.equal(after?.left_at != null, true, "the share that seated the guest is revoked, so its seat must be gone");
  assert.equal(pairGrants(room, F.bot.id, B.bot.id), 0, "a revoked share must not leave room grants between the guest and the members");
  assert.equal(sendAfter, "room_not_shared", "a guest whose share was revoked must not reach the room");
  // The usage row for this room is closed and no new row was written for it: the seat came from that one share,
  // and its record stays one row with an end.
  assert.equal((db.prepare("SELECT COUNT(*) n FROM grant_rooms WHERE grant_id = ?").get(gid) as any).n, usagesBefore, "revoking must not add grant_rooms rows");
  assert.equal((db.prepare("SELECT COUNT(*) n FROM grant_rooms WHERE grant_id = ? AND ended_at IS NULL").get(gid) as any).n, 0, "every usage of the revoked share is ended");
});

test("a revoked share gives back only the seats still held, and names only those rooms", async (t) => {
  const s: any = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const F = await ownerWithBot(s.base, "fay");
  await shareWith(s.base, F, A); // F shares its Bot with A, so A may bring it into a room

  const db = s.platform.db;
  const join = (o: any, code: string, bots: string[]) => req(s.base, "POST", "/v1/face-rooms/join", o.owner.token, { code, bots });
  const start = (room: string) => req(s.base, "POST", `/v1/face-rooms/${room}/start`, A.owner.token, {});
  const leave = (o: any, room: string, bots: string[]) => req(s.base, "POST", `/v1/face-rooms/${room}/leave`, o.owner.token, { bots });
  const memberOf = (room: string) => db.prepare("SELECT left_at FROM face_room_members WHERE room_id = ? AND bot_id = ?").get(room, F.bot.id) as any;
  const usageOf = (room: string) => db.prepare("SELECT ended_at FROM grant_rooms WHERE grant_id = ? AND room_id = ?").get(gid, room) as any;
  const gid = (db.prepare(`SELECT id FROM grants WHERE capability = 'chat.public' AND grantor_owner = ? AND grantee_bot = ? AND room_id IS NULL ORDER BY created_at`).get(F.owner_id, A.bot.id) as any).id;

  // Room 1: its usage is already closed by the sweep that ran when the bringer left, but the guest is still seated.
  const seated = (await join(A, "616161", [A.bot.id, F.bot.id])).body.room_id;
  assert.equal((await start(seated)).status, 200);
  assert.equal((await leave(A, seated, [A.bot.id])).status, 200);
  // Room 2: the guest's own owner walked it out, so this usage is history and its seat is already gone.
  const gone = (await join(A, "626262", [A.bot.id, F.bot.id])).body.room_id;
  assert.equal((await start(gone)).status, 200);
  assert.equal((await leave(F, gone, [F.bot.id])).status, 200);

  const closedUsage = usageOf(seated)?.ended_at;
  assert.ok(closedUsage, "the room sweep ends the usage when the bringer leaves");
  assert.ok(usageOf(gone)?.ended_at, "the room sweep ends the usage when the guest leaves");
  assert.equal(memberOf(seated)?.left_at, null);
  const goneLeftAt = memberOf(gone)?.left_at;
  const goneEndedAt = usageOf(gone)?.ended_at;
  assert.notEqual(goneLeftAt, null);

  const res = await req(s.base, "DELETE", `/v1/bots/${F.bot.id}/grants/${gid}`, F.owner.token);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  console.log(`# revoked: rooms_removed ${JSON.stringify(res.body.rooms_removed)} | seated left_at ${memberOf(seated)?.left_at ? "set" : "null"} | gone left_at ${memberOf(gone)?.left_at === goneLeftAt ? "unchanged" : "changed"}`);

  assert.deepEqual(res.body.rooms_removed, [seated], "only the room that still seated the guest is given back");
  assert.notEqual(memberOf(seated)?.left_at, null, "the seat the revoked share still held is gone");
  assert.equal(memberOf(gone)?.left_at, goneLeftAt, "a seat already given back must not be touched a second time");
  assert.equal(usageOf(gone)?.ended_at, goneEndedAt, "a usage already ended keeps its end time");
  const audits = (s.platform.audit.db.prepare("SELECT data FROM audit_events WHERE action = 'grant.revoked' AND subject = ?").all(gid) as any[])
    .map((r) => JSON.parse(r.data)).filter((d) => Array.isArray(d.rooms));
  assert.equal(audits.length, 1, "one grant.revoked row carries the rooms this revoke gave back");
  assert.deepEqual(audits[0].rooms, [seated], "the audit names only the room whose seat was really removed");
  assert.equal((db.prepare("SELECT COUNT(*) n FROM face_room_members WHERE room_id = ? AND left_at IS NULL").get(gone) as any).n, 1, "the other room keeps its own seat");
});
