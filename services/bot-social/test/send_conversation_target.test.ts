// The console's chat page shows one conversation and reads it back after a send, but the owner send route
// (`POST /v1/homes/:id/send`) had no way to name that conversation: `sendAsMember` always reused the pair's
// newest conversation whose status is open/awaiting_approval, or opened a new one. So a line typed while
// reading an older thread landed in the newest one — the re-read of the page on screen showed nothing, and
// the 202 said it had been accepted. These tests pin the named target: with `conversation_id` the write goes
// to that conversation or is refused whole (404 when it is not this pair's, 409 when it is not sendable),
// never to the newest one and never into a new one; without it the old behaviour stays exactly as it was.
import assert from "node:assert/strict";
import { test } from "node:test";
import { expectApiError, friends, startServer } from "./helpers.js";

/** The platform holds this Bot's key, so its owner may write through the console's owner-typed route. */
const holdKey = (s: any, o: any) => s.platform.enableCustody({ kind: "owner" as const, ownerId: o.owner_id }, o.bot.id, { private_key_pem: o.kp.privateKeyPem });

/** The owner's own credential, sent the way the console sends it (the owner's home route, body only). */
async function ownerSend(A: any, body: Record<string, unknown>) {
  const me = await A.owner.req("GET", "/v1/me");
  return A.owner.req("POST", `/v1/homes/${encodeURIComponent(me.home || A.bot.id)}/send`, body);
}

/** Two friends whose Bots already have two open conversations; the second one is the newest.
 *  The platform holds every outbound line for approval, so each thread's line is approved and delivered —
 *  both threads are really readable chats with history, not empty shells. */
async function pairWithTwoChats(s: any) {
  const { A, B } = await friends(s.base);
  holdKey(s, A);
  const first = await B.bot.startConversation(A.bot.id, { type: "general_chat", summary: "First thread" });
  const firstDraft = await B.bot.draftMessage(first.conversation_id, { text: "the first thread has a message" });
  await B.owner.req("POST", `/v1/approvals/${firstDraft.approval_id}/decision`, { decision: "approved" });
  const second = await B.bot.startConversation(A.bot.id, { type: "general_chat", summary: "Second thread" });
  const secondDraft = await B.bot.draftMessage(second.conversation_id, { text: "the second thread is newer" });
  await B.owner.req("POST", `/v1/approvals/${secondDraft.approval_id}/decision`, { decision: "approved" });
  return { A, B, c1: first.conversation_id as string, c2: second.conversation_id as string };
}

/** What the owner's console reads: the lines in one conversation, oldest first. */
async function lines(A: any, conversationId: string) {
  const c = await A.owner.req("GET", `/v1/conversations/${conversationId}`);
  return c.messages as any[];
}

test("a send that names a conversation writes there, not into the pair's newest one", async () => {
  const s = await startServer();
  try {
    const { A, B, c1, c2 } = await pairWithTwoChats(s);
    const before1 = (await lines(A, c1)).length, before2 = (await lines(A, c2)).length;
    const r = await ownerSend(A, { from_bot_id: A.bot.id, to: B.bot.id, text: "this belongs to the thread on screen", typed_by_owner: true, conversation_id: c1 });
    assert.equal(r.conversation_id, c1, "the 202 names the conversation it wrote into");
    const after1 = await lines(A, c1), after2 = await lines(A, c2);
    assert.equal(after1.length, before1 + 1, "the named conversation gained exactly one line");
    assert.equal(after2.length, before2, "the newer conversation gained none");
    const mine = after1.find((m: any) => m.direction === "outbound" && m.content?.text === "this belongs to the thread on screen");
    assert.ok(mine, "the owner's line is in the named conversation");
    assert.equal(mine.status, "delivered", "and it was delivered, not left behind");
    assert.equal(mine.typed_by_owner, true, "still marked as the owner's own words");
  } finally { await s.stop(); }
});

