import assert from "node:assert/strict";
import { test } from "node:test";
import { friends, ownerWithBot, startServer } from "./helpers.js";

// P23 / product's "P20": a Block ends the friendship row it is pointed at, but the room rows written when the two
// Bots were seated in the same face room keep their `status='room'` door and the room-scoped `chat.public` grants
// that ride on it. `POST /v1/homes/{id}/send {room_id}` then still delivers to the blocked party, so "Block" does
// not actually cut the pair off. Three ways in: the UI blocks by `relationship_id` (only that row ends), a whole-pair
// block still lets the pair rebuild the door by re-joining the same room, and a row blocked before this fix keeps
// its door alive.
//
// The refusals do not announce the block. Each door re-joins the answer it already gives for a number or a link
// that is no longer there: `409 code_void` for the 6-digit door (the shape of a number whose room has gone) and
// `404 invite_not_found` for the ticket doors (the shape of a ticket that is not there for the caller). The tests
// produce that existing refusal and compare the blocked one against it field by field.
//
// A block also ends the blocked Bot's seat in every live room the pair still shares, so a leave written after the
// block answers `404 face_room_not_found` instead of the old `200`: the seat it was written for is already gone,
// and a re-join with the same number is refused exactly like the re-join of a pair that never re-entered.

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
const custody = (s: any, o: any) => s.platform.enableCustody(owner(o), o.bot.id, { private_key_pem: o.kp.privateKeyPem });
const send = (base: string, o: any, from: string, to: string, text: string, room_id?: string) =>
  req(base, "POST", `/v1/homes/${from}/send`, tok(o), { from_bot_id: from, to, text, ...(room_id ? { room_id } : {}) });
const pairRows = (s: any, a: string, b: string) =>
  (s.platform.db.prepare("SELECT status FROM relationships WHERE (requester_bot = ? AND target_bot = ?) OR (requester_bot = ? AND target_bot = ?)").all(a, b, b, a) as any[]).map((r) => r.status);
const received = async (s: any, o: any) => (await o.bot.events()).events.filter((e: any) => e.event_type === "message.received");
const seats = (s: any, roomId: string, botId: string) =>
  (s.platform.db.prepare("SELECT COUNT(*) n FROM face_room_members WHERE room_id = ? AND bot_id = ? AND left_at IS NULL").get(roomId, botId) as any).n;
const attempts = (s: any, code: string) =>
  s.platform.db.prepare("SELECT outcome FROM face_room_attempts WHERE code = ? ORDER BY rowid DESC LIMIT 1").get(code) as any;

/** Both Bots seated in one face room, with the room relationship and grants that the join wrote. */
async function sharedRoom(s: any, A: any, B: any, code: string) {
  const a = await req(s.base, "POST", "/v1/face-rooms/join", tok(A), { code, bots: [A.bot.id] });
  const b = await req(s.base, "POST", "/v1/face-rooms/join", tok(B), { code, bots: [B.bot.id] });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.equal(a.body.room_id, b.body.room_id);
  return a.body.room_id as string;
}

test("P23 (a): the UI-shaped block by relationship_id also closes the pair's room door", async (t) => {
  const s = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  t.after(s.stop);
  const { A, B, relId } = await friends(s.base);
  const roomId = await sharedRoom(s, A, B, "737373");
  custody(s, A);
  custody(s, B);

  // The door works before the block, so the red below is about the block and not about the room setup.
  const before = await send(s.base, B, B.bot.id, A.handle, "in the room", roomId);
  assert.equal(before.status, 202, JSON.stringify(before.body));
  assert.equal(before.body.message.status, "delivered");
  assert.equal((await received(s, A)).length, 1);

  // What the Block button in public/ui.js and scripts/botctl.ts send: the friendship's id, not the Bot id.
  const blocked = await req(s.base, "POST", "/v1/blocks", tok(A), { relationship_id: relId });
  assert.equal(blocked.status, 200, JSON.stringify(blocked.body));
  assert.equal(blocked.body.status, "blocked");
  assert.equal(blocked.body.relationship_id, relId, "the shape of the answer is unchanged");
  assert.deepEqual(pairRows(s, A.bot.id, B.bot.id).filter((x: string) => x !== "blocked"), [], "no live row is left between the pair");

  // The friendship is no longer live: the pair's row reads back blocked, and the friend list is empty.
  const rels = await req(s.base, "GET", "/v1/relationships", tok(A));
  const row = rels.body.relationships.find((r: any) => r.relationship_id === relId);
  assert.equal(row.status, "blocked");
  assert.equal(row.blocked_by_me, true);
  const friendList = await req(s.base, "GET", "/v1/friends", tok(A));
  assert.deepEqual(friendList.body.friends, [], "the friendship is gone from the friend list");

  const after = await send(s.base, B, B.bot.id, A.handle, "blocked but in the room", roomId);
  assert.equal(after.status, 403, JSON.stringify(after.body));
  assert.equal(after.body.code, "room_not_shared");
  assert.equal((await received(s, A)).length, 1, "nothing reached the blocked side");
});

