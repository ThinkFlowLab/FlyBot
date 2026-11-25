import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

// Bot Social #7xx: `room_id` on `POST /v1/homes/{id}/send` was the last id on this door without a shape gate. It went
// into the statement as it arrived: `{}` was read as "[object Object]" and answered 400 with the room id's own
// charset message, `true` and `7` became the strings "true" and "7" and were refused only because no such room is
// shared, `{"toString":null}` answered 500, and an array was stringified, so `["<room>"]` sent a real line into that
// room. A room id is a string; every other shape is refused before any read, any write and any sweep.
//
// One shape per case, so a gate that lets exactly one shape through leaves exactly one case red.

const ROOM = "session-hsrid-6d2f-4b8e-9a1c-3e7f5d2b8c41";
const SHAPE_REFUSAL = "room_id must be a string";
const CHARSET_REFUSAL = "room_id: 1-64 chars [A-Za-z0-9._:-]";

async function post(base: string, path: string, token: string, body: unknown) {
  const r = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}

/** A FlyBot home with one custodial member, a peer that is already a friend, and the pair seated together in a local room. */
async function homeSeatedInTheRoom(base: string, name: string) {
  const peer = await ownerWithBot(base, `${name}peer`);
  const home = await post(base, "/v1/onboard/flybot", "", { display_name: name, username: `${name}own`, password: "secret-pw" });
  assert.equal(home.status, 201, JSON.stringify(home.body));
  const login = await post(base, "/v1/auth/login", "", { username: `${name}own`, password: "secret-pw" });
  const token = login.body.owner_token as string;
  const homeId = home.body.home.bot_id as string;
  const member = await post(base, `/v1/homes/${homeId}/members`, token, { name: "writer", display_name: "Writer" });
  assert.equal(member.status, 201, JSON.stringify(member.body));
  const memberId = member.body.bot_id as string;
  // The friendship the one-to-one branch sends on, with the capability that lets a line be drafted.
  const rel = await post(base, "/v1/relationships", token, { from_bot_id: memberId, target_handle: peer.handle, message: "hi", requested_capabilities: ["chat.public"] });
  assert.equal(rel.status, 201, JSON.stringify(rel.body));
  const consent = await post(base, `/v1/relationships/${rel.body.relationship_id}/consent`, peer.owner.token, { decision: "accept", grant_capabilities: [{ capability: "chat.public" }] });
  assert.equal(consent.status, 200, JSON.stringify(consent.body));
  // The room seat: the claim writes the room-scoped grant from the peer's owner to the member for that room.
  const minted = await post(base, "/v1/local-room-invites", token, { room_id: ROOM, name: "Launch plan", bot_id: memberId });
  assert.equal(minted.status, 201, JSON.stringify(minted.body));
  const claimed = await post(base, `/v1/local-room-invites/${encodeURIComponent(minted.body.ticket)}/claim`, peer.owner.token, { bots: [peer.bot.id] });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  return { peer, homeId, token, memberId };
}

const snapshot = (db: any) => ({
  messages: (db.prepare("SELECT COUNT(*) AS c FROM messages").get() as any).c,
  approvals: (db.prepare("SELECT COUNT(*) AS c FROM approvals").get() as any).c,
  conversations: (db.prepare("SELECT COUNT(*) AS c FROM conversations").get() as any).c,
  events: (db.prepare("SELECT COUNT(*) AS c FROM events").get() as any).c,
  face_room_events: (db.prepare("SELECT COUNT(*) AS c FROM face_room_events").get() as any).c,
});

const send = (base: string, h: { homeId: string; token: string; memberId: string; peer: { handle: string } }, extra: Record<string, unknown> = {}) =>
  post(base, `/v1/homes/${h.homeId}/send`, h.token, { from_bot_id: h.memberId, to: h.peer.handle, text: "hello from the home page", ...extra });

/** The one refusal this shape must get: 400, the field's own words, no thread, and not one row written. */
async function expectShapeRefused(s: any, h: any, room_id: unknown, shape: string) {
  const before = snapshot(s.platform.db);
  const r = await send(s.base, h, { room_id });
  assert.equal(r.status, 400, `the room as ${shape} answered ${r.status}, not 400`);
  assert.equal(r.body.error?.code, "invalid_request", `the room as ${shape} did not answer invalid_request`);
  assert.equal(r.body.error?.message, SHAPE_REFUSAL, `the room as ${shape} was judged by something else`);
  assert.equal(r.body.conversation_id, undefined, `the room as ${shape} answered with a conversation`);
  assert.deepEqual(snapshot(s.platform.db), before, `the room as ${shape} wrote before refusing`);
}

