import assert from "node:assert/strict";
import { test } from "node:test";
import { friends, ownerWithBot, startServer } from "./helpers.js";

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
const tok = (o: any) => o.owner.token;
const owner = (o: any) => ({ kind: "owner" as const, ownerId: o.owner_id });
const openRoom = (base: string, o: any, code: string) => req(base, "POST", "/v1/face-rooms/join", tok(o), { code, bots: [o.bot.id] });
const mint = (base: string, o: any, roomId: string) => req(base, "POST", `/v1/face-rooms/${roomId}/invites`, tok(o));
const joinInvite = (base: string, o: any, ticket: string) => req(base, "POST", "/v1/face-rooms/join-invite", tok(o), { ticket, bots: [o.bot.id] });

test("#57: a room id the sender has left does not authorise the friendship door", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);                       // an active friendship, a real door
  s.platform.enableCustody(owner(B), B.bot.id, { private_key_pem: B.kp.privateKeyPem });
  const room = await openRoom(s.base, A, "919191");
  const roomId = room.body.room_id as string;
  const ticket = await mint(s.base, A, roomId);
  assert.equal((await joinInvite(s.base, B, ticket.body.ticket)).status, 200);
  // the guest leaves: the room door is gone, the friendship stays
  assert.equal((await req(s.base, "POST", `/v1/face-rooms/${roomId}/leave`, tok(B), {})).status, 200);

  // a plain friendship line opens the conversation (it waits on the owner's card, as always)
  const plain = s.platform.sendAsMember(owner(B), { from_bot_id: B.bot.id, to: A.handle, text: "before" });
  assert.equal(plain.message.status, "pending_approval");
  const convId = plain.conversation_id;

  // the same send, now naming the room the Bot has left: it must not auto-deliver as room context
  const cb = s.platform.custodialBot(owner(B), B.bot.id);
  const env = cb.sign("message.draft", { text: "after the room" }, { conversation_id: convId });
  const drafted = s.platform.draftMessage(cb.bp, convId, env, false, [], roomId);
  assert.equal(drafted.status, "pending_approval", "the friendship door still needs the owner");
  assert.equal((drafted as any).policy.reasons.includes("room.context"), false, "the reason must not claim a room door the send did not use");
  assert.equal((drafted as any).room_id, undefined);
});

test("#57: a room conversation reports that room's capabilities, a 1:1 view keeps its own", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  // a room conversation between two homes with no friendship
  const A = await ownerWithBot(s.base, "alice");
  const B = await ownerWithBot(s.base, "bob");
  const room = await openRoom(s.base, A, "929292");
  const roomId = room.body.room_id as string;
  const ticket = await mint(s.base, A, roomId);
  assert.equal((await joinInvite(s.base, B, ticket.body.ticket)).status, 200);
  s.platform.enableCustody(owner(B), B.bot.id, { private_key_pem: B.kp.privateKeyPem });
  const sent = s.platform.sendAsMember(owner(B), { from_bot_id: B.bot.id, to: A.handle, text: "in the room", room_id: roomId });
  assert.equal(sent.message.status, "delivered");
  const roomView = s.platform.getConversation(owner(B), sent.conversation_id) as any;
  assert.ok(roomView.effective_capabilities.me_on_peer.includes("chat.public"), `room caps: ${JSON.stringify(roomView.effective_capabilities)}`);
  assert.ok(roomView.effective_capabilities.peer_on_me.includes("chat.public"), `room caps back: ${JSON.stringify(roomView.effective_capabilities)}`);

  // a 1:1 conversation of the same pair of owners is untouched by that
  const C = await ownerWithBot(s.base, "carol");
  const D = await ownerWithBot(s.base, "dave");
  const rel = await C.owner.req("POST", "/v1/relationships", { from_bot_id: C.bot.id, target_handle: D.handle, message: "hi", requested_capabilities: ["chat.public"] });
  await D.owner.req("POST", `/v1/relationships/${rel.relationship_id}/consent`, { decision: "accept", grant_capabilities: [] });
  s.platform.enableCustody({ kind: "owner", ownerId: C.owner_id }, C.bot.id, { private_key_pem: C.kp.privateKeyPem });
  const plain = s.platform.sendAsMember({ kind: "owner", ownerId: C.owner_id }, { from_bot_id: C.bot.id, to: D.handle, text: "hello" });
  const plainView = s.platform.getConversation({ kind: "owner", ownerId: C.owner_id }, plain.conversation_id) as any;
  assert.equal(plainView.effective_capabilities.me_on_peer.includes("chat.public"), true, "the 1:1 view still comes from the friendship grants");
});

test("#57: a room grant on an active relationship is not read as a room grant", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B, relId } = await friends(s.base);
  s.platform.enableCustody(owner(B), B.bot.id, { private_key_pem: B.kp.privateKeyPem });
  const room = await openRoom(s.base, A, "939393");
  const roomId = room.body.room_id as string;
  // a legacy shape: a room-scoped grant on the friendship's `active` row (no `room` relationship involved)
  const id = "grt_legacy_" + Math.random().toString(36).slice(2, 8);
  s.platform.db.prepare("INSERT INTO grants (id, relationship_id, grantor_owner, grantee_bot, capability, scope, status, created_at, room_id, reply_only) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(id, relId, A.owner_id, B.bot.id, "chat.public", "{}", "active", new Date().toISOString(), roomId, 0);
  // one lookup says "there is a grant for this room", the other says "there is no room reach": both must agree
  assert.throws(
    () => s.platform.sendAsMember(owner(B), { from_bot_id: B.bot.id, to: A.handle, text: "legacy", room_id: roomId }),
    (e: any) => e.code === "room_not_shared",
  );
});
