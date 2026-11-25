/**
 * A Block ends every relationship row the pair holds and the grants that ride on them, but it leaves the seat the
 * blocked Bot took in a face room behind. The room's read door (`faceRequireMember`) and its message door
 * (`deliverFaceRoomMessage`) only ask whether the caller still holds a seat, so the pair kept reading and writing
 * each other in every room both were seated in, while the friendship itself said `blocked`.
 *
 * `endRelationship` hands only the shares with `room_id IS NULL` to `endGrantRooms`, and even there a seat is given
 * back only when a share paid for it (`grantPaysForSeat`); a seat an owner took for its own Bot belongs to no
 * share and outlived every row the block ended. The block is the moment the pair's door ends, so `block` now hands
 * the blocked Bot's seat in every live room the two Bots still share to the same two calls the room's own leave
 * door makes: `removeFaceMember` then `endRoomGrantsForBots`.
 *
 * Only the blocked Bot's seat ends. The owner who blocked keeps its own seat and the room, so a Block never takes
 * a third member's seat or an unrelated Bot's; a Bot of the same owner that was not blocked, and a third owner in
 * the same room, are the two controls below. Undoing the block does not give the seat back: it is a seat, not a
 * grant, and the pair can only meet again by asking.
 *
 * A seat that ends this way ends the way the leave door ends one: the room writes one `member.left` event naming
 * the Bot and moves its cursor by one, the Bot gets one `face_room.left` item, and the audit row is
 * `face_room.left` with the caller who ended the seat as its actor, the room as its subject and the Bot in its
 * data. The room-scoped grants the seat rode on are revoked with it, so none of the pair's stays active there.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { generateEd25519 } from "../src/crypto.js";
import { BotClient } from "../src/client.js";
import { friends, ownerWithBot, startServer } from "./helpers.js";

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
const botToken = (b: any) => b.cred.token;

const seat = (s: any, roomId: string, botId: string) =>
  s.platform.db.prepare("SELECT * FROM face_room_members WHERE room_id = ? AND bot_id = ?").get(roomId, botId) as any;
const openSeats = (s: any, roomId: string) =>
  (s.platform.db.prepare("SELECT bot_id FROM face_room_members WHERE room_id = ? AND left_at IS NULL ORDER BY bot_id").all(roomId) as any[]).map((m) => m.bot_id);
const roomSeq = (s: any, roomId: string) =>
  (s.platform.db.prepare("SELECT IFNULL(MAX(seq), 0) n FROM face_room_events WHERE room_id = ?").get(roomId) as any).n;
const roomMessages = (s: any, roomId: string) =>
  (s.platform.db.prepare("SELECT COUNT(*) n FROM face_room_events WHERE room_id = ? AND type = 'room.message'").get(roomId) as any).n;
const pendingCards = (s: any, roomId: string) =>
  (s.platform.db.prepare(`SELECT COUNT(*) n FROM approvals a JOIN face_room_drafts d ON d.id = a.subject_id
    WHERE a.kind = 'face_room_message' AND a.status = 'pending_approval' AND d.room_id = ?`).get(roomId) as any).n;
const roomEventsAfter = (s: any, roomId: string, after: number) =>
  s.platform.db.prepare("SELECT seq, type, actor_bot FROM face_room_events WHERE room_id = ? AND seq > ? ORDER BY seq").all(roomId, after) as any[];
const auditAfter = (s: any, after: number) =>
  s.platform.audit.db.prepare("SELECT seq, actor, action, subject, data FROM audit_events WHERE seq > ? ORDER BY seq").all(after) as any[];
const auditSeq = (s: any) =>
  (s.platform.audit.db.prepare("SELECT IFNULL(MAX(seq), 0) n FROM audit_events").get() as any).n;
/** The pair's room-scoped grants still active in this room (either side of the grant). */
const activePairGrants = (s: any, roomId: string, botId: string) =>
  (s.platform.db.prepare(`SELECT COUNT(*) n FROM grants g JOIN relationships r ON r.id = g.relationship_id
    WHERE g.room_id = ? AND g.status = 'active'
      AND (g.grantee_bot = ? OR r.requester_bot = ? OR r.target_bot = ?)`).get(roomId, botId, botId, botId) as any).n;

/** One more Bot for this owner, with its own token, seated in the same room. */
async function secondBot(s: any, o: any) {
  const kp = generateEd25519();
  const made = await o.owner.req("POST", "/v1/bots", {
    handle: `${o.handle.replace(/^@/, "").replace(/\.bot$/, "")}-two.bot`,
    public_key: { alg: "Ed25519", kid: "k1", value: kp.publicKey },
  });
  return new BotClient({ base: s.base, botId: made.bot_id, token: made.bot_token, kid: "k1", privateKeyPem: kp.privateKeyPem });
}

