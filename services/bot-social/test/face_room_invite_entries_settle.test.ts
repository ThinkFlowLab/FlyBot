import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

async function req(base: string, method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  const json = text ? JSON.parse(text) : {};
  return { status: r.status, body: json };
}
const tok = (o: { owner: { token: string } }) => o.owner.token;
const newRoom = (base: string, o: { owner: { token: string }; bot: { id: string } }, code: string) =>
  req(base, "POST", "/v1/face-rooms/join", tok(o), { code, bots: [o.bot.id] });
const mint = (base: string, o: { owner: { token: string } }, roomId: string) =>
  req(base, "POST", `/v1/face-rooms/${roomId}/invites`, tok(o));
const mintAs = (base: string, token: string, roomId: string) =>
  req(base, "POST", `/v1/face-rooms/${roomId}/invites`, token);
const revokeAs = (base: string, token: string, roomId: string, ticket: string) =>
  req(base, "DELETE", `/v1/face-rooms/${roomId}/invites/${ticket}`, token);
const joinInvite = (base: string, o: { owner: { token: string }; bot: { id: string } }, ticket: string) =>
  req(base, "POST", "/v1/face-rooms/join-invite", tok(o), { ticket, bots: [o.bot.id] });
const preview = (base: string, ticket: string, token?: string) =>
  req(base, "GET", `/v1/face-rooms/invites/${encodeURIComponent(ticket)}`, token);

// ---- Q1: an owner whose own seat has left cannot write to the room through its invitation.

test("Q1: a left owner cannot mint or revoke that room's invite, and the ticket it left behind still seats", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const O = await ownerWithBot(s.base, "q1olga");
  const P = await ownerWithBot(s.base, "q1paul");
  const Q = await ownerWithBot(s.base, "q1quinn");
  const room = await newRoom(s.base, O, "414141");
  assert.equal(room.status, 200, JSON.stringify(room.body));
  const roomId = room.body.room_id as string;
  const p = await req(s.base, "POST", "/v1/face-rooms/join", tok(P), { code: "414141", bots: [P.bot.id] });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const minted = await mint(s.base, O, roomId);
  assert.equal(minted.status, 201, JSON.stringify(minted.body));
  const ticket = minted.body.ticket as string;
  const left = await req(s.base, "POST", `/v1/face-rooms/${roomId}/leave`, tok(O), { bots: [O.bot.id] });
  assert.equal(left.status, 200, JSON.stringify(left.body));
  const seat = s.platform.db.prepare("SELECT left_at FROM face_room_members WHERE room_id = ? AND bot_id = ?").get(roomId, O.bot.id) as any;
  assert.ok(seat && seat.left_at, "setup: O's own seat is left");

  const readAfter = await req(s.base, "GET", `/v1/face-rooms/${roomId}`, tok(O));
  assert.equal(readAfter.status, 404, "a left owner cannot even read the room");
  const mintAfter = await mint(s.base, O, roomId);
  assert.equal(mintAfter.status, 404, `a left owner must not mint: got ${mintAfter.status} ${JSON.stringify(mintAfter.body)}`);
  assert.equal(mintAfter.body.error.code, "face_room_not_found");
  const revokeAfter = await revokeAs(s.base, tok(O), roomId, ticket);
  assert.equal(revokeAfter.status, 404, `a left owner must not revoke: got ${revokeAfter.status} ${JSON.stringify(revokeAfter.body)}`);
  assert.equal(revokeAfter.body.error.code, "face_room_not_found");
  // The same two writes with the seat's own bot token.
  const mintBot = await mintAs(s.base, O.bot.cred.token, roomId);
  assert.equal(mintBot.status, 404, `a left seat's bot token must not mint: got ${mintBot.status} ${JSON.stringify(mintBot.body)}`);
  const revokeBot = await revokeAs(s.base, O.bot.cred.token, roomId, ticket);
  assert.equal(revokeBot.status, 404, `a left seat's bot token must not revoke: got ${revokeBot.status} ${JSON.stringify(revokeBot.body)}`);
  // Nothing was withdrawn by the refused calls: the ticket still admits the next owner.
  const stillAlive = await joinInvite(s.base, Q, ticket);
  assert.equal(stillAlive.status, 200, `the refused revoke must not have landed: got ${stillAlive.status} ${JSON.stringify(stillAlive.body)}`);
});

