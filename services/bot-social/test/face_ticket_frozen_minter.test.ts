import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

// A face-room ticket is a bearer credential, and a ticket a Bot minted is that identity's reach: `removeHomeMember`
// withdraws the tickets its revoked members minted for exactly this reason (#183). A stop is the softer kill switch
// ("stop now", resumable), so the ticket itself stays and the state is checked instead: while the minting Bot is
// frozen, the ticket must not preview the room or seat anyone, and resuming the Bot must make the same ticket work
// again. Without the check, a link handed out before an emergency stop keeps letting strangers in — permanently,
// because there is no kick door — with `effective_lead_bot_handle` still naming the stopped Bot.
//
// Owner-minted tickets (`created_by_bot IS NULL`) are the owner's own reach, not a Bot's, and stay usable.

async function req(base: string, method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}
const tok = (o: { owner: { token: string } }) => o.owner.token;
const seats = (s: { platform: any }, roomId: string) =>
  (s.platform.db.prepare("SELECT COUNT(*) n FROM face_room_members WHERE room_id = ? AND left_at IS NULL").get(roomId) as any).n as number;
const uses = (s: { platform: any }, roomId: string) =>
  (s.platform.db.prepare("SELECT used_count FROM face_room_invites WHERE room_id = ?").get(roomId) as any).used_count as number;

test("a ticket a frozen Bot minted stops previewing the room", async (t) => {
  const s = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  t.after(s.stop);
  const host = await ownerWithBot(s.base, "frzminter");
  const room = await req(s.base, "POST", "/v1/face-rooms/join", tok(host), { code: "741001", bots: [host.bot.id] });
  assert.equal(room.status, 200);
  const minted = await req(s.base, "POST", `/v1/face-rooms/${room.body.room_id}/invites`, host.reg.bot_token);
  assert.equal(minted.status, 201);
  const invite = s.platform.db.prepare("SELECT created_by_bot, created_by_owner_id FROM face_room_invites WHERE ticket = ?").get(minted.body.ticket) as any;
  assert.equal(invite.created_by_bot, host.bot.id);
  assert.equal(invite.created_by_owner_id, host.owner_id);

  assert.equal((await req(s.base, "POST", "/v1/emergency-stop", tok(host), { bot_id: host.bot.id })).status, 200);

  // The preview is public and names the room, so it is the first thing a leaked link shows while the Bot is stopped.
  const preview = await req(s.base, "GET", `/v1/face-rooms/invites/${minted.body.ticket}`);
  assert.equal(preview.status, 403);
  assert.equal(preview.body.error.code, "bot_frozen");
  assert.equal(preview.body.error.message, "this bot is frozen (emergency stop)");
  // The stop is a state, not a revoke: the ticket row is untouched, which is what makes resume enough below.
  const row = s.platform.db.prepare("SELECT revoked_at, expires_at FROM face_room_invites WHERE ticket = ?").get(minted.body.ticket) as any;
  assert.equal(row.revoked_at, null);
});

test("a ticket a frozen Bot minted seats nobody while that Bot is stopped", async (t) => {
  const s = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  t.after(s.stop);
  const host = await ownerWithBot(s.base, "frzticketseat");
  const guest = await ownerWithBot(s.base, "frzticketguest");
  const room = await req(s.base, "POST", "/v1/face-rooms/join", tok(host), { code: "741002", bots: [host.bot.id] });
  assert.equal(room.status, 200);
  const minted = await req(s.base, "POST", `/v1/face-rooms/${room.body.room_id}/invites`, host.reg.bot_token);
  assert.equal(minted.status, 201);
  const before = seats(s, room.body.room_id);
  assert.equal(before, 1);
  assert.equal((await req(s.base, "POST", "/v1/emergency-stop", tok(host), { bot_id: host.bot.id })).status, 200);

  // The seat itself is the damage: a refused join must leave the room exactly as it was, and not consume the ticket.
  const join = await req(s.base, "POST", "/v1/face-rooms/join-invite", tok(guest), { ticket: minted.body.ticket, bots: [guest.bot.id] });
  assert.equal(join.status, 403);
  assert.equal(join.body.error.code, "bot_frozen");
  assert.equal(join.body.error.message, "this bot is frozen (emergency stop)");
  assert.equal(seats(s, room.body.room_id), before);
  assert.equal(uses(s, room.body.room_id), 0);
});

test("resuming the minting Bot makes the same ticket work again", async (t) => {
  const s = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  t.after(s.stop);
  const host = await ownerWithBot(s.base, "frzresume");
  const guest = await ownerWithBot(s.base, "frzresumeguest");
  const room = await req(s.base, "POST", "/v1/face-rooms/join", tok(host), { code: "741003", bots: [host.bot.id] });
  assert.equal(room.status, 200);
  const minted = await req(s.base, "POST", `/v1/face-rooms/${room.body.room_id}/invites`, host.reg.bot_token);
  assert.equal(minted.status, 201);
  assert.equal((await req(s.base, "POST", "/v1/emergency-stop", tok(host), { bot_id: host.bot.id })).status, 200);
  const resumed = await req(s.base, "POST", `/v1/bots/${host.bot.id}/resume`, tok(host));
  assert.equal(resumed.status, 200);

  // A state gate, not a revoke: the stop left the ticket alive and resume makes it usable with nothing restored.
  const preview = await req(s.base, "GET", `/v1/face-rooms/invites/${minted.body.ticket}`);
  assert.equal(preview.status, 200);
  const join = await req(s.base, "POST", "/v1/face-rooms/join-invite", tok(guest), { ticket: minted.body.ticket, bots: [guest.bot.id] });
  assert.equal(join.status, 200);
  assert.ok(join.body.members.some((m: any) => m.handle === guest.handle));
  assert.equal(join.body.effective_lead_bot_handle, host.handle);
});

test("a ticket the owner minted is the owner's reach and survives a Bot stop", async (t) => {
  const s = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  t.after(s.stop);
  const host = await ownerWithBot(s.base, "ownermint");
  const guest = await ownerWithBot(s.base, "ownermintguest");
  const room = await req(s.base, "POST", "/v1/face-rooms/join", tok(host), { code: "741002", bots: [host.bot.id] });
  assert.equal(room.status, 200);
  const minted = await req(s.base, "POST", `/v1/face-rooms/${room.body.room_id}/invites`, tok(host));
  assert.equal(minted.status, 201);
  const invite = s.platform.db.prepare("SELECT created_by_bot FROM face_room_invites WHERE ticket = ?").get(minted.body.ticket) as any;
  assert.equal(invite.created_by_bot, null);
  assert.equal((await req(s.base, "POST", "/v1/emergency-stop", tok(host), { bot_id: host.bot.id })).status, 200);
  const preview = await req(s.base, "GET", `/v1/face-rooms/invites/${minted.body.ticket}`);
  assert.equal(preview.status, 200);
  const join = await req(s.base, "POST", "/v1/face-rooms/join-invite", tok(guest), { ticket: minted.body.ticket, bots: [guest.bot.id] });
  assert.equal(join.status, 200);
  assert.ok(join.body.members.some((m: any) => m.handle === guest.handle));
});