test("a room id as an object is refused as a string, not as a charset", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const h = await homeSeatedInTheRoom(s.base, "hsrobj");
  await expectShapeRefused(s, h, {}, "an object");
});

test("a room id as an object with no toString is refused, not answered 500", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const h = await homeSeatedInTheRoom(s.base, "hsrstr");
  await expectShapeRefused(s, h, { toString: null }, 'an object with no toString (`{"toString":null}`)');
});

test("a room id as a boolean is refused as a string, not as a room nobody shares", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const h = await homeSeatedInTheRoom(s.base, "hsrbool");
  await expectShapeRefused(s, h, true, "a boolean");
});

test("a room id as a number is refused as a string, not as a room nobody shares", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const h = await homeSeatedInTheRoom(s.base, "hsrnum");
  await expectShapeRefused(s, h, 7, "a number");
});

test("a room id in a one-id list is refused and sends nothing into that room", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const h = await homeSeatedInTheRoom(s.base, "hsrarr");
  await expectShapeRefused(s, h, [ROOM], "a one-id list");
});

test("a room id in a two-id list is refused as a string, not as a charset", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const h = await homeSeatedInTheRoom(s.base, "hsrarr2");
  await expectShapeRefused(s, h, [ROOM, ROOM], "a two-id list");
});

test("a string room id still sends, and the line lands in that room", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const h = await homeSeatedInTheRoom(s.base, "hsrctl");
  // The seat is the consent, so the line is delivered, not held, and it names the room it was written in.
  const sent = await send(s.base, h, { room_id: ROOM });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  assert.equal(sent.body.message?.status, "delivered", "a string room id stopped delivering");
  assert.equal(sent.body.room_id, ROOM, "a string room id stopped naming the room");
  assert.ok(sent.body.conversation_id, "a string room id opened no thread");
});

test("an absent or null room id still means no room, and takes the one-to-one branch", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const h = await homeSeatedInTheRoom(s.base, "hsrnone");
  for (const [label, extra] of [["missing", {}], ["null", { room_id: null }]] as const) {
    const r = await send(s.base, h, { text: `hello with a ${label} room`, ...extra });
    assert.equal(r.status, 202, `a ${label} room id answered ${r.status}, not 202`);
    assert.equal(r.body.message?.status, "pending_approval", `a ${label} room id stopped taking the one-to-one branch`);
    assert.equal(r.body.room_id, undefined, `a ${label} room id answered with a room`);
  }
});

test("a string the room id's own rules refuse still answers in the room id's own words", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const h = await homeSeatedInTheRoom(s.base, "hsrbad");
  // Still a string: the gate this fix adds never speaks for the room id's charset, and nothing is written.
  for (const bad of ["", "   ", "x".repeat(65)]) {
    const before = snapshot(s.platform.db);
    const r = await send(s.base, h, { room_id: bad });
    assert.equal(r.status, 400, `the room id ${JSON.stringify(bad)} answered ${r.status}`);
    assert.equal(r.body.error?.code, "invalid_request", `the room id ${JSON.stringify(bad)} did not answer invalid_request`);
    assert.equal(r.body.error?.message, CHARSET_REFUSAL, `the room id ${JSON.stringify(bad)} lost its own words`);
    assert.deepEqual(snapshot(s.platform.db), before, `the room id ${JSON.stringify(bad)} wrote before refusing`);
  }
});

test("a sender with no seat in that room is still refused by reach, not by shape", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const h = await homeSeatedInTheRoom(s.base, "hsrreach");
  const cadet = await post(s.base, `/v1/homes/${h.homeId}/members`, h.token, { name: "cadet", display_name: "Cadet" });
  assert.equal(cadet.status, 201, JSON.stringify(cadet.body));
  const refused = await post(s.base, `/v1/homes/${h.homeId}/send`, h.token, { from_bot_id: cadet.body.bot_id, to: h.peer.handle, text: "hello from outside the room", room_id: ROOM });
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(refused.body.error?.code, "room_not_shared", "a sender with no seat in the room");
  assert.equal(refused.body.error?.message, "no active room-scoped grant for that room between these Bots", "a sender with no seat in the room");
});