// ---- Q2: a preview is a public read; it must not carry the room's contents to a non-member.

test("Q2: a face ticket and a local ticket preview carry no members, events or messages to a non-member", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const O = await ownerWithBot(s.base, "q2olga");
  const P = await ownerWithBot(s.base, "q2paul");
  const Q = await ownerWithBot(s.base, "q2quinn");
  const room = await newRoom(s.base, O, "424242");
  assert.equal(room.status, 200, JSON.stringify(room.body));
  const roomId = room.body.room_id as string;
  assert.equal((await req(s.base, "POST", "/v1/face-rooms/join", tok(P), { code: "424242", bots: [P.bot.id] })).status, 200);
  const ticket = (await mint(s.base, O, roomId)).body.ticket as string;
  // A line and a join event exist inside the room; neither may leak.
  assert.equal((await req(s.base, "POST", `/v1/face-rooms/${roomId}/messages`, tok(O), { text: "inside line", bot_id: O.bot.id })).status, 202);

  for (const [who, token] of [["anonymous", undefined], ["non-member", tok(Q)]] as const) {
    const p = await preview(s.base, ticket, token);
    assert.equal(p.status, 200, `${who}: ${JSON.stringify(p.body)}`);
    assert.equal(p.body.member_count, 2);
    assert.ok(!("members" in p.body), `${who} preview must not carry members[]: ${Object.keys(p.body).join(",")}`);
    assert.ok(!("events" in p.body), `${who} preview must not carry events[]: ${Object.keys(p.body).join(",")}`);
    assert.ok(!("messages" in p.body) && !("recent" in p.body), `${who} preview must not carry messages: ${Object.keys(p.body).join(",")}`);
    const text = JSON.stringify(p.body);
    assert.ok(!text.includes("inside line"), `${who} preview leaked a room line: ${text}`);
    assert.ok(!text.includes(P.handle), `${who} preview leaked a member handle: ${text}`);
  }

  // Local tickets: same question, with a claimed link and a third owner who is no party to it.
  const local = await req(s.base, "POST", "/v1/local-room-invites", tok(O), { room_id: "probe:room:q2", bot_id: O.bot.id });
  assert.equal(local.status, 201, JSON.stringify(local.body));
  const lticket = local.body.ticket as string;
  assert.equal((await req(s.base, "POST", `/v1/local-room-invites/${lticket}/claim`, tok(P), { bots: [P.bot.id] })).status, 200);
  const localAnon = await req(s.base, "GET", `/v1/local-room-invites/${lticket}`);
  assert.equal(localAnon.status, 200);
  assert.ok(!("claimers" in localAnon.body), `anonymous local preview must not carry claimers: ${JSON.stringify(localAnon.body)}`);
  assert.ok(!("claimer" in localAnon.body), `anonymous local preview must not carry claimer: ${JSON.stringify(localAnon.body)}`);
  const localOther = await req(s.base, "GET", `/v1/local-room-invites/${lticket}`, tok(Q));
  assert.equal(localOther.status, 200);
  assert.ok(!("claimers" in localOther.body), `a non-party local preview must not carry claimers: ${JSON.stringify(localOther.body)}`);
  assert.equal(localOther.body.claimer, null, "a non-party local preview names no claimer");
  const text = JSON.stringify(localOther.body);
  assert.ok(!text.includes(P.handle), `a non-party local preview leaked the claiming Bots: ${text}`);
});

// ---- Q3: the ticket row's own expires_at, with no revoked_at, still refuses a redemption.

