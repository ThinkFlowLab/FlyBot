import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

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

test("#43: a guest who joins with a ticket can answer the inviter in that room, and only there", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "alice");
  const B = await ownerWithBot(s.base, "bob");   // no friendship with A
  const room = await openRoom(s.base, A, "717171");
  assert.equal(room.status, 200, JSON.stringify(room.body));
  const ticket = await mint(s.base, A, room.body.room_id);
  assert.equal(ticket.status, 201);
  const joined = await joinInvite(s.base, B, ticket.body.ticket);
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  s.platform.enableCustody(owner(B), B.bot.id, { private_key_pem: B.kp.privateKeyPem });

  // the first line to the inviter's Bot, with no friendship and no invite-based grant beyond this room
  const sent = s.platform.sendAsMember(owner(B), { from_bot_id: B.bot.id, to: A.handle, text: "thank you for the invite", room_id: room.body.room_id });
  assert.equal(sent.message.status, "delivered");
  assert.equal((sent.message as any).room_id, room.body.room_id);
  assert.deepEqual((sent.message as any).policy.reasons, ["room.context", "dlp.clean"]);
  const arrived = await A.bot.events(0);
  const line = arrived.events.find((e: any) => e.event_type === "message.received");
  assert.ok(line, "the inviter gets an ordinary peer line");
  assert.equal(line.from.handle, B.handle);

  // without the room id the same Bots are still strangers
  assert.throws(
    () => s.platform.sendAsMember(owner(B), { from_bot_id: B.bot.id, to: A.handle, text: "out of the blue" }),
    (e: any) => e.code === "no_relationship",
  );

  // a second room is out of reach: sharing another room does not make this pair reachable
  const C = await ownerWithBot(s.base, "carol");
  const other = await openRoom(s.base, C, "828282");
  const otherTicket = await mint(s.base, C, other.body.room_id);
  assert.equal((await joinInvite(s.base, B, otherTicket.body.ticket)).status, 200);
  assert.throws(
    () => s.platform.sendAsMember(owner(B), { from_bot_id: B.bot.id, to: A.handle, text: "wrong room", room_id: other.body.room_id }),
    (e: any) => e.code === "room_not_shared",
  );

  // the reach dies with the room
  assert.equal((await req(s.base, "POST", `/v1/face-rooms/${room.body.room_id}/leave`, tok(A), {})).status, 200);
  assert.equal((await req(s.base, "POST", `/v1/face-rooms/${room.body.room_id}/leave`, tok(B), {})).status, 200);
  assert.throws(
    () => s.platform.sendAsMember(owner(B), { from_bot_id: B.bot.id, to: A.handle, text: "after the room", room_id: room.body.room_id }),
    (e: any) => e.code === "room_not_shared",
  );
});

