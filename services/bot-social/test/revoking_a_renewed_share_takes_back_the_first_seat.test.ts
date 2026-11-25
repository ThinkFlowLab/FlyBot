/**
 * Revoking a renewed share must take back the seat an earlier share of the same line made.
 * `insertGrant` marks the live row `superseded` and writes a new one, and the old row keeps the `grant_rooms` rows
 * that made the guest seat. Every explicit end door hands `endGrantRooms` only the rows it just ended, so the seat
 * outlives the share: the guest stays in the room, its room grants stay active, and `send_as_member` naming that
 * room still delivers. Both shapes of the old usage matter — still open while the bringer sits in the room, and
 * already closed by the room sweep because the bringer left first — and the bundle door has the same hole.
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

async function share(base: string, from: any, to: any) {
  const rel = await req(base, "POST", "/v1/relationships", to.owner.token, {
    from_bot_id: to.bot.id, target_handle: from.handle, message: "hi", requested_capabilities: ["chat.public"],
  });
  assert.ok(rel.status < 300, JSON.stringify(rel.body));
  const c = await req(base, "POST", `/v1/relationships/${rel.body.relationship_id}/consent`, from.owner.token, {
    decision: "accept", grant_capabilities: [{ capability: "chat.public" }],
  });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  return rel.body.relationship_id as string;
}

/** B hosts a room and A brings A's own Bot plus F's Bot into it on the share F gave A. */
async function roomWithGuest(s: any, B: any, A: any, F: any, code: string) {
  const host = await req(s.base, "POST", "/v1/face-rooms/join", B.owner.token, { code, bots: [B.bot.id] });
  assert.equal(host.status, 200, JSON.stringify(host.body));
  const roomId = host.body.room_id as string;
  const brought = await req(s.base, "POST", "/v1/face-rooms/join", A.owner.token, { code, bots: [A.bot.id, F.bot.id] });
  assert.equal(brought.status, 200, JSON.stringify(brought.body));
  return roomId;
}

async function renew(s: any, relationshipId: string, F: any, capability = "chat.public") {
  const renewed = await req(s.base, "POST", `/v1/relationships/${relationshipId}/grants`, F.owner.token, { capability });
  assert.ok(renewed.status < 300, JSON.stringify(renewed.body));
  return renewed.body.grant_id as string;
}

function seatOf(s: any, roomId: string, botId: string) {
  return s.platform.db.prepare("SELECT left_at FROM face_room_members WHERE room_id = ? AND bot_id = ?").get(roomId, botId) as any;
}

test("revoking a renewed share takes back the seat the first share made while its bringer stayed", async (t) => {
  const s: any = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const F = await ownerWithBot(s.base, "fay");
  const custody = (o: any) => s.platform.enableCustody({ kind: "owner" as const, ownerId: o.owner_id }, o.bot.id, { private_key_pem: o.kp.privateKeyPem });
  custody(A); custody(B); custody(F);
  const relationshipId = await share(s.base, F, A);
  const roomId = await roomWithGuest(s, B, A, F, "858585");

  const db = s.platform.db;
  const first = db.prepare("SELECT id FROM grants WHERE grantor_owner = ? AND grantee_bot = ? AND capability = 'chat.public'").get(F.owner_id, A.bot.id) as any;
  assert.ok(first, "the first share row exists");
  const firstUsage = db.prepare("SELECT room_id, ended_at FROM grant_rooms WHERE grant_id = ?").get(first.id) as any;
  assert.ok(firstUsage && firstUsage.ended_at == null, "the first share's usage is still open while its bringer sits in the room");

  const renewedId = await renew(s, relationshipId, F);
  const firstAfter = db.prepare("SELECT status FROM grants WHERE id = ?").get(first.id) as any;
  assert.equal(firstAfter.status, "superseded", "renewing marked the first share superseded");
  const renewedUsages = (db.prepare("SELECT COUNT(*) n FROM grant_rooms WHERE grant_id = ?").get(renewedId) as any).n;
  assert.equal(renewedUsages, 0, "the renewed share never touched the room: only the first row holds that seat");

  assert.equal(seatOf(s, roomId, F.bot.id)?.left_at, null, "the guest still sits there on the first share's seat");

  const rev = await req(s.base, "DELETE", `/v1/grants/${renewedId}`, F.owner.token);
  assert.equal(rev.status, 200, JSON.stringify(rev.body));

  const seat = seatOf(s, roomId, F.bot.id);
  assert.ok(seat && seat.left_at != null, "the seat the first share made is gone");
  const roomGrants = (db.prepare(`SELECT COUNT(*) n FROM grants g JOIN relationships r ON r.id = g.relationship_id
    WHERE g.room_id = ? AND g.status = 'active' AND (r.requester_bot = ? OR r.target_bot = ?)`).get(roomId, F.bot.id, F.bot.id) as any).n;
  assert.equal(roomGrants, 0, "no room-scoped grant of that seat is left active");
  const send = await req(s.base, "POST", `/v1/homes/${F.bot.id}/send`, F.owner.token, { from_bot_id: F.bot.id, to: B.bot.id, text: "after the renewal ended", room_id: roomId });
  assert.equal(send.status, 403, "a send naming that room is refused");
  assert.equal(send.body?.error?.code, "room_not_shared");
});

