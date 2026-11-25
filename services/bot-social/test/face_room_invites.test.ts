import assert from "node:assert/strict";
import { test } from "node:test";
import { loadFaceRoomLimits, newInviteTicket, isInviteTicket } from "../src/face-rooms.js";
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
const joinInvite = (base: string, o: { owner: { token: string }; bot: { id: string } }, ticket: string, extra: Record<string, unknown> = {}) =>
  req(base, "POST", "/v1/face-rooms/join-invite", tok(o), { ticket, bots: [o.bot.id], ...extra });
const preview = (base: string, ticket: string, ip?: string) =>
  req(base, "GET", `/v1/face-rooms/invites/${encodeURIComponent(ticket)}`, undefined, undefined, ip ? { "x-forwarded-for": ip } : {});

test("the ticket helpers: 256 random bits, base64url, nothing else accepted", () => {
  const t = newInviteTicket();
  assert.equal(t.length, 43);
  assert.match(t, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(t, newInviteTicket());
  assert.equal(isInviteTicket(t), true);
  assert.equal(isInviteTicket("short"), false);
  assert.equal(isInviteTicket(""), false);
  assert.equal(isInviteTicket(null), false);
  assert.equal(loadFaceRoomLimits().inviteTtlMs, 600_000);
  assert.equal(loadFaceRoomLimits({ inviteTtlMs: 1000 }).inviteTtlMs, 1000);
});

test("the lead mints a ticket and a second owner joins that same room with it", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const room = await newRoom(s.base, A, "313131");
  assert.equal(room.status, 200);
  const m = await mint(s.base, A, room.body.room_id);
  assert.equal(m.status, 201);
  assert.equal(m.body.room_id, room.body.room_id);
  assert.match(m.body.ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(m.body.url, `${s.base}/r/${m.body.ticket}`);
  assert.ok(Date.parse(m.body.expires_at) > Date.now());

  const p = await preview(s.base, m.body.ticket);
  assert.equal(p.status, 200);
  assert.equal(p.body.room_id, room.body.room_id);
  assert.equal(p.body.member_count, 1);
  assert.equal(p.body.max_members, 8);
  assert.equal(p.body.lead.handle, A.handle);
  assert.equal(p.body.expires_at, m.body.expires_at);
  assert.equal(p.body.name, null);

  const b = await joinInvite(s.base, B, m.body.ticket);
  assert.equal(b.status, 200);
  assert.equal(b.body.room_id, room.body.room_id);
  assert.equal(b.body.members.length, 2);
  assert.ok(b.body.members.some((x: any) => x.handle === B.handle));
  const mine = await req(s.base, "GET", "/v1/face-rooms", tok(B));
  assert.ok(mine.body.rooms.some((r: any) => r.room_id === room.body.room_id));
  // The room grant is written: B's Bot sees the room members it now shares.
  const again = await joinInvite(s.base, B, m.body.ticket);
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, "already_member");
});

test("only the room lead may mint or revoke a ticket", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const room = await newRoom(s.base, A, "323232");
  await joinInvite(s.base, B, (await mint(s.base, A, room.body.room_id)).body.ticket);
  const denied = await mint(s.base, B, room.body.room_id);
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, "not_lead");
  const ticket = (await mint(s.base, A, room.body.room_id)).body.ticket;
  const revokeByB = await req(s.base, "DELETE", `/v1/face-rooms/${room.body.room_id}/invites/${ticket}`, tok(B));
  assert.equal(revokeByB.status, 403);
  assert.equal(revokeByB.body.error.code, "not_lead");
});

test("a revoked ticket answers revoked; an unknown or malformed one is the same shape", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const room = await newRoom(s.base, A, "333333");
  const ticket = (await mint(s.base, A, room.body.room_id)).body.ticket;
  const del = await req(s.base, "DELETE", `/v1/face-rooms/${room.body.room_id}/invites/${ticket}`, tok(A));
  assert.equal(del.status, 200);
  assert.equal(del.body.revoked, true);
  const join = await joinInvite(s.base, B, ticket);
  assert.equal(join.status, 410);
  assert.equal(join.body.error.code, "revoked");
  const p = await preview(s.base, ticket);
  assert.equal(p.status, 410);
  assert.equal(p.body.error.code, "revoked");
  const unknown = await joinInvite(s.base, B, newInviteTicket());
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, "invite_not_found");
  const malformed = await joinInvite(s.base, B, "not-a-ticket");
  assert.equal(malformed.status, 404);
  assert.equal(malformed.body.error.code, "invite_not_found");
});

