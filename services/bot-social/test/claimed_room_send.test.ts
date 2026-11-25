import assert from "node:assert/strict";
import { test } from "node:test";
import { generateEd25519 } from "../src/crypto.js";
import { friends, ownerWithBot, startServer } from "./helpers.js";

// Bot Social #59: "a claimed room's member still cannot send into that room: the correct room_id returns
// no_relationship". These cases replay the issue's table over the REST route a FlyBot home uses
// (POST /v1/homes/{id}/send with the owner's token), for both doors a stranger can be seated by:
// a face-room ticket (#43) and a local room's ticket (#60, the room id a FlyBot home actually sends).

async function req(base: string, method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  const json = text ? JSON.parse(text) : {};
  return { status: r.status, body: json.error ? json.error : json };
}
const tok = (o: any) => o.owner.token;
const owner = (o: any) => ({ kind: "owner" as const, ownerId: o.owner_id });
const custody = (s: any, o: any, bot = o.bot, kp = o.kp) => s.platform.enableCustody(owner(o), bot.id, { private_key_pem: kp.privateKeyPem });
const send = (base: string, o: any, from: string, to: string, text: string, room_id?: string) =>
  req(base, "POST", `/v1/homes/${from}/send`, tok(o), { from_bot_id: from, to, text, ...(room_id ? { room_id } : {}) });
const pairRows = (s: any, a: string, b: string) =>
  (s.platform.db.prepare("SELECT status FROM relationships WHERE (requester_bot = ? AND target_bot = ?) OR (requester_bot = ? AND target_bot = ?)").all(a, b, b, a) as any[]).map((r) => r.status);
async function secondBot(base: string, o: any, suffix: string) {
  const kp = generateEd25519();
  const handle = `${o.handle.slice(1).replace(/\.bot$/, "")}${suffix}.bot`;
  const r = await o.owner.req("POST", "/v1/bots", { handle, public_key: { alg: "Ed25519", kid: "k1", value: kp.publicKey } });
  return { bot: { id: r.bot_id as string }, handle: `@${handle}`, kp };
}

test("#59: a guest seated by a face-room ticket sends naming that room and it is delivered", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "alice");
  const B = await ownerWithBot(s.base, "bob"); // a stranger: no relationship at all
  const room = await req(s.base, "POST", "/v1/face-rooms/join", tok(A), { code: "595959", bots: [A.bot.id] });
  assert.equal(room.status, 200, JSON.stringify(room.body));
  const roomId = room.body.room_id;
  const ticket = await req(s.base, "POST", `/v1/face-rooms/${roomId}/invites`, tok(A));
  assert.equal((await req(s.base, "POST", "/v1/face-rooms/join-invite", tok(B), { ticket: ticket.body.ticket, bots: [B.bot.id] })).status, 200);
  custody(s, A);
  custody(s, B);
  assert.deepEqual(pairRows(s, A.bot.id, B.bot.id), ["room"], "the claim wrote one room relationship");

  const ok = await send(s.base, B, B.bot.id, A.handle, "thanks for the invite", roomId);
  assert.equal(ok.status, 202, JSON.stringify(ok.body));
  assert.equal(ok.body.message.status, "delivered", "the defect row: correct room_id must not be no_relationship");
  assert.equal((await send(s.base, A, A.bot.id, B.handle, "welcome", roomId)).body.message.status, "delivered", "and the host answers");

  const plain = await send(s.base, B, B.bot.id, A.handle, "out of the blue");
  assert.equal(plain.status, 403);
  assert.equal(plain.body.code, "no_relationship", "no room_id: the 1:1 path is unchanged for a stranger");
  const other = await send(s.base, B, B.bot.id, A.handle, "wrong room", "frm_not_this_one");
  assert.equal(other.status, 403);
  assert.equal(other.body.code, "room_not_shared");
  assert.deepEqual(pairRows(s, A.bot.id, B.bot.id), ["room"], "no friendship row is written by a room send");

  assert.equal((await req(s.base, "POST", `/v1/face-rooms/${roomId}/leave`, tok(B), {})).status, 200);
  const after = await send(s.base, B, B.bot.id, A.handle, "after leaving", roomId);
  assert.equal(after.status, 403);
  assert.equal(after.body.code, "room_not_shared", "after Leave: refused whole, never delivered");
});

test("#59: a guest seated by a local room's ticket sends naming the FlyBot room id and it is delivered", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const B2 = await secondBot(s.base, B, "x");
  const ROOM = "war-59"; // a FlyBot local room id: no face_rooms row
  const m = await req(s.base, "POST", "/v1/local-room-invites", tok(A), { room_id: ROOM, bot_id: A.bot.id });
  assert.equal(m.status, 201, JSON.stringify(m.body));
  custody(s, A);
  custody(s, B);
  custody(s, B, B2.bot, B2.kp);
  const before = await send(s.base, B, B.bot.id, A.handle, "knock", ROOM);
  assert.equal(before.body.code, "room_not_shared", "before the claim the room is not shared");
  assert.equal((await req(s.base, "POST", `/v1/local-room-invites/${m.body.ticket}/claim`, tok(B), { bots: [B.bot.id, B2.bot.id] })).status, 200);

  for (const g of [B, B2]) {
    const ok = await send(s.base, B, g.bot.id, A.handle, "hello from the guest home", ROOM);
    assert.equal(ok.status, 202, JSON.stringify(ok.body));
    assert.equal(ok.body.message.status, "delivered", `${g.handle}: correct room_id must not be no_relationship`);
    assert.equal((await send(s.base, A, A.bot.id, g.handle, "welcome", ROOM)).body.message.status, "delivered");
  }
  assert.equal((await send(s.base, B, B.bot.id, A.handle, "plain")).body.code, "no_relationship");
  assert.equal((await send(s.base, B, B.bot.id, A.handle, "x", "war-other")).body.code, "room_not_shared");
  assert.deepEqual(pairRows(s, A.bot.id, B.bot.id), ["room"], "no friendship row is written by a room send");

  assert.equal((await req(s.base, "DELETE", `/v1/local-room-invites/${m.body.ticket}`, tok(B))).status, 204);
  const after = await send(s.base, B, B.bot.id, A.handle, "after release", ROOM);
  assert.equal(after.status, 403);
  assert.equal(after.body.code, "room_not_shared", "the grant died with the release: refused, never delivered");
});

test("#59: control — friends without a room_id still get the normal approval card", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  custody(s, A);
  const r = await send(s.base, A, A.bot.id, B.handle, "hi friend");
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(r.body.message.status, "pending_approval");
});
