// P32: a share that lapses by TIME must give back what revoking it gives back.
//
// `revokeGrant` / `revokeBotGrant` / `declineBotGrant` all end the rooms where the grant was used
// (`endGrantRooms`, src/platform.ts:1564/1591/1630). `grant_rooms` exists for exactly that: it records the face
// rooms a per-bot share put the shared Bot into (`syncFaceRoomAccess` -> `recordGrantRoomUse`). No expiry path
// reads it: `expireStale` sweeps relationships and approvals only, and `grantsFor` / `findGrant` write a lapsed row
// back to `status='expired'` and nothing else.
//
// So a share that runs out on its own clock (every friendship's default per-bot bundle: 90 days) keeps the guest
// seat it created, keeps the room-scoped grants that seat wrote (they never expire), and keeps the room door open
// between two Bots whose share the granting owner sees as `expired`. Revoking the same row closes all of it.
//
// These tests drive the real routes. Time is moved the way the rest of the suite moves it: the row's `expires_at`
// is rewritten in the past, because a 90-day wait is not a test.
import assert from "node:assert/strict";
import { test } from "node:test";
import { expectApiError, friends, ownerWithBot, startServer } from "./helpers.js";

const past = () => new Date(Date.now() - 3600e3).toISOString();

/** Every non-room grant owner A gave B's Bot: the per-bot share a friendship starts with. */
const lapseShare = (S: any, grantorOwner: string, granteeBot: string) =>
  S.platform.db.prepare("UPDATE grants SET expires_at = ? WHERE grantor_owner = ? AND grantee_bot = ? AND room_id IS NULL AND status = 'active'")
    .run(past(), grantorOwner, granteeBot);

const memberIds = (room: any) => room.members.map((m: any) => m.bot_id);

test("a lapsed share takes the guest seat it made out of the room", async () => {
  const S = await startServer();
  try {
    const { A, B } = await friends(S.base);
    // B enters a 6-digit number and brings its own Bot and A's Bot. Bringing another owner's Bot is allowed only
    // through a full per-bot share (faceBotsToBring -> accessGrantTo), and the friendship's default bundle is one.
    const room = await B.owner.req("POST", "/v1/face-rooms/join", { code: "482915", bots: [B.bot.id, A.bot.id] });
    assert.deepEqual([...memberIds(room)].sort(), [A.bot.id, B.bot.id].sort(), "both Bots are seated");

    // Control: while the share is live, A reads the room it was brought into and may answer in it.
    const live = await A.owner.req("GET", `/v1/face-rooms/${room.room_id}`);
    assert.ok(memberIds(live).includes(A.bot.id), "A's Bot is a member while the share is live");
    const drafted = await A.bot.req("POST", `/v1/face-rooms/${room.room_id}/messages`, { text: "hello from the shared Bot" });
    assert.equal(drafted.status, "pending_approval", "the shared Bot may draft into the room while the share is live");

    lapseShare(S, A.owner_id, B.bot.id);

    // The share is now over: the seat it created goes with it, exactly as `revokeBotGrant` takes it away.
    await expectApiError(A.owner.req("GET", `/v1/face-rooms/${room.room_id}`), 404, "face_room_not_found");
    const listed = await A.owner.req("GET", "/v1/face-rooms");
    assert.deepEqual(listed.rooms.map((r: any) => r.room_id), [], "a lapsed share leaves no room on A's list");
    await expectApiError(A.bot.req("POST", `/v1/face-rooms/${room.room_id}/messages`, { text: "still here?" }), 404, "face_room_not_found");

    // The room is B's, and B seated itself in it: only the seat this share made goes, never the room.
    const hostSide = await B.owner.req("GET", `/v1/face-rooms/${room.room_id}`);
    assert.ok(memberIds(hostSide).includes(B.bot.id), "the host keeps its own seat");
    assert.deepEqual([...memberIds(hostSide)].sort(), [B.bot.id], "the guest seat is the only one taken");
    const hostList = await B.owner.req("GET", "/v1/face-rooms");
    assert.ok(hostList.rooms.some((r: any) => r.room_id === room.room_id), "the room is still on the host's list");
  } finally {
    await S.stop();
  }
});

