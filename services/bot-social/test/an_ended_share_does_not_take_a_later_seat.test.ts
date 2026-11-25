/**
 * A share that is already over must never take a seat a newer share made.
 *
 * `revokeGrant` hands `shareLineage` its rows to `endGrantRooms`, and a renewed share's older row keeps the room
 * usage that made the first seat. That is wanted while the seat is still there. It is wrong once the older row's
 * usage has ended and the guest was let back in by a later share: an ended usage can only claim the seat it still
 * had when it ended, never one that appeared afterwards. Without that bound, asking to end the already finished
 * share again takes the live share's seat away and the guest is out of the room while its share still reads
 * `active`.
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

test("an ended share does not take a seat a newer share made", async (t) => {
  const s: any = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const F = await ownerWithBot(s.base, "fay");
  const custody = (o: any) => s.platform.enableCustody({ kind: "owner" as const, ownerId: o.owner_id }, o.bot.id, { private_key_pem: o.kp.privateKeyPem });
  custody(A); custody(B); custody(F);
  const relationshipId = await share(s.base, F, A);

  const db = s.platform.db;
  const shareRow = () => (db.prepare("SELECT id FROM grants WHERE grantor_owner = ? AND grantee_bot = ? AND capability = 'chat.public' AND room_id IS NULL ORDER BY created_at DESC, id DESC").get(F.owner_id, A.bot.id) as any).id;
  const statusOf = (id: string) => (db.prepare("SELECT status FROM grants WHERE id = ?").get(id) as any)?.status;
  const seat = (roomId: string) => db.prepare("SELECT left_at FROM face_room_members WHERE room_id = ? AND bot_id = ?").get(roomId, F.bot.id) as any;

  const code = "737371";
  const host = await req(s.base, "POST", "/v1/face-rooms/join", B.owner.token, { code, bots: [B.bot.id] });
  assert.equal(host.status, 200, JSON.stringify(host.body));
  const roomId = host.body.room_id as string;
  const brought = await req(s.base, "POST", "/v1/face-rooms/join", A.owner.token, { code, bots: [A.bot.id, F.bot.id] });
  assert.equal(brought.status, 200, JSON.stringify(brought.body));
  const firstShare = shareRow();
  assert.equal(statusOf(firstShare), "active");

  const renewed = await req(s.base, "POST", `/v1/relationships/${relationshipId}/grants`, F.owner.token, { capability: "chat.public" });
  assert.ok(renewed.status < 300, JSON.stringify(renewed.body));
  const secondShare = shareRow();
  assert.notEqual(secondShare, firstShare);
  assert.equal(statusOf(firstShare), "superseded", "the renewal supersedes the row that made the first seat");

  // Ending the renewal takes the seat the first share made: that is what this branch is for.
  const ended = await req(s.base, "DELETE", `/v1/grants/${secondShare}`, F.owner.token);
  assert.equal(ended.status, 200, JSON.stringify(ended.body));
  assert.notEqual(seat(roomId).left_at, null, "the renewal's end takes the first share's seat");

  // A fresh share lets the guest back in, and its seat is the new share's.
  const renewedAgain = await req(s.base, "POST", `/v1/relationships/${relationshipId}/grants`, F.owner.token, { capability: "chat.public" });
  assert.ok(renewedAgain.status < 300, JSON.stringify(renewedAgain.body));
  const liveShare = shareRow();
  assert.notEqual(liveShare, secondShare);
  const back = await req(s.base, "POST", "/v1/face-rooms/join", A.owner.token, { code, bots: [A.bot.id, F.bot.id] });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal(seat(roomId).left_at, null, "the guest is back in on the live share");

  // Asking to end the share that is already over must not reach the seat that arrived later. Refusing that call
  // outright is a separate fix; either answer is fine here as long as the seat and the live share survive.
  const again = await req(s.base, "DELETE", `/v1/grants/${secondShare}`, F.owner.token);
  assert.ok(again.status === 200 || again.status === 409, `unexpected answer ${again.status} ${JSON.stringify(again.body)}`);
  assert.equal(statusOf(secondShare), "revoked");
  assert.equal(statusOf(firstShare), "superseded");
  assert.equal(statusOf(liveShare), "active", "the live share is untouched");
  assert.equal(seat(roomId).left_at, null, "an ended share does not take a seat a newer share made");

  const send = await req(s.base, "POST", `/v1/homes/${F.bot.id}/send`, F.owner.token, { from_bot_id: F.bot.id, to: B.bot.id, text: "still seated", room_id: roomId });
  assert.equal(send.status, 202, JSON.stringify(send.body));
});
