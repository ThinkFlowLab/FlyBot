/**
 * An old lapsed share must not take back a seat a newer share made.
 * `expireLapsedShares` hands a lapsed share to `endGrantRooms` when the room still shows a guest seat, and
 * `endGrantRooms` claims seats by (granted bot, added_by == grantee owner) — not by which share made them. So a
 * share that lapsed before the seat existed keeps claiming the seat every time it appears, even after the guest
 * was let back in on a fresh share. The seat has to survive the sweep and the delivery that names the room.
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

test("a renewed share keeps the seat it makes after an older share lapsed", async (t) => {
  const s: any = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const F = await ownerWithBot(s.base, "fay");
  const custody = (o: any) => s.platform.enableCustody({ kind: "owner" as const, ownerId: o.owner_id }, o.bot.id, { private_key_pem: o.kp.privateKeyPem });
  custody(A); custody(B); custody(F);
  const relationshipId = await share(s.base, F, A);

  const code = "848485";
  const host = await req(s.base, "POST", "/v1/face-rooms/join", B.owner.token, { code, bots: [B.bot.id] });
  assert.equal(host.status, 200, JSON.stringify(host.body));
  const roomId = host.body.room_id as string;
  const brought = await req(s.base, "POST", "/v1/face-rooms/join", A.owner.token, { code, bots: [A.bot.id, F.bot.id] });
  assert.equal(brought.status, 200, JSON.stringify(brought.body));

  const left = await req(s.base, "POST", `/v1/face-rooms/${roomId}/leave`, A.owner.token, {});
  assert.equal(left.status, 200, JSON.stringify(left.body));

  const db = s.platform.db;
  const oldShare = db.prepare("SELECT id FROM grants WHERE grantor_owner = ? AND grantee_bot = ? AND capability = 'chat.public'").get(F.owner_id, A.bot.id) as any;
  assert.ok(oldShare, "the first share row exists");
  db.prepare("UPDATE grants SET expires_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", oldShare.id);
  await req(s.base, "GET", "/v1/face-rooms", B.owner.token);

  const oldSeat = db.prepare("SELECT left_at FROM face_room_members WHERE room_id = ? AND bot_id = ?").get(roomId, F.bot.id) as any;
  assert.ok(oldSeat && oldSeat.left_at != null, "the old share's seat was taken back first");

  const renewed = await req(s.base, "POST", `/v1/relationships/${relationshipId}/grants`, F.owner.token, { capability: "chat.public" });
  assert.ok(renewed.status < 300, JSON.stringify(renewed.body));

  const back = await req(s.base, "POST", "/v1/face-rooms/join", A.owner.token, { code, bots: [A.bot.id, F.bot.id] });
  assert.equal(back.status, 200, JSON.stringify(back.body));

  const seat = () => (db.prepare("SELECT left_at FROM face_room_members WHERE room_id = ? AND bot_id = ?").get(roomId, F.bot.id) as any);
  assert.equal(seat().left_at, null, "the seat the renewed share made survives the join");
  await req(s.base, "GET", "/v1/face-rooms", B.owner.token);
  assert.equal(seat().left_at, null, "and it survives the next sweep");

  const send = await req(s.base, "POST", `/v1/homes/${F.bot.id}/send`, F.owner.token, { from_bot_id: F.bot.id, to: B.bot.id, text: "still seated", room_id: roomId });
  assert.equal(send.status, 202, JSON.stringify(send.body));
});
