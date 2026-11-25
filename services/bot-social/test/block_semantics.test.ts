import assert from "node:assert/strict";
import { test } from "node:test";
import { expectApiError, friends, ownerWithBot, startServer } from "./helpers.js";

test("blocking a Bot ends the friendship even when a newer room row exists", async (t) => {
  const s = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  t.after(s.stop);
  const { A, B } = await friends(s.base);

  // Sharing a face room writes a room relationship after the friendship. Blocking the Bot used to act on
  // whichever row was newest, so it blocked the room and left the friendship active.
  const a = await A.owner.req("POST", "/v1/face-rooms/join", { code: "987654", bots: [A.bot.id] });
  const b = await B.owner.req("POST", "/v1/face-rooms/join", { code: "987654", bots: [B.bot.id] });
  assert.equal(a.room_id, b.room_id);

  const blocked = await A.owner.req("POST", "/v1/blocks", { bot_id: B.bot.id });
  assert.equal(blocked.status, "blocked");

  const after = await A.owner.req("GET", "/v1/friends");
  assert.deepEqual(after.friends, [], "the friendship must not survive a block");
  await expectApiError(B.owner.req("POST", "/v1/relationships", { from_bot_id: B.bot.id, target_handle: A.handle }), 403, "blocked");
});

test("grant_bot_to_friend cannot create a fresh relationship around a blocked Bot pair", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ada");
  const B = await ownerWithBot(s.base, "ben");
  const second = await A.owner.req("POST", "/v1/bots", { handle: `${A.handle.replace(/^@/, "").replace(".bot", "")}-two.bot`, display_name: "Second" });

  // A2 and B are friends; A1 and B are blocked. The owner shortcut must not use the A2 friendship to
  // open an active A1-B relationship that the blocked pair already refused.
  await A.owner.req("POST", "/v1/relationships", { from_bot_id: second.bot_id, target_handle: B.handle });
  const list = await B.owner.req("GET", "/v1/relationships");
  const pending = list.relationships.find((r: any) => r.peer.handle === A.handle || r.peer.bot_id === second.bot_id);
  assert.ok(pending, "the friend request is visible to B");
  await B.owner.req("POST", `/v1/relationships/${pending.relationship_id}/consent`, { decision: "accept" });

  await A.owner.req("POST", "/v1/blocks", { bot_id: B.bot.id, my_bot_id: A.bot.id });
  await expectApiError(A.owner.req("POST", `/v1/bots/${A.bot.id}/grants`, { friend_bot_id: B.bot.id }), 403, "blocked");
});