test("P23 (b): a whole-pair block survives a leave and a re-join with the same code", async (t) => {
  const s = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const roomId = await sharedRoom(s, A, B, "747474");
  custody(s, A);
  custody(s, B);
  assert.deepEqual(pairRows(s, A.bot.id, B.bot.id).sort(), ["active", "room"], "the room wrote its own row");

  const blocked = await req(s.base, "POST", "/v1/blocks", tok(A), { bot_id: B.bot.id });
  assert.equal(blocked.body.status, "blocked");

  // The block already handed back the seat this leave was written for, so the leave door answers the blocked Bot
  // the way it answers any Bot that is not in the room: 404 `face_room_not_found`. The door under test below is
  // the number door, with the seat already gone.
  const left = await req(s.base, "POST", `/v1/face-rooms/${roomId}/leave`, tok(B), {});
  assert.equal(left.status, 404, JSON.stringify(left.body));
  assert.equal(left.body.code, "face_room_not_found");
  assert.equal(seats(s, roomId, B.bot.id), 0, "the block took the seat before the leave could end it");

  // The number the 6-digit door answers with `code_void`: a room whose window is over while its mapping is still
  // there. Produced here from a second room so the blocked re-join can be compared with the real refusal.
  const C = await ownerWithBot(s.base, "carl");
  assert.equal((await req(s.base, "POST", "/v1/face-rooms/join", tok(C), { code: "818181", bots: [C.bot.id] })).status, 200);
  s.platform.db.prepare("UPDATE face_rooms SET status = 'closed' WHERE code = ?").run("818181");
  const dead = await req(s.base, "POST", "/v1/face-rooms/join", tok(C), { code: "818181", bots: [C.bot.id] });
  assert.equal(dead.status, 409, JSON.stringify(dead.body));
  assert.equal(dead.body.code, "code_void");

  // Re-joining the same room with the same code used to write a fresh room row and grants for the blocked pair,
  // handing the door straight back.
  const again = await req(s.base, "POST", "/v1/face-rooms/join", tok(B), { code: "747474", bots: [B.bot.id] });
  assert.equal(again.status, dead.status, "refused, not a silent success");
  assert.equal(again.body.code, dead.body.code, "the answer is the door's own dead-number one");
  assert.equal(again.body.message, dead.body.message);
  assert.equal(attempts(s, "747474").outcome, "code_void", "booked as the same failure, not as a new one");
  assert.equal((s.platform.db.prepare("SELECT COUNT(*) n FROM face_room_attempts WHERE outcome = 'blocked'").get() as any).n, 0, "no attempt outcome is invented for a block");
  assert.equal(seats(s, roomId, B.bot.id), 0, "no seat is written");
  assert.equal(pairRows(s, A.bot.id, B.bot.id).includes("room"), false, "the re-join writes no room door for a blocked pair");

  const after = await send(s.base, B, B.bot.id, A.handle, "re-joined, still blocked", roomId);
  assert.equal(after.status, 403, JSON.stringify(after.body));
  assert.equal(after.body.code, "room_not_shared");
  assert.equal((await received(s, A)).length, 0, "the blocked side's re-join delivered nothing");
});