/** Every owner joins one room by the same number; the last answer names it. */
async function sharedRoom(s: any, code: string, ...bots: any[]) {
  let roomId = "";
  for (const b of bots) {
    const r = await req(s.base, "POST", "/v1/face-rooms/join", tok(b), { code, bots: [b.bot.id] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    roomId = r.body.room_id as string;
  }
  return roomId;
}

/** A pair in one room, a third owner in it, and one more Bot of the blocked owner's: the four seats the block sees. */
async function pairInARoom(code: string) {
  const s = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  const { A, B } = await friends(s.base);
  const G = await ownerWithBot(s.base, "gina");
  const extra = await secondBot(s, B);
  const roomId = await sharedRoom(s, code, A, B, G, { owner: B.owner, bot: extra });
  return { s, A, B, G, extra, roomId };
}

test("a block takes back the blocked Bot's seat in the room the pair shared", async (t) => {
  const { s, A, B, G, extra, roomId } = await pairInARoom("838383");
  t.after(s.stop);

  // The door works before the block, so the red below is about the block and not about the room setup.
  assert.equal((await req(s.base, "GET", `/v1/face-rooms/${roomId}`, tok(B))).status, 200, "the blocked side reads the room before the block");
  assert.equal((await req(s.base, "GET", `/v1/face-rooms/${roomId}`, botToken(B.bot))).status, 200);

  const blocked = await req(s.base, "POST", "/v1/blocks", tok(A), { bot_id: B.bot.id });
  assert.equal(blocked.status, 200, JSON.stringify(blocked.body));
  assert.equal(blocked.body.status, "blocked");

  // (a) The seat ends with the block, and the room door answers the Bot as it answers any Bot that is not in it:
  // 404 `face_room_not_found`. Nothing about the block is announced in it.
  assert.ok(seat(s, roomId, B.bot.id).left_at, "the blocked Bot's seat ended with the block");
  const view = await req(s.base, "GET", `/v1/face-rooms/${roomId}`, botToken(B.bot));
  assert.equal(view.status, 404, JSON.stringify(view.body));
  assert.equal(view.body.code, "face_room_not_found");

  // (c) A third owner in the same room is not part of the pair and keeps its seat and its read.
  assert.equal(seat(s, roomId, G.bot.id).left_at, null, "the third owner's seat is not the block's to take");
  const g = await req(s.base, "GET", `/v1/face-rooms/${roomId}`, tok(G));
  assert.equal(g.status, 200, JSON.stringify(g.body));
  assert.ok((g.body.members as any[]).some((m: any) => m.bot_id === G.bot.id), "the third owner is still a member");

  // (d) The blocked owner's other Bot was not blocked, and the owner who blocked keeps its own seat: a block takes
  // the pair's seat on the room door, never the whole room.
  assert.equal(seat(s, roomId, extra.id).left_at, null, "an unblocked Bot of the same owner keeps its seat");
  assert.equal((await req(s.base, "GET", `/v1/face-rooms/${roomId}`, botToken(extra))).status, 200);
  assert.equal(seat(s, roomId, A.bot.id).left_at, null, "the owner who blocked keeps its own seat");
  assert.equal((await req(s.base, "GET", `/v1/face-rooms/${roomId}`, tok(A))).status, 200);
  assert.deepEqual(openSeats(s, roomId).sort(), [A.bot.id, G.bot.id, extra.id].sort(), "exactly one seat ended");
});

test("and the room takes no line from that Bot and hands it none", async (t) => {
  const { s, A, B, G, roomId } = await pairInARoom("848484");
  t.after(s.stop);
  assert.equal((await req(s.base, "POST", "/v1/blocks", tok(A), { bot_id: B.bot.id })).body.status, "blocked");

  const seqBefore = roomSeq(s, roomId);
  const messagesBefore = roomMessages(s, roomId);
  const cardsBefore = pendingCards(s, roomId);

  // (b) The message door goes through the same member check, so a seat that ended writes nothing: no draft, no
  // card, no event, and the room's cursor does not move.
  const refused = await req(s.base, "POST", `/v1/face-rooms/${roomId}/messages`, tok(B), { bot_id: B.bot.id, text: "blocked but still typing" });
  assert.equal(refused.status, 404, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "face_room_not_found");
  assert.equal(pendingCards(s, roomId), cardsBefore, "no card is queued for a line nobody may deliver");
  assert.equal(roomMessages(s, roomId), messagesBefore, "no room.message lands");
  assert.equal(roomSeq(s, roomId), seqBefore, "a refused line moves no cursor");

  // Control: the room itself still works, and the line the remaining members deliver is not handed to the seat
  // that ended.
  const line = "the rest of us are still here";
  const drafted = await req(s.base, "POST", `/v1/face-rooms/${roomId}/messages`, tok(G), { bot_id: G.bot.id, text: line });
  assert.equal(drafted.status, 202, JSON.stringify(drafted.body));
  const decided = await req(s.base, "POST", `/v1/approvals/${drafted.body.approval_id}/decision`, tok(G), { decision: "approved" });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  assert.equal(roomMessages(s, roomId), messagesBefore + 1, "the room still delivers for the members who are in it");

  const handed = ((await B.bot.events()).events as any[]).filter((e) =>
    e.event_type === "face_room.message" && e.room_id === roomId && e.untrusted_content?.text === line);
  assert.deepEqual(handed, [], "the seat that ended is not handed the room's lines");
});

test("undoing the block does not give the seat back", async (t) => {
  const { s, A, B, G, extra, roomId } = await pairInARoom("858585");
  t.after(s.stop);
  const blocked = await req(s.base, "POST", "/v1/blocks", tok(A), { bot_id: B.bot.id });
  assert.equal(blocked.body.status, "blocked");
  const endedAt = seat(s, roomId, B.bot.id).left_at;
  assert.ok(endedAt, "the seat ended with the block");

  const undone = await req(s.base, "POST", `/v1/blocks/${blocked.body.relationship_id}/undo`, tok(A));
  assert.equal(undone.status, 200, JSON.stringify(undone.body));
  assert.equal(undone.body.status, "revoked");

  // A seat is not a grant: the undo takes back the rows, and the pair must ask again before either Bot sits with
  // the other. The unblocked owner's other Bot, the third owner and the blocker keep what they had.
  assert.equal(seat(s, roomId, B.bot.id).left_at, endedAt, "the undo restores no seat");
  assert.equal((await req(s.base, "GET", `/v1/face-rooms/${roomId}`, botToken(B.bot))).status, 404);
  assert.deepEqual(openSeats(s, roomId).sort(), [A.bot.id, G.bot.id, extra.id].sort(), "the other seats are untouched");
});

test("the seat ends the way the leave door ends it, and no grant of the pair stays active", async (t) => {
  const { s, A, B, roomId } = await pairInARoom("868686");
  t.after(s.stop);
  const seqBefore = roomSeq(s, roomId);
  const auditBefore = auditSeq(s);

  assert.equal((await req(s.base, "POST", "/v1/blocks", tok(A), { bot_id: B.bot.id })).body.status, "blocked");

  // The room writes the seat end exactly as the leave door writes it: one `member.left` event naming the Bot whose
  // seat ended, one step forward on the room's cursor, and the same item in that Bot's inbox.
  const fresh = roomEventsAfter(s, roomId, seqBefore);
  assert.deepEqual(fresh.map((e: any) => e.type), ["member.left"], "the seat end is the room's own leave event");
  assert.equal(fresh[0].actor_bot, B.bot.id, "the event names the Bot whose seat ended");
  assert.equal(roomSeq(s, roomId), seqBefore + 1, "the seat end moves the cursor by one");
  const inbox = ((await B.bot.events()).events as any[]).filter((e: any) => e.event_type === "face_room.left" && e.room_id === roomId);
  assert.equal(inbox.length, 1, "the Bot is told its seat ended");

  // The audit trail writes the same row the leave door writes: the caller who ended the seat, the room, the Bot.
  const writes = auditAfter(s, auditBefore).filter((r: any) => r.action === "face_room.left");
  assert.equal(writes.length, 1, "the seat end is written down once");
  assert.equal(writes[0].actor, `owner:${A.owner_id}`, "the caller who blocked is the actor, as on a leave");
  assert.equal(writes[0].subject, roomId, "the room is the subject");
  assert.deepEqual(JSON.parse(writes[0].data), { bots: [B.bot.id] }, "the row names the Bot whose seat ended");

  // Nothing of the pair's stays paid for in this room: the seat and the grants it rode on end together.
  assert.equal(activePairGrants(s, roomId, B.bot.id), 0, "no room-scoped grant of the blocked pair stays active");
});