test("Q3: a lapsed ticket row refuses the preview and the join, and writes nothing", async (t) => {
  let now = Date.now();
  const s = await startServer({ now: () => now, faceRooms: { inviteTtlMs: 60_000 } });
  t.after(s.stop);
  const O = await ownerWithBot(s.base, "q3olga");
  const P = await ownerWithBot(s.base, "q3paul");
  const room = await newRoom(s.base, O, "434343");
  assert.equal(room.status, 200, JSON.stringify(room.body));
  const roomId = room.body.room_id as string;
  const ticket = (await mint(s.base, O, roomId)).body.ticket as string;
  const row = s.platform.db.prepare("SELECT expires_at, revoked_at FROM face_room_invites WHERE ticket = ?").get(ticket) as any;
  assert.ok(row && !row.revoked_at, "setup: the row is not revoked, only its clock runs out");
  now += 60_001;
  const before = (s.platform.db.prepare("SELECT COUNT(*) n FROM face_room_members WHERE room_id = ?").get(roomId) as any).n as number;
  const join = await joinInvite(s.base, P, ticket);
  assert.equal(join.status, 410, `a lapsed ticket must not seat anyone: ${JSON.stringify(join.body)}`);
  assert.equal(join.body.error.code, "expired");
  const p = await preview(s.base, ticket);
  assert.equal(p.status, 410, `a lapsed ticket must not preview: ${JSON.stringify(p.body)}`);
  assert.equal(p.body.error.code, "expired");
  const after = (s.platform.db.prepare("SELECT COUNT(*) n FROM face_room_members WHERE room_id = ?").get(roomId) as any).n as number;
  assert.equal(after, before, "no seat for a refused ticket");

  // A local ticket minted before the no-deadline rule: same clock, same refusal, no claim written.
  const O2 = await ownerWithBot(s.base, "q3olga2");
  const P2 = await ownerWithBot(s.base, "q3paul2");
  const local = await req(s.base, "POST", "/v1/local-room-invites", tok(O2), { room_id: "probe:room:q3", bot_id: O2.bot.id });
  assert.equal(local.status, 201, JSON.stringify(local.body));
  const lticket = local.body.ticket as string;
  s.platform.db.prepare("UPDATE local_room_invites SET expires_at = ? WHERE ticket = ?").run(new Date(now + 60_000).toISOString(), lticket);
  now += 61_000;
  const claimsBefore = (s.platform.db.prepare("SELECT COUNT(*) n FROM local_room_invite_claims WHERE ticket = ?").get(lticket) as any).n as number;
  const claim = await req(s.base, "POST", `/v1/local-room-invites/${lticket}/claim`, tok(P2), { bots: [P2.bot.id] });
  assert.equal(claim.status, 410, `a lapsed local ticket must not seat anyone: ${JSON.stringify(claim.body)}`);
  assert.equal(claim.body.error.code, "expired");
  const lpreview = await req(s.base, "GET", `/v1/local-room-invites/${lticket}`);
  assert.equal(lpreview.status, 410, `a lapsed local ticket must not preview: ${JSON.stringify(lpreview.body)}`);
  const claimsAfter = (s.platform.db.prepare("SELECT COUNT(*) n FROM local_room_invite_claims WHERE ticket = ?").get(lticket) as any).n as number;
  assert.equal(claimsAfter, claimsBefore, "no claim for a refused local ticket");
});

// ---- Q4: the invite door is a read of the room; it must answer the room the number door answers.

test("Q4: once the matching window has passed, the invite door answers the open room the number door answers", async (t) => {
  let now = Date.now();
  const s = await startServer({ now: () => now, faceRooms: { ttlMs: 60_000, inviteTtlMs: 600_000 } });
  t.after(s.stop);
  const O = await ownerWithBot(s.base, "q4olga");
  const P = await ownerWithBot(s.base, "q4paul");
  const room = await newRoom(s.base, O, "444444");
  assert.equal(room.status, 200, JSON.stringify(room.body));
  assert.equal(room.body.status, "candidate");
  const roomId = room.body.room_id as string;
  const ticket = (await mint(s.base, O, roomId)).body.ticket as string;
  now += 60_001; // the 10-minute matching window is over

  const p = await preview(s.base, ticket);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body.status, "open", `a preview after the matching window must show the room as open (docs/FACE_ROOMS.md:464); got ${p.body.status}`);
  const join = await joinInvite(s.base, P, ticket);
  assert.equal(join.status, 200, JSON.stringify(join.body));
  assert.equal(join.body.status, "open", `join-invite must answer the same room view as a join by number (docs/FACE_ROOMS.md:130); got ${join.body.status}, started_at ${JSON.stringify(join.body.started_at)}`);
  // The very next read already says open: the two answers contradict each other.
  const later = await req(s.base, "GET", `/v1/face-rooms/${roomId}`, tok(P));
  assert.equal(later.status, 200, JSON.stringify(later.body));
  assert.equal(later.body.status, "open");
  assert.ok(later.body.started_at, "the room really did become open");
});