test("P23 (c): without a block the room door still delivers both ways", async (t) => {
  const s = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const roomId = await sharedRoom(s, A, B, "757575");
  custody(s, A);
  custody(s, B);

  const fromB = await send(s.base, B, B.bot.id, A.handle, "hello", roomId);
  assert.equal(fromB.status, 202, JSON.stringify(fromB.body));
  assert.equal(fromB.body.message.status, "delivered");
  const fromA = await send(s.base, A, A.bot.id, B.handle, "hello back", roomId);
  assert.equal(fromA.status, 202, JSON.stringify(fromA.body));
  assert.equal(fromA.body.message.status, "delivered");
  assert.equal((await received(s, A)).length, 1);
  assert.equal((await received(s, B)).length, 1);
  assert.deepEqual(pairRows(s, A.bot.id, B.bot.id).sort(), ["active", "room"], "an unblocked pair keeps its rows");
});

test("P23 (d): a pair blocked before this fix cannot still send through its old room row", async (t) => {
  const s = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  t.after(s.stop);
  const { A, B, relId } = await friends(s.base);
  const roomId = await sharedRoom(s, A, B, "767676");
  custody(s, A);
  custody(s, B);

  // The state an older block left behind: the friendship row is blocked, the room row and its grants are untouched.
  s.platform.db.prepare("UPDATE relationships SET status = 'blocked', blocked_by = ? WHERE id = ?").run(A.owner_id, relId);
  assert.deepEqual(pairRows(s, A.bot.id, B.bot.id).sort(), ["blocked", "room"], "the legacy shape");

  const after = await send(s.base, B, B.bot.id, A.handle, "old block, old door", roomId);
  assert.equal(after.status, 403, JSON.stringify(after.body));
  assert.equal(after.body.code, "room_not_shared");
  assert.equal((await received(s, A)).length, 0, "the old door stays shut");
});

test("P23 (e): a blocked pair cannot re-claim a local-room ticket for the same room", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const ROOM = "war-71"; // a FlyBot local room id: no face_rooms row
  custody(s, A);
  custody(s, B);

  const mint = await req(s.base, "POST", "/v1/local-room-invites", tok(A), { room_id: ROOM, bot_id: A.bot.id });
  assert.equal(mint.status, 201, JSON.stringify(mint.body));
  const ticket = mint.body.ticket as string;
  assert.equal((await req(s.base, "POST", `/v1/local-room-invites/${ticket}/claim`, tok(B), { bots: [B.bot.id] })).status, 200);
  assert.equal((await send(s.base, B, B.bot.id, A.handle, "in", ROOM)).body.message.status, "delivered");

  const blocked = await req(s.base, "POST", "/v1/blocks", tok(A), { bot_id: B.bot.id });
  assert.equal(blocked.body.status, "blocked");
  // The block closes the room door, not the seat: the claim is still held (it is given back here only to replay
  // the "leave and come back with the same link" path below).
  assert.equal((s.platform.db.prepare("SELECT COUNT(*) n FROM local_room_invite_claims WHERE ticket = ? AND owner_id = ? AND released_at IS NULL").get(ticket, B.owner_id) as any).n, 1, "the block does not give the claim back");
  assert.equal((await req(s.base, "DELETE", `/v1/local-room-invites/${ticket}`, tok(B))).status, 204);

  // What this door answers for a link that is not there for the caller, to compare the blocked claim with.
  const gone = await req(s.base, "POST", "/v1/local-room-invites/Zx90123456789abc/claim", tok(B), { bots: [B.bot.id] });
  assert.equal(gone.status, 404, JSON.stringify(gone.body));
  assert.equal(gone.body.code, "invite_not_found");

  const again = await req(s.base, "POST", `/v1/local-room-invites/${ticket}/claim`, tok(B), { bots: [B.bot.id] });
  assert.equal(again.status, gone.status, JSON.stringify(again.body));
  assert.equal(again.body.code, gone.body.code);
  assert.equal(again.body.message, gone.body.message);
  assert.equal(pairRows(s, A.bot.id, B.bot.id).includes("room"), false, "no room door is rebuilt");

  const after = await send(s.base, B, B.bot.id, A.handle, "back in", ROOM);
  assert.equal(after.status, 403, JSON.stringify(after.body));
  assert.equal(after.body.code, "room_not_shared");
  assert.equal((await received(s, A)).length, 1, "only the line sent before the block arrived");
});

