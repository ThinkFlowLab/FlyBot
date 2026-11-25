// A share that brought someone else's Bot into a room is not a seat of your own. Once your last Bot leaves,
// that room is not yours to read (docs/FACE_ROOMS.md: "Rooms you currently belong to"; a non-member gets 404),
// even while your guest still sits there. The guard below pins :90: a bringer who never sat keeps the list.
import assert from "node:assert/strict";
import { test } from "node:test";
import { expectApiError, friends, startServer } from "./helpers.js";

async function leaverRoom(t: any) {
  const s = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  // Bob's owner brings Alice's Bot in on the share Alice's owner gave Bob's Bot when they became friends.
  const joined = await B.owner.req("POST", "/v1/face-rooms/join", { code: "919191", bots: [B.bot.id, A.bot.id] });
  return { s, A, B, roomId: joined.room_id as string };
}

test("a room you left is not one you can read, even while your guest still sits in it", async (t) => {
  const { A, B, roomId } = await leaverRoom(t);
  // Alice approves her own room lines, so the line sent after Bob left is really delivered.
  await A.owner.req("PATCH", "/v1/me", { auto_approve_face_rooms: true });
  await B.owner.req("POST", `/v1/face-rooms/${roomId}/leave`, {});
  const sent = await A.owner.req("POST", `/v1/face-rooms/${roomId}/messages`, { text: "after bob left", bot_id: A.bot.id });
  assert.equal(sent.status, "delivered", "the seated guest's line is delivered");

  await expectApiError(B.owner.req("GET", `/v1/face-rooms/${roomId}`), 404, "face_room_not_found");
  // The write door answers the same non-member 404 once no seat of Bob's is left there.
  await expectApiError(B.owner.req("POST", `/v1/face-rooms/${roomId}/messages`, { text: "let me in" }), 404, "face_room_not_found");
});

test("a room you left is not listed among the rooms you currently belong to", async (t) => {
  const { A, B, roomId } = await leaverRoom(t);
  await B.owner.req("POST", `/v1/face-rooms/${roomId}/leave`, {});
  const list = await B.owner.req("GET", "/v1/face-rooms");
  const row = (list.rooms as any[]).find((r: any) => r.room_id === roomId);
  assert.equal(row, undefined, `the room you left is still listed as yours: ${JSON.stringify(row)}`);
  // The guest's own owner still sees the room, with the leave and the guest's presence in it.
  const mine = await A.owner.req("GET", "/v1/face-rooms");
  const kept = (mine.rooms as any[]).find((r: any) => r.room_id === roomId);
  assert.ok(kept, "Alice's Bot still sits there, so the room is still Alice's");
  assert.deepEqual(kept.my_bots.map((b: any) => b.handle), [A.handle]);
});

test("presence in a room you left does not reach you", async (t) => {
  const { A, B, roomId } = await leaverRoom(t);
  await B.owner.req("POST", `/v1/face-rooms/${roomId}/start`, {});
  await B.owner.req("POST", `/v1/face-rooms/${roomId}/leave`, {});
  await A.owner.req("PUT", "/v1/presence", { bot_id: A.bot.id, room_id: roomId, state: "thinking", ttl_seconds: 60 });
  const seen = await B.owner.req("GET", "/v1/presence");
  const leaked = (seen.presence as any[]).filter((p: any) => p.room_id === roomId);
  assert.deepEqual(leaked, [], "a room you left is not a room whose presence you hear");
});

test("a rejoin hands back no line sent while you were gone, though your guest still sits there", async (t) => {
  const { A, B, roomId } = await leaverRoom(t);
  await A.owner.req("PATCH", "/v1/me", { auto_approve_face_rooms: true });
  await B.owner.req("POST", `/v1/face-rooms/${roomId}/leave`, {});
  const sent = await A.owner.req("POST", `/v1/face-rooms/${roomId}/messages`, { text: "after bob left", bot_id: A.bot.id });
  assert.equal(sent.status, "delivered", "the seated guest's line is delivered");

  // The guest Bob brought in still sits there, so the rejoin writes no seat of its own: the answer carries the
  // room, but must not replay what happened while Bob was gone.
  const again = await B.owner.req("POST", "/v1/face-rooms/join", { code: "919191", bots: [A.bot.id] });
  assert.equal(again.room_id, roomId);
  const early = (again.events as any[]).filter((e: any) => e.event_cursor <= sent.event_cursor);
  assert.deepEqual(early, [], `a join repeats events from before it: ${JSON.stringify(early)}`);
});

test("a rejoin that seats nothing new hands back the room and no events at all", async (t) => {
  const s = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  // Alice made the room with her own Bot; Bob joins with his and leaves, so the only seat left is a Bot someone
  // else added. A fallback floor of 1 would dump the whole history of a room Bob cannot even read.
  const made = await A.owner.req("POST", "/v1/face-rooms/join", { code: "828282", bots: [A.bot.id] });
  const roomId = made.room_id as string;
  await B.owner.req("POST", "/v1/face-rooms/join", { code: "828282", bots: [B.bot.id] });
  await A.owner.req("PATCH", "/v1/me", { auto_approve_face_rooms: true });
  await B.owner.req("POST", `/v1/face-rooms/${roomId}/leave`, {});
  await A.owner.req("POST", `/v1/face-rooms/${roomId}/messages`, { text: "after bob left", bot_id: A.bot.id });

  const again = await B.owner.req("POST", "/v1/face-rooms/join", { code: "828282", bots: [A.bot.id] });
  assert.equal(again.room_id, roomId);
  assert.deepEqual(again.events, [], "a join that seats nothing new repeats the room history");
});

test("an owner who only brought a guest in, and never took a seat, can still read the room", async (t) => {
  const s = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  // Bob brings Alice's Bot in and seats no Bot of his own: the seats in the room are all Alice's.
  const joined = await B.owner.req("POST", "/v1/face-rooms/join", { code: "929292", bots: [A.bot.id] });
  const roomId = joined.room_id as string;

  assert.equal((await B.owner.req("GET", `/v1/face-rooms/${roomId}`)).room_id, roomId);
  const listed = await B.owner.req("GET", "/v1/face-rooms");
  const row = (listed.rooms as any[]).find((r: any) => r.room_id === roomId);
  assert.ok(row, "docs/FACE_ROOMS.md:90 keeps the room list readable to the owner who brought the Bot in");
  // A guest is not a seat of the home that brought it: `my_bots` is what this home owns, `brought_bots` what it brought.
  assert.deepEqual(row.my_bots, [], "Bob seats no Bot of his own here");
  assert.deepEqual(row.brought_bots.map((b: any) => b.handle), [A.handle], "the guest Bob brought in stays visible to him");

  await A.owner.req("POST", `/v1/face-rooms/${roomId}/start`, {});
  await A.owner.req("PUT", "/v1/presence", { bot_id: A.bot.id, room_id: roomId, state: "thinking", ttl_seconds: 60 });
  const seen = await B.owner.req("GET", "/v1/presence");
  assert.equal((seen.presence as any[]).filter((p: any) => p.room_id === roomId).length, 1, "the guest's owner brings the room's presence to whoever brought the guest in");
});
