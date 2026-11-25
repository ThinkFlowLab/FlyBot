// #515: a room's conversation outlives its room. Its door is the room's relationship row, and once the room is
// over that row stops reading `room` — so the owner's console, which reads the thread, shows a composer and names
// the thread on its next line, was answered `404 conversation_not_found` about a chat it had just read. The same
// thread still took the peer's Bot lines on the friendship (#67). These cases replay the issue's HTTP reproduction
// and pin the door: an ended room's thread takes the owner's own line on the friendship the pair still have, a
// live room's thread still does not, the room route is untouched, and a stranger still cannot write into it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { friends, ownerWithBot, startServer } from "./helpers.js";

const ROOM = "session-515-4a1c-9f0e-7b2d-8c31e5a6b7d8";
const owner = (o: any) => ({ kind: "owner" as const, ownerId: o.owner_id });
const custody = (s: any, o: any) => s.platform.enableCustody(owner(o), o.bot.id, { private_key_pem: o.kp.privateKeyPem });

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

/** The console's write: the owner's own credential on the home route, naming the thread on screen. */
const reply = (s: any, o: any, to: string, text: string, extra: Record<string, unknown> = {}) =>
  req(s.base, "POST", `/v1/homes/${o.bot.id}/send`, o.owner.token, { from_bot_id: o.bot.id, to, text, typed_by_owner: true, ...extra });

/** What one side's console reads in a thread: every line, oldest first. */
const lines = async (o: any, conversationId: string) => (await o.owner.req("GET", `/v1/conversations/${conversationId}`)).messages as any[];

/** Two friends with custody, one Bot each, and the pair seated together in a local room by a claim. */
async function seatedFriends(s: any) {
  const { A, B } = await friends(s.base);
  custody(s, A);
  custody(s, B);
  const minted = await req(s.base, "POST", "/v1/local-room-invites", A.owner.token, { room_id: ROOM, name: "Launch plan", bot_id: A.bot.id });
  assert.equal(minted.status, 201, JSON.stringify(minted.body));
  const claimed = await req(s.base, "POST", `/v1/local-room-invites/${encodeURIComponent(minted.body.ticket)}/claim`, B.owner.token, { bots: [B.bot.id] });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  return { A, B, ticket: minted.body.ticket as string };
}

/** The thread the room opened: A's first line in that room, which is what both consoles then read. */
async function roomThread(s: any, seated: { A: any; B: any; ticket: string }) {
  const sent = await reply(s, seated.A, seated.B.handle, "the room is open", { room_id: ROOM });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  assert.equal(sent.body.message.status, "delivered", "the first room line was delivered");
  assert.ok(sent.body.conversation_id, "the room opened a conversation");
  return sent.body.conversation_id as string;
}

/** The minter ends the guest's seat: the room's relationship row stops reading `room`, its grants are revoked. */
async function endSeat(s: any, seated: { A: any; B: any; ticket: string }) {
  const ended = await req(s.base, "DELETE", `/v1/local-room-invites/${encodeURIComponent(seated.ticket)}/claims/${encodeURIComponent(seated.B.handle)}`, seated.A.owner.token);
  assert.equal(ended.status, 204, JSON.stringify(ended.body));
}

test("#515: after the seat ends, the owner's reply into that thread lands instead of 404", async () => {
  const s = await startServer();
  try {
    const seated = await seatedFriends(s);
    const { A, B } = seated;
    const cnv = await roomThread(s, seated);
    await endSeat(s, seated);

    const read = await A.owner.req("GET", `/v1/conversations/${cnv}`);
    assert.equal(read.room_id, null, "the ended room's thread reports no room");
    assert.equal(read.status, "open", "and the thread is still open for both consoles");

    const before = (await lines(A, cnv)).length;
    const r = await reply(s, A, B.handle, "the room is over; this is the reply the console sends", { conversation_id: cnv });
    assert.equal(r.status, 202, `expected 202, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.conversation_id, cnv, "the line lands in the thread on screen");
    assert.equal(r.body.message.status, "delivered", "and it was delivered, not refused as an unknown chat");

    const after = await lines(A, cnv);
    assert.equal(after.length, before + 1, "the thread gained exactly one line");
    const mine = after.find((m: any) => m.direction === "outbound" && m.content?.text === "the room is over; this is the reply the console sends");
    assert.ok(mine, "the owner's line is in the thread it named");
    assert.equal(mine.status, "delivered", "delivered, not left pending");
    assert.equal(mine.typed_by_owner, true, "still marked as the owner's own words");

    const fromB = await lines(B, cnv);
    const heard = fromB.find((m: any) => m.direction === "inbound" && m.untrusted_content?.text === "the room is over; this is the reply the console sends");
    assert.ok(heard, "the other side reads the same line in the same thread");
    assert.equal(heard.status, "delivered", "as a delivered inbound line");
  } finally { await s.stop(); }
});

test("#515: the same thread takes the other owner's reply too", async () => {
  const s = await startServer();
  try {
    const seated = await seatedFriends(s);
    const { A, B } = seated;
    const cnv = await roomThread(s, seated);
    await endSeat(s, seated);

    const r = await reply(s, B, A.handle, "answering from the guest's own console", { conversation_id: cnv });
    assert.equal(r.status, 202, `expected 202, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.conversation_id, cnv, "the guest's line lands in the same thread");
    assert.equal(r.body.message.status, "delivered", "and it was delivered");
    const heard = (await lines(A, cnv)).find((m: any) => m.direction === "inbound" && m.untrusted_content?.text === "answering from the guest's own console");
    assert.ok(heard, "the host reads it in that thread");
  } finally { await s.stop(); }
});