test("P23 (f): a blocked pair cannot re-enter the room through its ticket", async (t) => {
  const s = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const roomId = await sharedRoom(s, A, B, "787878");
  custody(s, A);
  custody(s, B);
  const minted = await req(s.base, "POST", `/v1/face-rooms/${roomId}/invites`, tok(A));
  assert.equal(minted.status, 201, JSON.stringify(minted.body));
  const ticket = minted.body.ticket as string;
  assert.equal((await send(s.base, B, B.bot.id, A.handle, "in by link", roomId)).body.message.status, "delivered");

  assert.equal((await req(s.base, "POST", "/v1/blocks", tok(A), { bot_id: B.bot.id })).body.status, "blocked");
  const left = await req(s.base, "POST", `/v1/face-rooms/${roomId}/leave`, tok(B), {});
  assert.equal(left.status, 404, JSON.stringify(left.body));
  assert.equal(left.body.code, "face_room_not_found");
  assert.equal(seats(s, roomId, B.bot.id), 0, "the block took the seat before the leave could end it");

  // What the ticket door answers for a link that is not there: mint a second one and drop its row.
  const other = await req(s.base, "POST", `/v1/face-rooms/${roomId}/invites`, tok(A));
  assert.equal(other.status, 201, JSON.stringify(other.body));
  const C = await ownerWithBot(s.base, "dora");
  s.platform.db.prepare("DELETE FROM face_room_invites WHERE ticket = ?").run(other.body.ticket);
  const gone = await req(s.base, "POST", "/v1/face-rooms/join-invite", tok(C), { ticket: other.body.ticket, bots: [C.bot.id] });
  assert.equal(gone.status, 404, JSON.stringify(gone.body));
  assert.equal(gone.body.code, "invite_not_found");

  const again = await req(s.base, "POST", "/v1/face-rooms/join-invite", tok(B), { ticket, bots: [B.bot.id] });
  assert.equal(again.status, gone.status, JSON.stringify(again.body));
  assert.equal(again.body.code, gone.body.code, "the answer is the door's own missing-link one");
  assert.equal(again.body.message, gone.body.message);
  assert.equal(attempts(s, "invite").outcome, "invite_not_found", "booked as the same failure, not as a new one");
  assert.equal((s.platform.db.prepare("SELECT COUNT(*) n FROM face_room_attempts WHERE outcome = 'blocked'").get() as any).n, 0, "no attempt outcome is invented for a block");
  assert.equal(seats(s, roomId, B.bot.id), 0, "no seat is written");
  assert.equal(pairRows(s, A.bot.id, B.bot.id).includes("room"), false, "the ticket writes no room door for a blocked pair");

  const after = await send(s.base, B, B.bot.id, A.handle, "back by link, still blocked", roomId);
  assert.equal(after.status, 403, JSON.stringify(after.body));
  assert.equal(after.body.code, "room_not_shared");
  assert.equal((await received(s, A)).length, 1, "only the line sent before the block arrived");
});

test("P23 (g): a block ends the blocked Bot's seat and the door, and the number is dead to it", async (t) => {
  const s = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const roomId = await sharedRoom(s, A, B, "797979");
  custody(s, A);
  custody(s, B);

  assert.equal((await req(s.base, "POST", "/v1/blocks", tok(A), { bot_id: B.bot.id })).body.status, "blocked");
  // The seat goes with the block: the read and message doors only ask whether the caller still holds one, so a
  // seat left behind was the door. The owner who blocked keeps its own seat and the room.
  assert.equal(seats(s, roomId, B.bot.id), 0, "the block ends the blocked Bot's seat");
  assert.equal(seats(s, roomId, A.bot.id), 1, "the owner who blocked keeps its seat");

  // With no seat, re-entering with the same number is the same refusal the number door gives a pair that never
  // re-entered: `409 code_void`, nothing seated, nothing sent.
  const again = await req(s.base, "POST", "/v1/face-rooms/join", tok(B), { code: "797979", bots: [B.bot.id] });
  assert.equal(again.status, 409, JSON.stringify(again.body));
  assert.equal(again.body.code, "code_void");
  assert.equal(seats(s, roomId, B.bot.id), 0, "no seat is written by the refused re-join");
  assert.equal((await received(s, A)).length, 0, "re-entering sends nothing");

  // The door stays shut all the same.
  const after = await send(s.base, B, B.bot.id, A.handle, "seated but blocked", roomId);
  assert.equal(after.status, 403, JSON.stringify(after.body));
  assert.equal(after.body.code, "room_not_shared");
});