test("a named conversation that is closed is refused with 409 and nothing is written anywhere", async () => {
  const s = await startServer();
  try {
    const { A, B, c1, c2 } = await pairWithTwoChats(s);
    await B.bot.close(c1, "abandoned");
    const before1 = (await lines(A, c1)).length, before2 = (await lines(A, c2)).length;
    const conversationsBefore = (await A.owner.req("GET", "/v1/conversations")).conversations.length;
    const err = await expectApiError(
      ownerSend(A, { from_bot_id: A.bot.id, to: B.bot.id, text: "too late for that thread", typed_by_owner: true, conversation_id: c1 }),
      409,
      "conversation_closed",
    );
    assert.match(err.message, /closed/, "the refusal says the conversation is closed");
    assert.equal((await lines(A, c1)).length, before1, "the closed conversation gained nothing");
    assert.equal((await lines(A, c2)).length, before2, "and the line did not fall through to the newest open conversation");
    assert.equal((await A.owner.req("GET", "/v1/conversations")).conversations.length, conversationsBefore,
      "a refused send never opens a new conversation");
  } finally { await s.stop(); }
});

test("a named conversation of another pair is refused with 404 and nothing is written anywhere", async () => {
  const s = await startServer();
  try {
    const { A, B, c2 } = await pairWithTwoChats(s);
    // A different pair with a perfectly open conversation: naming it must not let one owner write into it.
    const other = await friends(s.base);
    const elsewhere = await other.B.bot.startConversation(other.A.bot.id, { type: "general_chat", summary: "Not ours" });
    await other.B.bot.draftMessage(elsewhere.conversation_id, { text: "a message in someone else's thread" });
    const foreignId = elsewhere.conversation_id as string;
    const foreignBefore = (await other.A.owner.req("GET", `/v1/conversations/${foreignId}`)).messages.length;
    const ownBefore = (await lines(A, c2)).length;
    const err = await expectApiError(
      ownerSend(A, { from_bot_id: A.bot.id, to: B.bot.id, text: "not for that thread", typed_by_owner: true, conversation_id: foreignId }),
      404,
      "conversation_not_found",
    );
    assert.match(err.message, /conversation/, "the refusal names what was not found");
    assert.equal((await other.A.owner.req("GET", `/v1/conversations/${foreignId}`)).messages.length, foreignBefore,
      "the other pair's conversation gained nothing");
    assert.equal((await lines(A, c2)).length, ownBefore,
      "and the line did not fall through to this pair's newest open conversation");
  } finally { await s.stop(); }
});

test("an unknown conversation id is a 404, never a fresh conversation", async () => {
  const s = await startServer();
  try {
    const { A, B } = await pairWithTwoChats(s);
    const conversationsBefore = (await A.owner.req("GET", "/v1/conversations")).conversations.length;
    await expectApiError(
      ownerSend(A, { from_bot_id: A.bot.id, to: B.bot.id, text: "nowhere", typed_by_owner: true, conversation_id: "cnv_does_not_exist" }),
      404,
      "conversation_not_found",
    );
    assert.equal((await A.owner.req("GET", "/v1/conversations")).conversations.length, conversationsBefore,
      "no conversation was opened for the refused send");
  } finally { await s.stop(); }
});

test("without a conversation id the old route is unchanged: the newest open conversation is reused", async () => {
  const s = await startServer();
  try {
    const { A, B, c1, c2 } = await pairWithTwoChats(s);
    const before1 = (await lines(A, c1)).length;
    const r = await ownerSend(A, { from_bot_id: A.bot.id, to: B.bot.id, text: "a bot-style send with no target", typed_by_owner: true });
    assert.equal(r.conversation_id, c2, "the pair's newest open conversation is the one the old route picks");
    assert.equal((await lines(A, c1)).length, before1, "the older conversation is untouched");
    assert.equal((await lines(A, c2)).length, 2, "the newest conversation carries the original line plus this one");
  } finally { await s.stop(); }
});

/** Two FlyBot local rooms the same pair shares, each with its own room conversation — the shape of a pair that
 *  met in two rooms: one `room` relationship and one open conversation per room. */
async function pairWithTwoRooms(s: any) {
  const { A, B } = await friends(s.base);
  holdKey(s, A);
  holdKey(s, B);
  const rooms: { room_id: string; conversation_id: string }[] = [];
  for (const room of ["war-thread-one", "war-thread-two"]) {
    const invite = await A.owner.req("POST", "/v1/local-room-invites", { room_id: room, bot_id: A.bot.id });
    await B.owner.req("POST", `/v1/local-room-invites/${invite.ticket}/claim`, { bots: [B.bot.id] });
    const sent = await ownerSend(A, { from_bot_id: A.bot.id, to: B.bot.id, text: `the line in ${room}`, room_id: room });
    assert.equal(sent.message.status, "delivered", `the room send in ${room} was delivered`);
    rooms.push({ room_id: room, conversation_id: sent.conversation_id as string });
  }
  return { A, B, rooms };
}

