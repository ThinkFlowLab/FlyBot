import assert from "node:assert/strict";
import { test } from "node:test";
import { expectApiError, friends, startServer } from "./helpers.js";

/**
 * Bringing a friend's Bot into a face room is a chat act: it seats the pair and `ensurePairRoomGrant` writes the
 * room-scoped pair grants back with `DEFAULT_CAPABILITIES` (which include chat.public). So a friend who took back
 * the chat.public share of their Bot must not be able to be brought in on the profile/freebusy rows that are left —
 * otherwise the join hands the withdrawn speaking capability back as a room grant.
 */
test("a taken-back chat share does not let its holder bring the Bot into a face room", async (t) => {
  const s = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  t.after(s.stop);
  const { A, B, relId } = await friends(s.base, { freebusy: true });
  const count = (sql: string) => (s.platform.db.prepare(sql).get() as any).n as number;

  // Bob takes back the chat.public half of his share of Bob.bot. The other rows of that share stay: profile.read and
  // the freebusy window Alice asked for.
  const bobView = (await B.owner.req("GET", "/v1/relationships")).relationships.find((r: any) => r.relationship_id === relId);
  const chatShare = bobView.capabilities.peer_on_me.find((g: any) => g.capability === "chat.public");
  assert.ok(chatShare, "Bob shares Bob.bot's chat before it is taken back");
  await B.owner.req("DELETE", `/v1/grants/${chatShare.grant_id}`);

  const aliceView = (await A.owner.req("GET", "/v1/relationships")).relationships.find((r: any) => r.relationship_id === relId);
  assert.deepEqual(
    aliceView.capabilities.me_on_peer.map((g: any) => g.capability).sort(),
    ["calendar.freebusy.read", "profile.read"],
    "only profile.read and freebusy are left on Alice's side of the friendship",
  );

  // Bringing Bob.bot is refused as if Bob's Bot were not shared at all, and the refusal writes nothing: no room, no
  // seat, no room grant, no room event.
  await expectApiError(A.owner.req("POST", "/v1/face-rooms/join", { code: "246810", bots: [A.bot.id, B.bot.id] }), 404, "bot_not_found");
  assert.equal(count("SELECT COUNT(*) AS n FROM face_rooms"), 0, "no room was opened");
  assert.equal(count("SELECT COUNT(*) AS n FROM face_room_members"), 0, "no seat was taken");
  assert.equal(count("SELECT COUNT(*) AS n FROM grants WHERE room_id IS NOT NULL"), 0, "no room grant was written back");
  assert.equal(count("SELECT COUNT(*) AS n FROM face_room_events"), 0, "no room event was written");
});

test("a live chat share still lets its holder bring the Bot into a face room", async (t) => {
  const s = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  t.after(s.stop);
  const { A, B } = await friends(s.base);

  const joined = await A.owner.req("POST", "/v1/face-rooms/join", { code: "246811", bots: [A.bot.id, B.bot.id] });
  const view = await A.owner.req("GET", `/v1/face-rooms/${joined.room_id}`);
  assert.ok(view.members.some((m: any) => m.bot_id === A.bot.id), "Alice's Bot is seated");
  assert.ok(view.members.some((m: any) => m.bot_id === B.bot.id), "Bob's Bot, brought on the live chat share, is seated");
});