test("#43: every refused ticket writes nothing", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "alice");
  const room = await openRoom(s.base, A, "737373");
  const roomId = room.body.room_id as string;
  const count = (sql: string) => (s.platform.db.prepare(sql).get() as any).n as number;
  const counts = () => ({
    grants: count("SELECT COUNT(*) n FROM grants"),
    members: count("SELECT COUNT(*) n FROM face_room_members"),
    relationships: count("SELECT COUNT(*) n FROM relationships"),
  });
  const refused = async (guest: any, ticket: string, status: number, code: string) => {
    const before = counts();
    const r = await joinInvite(s.base, guest, ticket);
    assert.equal(r.status, status, `${code}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, code);
    assert.deepEqual(counts(), before, `${code} must write nothing`);
  };

  // 1. a ticket that does not exist
  const g1 = await ownerWithBot(s.base, "gina");
  await refused(g1, "A".repeat(43), 404, "invite_not_found");
  // 2. a string that is not a ticket at all: same answer, nothing to probe
  await refused(g1, "not-a-ticket", 404, "invite_not_found");
  // 3. revoked
  const revoked = await mint(s.base, A, roomId);
  assert.equal((await req(s.base, "DELETE", `/v1/face-rooms/${roomId}/invites/${revoked.body.ticket}`, tok(A))).status, 200);
  const g2 = await ownerWithBot(s.base, "gus");
  await refused(g2, revoked.body.ticket, 410, "revoked");
  // 4. expired
  const expired = await mint(s.base, A, roomId);
  s.platform.db.prepare("UPDATE face_room_invites SET expires_at = ? WHERE ticket = ?").run(new Date(Date.now() - 60_000).toISOString(), expired.body.ticket);
  const g3 = await ownerWithBot(s.base, "gail");
  await refused(g3, expired.body.ticket, 410, "expired");
  // 5. already a member: the ticket is used up for that home, and a second join writes nothing either
  const live = await mint(s.base, A, roomId);
  const g4 = await ownerWithBot(s.base, "gwen");
  assert.equal((await joinInvite(s.base, g4, live.body.ticket)).status, 200);
  await refused(g4, live.body.ticket, 409, "already_member");
  // 6. the room has ended
  const last = await mint(s.base, A, roomId);
  assert.equal((await req(s.base, "POST", `/v1/face-rooms/${roomId}/leave`, tok(A), {})).status, 200);
  assert.equal((await req(s.base, "POST", `/v1/face-rooms/${roomId}/leave`, tok(g4), {})).status, 200);   // the room is empty now, so it closes
  const g5 = await ownerWithBot(s.base, "gina2");
  await refused(g5, last.body.ticket, 410, "ended");
});

test("#43: a line whose room grant is gone is not delivered", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "alice");
  const B = await ownerWithBot(s.base, "bob");
  const room = await openRoom(s.base, A, "747474");
  const roomId = room.body.room_id as string;
  // a third owner keeps the room open after A and B leave, so the pair's room relationship stays and only its grants die
  const C = await ownerWithBot(s.base, "carol");
  assert.equal((await openRoom(s.base, C, "747474")).status, 200);
  const ticket = await mint(s.base, A, roomId);
  assert.equal((await joinInvite(s.base, B, ticket.body.ticket)).status, 200);
  s.platform.enableCustody(owner(B), B.bot.id, { private_key_pem: B.kp.privateKeyPem });
  await req(s.base, "PATCH", "/v1/me", tok(B), { sensitive_terms: ["swordfish"] });
  const held = s.platform.sendAsMember(owner(B), { from_bot_id: B.bot.id, to: A.handle, text: "swordfish", room_id: roomId });
  assert.equal(held.message.status, "pending_approval");
  // the room's grants are cleared while the line waits (the room itself stays open for C)
  s.platform.db.prepare("UPDATE grants SET status = 'revoked' WHERE room_id = ?").run(roomId);
  assert.throws(
    () => s.platform.decideApproval(owner(B), (held.message as any).approval_id, { decision: "approved" }),
    (e: any) => e.code === "no_relationship",
  );
  const inbox = await A.bot.events(0);
  assert.equal(inbox.events.some((e: any) => e.event_type === "message.received"), false, "nothing reached the inviter");
});

test("#43: two rooms between the same pair stay apart", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "alice");
  const B = await ownerWithBot(s.base, "bob");
  const r1 = await openRoom(s.base, A, "757575");
  const r2 = await openRoom(s.base, A, "767676");
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  const room1 = r1.body.room_id as string;
  const room2 = r2.body.room_id as string;
  for (const id of [room1, room2]) {
    const ticket = await mint(s.base, A, id);
    assert.equal((await joinInvite(s.base, B, ticket.body.ticket)).status, 200, `join ${id}: ${JSON.stringify(id)}`);
  }
  s.platform.enableCustody(owner(B), B.bot.id, { private_key_pem: B.kp.privateKeyPem });
  // each room's join wrote its own relationship row; the two must not be interchangeable
  const relOf = (roomId: string) => (s.platform.db.prepare("SELECT relationship_id FROM grants WHERE room_id = ? AND grantor_owner = ? AND grantee_bot = ? AND capability = 'chat.public' AND status = 'active'").get(roomId, A.owner_id, B.bot.id) as any)?.relationship_id as string;
  const rel1 = relOf(room1);
  const rel2 = relOf(room2);
  assert.ok(rel1 && rel2 && rel1 !== rel2, `each room has its own relationship row: ${rel1} / ${rel2}`);

  // a line in room 1 binds its conversation to room 1's door, not to the newest room the pair shares
  const sent = s.platform.sendAsMember(owner(B), { from_bot_id: B.bot.id, to: A.handle, text: "room one", room_id: room1 });
  assert.equal(sent.message.status, "delivered");
  const conv = s.platform.db.prepare("SELECT relationship_id FROM conversations WHERE id = ?").get(sent.conversation_id) as any;
  assert.equal(conv.relationship_id, rel1, "the conversation is bound to room 1");

  // room 2 ends; room 1's reach must not depend on it
  const leave = (o: any, roomId: string) => req(s.base, "POST", `/v1/face-rooms/${roomId}/leave`, tok(o), {});
  assert.equal((await leave(A, room2)).status, 200);
  assert.equal((await leave(B, room2)).status, 200);
  assert.equal((s.platform.db.prepare("SELECT status FROM face_rooms WHERE id = ?").get(room2) as any).status, "closed");
  const again = s.platform.sendAsMember(owner(B), { from_bot_id: B.bot.id, to: A.handle, text: "still room one", room_id: room1 });
  assert.equal(again.message.status, "delivered", "room 1 does not ride on room 2");
  const inbox = await A.bot.events(0);
  const lines = inbox.events.filter((e: any) => e.event_type === "message.received");
  assert.equal(lines.length, 2, "both room-1 lines reached the inviter");
});

test("#43: a room-bound conversation of two friends still stops when the room grant goes", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "alice");
  const B = await ownerWithBot(s.base, "bob");
  // They are friends, so dropping the delivery guard would still find an active relationship and deliver:
  // only the room guard can refuse the line below.
  const rel = await A.owner.req("POST", "/v1/relationships", { from_bot_id: A.bot.id, target_handle: B.handle, message: "hi", requested_capabilities: ["chat.public"] });
  await B.owner.req("POST", `/v1/relationships/${rel.relationship_id}/consent`, { decision: "accept", grant_capabilities: [] });
  const room = await openRoom(s.base, A, "787878");
  const roomId = room.body.room_id as string;
  const ticket = await mint(s.base, A, roomId);
  assert.equal((await joinInvite(s.base, B, ticket.body.ticket)).status, 200);
  s.platform.enableCustody(owner(B), B.bot.id, { private_key_pem: B.kp.privateKeyPem });
  await req(s.base, "PATCH", "/v1/me", tok(B), { sensitive_terms: ["swordfish"] });
  const held = s.platform.sendAsMember(owner(B), { from_bot_id: B.bot.id, to: A.handle, text: "swordfish", room_id: roomId });
  assert.equal(held.message.status, "pending_approval");
  s.platform.db.prepare("UPDATE grants SET status = 'revoked' WHERE room_id = ?").run(roomId);
  assert.throws(
    () => s.platform.decideApproval(owner(B), (held.message as any).approval_id, { decision: "approved" }),
    (e: any) => e.code === "no_relationship",
  );
  const inbox = await A.bot.events(0);
  assert.equal(inbox.events.some((e: any) => e.event_type === "message.received"), false, "friendship does not deliver a room line whose grant is gone");
});

test("#43: closing room 1 does not take room 2 with it", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "alice");
  const B = await ownerWithBot(s.base, "bob");
  const r1 = await openRoom(s.base, A, "797979");
  const r2 = await openRoom(s.base, A, "808080");
  const room1 = r1.body.room_id as string;
  const room2 = r2.body.room_id as string;
  for (const id of [room1, room2]) {
    const ticket = await mint(s.base, A, id);
    assert.equal((await joinInvite(s.base, B, ticket.body.ticket)).status, 200, `join ${id}`);
  }
  s.platform.enableCustody(owner(B), B.bot.id, { private_key_pem: B.kp.privateKeyPem });
  const relOf = (roomId: string) => (s.platform.db.prepare("SELECT relationship_id FROM grants WHERE room_id = ? AND grantor_owner = ? AND grantee_bot = ? AND capability = 'chat.public' AND status = 'active'").get(roomId, A.owner_id, B.bot.id) as any)?.relationship_id as string;
  const rel1 = relOf(room1);
  const rel2 = relOf(room2);
  const convOf = (id: string) => (s.platform.db.prepare("SELECT relationship_id FROM conversations WHERE id = ?").get(id) as any).relationship_id;
  const leave = (o: any, roomId: string) => req(s.base, "POST", `/v1/face-rooms/${roomId}/leave`, tok(o), {});

  // open a conversation in room 1
  const first = s.platform.sendAsMember(owner(B), { from_bot_id: B.bot.id, to: A.handle, text: "room one", room_id: room1 });
  assert.equal(first.message.status, "delivered");
  assert.equal(convOf(first.conversation_id), rel1);

  // room 1 ends (both members leave, the room is empty, its grants and relationship are revoked); room 2 is untouched
  assert.equal((await leave(A, room1)).status, 200);
  assert.equal((await leave(B, room1)).status, 200);
  assert.equal((s.platform.db.prepare("SELECT status FROM face_rooms WHERE id = ?").get(room1) as any).status, "closed");
  assert.equal(relOf(room1), undefined, "room 1 has no live grant left");

  // a line in room 2 must not reuse room 1's conversation, and must not fail halfway through a draft
  const second = s.platform.sendAsMember(owner(B), { from_bot_id: B.bot.id, to: A.handle, text: "room two", room_id: room2 });
  assert.equal(second.message.status, "delivered", "room 2 delivers on its own door");
  assert.notEqual(second.conversation_id, first.conversation_id, "room 2 gets its own conversation");
  assert.equal(convOf(second.conversation_id), rel2, "the new conversation is bound to room 2");
  assert.equal((s.platform.db.prepare("SELECT COUNT(*) n FROM approvals WHERE owner_id = ? AND status = 'pending'").get(B.owner_id) as any).n, 0, "no approval is left behind");

  const inbox = await A.bot.events(0);
  assert.equal(inbox.events.filter((e: any) => e.event_type === "message.received").length, 2);
});