test("expiry is enforced server-side, on the join and on the preview", async (t) => {
  let now = Date.now();
  const s = await startServer({ now: () => now, faceRooms: { inviteTtlMs: 60_000 } });
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const room = await newRoom(s.base, A, "343434");
  const m = await mint(s.base, A, room.body.room_id);
  now += 60_001;
  const join = await joinInvite(s.base, B, m.body.ticket);
  assert.equal(join.status, 410);
  assert.equal(join.body.error.code, "expired");
  const p = await preview(s.base, m.body.ticket);
  assert.equal(p.status, 410);
  assert.equal(p.body.error.code, "expired");
});

test("a full room answers room_full even with a valid ticket", async (t) => {
  const s = await startServer({ faceRooms: { maxMembers: 2 } });
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const C = await ownerWithBot(s.base, "cid");
  const room = await newRoom(s.base, A, "353535");
  const ticket = (await mint(s.base, A, room.body.room_id)).body.ticket;
  await joinInvite(s.base, B, ticket);
  const third = await joinInvite(s.base, C, ticket);
  assert.equal(third.status, 409);
  assert.equal(third.body.error.code, "room_full");
  // the ticket is still usable for a Bot that is already inside? no: it is already a member
  const full = await preview(s.base, ticket);
  assert.equal(full.body.member_count, 2);
  assert.equal(full.body.max_members, 2);
});

test("a room that ended answers ended instead of half-applying the join", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const room = await newRoom(s.base, A, "363636");
  await joinInvite(s.base, B, (await mint(s.base, A, room.body.room_id)).body.ticket);
  const ticket = (await mint(s.base, A, room.body.room_id)).body.ticket;
  const C = await ownerWithBot(s.base, "cid");
  await req(s.base, "POST", `/v1/face-rooms/${room.body.room_id}/leave`, tok(A), {});
  await req(s.base, "POST", `/v1/face-rooms/${room.body.room_id}/leave`, tok(B), {});
  const join = await joinInvite(s.base, C, ticket);
  assert.equal(join.status, 410);
  assert.equal(join.body.error.code, "ended");
  const listed = await req(s.base, "GET", "/v1/face-rooms", tok(C));
  assert.equal(listed.body.rooms.length, 0);
});

test("#69: minting a face-room invite does not spend the 6-digit attempt budget", async (t) => {
  const s = await startServer({
    faceRooms: {
      attemptsPerAccount: 2, attemptsPerIp: 40,
      createsPerAccount: 10, createsPerIp: 10,
      invitesPerAccount: 20,
    },
  });
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const room = await newRoom(s.base, A, "696901");
  assert.equal(room.status, 200);
  // The create already used one of two code attempts. Three mints would trip the old shared bucket.
  for (let i = 0; i < 3; i += 1) assert.equal((await mint(s.base, A, room.body.room_id)).status, 201);
  const again = await newRoom(s.base, A, "696902");
  assert.equal(again.status, 200, "mints must not starve the next code join");
  const blocked = await newRoom(s.base, A, "696903");
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error.code, "rate_limited");
  assert.equal(blocked.body.error.scope, "account");
});

test("previews are rate-limited per address, so a leaked ticket cannot be brute-forced", async (t) => {
  const s = await startServer({ faceRooms: { attemptsPerIp: 3, attemptWindowMs: 60_000 } });
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const room = await newRoom(s.base, A, "373737");
  const ticket = (await mint(s.base, A, room.body.room_id)).body.ticket;
  const ip = "203.0.113.7";
  assert.equal((await preview(s.base, ticket, ip)).status, 200);
  assert.equal((await preview(s.base, newInviteTicket(), ip)).status, 404);
  assert.equal((await preview(s.base, ticket, ip)).status, 200);
  const blocked = await preview(s.base, ticket, ip);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error.code, "rate_limited");
});