test("#515: while the room is live, its thread still takes only the room's own route", async () => {
  const s = await startServer();
  try {
    const seated = await seatedFriends(s);
    const { A, B } = seated;
    const cnv = await roomThread(s, seated);

    const inRoom = await reply(s, A, B.handle, "still in the room, naming the room", { room_id: ROOM, conversation_id: cnv });
    assert.equal(inRoom.status, 202, JSON.stringify(inRoom.body));
    assert.equal(inRoom.body.conversation_id, cnv, "the room route still writes into the room's thread");

    const before = (await lines(A, cnv)).length;
    const straight = await reply(s, A, B.handle, "the 1:1 page must not write into a live room's thread", { conversation_id: cnv });
    assert.equal(straight.status, 404, "a live room's thread is still refused on the 1:1 route");
    assert.equal(straight.body.code, "conversation_not_found", "with the same answer an unknown id gets");
    assert.equal((await lines(A, cnv)).length, before, "and nothing was written");
  } finally { await s.stop(); }
});

test("#515: ending the seat does not make the room route work — it still answers room_not_shared", async () => {
  const s = await startServer();
  try {
    const seated = await seatedFriends(s);
    const { A, B } = seated;
    const cnv = await roomThread(s, seated);
    await endSeat(s, seated);

    const before = (await lines(A, cnv)).length;
    const namingRoom = await reply(s, A, B.handle, "the room id after the seat ended", { room_id: ROOM, conversation_id: cnv });
    assert.equal(namingRoom.status, 403, JSON.stringify(namingRoom.body));
    assert.equal(namingRoom.body.code, "room_not_shared", "the room door is gone, and it is judged by the room alone");
    assert.equal((await lines(A, cnv)).length, before, "nothing was written");
  } finally { await s.stop(); }
});

test("#515: with the friendship gone there is no door left, so the ended room's thread is still 404", async () => {
  const s = await startServer();
  try {
    const seated = await seatedFriends(s);
    const { A, B } = seated;
    const cnv = await roomThread(s, seated);
    await endSeat(s, seated);
    const rel = await A.owner.req("GET", "/v1/relationships");
    const friendship = (rel.relationships as any[]).find((r: any) => r.status === "active");
    assert.ok(friendship, "the pair are still friends after the seat ended");
    await A.owner.req("DELETE", `/v1/relationships/${friendship.relationship_id}`);

    const before = (await lines(A, cnv)).length;
    const r = await reply(s, A, B.handle, "unfriended, so the thread has no door", { conversation_id: cnv });
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(r.body.code, "conversation_not_found", "an unfriended pair has no friendship door to settle on");
    assert.equal((await lines(A, cnv)).length, before, "nothing was written");
  } finally { await s.stop(); }
});

test("#515: a stranger naming that thread is still refused, and nothing is written", async () => {
  const s = await startServer();
  try {
    const seated = await seatedFriends(s);
    const { A, B } = seated;
    const cnv = await roomThread(s, seated);
    await endSeat(s, seated);

    const C = await ownerWithBot(s.base, "cara");
    custody(s, C);
    const before = (await lines(A, cnv)).length;
    const outsider = await reply(s, C, A.handle, "a stranger's line into a thread that is not theirs", { conversation_id: cnv });
    assert.equal(outsider.status, 404, JSON.stringify(outsider.body));
    assert.equal(outsider.body.code, "conversation_not_found", "a thread of another pair answers like one that does not exist");
    assert.equal((await lines(A, cnv)).length, before, "the thread gained nothing");
    assert.equal((await lines(B, cnv)).length, before, "and neither side sees a line");
  } finally { await s.stop(); }
});
