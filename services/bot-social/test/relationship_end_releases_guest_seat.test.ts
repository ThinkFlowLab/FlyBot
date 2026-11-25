import assert from "node:assert/strict";
import { test } from "node:test";
import { friends, ownerWithBot, startServer } from "./helpers.js";

// Bench slot 3: a share pulled A's Bot into B's room. Ending the relationship (unfriend) or blocking must take that
// seat back the way revoking/declining the same share does (`endGrantRooms`), because the seat was made by the grant
// the relationship just revoked. Today `endRelationship` revokes grants and closes chats but never visits
// `grant_rooms`, so the guest keeps the room, its row and its room-scoped grants.
async function seatByShare(t: any, code: string) {
  const s = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  t.after(s.stop);
  const { A, B, relId } = await friends(s.base);
  // B's owner brings A's Bot with the share B holds on it (added_by_owner_id = B, the guest seat case).
  const joined = await B.owner.req("POST", "/v1/face-rooms/join", { code, bots: [B.bot.id, A.bot.id] });
  const roomId = joined.room_id as string;
  const seats = async () => ((await B.owner.req("GET", `/v1/face-rooms/${roomId}`)).members as any[]).map((m: any) => m.bot_id);
  assert.deepEqual((await seats()).sort(), [A.bot.id, B.bot.id].sort(), "control: the share seated A's Bot");
  const seenByA = await A.owner.req("GET", `/v1/face-rooms/${roomId}`);
  assert.ok(seenByA.members.some((m: any) => m.bot_id === A.bot.id), "control: A reads the room through its own Bot's seat");
  const roomGrantsBefore = roomGrantsOf(s, roomId);
  assert.equal(roomGrantsBefore.filter((x) => x.endsWith(":active")).length, roomGrantsBefore.length, "control: the seat wrote live room grants");
  return { s, A, B, relId, roomId, seats, roomGrantsBefore };
}

const roomGrantsOf = (s: any, roomId: string) =>
  (s.platform.db.prepare("SELECT grantee_bot, status FROM grants WHERE room_id = ?").all(roomId) as any[]).map((g) => `${g.grantee_bot}:${g.status}`).sort();
// The revoke paths end a share's room doors with `endRoomGrantsForBots`, which keeps the rows as records and marks
// them `revoked` — it never deletes them. Ending the relationship must land in that same state, so the assertion
// below compares against it by shape rather than asking for an empty table.
const assertRoomGrantsRevoked = (s: any, roomId: string, before: string[]) => {
  const after = roomGrantsOf(s, roomId);
  assert.equal(after.length, before.length, "every room grant the seat wrote is still on record, like after a revoke");
  assert.deepEqual(after.filter((x) => !x.endsWith(":revoked")), [], "each one is revoked, not active and not deleted");
};

test("unfriending releases the guest seat the share made", async (t) => {
  const { s, A, B, relId, roomId, seats, roomGrantsBefore } = await seatByShare(t, "636363");

  await A.owner.req("DELETE", `/v1/relationships/${relId}`);

  // Guards: the room is B's, and B's own seat must survive one pair's breakup.
  const stillThere = await B.owner.req("GET", `/v1/face-rooms/${roomId}`);
  assert.ok(stillThere.members.some((m: any) => m.bot_id === B.bot.id), "B's own Bot keeps its seat");
  assert.equal(stillThere.room_id, roomId, "the room is not torn down by one relationship ending");

  // The seat existed only because the share did.
  assert.deepEqual(await seats(), [B.bot.id], "the guest seat is released");
  await assert.rejects(
    async () => A.owner.req("GET", `/v1/face-rooms/${roomId}`),
    (e: any) => e.status === 404 && e.code === "face_room_not_found",
    "the guest's own owner no longer reads the room",
  );
  assertRoomGrantsRevoked(s, roomId, roomGrantsBefore);
});

test("blocking releases the guest seat the share made", async (t) => {
  const { s, A, B, relId, roomId, seats, roomGrantsBefore } = await seatByShare(t, "646464");

  await A.owner.req("POST", "/v1/blocks", { relationship_id: relId });

  const stillThere = await B.owner.req("GET", `/v1/face-rooms/${roomId}`);
  assert.ok(stillThere.members.some((m: any) => m.bot_id === B.bot.id), "B's own Bot keeps its seat");
  assert.equal(stillThere.room_id, roomId, "the room is not torn down by one relationship ending");

  assert.deepEqual(await seats(), [B.bot.id], "the guest seat is released");
  await assert.rejects(
    async () => A.owner.req("GET", `/v1/face-rooms/${roomId}`),
    (e: any) => e.status === 404 && e.code === "face_room_not_found",
    "the guest's own owner no longer reads the room",
  );
  assertRoomGrantsRevoked(s, roomId, roomGrantsBefore);
});

test("ending one relationship touches no other share's seat and no other pair's room", async (t) => {
  // The over-broad fix this pins down is "take every seat this pair's Bots sit in" (or "end every room grant of the
  // room"): both would take seats paid for by a different, still-live share. Two of those exist here — C's Bot seated
  // in B's room on C's own bundle, and A's Bot seated in C's room on A's own bundle — plus B's own seat.
  const s = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  t.after(s.stop);
  const { A, B, relId } = await friends(s.base);
  const C = await ownerWithBot(s.base, "carol");
  const bc = await B.owner.req("POST", "/v1/relationships", { from_bot_id: B.bot.id, target_handle: C.handle, message: "hi", requested_capabilities: ["chat.public"] });
  await C.owner.req("POST", `/v1/relationships/${bc.relationship_id}/consent`, { decision: "accept", grant_capabilities: [] });
  const ca = await C.owner.req("POST", "/v1/relationships", { from_bot_id: C.bot.id, target_handle: A.handle, message: "hi", requested_capabilities: ["chat.public"] });
  await A.owner.req("POST", `/v1/relationships/${ca.relationship_id}/consent`, { decision: "accept", grant_capabilities: [] });

  const roomB = await B.owner.req("POST", "/v1/face-rooms/join", { code: "752314", bots: [B.bot.id, A.bot.id] });
  // C's Bot joins the same room on C's share; C seats A's Bot in a second room on A's share.
  await B.owner.req("POST", "/v1/face-rooms/join", { code: "752314", bots: [C.bot.id] });
  const roomC = await C.owner.req("POST", "/v1/face-rooms/join", { code: "864209", bots: [C.bot.id, A.bot.id] });
  const membersOf = async (who: any, roomId: string) => ((await who.owner.req("GET", `/v1/face-rooms/${roomId}`)).members as any[]).map((m: any) => m.bot_id).sort();

  await A.owner.req("DELETE", `/v1/relationships/${relId}`);

  // The share that ended gives its seat back...
  assert.ok(!(await membersOf(B, roomB.room_id)).includes(A.bot.id), "the guest seat that share made is released");
  // ...and nothing else moves: the host's seat, C's seat on C's share in the same room, A's Bot's seat in C's room.
  assert.ok((await membersOf(B, roomB.room_id)).includes(B.bot.id), "the host keeps its seat");
  assert.ok((await membersOf(B, roomB.room_id)).includes(C.bot.id), "another live share's seat in the same room stays");
  assert.ok((await membersOf(A, roomC.room_id)).includes(A.bot.id), "the same Bot's seat paid by another share stays");
});
