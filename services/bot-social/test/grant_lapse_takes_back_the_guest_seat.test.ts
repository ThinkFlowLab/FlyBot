/**
 * A share that lapses after its bringer left must still take back the guest seat it made.
 * `expireLapsedShares` only hands a lapsed share to `endGrantRooms` while that share still has an OPEN usage, but the
 * room sweep closes the usage when the bringer leaves (the seat is kept on purpose). So the seat, its room grants and
 * its delivery outlive the share. The three readings below are the regression: seat gone, no active room grants,
 * `send_as_member` with that `room_id` refused.
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
}

test("a lapsed share takes back the guest seat its bringer left behind", async (t) => {
  const s: any = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const F = await ownerWithBot(s.base, "fay");
  const custody = (o: any) => s.platform.enableCustody({ kind: "owner" as const, ownerId: o.owner_id }, o.bot.id, { private_key_pem: o.kp.privateKeyPem });
  custody(A); custody(B); custody(F);
  await share(s.base, F, A);

  const code = "848484";
  const host = await req(s.base, "POST", "/v1/face-rooms/join", B.owner.token, { code, bots: [B.bot.id] });
  assert.equal(host.status, 200, JSON.stringify(host.body));
  const roomId = host.body.room_id as string;
  const brought = await req(s.base, "POST", "/v1/face-rooms/join", A.owner.token, { code, bots: [A.bot.id, F.bot.id] });
  assert.equal(brought.status, 200, JSON.stringify(brought.body));

  const left = await req(s.base, "POST", `/v1/face-rooms/${roomId}/leave`, A.owner.token, {});
  assert.equal(left.status, 200, JSON.stringify(left.body));

  const db = s.platform.db;
  const shareRow = db.prepare("SELECT id, status, expires_at, room_id FROM grants WHERE grantor_owner = ? AND grantee_bot = ? AND capability = 'chat.public'").get(F.owner_id, A.bot.id) as any;
  assert.ok(shareRow, "the share row exists");
  const openUsagesBefore = (db.prepare("SELECT COUNT(*) n FROM grant_rooms WHERE grant_id = ? AND ended_at IS NULL").get(shareRow.id) as any).n;
  assert.equal(openUsagesBefore, 0, "the room sweep already closed the usage, which is what hid the seat from this door");

  // Let the share lapse, then trip the face-room sweep that runs expireLapsedShares.
  db.prepare("UPDATE grants SET expires_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", shareRow.id);
  await req(s.base, "GET", "/v1/face-rooms", B.owner.token);

  const afterShare = db.prepare("SELECT status, expires_at FROM grants WHERE id = ?").get(shareRow.id) as any;
  const seat = db.prepare("SELECT left_at FROM face_room_members WHERE room_id = ? AND bot_id = ?").get(roomId, F.bot.id) as any;
  const grants = (db.prepare("SELECT COUNT(*) n FROM grants WHERE room_id = ? AND status = 'active'").get(roomId) as any).n;
  const send = await req(s.base, "POST", `/v1/homes/${F.bot.id}/send`, F.owner.token, { from_bot_id: F.bot.id, to: B.bot.id, text: "after lapse", room_id: roomId });
  assert.equal(afterShare.status, "expired", "the share has lapsed");
  assert.ok(seat && seat.left_at != null, "the seat the lapsed share made is gone");
  assert.equal(grants, 0, "no room-scoped grant of that seat is left active");
  assert.equal(send.status, 403, "a send naming that room is refused");
  assert.equal(send.body?.error?.code, "room_not_shared");
});