test("a lapsed share takes only the seats it made: another live share's seats stay", async () => {
  // The over-broad fix this pins down is "every member whose adder is not its owner leaves": that would also take
  // seats paid for by a different, still-live share of a different owner. Two of those exist here: C's Bot seated by
  // B on C's bundle, and A's Bot seated by C on A's bundle.
  const S = await startServer();
  try {
    const { A, B } = await friends(S.base);
    const C = await ownerWithBot(S.base, "qrc");
    const bc = await B.owner.req("POST", "/v1/relationships", { from_bot_id: B.bot.id, target_handle: C.handle, message: "hi", requested_capabilities: ["chat.public"] });
    await C.owner.req("POST", `/v1/relationships/${bc.relationship_id}/consent`, { decision: "accept", grant_capabilities: [] });
    const ca = await C.owner.req("POST", "/v1/relationships", { from_bot_id: C.bot.id, target_handle: A.handle, message: "hi", requested_capabilities: ["chat.public"] });
    await A.owner.req("POST", `/v1/relationships/${ca.relationship_id}/consent`, { decision: "accept", grant_capabilities: [] });

    // B brings C's Bot on C's share; C brings A's Bot on A's share.
    const roomC = await B.owner.req("POST", "/v1/face-rooms/join", { code: "512907", bots: [B.bot.id, C.bot.id] });
    const roomA = await C.owner.req("POST", "/v1/face-rooms/join", { code: "640318", bots: [C.bot.id, A.bot.id] });

    lapseShare(S, A.owner_id, B.bot.id);

    const stillC = await C.owner.req("GET", `/v1/face-rooms/${roomC.room_id}`);
    assert.ok(memberIds(stillC).includes(C.bot.id), "a seat made on another live share is not this share's to take");
    const stillA = await A.owner.req("GET", `/v1/face-rooms/${roomA.room_id}`);
    assert.ok(memberIds(stillA).includes(A.bot.id), "the same Bot's other seat, paid by another share, stays");
  } finally {
    await S.stop();
  }
});

test("a room both owners entered themselves keeps its seats when a share lapses", async () => {
  // The default friendship bundle lapses for every friendship. A room the two owners each seated themselves in was
  // not created by that bundle (`grant_rooms` has no row for it), so it must not be touched.
  const S = await startServer();
  try {
    const { A, B } = await friends(S.base);
    const first = await A.owner.req("POST", "/v1/face-rooms/join", { code: "731420", bots: [A.bot.id] });
    const joined = await B.owner.req("POST", "/v1/face-rooms/join", { code: "731420", bots: [B.bot.id] });
    assert.equal(joined.room_id, first.room_id, "the same number seats both owners in one room");

    lapseShare(S, A.owner_id, B.bot.id);

    const still = await A.owner.req("GET", `/v1/face-rooms/${first.room_id}`);
    assert.deepEqual([...memberIds(still)].sort(), [A.bot.id, B.bot.id].sort(), "both seats stay: neither was made by the share");
    const drafted = await A.bot.req("POST", `/v1/face-rooms/${first.room_id}/messages`, { text: "we are still in this room together" });
    assert.equal(drafted.status, "pending_approval");
  } finally {
    await S.stop();
  }
});

test("a share another reader already flipped to expired still gives its seat back", async () => {
  // A lazy-expiry reader flips a lapsed row to `expired` in place and calls no sweep: one ordinary
  // `GET /v1/conversations/:id` (`effectiveCaps`) does it to both directions of chat.public / profile.read. The
  // face-room sweep must still see such a row — filtering on `active` alone would never release its seat.
  const S = await startServer();
  try {
    const { A, B } = await friends(S.base);
    const room = await B.owner.req("POST", "/v1/face-rooms/join", { code: "318642", bots: [B.bot.id, A.bot.id] });
    const cid = (await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "before the share ends" })).conversation_id;

    lapseShare(S, A.owner_id, B.bot.id);

    const seen = await A.owner.req("GET", `/v1/conversations/${cid}`);
    assert.equal(seen.conversation_id, cid, "the conversation stays readable");
    const flipped = (S.platform.db.prepare("SELECT status FROM grants WHERE grantor_owner = ? AND grantee_bot = ? AND capability = 'chat.public' AND room_id IS NULL").get(A.owner_id, B.bot.id) as any)?.status;
    assert.equal(flipped, "expired", "control: one ordinary GET already flipped the row, and no room sweep ran");

    await expectApiError(A.owner.req("GET", `/v1/face-rooms/${room.room_id}`), 404, "face_room_not_found");
    const members = S.platform.db.prepare("SELECT bot_id FROM face_room_members WHERE room_id = ? AND left_at IS NULL").all(room.room_id) as any[];
    assert.deepEqual(members.map((m) => m.bot_id), [B.bot.id], "the guest seat is released even though the row was pre-flipped");
    const usages = S.platform.db.prepare("SELECT ended_at FROM grant_rooms WHERE room_id = ?").all(room.room_id) as any[];
    assert.ok(usages.length > 0 && usages.every((u) => u.ended_at), "the room usages are ended");
  } finally {
    await S.stop();
  }
});
