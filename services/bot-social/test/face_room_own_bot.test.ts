import assert from "node:assert/strict";
import { test } from "node:test";
import { expectApiError, friends, startServer } from "./helpers.js";

async function broughtRoom(s: any, A: any, B: any, bots: string[]) {
  const joined = await A.owner.req("POST", "/v1/face-rooms/join", { code: "135790", bots });
  assert.equal(joined.room_id, (await B.owner.req("POST", "/v1/face-rooms/join", { code: "135790", bots: [B.bot.id] })).room_id);
  return joined.room_id as string;
}

test("bringing a friend's Bot into a room does not let the bringer speak as it", async (t) => {
  const s = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const roomId = await broughtRoom(s, A, B, [B.bot.id]);

  await expectApiError(A.owner.req("POST", `/v1/face-rooms/${roomId}/messages`, { bot_id: B.bot.id, text: "I am Bob's bot" }), 403, "forbidden");
  const approvals = await B.owner.req("GET", "/v1/approvals?status=pending");
  assert.equal(approvals.approvals.filter((a: any) => a.kind === "face_room_message").length, 0, "nothing was queued for the Bot's owner");
});

test("a room with one brought Bot and one own Bot sends as the own Bot by default", async (t) => {
  const s = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const roomId = await broughtRoom(s, A, B, [B.bot.id, A.bot.id]);
  // The brought Bot joined first, so "first member" used to be Bob's Bot. The default must be Alice's own.
  const sent = await A.owner.req("POST", `/v1/face-rooms/${roomId}/messages`, { text: "hello" });
  assert.equal(sent.status, "pending_approval");
  assert.equal(sent.from.handle, A.handle);
});

test("a bringer cannot set a role label on someone else's Bot", async (t) => {
  const s = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const roomId = await broughtRoom(s, A, B, [B.bot.id]);
  await expectApiError(A.owner.req("PUT", `/v1/face-rooms/${roomId}/roles`, { roles: { [B.bot.id]: "Chief" } }), 404, "bot_not_found");
  const view = await B.owner.req("GET", `/v1/face-rooms/${roomId}`);
  assert.equal(view.members.find((m: any) => m.bot_id === B.bot.id).role, null);
});

test("leaving without a bot list leaves the caller's Bots, not a brought guest", async (t) => {
  const s = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const roomId = await broughtRoom(s, A, B, [B.bot.id, A.bot.id]);
  const left = await A.owner.req("POST", `/v1/face-rooms/${roomId}/leave`, {});
  assert.deepEqual(left.left, [A.handle], "only Alice's Bot leaves");
  const view = await B.owner.req("GET", `/v1/face-rooms/${roomId}`);
  assert.ok(view.members.some((m: any) => m.bot_id === B.bot.id), "Bob's Bot is still in the room");
  assert.ok(!view.members.some((m: any) => m.bot_id === A.bot.id), "Alice's Bot is gone");
});
