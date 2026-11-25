import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

async function post(base: string, path: string, token: string, body: unknown) {
  const r = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}

// Every other id this door writes — `from_bot_id`, `room_id`, `conversation_id`, the attachment refs — is refused
// before it reaches SQL. The recipient was the one that went in as it arrived: an object or a boolean answered 500,
// and an array was spread over the statement's parameters, so `["@peer.bot"]` sent a real message to that Bot.

/** A FlyBot home with one custodial member that is already friends with the returned peer Bot. */
async function homeWithMember(base: string, name: string) {
  const peer = await ownerWithBot(base, `${name}peer`);
  const home = await post(base, "/v1/onboard/flybot", "", { display_name: name, username: `${name}own`, password: "secret-pw" });
  assert.equal(home.status, 201);
  const login = await post(base, "/v1/auth/login", "", { username: `${name}own`, password: "secret-pw" });
  const token = login.body.owner_token as string;
  const member = await post(base, `/v1/homes/${home.body.home.bot_id}/members`, token, { name: "writer", display_name: "Writer" });
  assert.equal(member.status, 201);
  const rel = await post(base, "/v1/relationships", token, { from_bot_id: member.body.bot_id, target_handle: peer.handle, message: "hi", requested_capabilities: ["chat.public"] });
  assert.equal(rel.status, 201);
  await post(base, `/v1/relationships/${rel.body.relationship_id}/consent`, peer.owner.token, { decision: "accept", grant_capabilities: [{ capability: "chat.public" }] });
  return { peer, homeId: home.body.home.bot_id as string, token, memberId: member.body.bot_id as string };
}

const snapshot = (db: any) => ({
  messages: (db.prepare("SELECT COUNT(*) AS c FROM messages").get() as any).c,
  approvals: (db.prepare("SELECT COUNT(*) AS c FROM approvals").get() as any).c,
  conversations: (db.prepare("SELECT COUNT(*) AS c FROM conversations").get() as any).c,
  events: (db.prepare("SELECT COUNT(*) AS c FROM events").get() as any).c,
});

test("a recipient of the wrong shape is refused before it reaches SQL", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const h = await homeWithMember(s.base, "hsgate");
  const before = snapshot(s.platform.db);
  const shapes: [string, unknown][] = [
    ["an object", {}],
    ["a boolean", true],
    ["an object with no toString", { toString: null }],
    ["a number", 7],
  ];
  for (const [shape, to] of shapes) {
    const r = await post(s.base, `/v1/homes/${h.homeId}/send`, h.token, { from_bot_id: h.memberId, to, text: `hello ${shape}` });
    assert.equal(r.status, 400, `the recipient as ${shape} answered ${r.status}, not 400`);
    assert.equal(r.body.error?.code, "invalid_request", `the recipient as ${shape}`);
    assert.equal(r.body.error?.message, "to must be a string", `the recipient as ${shape}`);
    assert.equal(r.body.conversation_id, undefined, `the recipient as ${shape} answered with a conversation`);
    assert.deepEqual(snapshot(s.platform.db), before, `the recipient as ${shape} wrote before refusing`);
  }
});

test("an array recipient never sends: it is not a list of handles", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const h = await homeWithMember(s.base, "hsarray");
  const before = snapshot(s.platform.db);
  for (const [label, to] of [
    ["one handle", [h.peer.handle]],
    ["two handles", [h.peer.handle, h.peer.handle]],
  ] as const) {
    const r = await post(s.base, `/v1/homes/${h.homeId}/send`, h.token, { from_bot_id: h.memberId, to, text: `hello ${label}` });
    assert.equal(r.status, 400, `the recipient as an array of ${label} answered ${r.status}, not 400`);
    assert.equal(r.body.error?.code, "invalid_request", `the recipient as an array of ${label}`);
    assert.equal(r.body.error?.message, "to must be a string", `the recipient as an array of ${label}`);
    assert.equal(r.body.conversation_id, undefined, `the recipient as an array of ${label} answered with a conversation`);
    assert.deepEqual(snapshot(s.platform.db), before, `the recipient as an array of ${label} wrote before refusing`);
  }
  // Nothing was sent on the peer's side either: no line arrived, no card was left waiting for the peer's owner.
  const peerCards = (s.platform.db.prepare("SELECT COUNT(*) AS c FROM approvals WHERE owner_id = ?").get(h.peer.owner_id) as any).c;
  assert.equal(peerCards, 0, "an array recipient left a card with the peer's owner");
});

test("an absent or null recipient is still an unknown Bot", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const h = await homeWithMember(s.base, "hsnull");
  const before = snapshot(s.platform.db);
  for (const [label, body] of [
    ["missing", { from_bot_id: h.memberId, text: "hello" }],
    ["null", { from_bot_id: h.memberId, to: null, text: "hello" }],
  ] as const) {
    const r = await post(s.base, `/v1/homes/${h.homeId}/send`, h.token, body);
    assert.equal(r.status, 404, `a ${label} recipient stopped being 404`);
    assert.equal(r.body.error?.code, "bot_not_found", `a ${label} recipient`);
    assert.deepEqual(snapshot(s.platform.db), before, `a ${label} recipient wrote before refusing`);
  }
});

test("a string recipient still sends, and is still looked up, refused and unknown as before", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const h = await homeWithMember(s.base, "hsstr");
  const stranger = await ownerWithBot(s.base, "hsstranger");
  const before = snapshot(s.platform.db);
  const sent = await post(s.base, `/v1/homes/${h.homeId}/send`, h.token, { from_bot_id: h.memberId, to: h.peer.handle, text: "hello from the home page" });
  assert.equal(sent.status, 202);
  assert.ok(sent.body.message?.message_id);
  assert.equal(snapshot(s.platform.db).messages, before.messages + 1);
  assert.equal(snapshot(s.platform.db).approvals, before.approvals + 1);
  // No friendship with this Bot's owner: the line is refused for reach, not for its shape.
  const unfriended = await post(s.base, `/v1/homes/${h.homeId}/send`, h.token, { from_bot_id: h.memberId, to: stranger.handle, text: "hello stranger" });
  assert.equal(unfriended.status, 403);
  // A handle nobody holds is still "no such remote bot".
  const unknown = await post(s.base, `/v1/homes/${h.homeId}/send`, h.token, { from_bot_id: h.memberId, to: "@nobody.here", text: "hello nobody" });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error?.code, "bot_not_found");
});