test("a conversation opened in another room is refused with 404 under this room's door and nothing is written", async () => {
  const s = await startServer();
  try {
    const { A, B, rooms } = await pairWithTwoRooms(s);
    const [one, two] = rooms;
    const beforeOne = (await lines(A, one.conversation_id)).length;
    const beforeTwo = (await lines(A, two.conversation_id)).length;
    const conversationsBefore = (await A.owner.req("GET", "/v1/conversations")).conversations.length;
    const err = await expectApiError(
      ownerSend(A, { from_bot_id: A.bot.id, to: B.bot.id, text: "this belongs to the other room", typed_by_owner: true, room_id: one.room_id, conversation_id: two.conversation_id }),
      404,
      "conversation_not_found",
    );
    assert.match(err.message, /conversation/, "the refusal reads like the one an unknown id gets");
    assert.equal((await lines(A, two.conversation_id)).length, beforeTwo, "the other room's thread gained nothing");
    assert.equal((await lines(A, one.conversation_id)).length, beforeOne, "this room's own thread gained nothing either");
    assert.equal((await A.owner.req("GET", "/v1/conversations")).conversations.length, conversationsBefore,
      "a refused send never opens a conversation");
  } finally { await s.stop(); }
});

test("a room conversation named on the 1:1 route is refused with 404, never written through the friendship", async () => {
  const s = await startServer();
  try {
    const { A, B, rooms } = await pairWithTwoRooms(s);
    const [one] = rooms;
    const before = (await lines(A, one.conversation_id)).length;
    const conversationsBefore = (await A.owner.req("GET", "/v1/conversations")).conversations.length;
    await expectApiError(
      ownerSend(A, { from_bot_id: A.bot.id, to: B.bot.id, text: "into the room thread from the 1:1 page", typed_by_owner: true, conversation_id: one.conversation_id }),
      404,
      "conversation_not_found",
    );
    assert.equal((await lines(A, one.conversation_id)).length, before, "the room thread gained nothing");
    assert.equal((await A.owner.req("GET", "/v1/conversations")).conversations.length, conversationsBefore,
      "no 1:1 conversation was opened instead");
  } finally { await s.stop(); }
});

test("a room conversation named under its own room's door still takes the line", async () => {
  const s = await startServer();
  try {
    const { A, B, rooms } = await pairWithTwoRooms(s);
    const [one] = rooms;
    const before = (await lines(A, one.conversation_id)).length;
    const r = await ownerSend(A, { from_bot_id: A.bot.id, to: B.bot.id, text: "the same room, still allowed", typed_by_owner: true, room_id: one.room_id, conversation_id: one.conversation_id });
    assert.equal(r.conversation_id, one.conversation_id, "the 202 names the room's conversation");
    const after = await lines(A, one.conversation_id);
    assert.equal(after.length, before + 1, "the room conversation gained exactly one line");
    const mine = after.find((m: any) => m.direction === "outbound" && m.content?.text === "the same room, still allowed");
    assert.ok(mine, "the line is in the room conversation it named");
    assert.equal(mine.status, "delivered", "and it was delivered");
  } finally { await s.stop(); }
});

test("a 1:1 conversation is still written when the pair also shares a room", async () => {
  const s = await startServer();
  try {
    const { A, B, rooms } = await pairWithTwoRooms(s);
    const c = await B.bot.startConversation(A.bot.id, { type: "general_chat", summary: "The 1:1 thread" });
    const c1 = c.conversation_id as string;
    const before = (await lines(A, c1)).length;
    const roomBefore = (await lines(A, rooms[0].conversation_id)).length;
    const r = await ownerSend(A, { from_bot_id: A.bot.id, to: B.bot.id, text: "from the 1:1 page", typed_by_owner: true, conversation_id: c1 });
    assert.equal(r.conversation_id, c1, "the 202 names the 1:1 conversation");
    assert.equal((await lines(A, c1)).length, before + 1, "the 1:1 conversation gained exactly one line");
    assert.equal((await lines(A, rooms[0].conversation_id)).length, roomBefore, "no room thread gained anything");
  } finally { await s.stop(); }
});