test("the ticket reaches neither the audit log nor the attempt rows, and clients can discover the feature", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const room = await newRoom(s.base, A, "383838");
  const ticket = (await mint(s.base, A, room.body.room_id)).body.ticket;
  const ip = "198.51.100.23";
  assert.equal((await preview(s.base, ticket, ip)).status, 200);
  assert.equal((await joinInvite(s.base, B, ticket)).status, 200);
  assert.equal((await req(s.base, "DELETE", `/v1/face-rooms/${room.body.room_id}/invites/${ticket}`, tok(A))).status, 200);

  // The mint and the revoke are audited; the credential itself never is.
  const audit = s.platform.auditEvents({ kind: "owner", ownerId: A.owner_id } as any, { limit: 500 });
  const actions = audit.events.map((e: any) => e.action);
  assert.ok(actions.includes("face_room.invite_minted"), actions.join(","));
  assert.ok(actions.includes("face_room.invite_revoked"), actions.join(","));
  assert.equal(JSON.stringify(audit.events).includes(ticket), false, "the audit log must not store the ticket");

  // Attempt rows keep the outcome (`minted`, `preview`, `invited`), never the ticket.
  const attempts = s.platform.db.prepare("SELECT code, outcome FROM face_room_attempts").all() as any[];
  assert.ok(attempts.length > 0, "the mint, the preview and the join each left a row");
  assert.equal(JSON.stringify(attempts).includes(ticket), false, "attempt rows must not store the ticket");
  assert.deepEqual([...new Set(attempts.map((a: any) => a.outcome))].sort(), ["created", "invited", "minted", "preview"]);

  const info = await req(s.base, "GET", "/v1/platform");
  assert.ok(info.body.features.includes("face_room_invites"), "a client can tell the invite endpoints exist");
});

test("a ticket minted by a revoked home member previews as revoked and seats nobody (#183)", async (t) => {
  const s = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  t.after(s.stop);
  const onboard = await req(s.base, "POST", "/v1/onboard/flybot", undefined, { display_name: "Dana" });
  assert.equal(onboard.status, 201);
  const login = await req(s.base, "POST", "/v1/auth/login", undefined, { username: onboard.body.username, password: onboard.body.generated_password });
  assert.equal(login.status, 200);
  const token = login.body.owner_token as string;
  const homeId = onboard.body.home.bot_id as string;
  const added = await req(s.base, "POST", `/v1/homes/${homeId}/members`, token, { name: "writer", display_name: "Writer" });
  assert.equal(added.status, 201);
  const writerId = added.body.bot_id as string;
  const mintedToken = await req(s.base, "POST", `/v1/bots/${writerId}/token`, token);
  assert.equal(mintedToken.status, 200);
  const writerToken = mintedToken.body.bot_token as string;

  const room = await req(s.base, "POST", "/v1/face-rooms/join", token, { code: "414141", bots: [writerId] });
  assert.equal(room.status, 200);
  const roomId = room.body.room_id as string;

  // The Bot minted one ticket; the owner minted another on the same room, so the revocation has to tell them apart.
  const botTicket = (await req(s.base, "POST", `/v1/face-rooms/${roomId}/invites`, writerToken)).body.ticket as string;
  const ownerTicket = (await req(s.base, "POST", `/v1/face-rooms/${roomId}/invites`, token)).body.ticket as string;
  assert.notEqual(botTicket, ownerTicket);
  const B = await ownerWithBot(s.base, "ben");
  assert.equal((await joinInvite(s.base, B, botTicket)).status, 200, "the Bot's link works while it lives");

  // A second owner joined the same room, so the room survives losing its lead.
  const removed = await req(s.base, "DELETE", `/v1/homes/${homeId}/members/${writerId}`, token);
  assert.equal(removed.status, 200);
  assert.equal(removed.body.status, "revoked");

  const previewBot = await preview(s.base, botTicket);
  assert.equal(previewBot.status, 410);
  assert.equal(previewBot.body.error.code, "revoked");
  const C = await ownerWithBot(s.base, "cat");
  const joinBot = await joinInvite(s.base, C, botTicket);
  assert.equal(joinBot.status, 410);
  assert.equal(joinBot.body.error.code, "revoked");

  // Owner-minted tickets are not this identity's reach and keep working.
  const previewOwner = await preview(s.base, ownerTicket);
  assert.equal(previewOwner.status, 200);
  assert.equal((await joinInvite(s.base, C, ownerTicket)).status, 200);

  // The audit entry counts the withdrawn face-room tickets next to the other counts.
  const audit = s.platform.auditEvents({ kind: "owner", ownerId: onboard.body.owner_id } as any, { limit: 500 });
  const revoked: any = audit.events.find((e: any) => e.action === "home.member_revoked");
  assert.ok(revoked);
  assert.equal(revoked.data.revoked_face_invites, 1);
});