test("revoking a renewed share takes back the seat the first share made after its bringer left", async (t) => {
  const s: any = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const F = await ownerWithBot(s.base, "fay");
  const custody = (o: any) => s.platform.enableCustody({ kind: "owner" as const, ownerId: o.owner_id }, o.bot.id, { private_key_pem: o.kp.privateKeyPem });
  custody(A); custody(B); custody(F);
  const relationshipId = await share(s.base, F, A);
  const roomId = await roomWithGuest(s, B, A, F, "858586");

  const left = await req(s.base, "POST", `/v1/face-rooms/${roomId}/leave`, A.owner.token, {});
  assert.equal(left.status, 200, JSON.stringify(left.body));

  const db = s.platform.db;
  const first = db.prepare("SELECT id FROM grants WHERE grantor_owner = ? AND grantee_bot = ? AND capability = 'chat.public'").get(F.owner_id, A.bot.id) as any;
  const firstUsage = db.prepare("SELECT ended_at FROM grant_rooms WHERE grant_id = ?").get(first.id) as any;
  assert.ok(firstUsage && firstUsage.ended_at != null, "the room sweep closed the usage when the bringer left");

  const renewedId = await renew(s, relationshipId, F);
  const firstAfter = db.prepare("SELECT status FROM grants WHERE id = ?").get(first.id) as any;
  assert.equal(firstAfter.status, "superseded", "renewing marked the first share superseded");

  const rev = await req(s.base, "DELETE", `/v1/grants/${renewedId}`, F.owner.token);
  assert.equal(rev.status, 200, JSON.stringify(rev.body));

  const seat = seatOf(s, roomId, F.bot.id);
  assert.ok(seat && seat.left_at != null, "the seat the first share made is gone after the renewal ended");
});

test("revoking the bundle with revoke_bot_grant takes back the seat the first share made", async (t) => {
  const s: any = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const F = await ownerWithBot(s.base, "fay");
  const custody = (o: any) => s.platform.enableCustody({ kind: "owner" as const, ownerId: o.owner_id }, o.bot.id, { private_key_pem: o.kp.privateKeyPem });
  custody(A); custody(B); custody(F);
  const relationshipId = await share(s.base, F, A);
  const roomId = await roomWithGuest(s, B, A, F, "858587");

  const db = s.platform.db;
  // `revoke_bot_grant` ends the whole bundle — every capability of that share — and the room sweep wrote a usage
  // row for each capability. Renew every one of them, or the still-original sibling row carries the seat and hides
  // the hole; then the bundle only holds rows that never touched the room.
  const renewedId = await renew(s, relationshipId, F, "chat.public");
  await renew(s, relationshipId, F, "profile.read");
  const first = db.prepare("SELECT id, status FROM grants WHERE grantor_owner = ? AND grantee_bot = ? AND capability = 'chat.public'").get(F.owner_id, A.bot.id) as any;
  assert.equal(first?.status, "superseded", "the first share row is the superseded one");
  assert.equal(seatOf(s, roomId, F.bot.id)?.left_at, null, "the guest still sits there on the first share's seat");

  const rev = await req(s.base, "DELETE", `/v1/bots/${F.bot.id}/grants/${renewedId}`, F.owner.token);
  assert.equal(rev.status, 200, JSON.stringify(rev.body));

  const seat = seatOf(s, roomId, F.bot.id);
  assert.ok(seat && seat.left_at != null, "the seat the first share made is gone after the bundle ended");
});
