import assert from "node:assert/strict";
import { test } from "node:test";
import { generateEd25519 } from "../src/crypto.js";
import { isLocalInviteTicket, newLocalInviteTicket } from "../src/local-room-invites.js";
import { ownerWithBot, startServer } from "./helpers.js";

// Bot Social #60: a ticket for a room that lives in one FlyBot home. The server keeps the ticket, never the room.

async function req(base: string, method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  const json = text ? JSON.parse(text) : {};
  return { status: r.status, body: json.error ? json.error : json };
}
const tok = (o: any) => o.owner.token;
const owner = (o: any) => ({ kind: "owner" as const, ownerId: o.owner_id });
const ROOM = "session-3f2a9c1e-6b7d-4e1a-9f0c-2d4b6a8c0e12";
const mint = (base: string, o: any, body: Record<string, unknown> = {}, ip?: string) =>
  req(base, "POST", "/v1/local-room-invites", tok(o), { room_id: ROOM, name: "Launch plan", bot_id: o.bot.id, ...body }, ip ? { "x-forwarded-for": ip } : {});
const preview = (base: string, ticket: string, token?: string, ip?: string) =>
  req(base, "GET", `/v1/local-room-invites/${encodeURIComponent(ticket)}`, token, undefined, ip ? { "x-forwarded-for": ip } : {});
const claim = (base: string, o: any, ticket: string, bots: string[]) =>
  req(base, "POST", `/v1/local-room-invites/${encodeURIComponent(ticket)}/claim`, tok(o), { bots });
const revoke = (base: string, o: any, ticket: string) => req(base, "DELETE", `/v1/local-room-invites/${encodeURIComponent(ticket)}`, tok(o));
async function secondBot(base: string, o: any, suffix: string) {
  const kp = generateEd25519();
  const handle = `${o.handle.slice(1).replace(/\.bot$/, "")}${suffix}.bot`;
  const r = await o.owner.req("POST", "/v1/bots", { handle, public_key: { alg: "Ed25519", kid: "k1", value: kp.publicKey } });
  return { id: r.bot_id as string, handle: `@${handle}`, kp };
}

test("#60: the ticket helpers — 22 characters of base64url, the shape a local link carries", () => {
  const t = newLocalInviteTicket();
  assert.match(t, /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(t, newLocalInviteTicket());
  assert.equal(isLocalInviteTicket(t), true);
  assert.equal(isLocalInviteTicket("a".repeat(15)), false);
  assert.equal(isLocalInviteTicket("a".repeat(65)), false);
  assert.equal(isLocalInviteTicket("has.dot.in.it.abcdefgh"), false);
});

test("#60: mint answers the two-segment link, the preview is public, and the platform lists the feature", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const m = await mint(s.base, A);
  assert.equal(m.status, 201, JSON.stringify(m.body));
  assert.equal(m.body.kind, "local_room");
  assert.match(m.body.ticket, /^[A-Za-z0-9_-]{16,64}$/);
  assert.equal(m.body.url, `${s.base}/r/${A.handle}/${m.body.ticket}`);
  assert.equal(m.body.room_id, ROOM);
  assert.equal(m.body.expires_at, null, "a local room's link has no deadline");
  assert.equal(m.body.inviter.handle, A.handle);

  const p = await preview(s.base, m.body.ticket);
  assert.equal(p.status, 200);
  assert.equal(p.body.kind, "local_room");
  assert.equal(p.body.name, "Launch plan");
  assert.equal(p.body.lead.handle, A.handle);
  assert.equal(typeof p.body.lead.owner_name, "string");
  assert.equal(p.body.expires_at, m.body.expires_at);
  assert.equal(p.body.claimed, false);
  assert.equal("claimer" in p.body, false, "an anonymous caller never sees a claimer field");
  const mine = await preview(s.base, m.body.ticket, tok(A));
  assert.equal(mine.body.claimer, null);

  const info = await req(s.base, "GET", "/v1/platform");
  assert.ok(info.body.features.includes("local_room_invites"));
  assert.ok(info.body.features.includes("face_room_invites"), "the face-room feature is still listed");
});

test("#60: a room name is cleaned, a bad room id is refused, and a face room keeps its own invitation", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const named = await mint(s.base, A, { name: "<b>War\nroom</b> @all" });
  assert.equal(named.status, 201);
  assert.doesNotMatch(String(named.body.name), /[<>@\n]/);
  assert.equal((await mint(s.base, A, { room_id: "has space" })).status, 400);
  assert.equal((await mint(s.base, A, { room_id: "x".repeat(65) })).status, 400);
  const face = await req(s.base, "POST", "/v1/face-rooms/join", tok(A), { code: "616161", bots: [A.bot.id] });
  assert.equal(face.status, 200);
  const clash = await mint(s.base, A, { room_id: face.body.room_id });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.code, "face_room");
  const B = await ownerWithBot(s.base, "ben");
  const theirs = await mint(s.base, A, { bot_id: B.bot.id });
  assert.equal(theirs.status, 404, "a link can only knock on one of your own Bots");
});

test("#60, #65: each home claims once with its Bots; another home joins with the same link", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const C = await ownerWithBot(s.base, "cat");
  const B2 = await secondBot(s.base, B, "two");
  const m = await mint(s.base, A);
  const ticket = m.body.ticket as string;

  const own = await claim(s.base, A, ticket, [A.bot.id]);
  assert.equal(own.status, 409);
  assert.equal(own.body.code, "own_invite");
  const foreign = await claim(s.base, B, ticket, [C.bot.id]);
  assert.equal(foreign.status, 404, "a home cannot bring a Bot it does not own");
  assert.equal(foreign.body.code, "bot_not_found");

  const first = await claim(s.base, B, ticket, [B.bot.id, B2.handle]);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.claimed, true);
  assert.equal(first.body.room_id, ROOM);
  assert.equal(first.body.inviter.handle, A.handle);
  assert.deepEqual([...first.body.bots].sort(), [B.handle, B2.handle].sort());

  const retry = await claim(s.base, B, ticket, [B2.id, B.handle]);
  assert.equal(retry.status, 200, "the same home with the same Bots is the idempotent retry");
  const otherSet = await claim(s.base, B, ticket, [B.bot.id]);
  assert.equal(otherSet.status, 409);
  assert.equal(otherSet.body.code, "already_claimed");
  // #65: the link admits anyone it is given to, until withdrawn: a second home joins with the same ticket.
  const before = await preview(s.base, ticket, tok(C));
  assert.equal(before.body.claimed, false, "another home's claim does not close the link");
  assert.equal(before.body.claimer, null, "a signed-in owner who has not joined sees no claim");
  const otherHome = await claim(s.base, C, ticket, [C.bot.id]);
  assert.equal(otherHome.status, 200, JSON.stringify(otherHome.body));
  assert.deepEqual(otherHome.body.bots, [C.handle]);
  assert.deepEqual(otherHome.body.claimer.bots, [C.handle], "the claiming home reads its own claim only");

  // The inviter re-reads every home that joined; an anonymous caller learns nothing about claims.
  const seen = await preview(s.base, ticket, tok(A));
  assert.equal(seen.body.claimers.length, 2);
  const forB = seen.body.claimers.find((c: any) => c.bots.includes(B.handle));
  assert.deepEqual([...forB.bots].sort(), [B.handle, B2.handle].sort());
  assert.deepEqual(forB.members.map((m: any) => m.handle).sort(), [B.handle, B2.handle].sort(), "each seat carries a name to show");
  assert.ok(forB.members.every((m: any) => typeof m.display_name === "string" && m.display_name), "names are cleaned strings");
  assert.deepEqual(seen.body.claimers.find((c: any) => c.bots.includes(C.handle)).bots, [C.handle]);
  assert.deepEqual(seen.body.claimer.bots, [C.handle], "claimer is the latest, for an older reader");
  const anon = await preview(s.base, ticket);
  assert.equal(anon.body.claimed, false);
  assert.equal("claimer" in anon.body, false);
  assert.equal("claimers" in anon.body, false);
  const asB = await preview(s.base, ticket, tok(B));
  assert.equal(asB.body.claimed, true);
  assert.equal("claimers" in asB.body, false, "a guest never sees the other guests' claims");

  const unknown = await claim(s.base, B, newLocalInviteTicket(), [B.bot.id]);
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.code, "invite_not_found");
  assert.equal((await preview(s.base, newLocalInviteTicket())).body.code, "invite_not_found");
});

test("#60: an expired or withdrawn ticket refuses a claim and writes nothing", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const count = () => (s.platform.db.prepare("SELECT COUNT(*) n FROM grants").get() as any).n as number;
  const late = await mint(s.base, A);
  // A ticket minted before links lost their deadline keeps the one it was given.
  s.platform.db.prepare("UPDATE local_room_invites SET expires_at = ? WHERE ticket = ?").run(new Date(Date.now() + 10 * 60e3).toISOString(), late.body.ticket);
  const gone = await mint(s.base, A);
  assert.equal((await revoke(s.base, A, gone.body.ticket)).status, 204);
  const before = count();
  const real = s.platform.nowMs;
  s.platform.nowMs = () => real() + 11 * 60e3;
  const expired = await claim(s.base, B, late.body.ticket, [B.bot.id]);
  s.platform.nowMs = real;
  assert.equal(expired.status, 410);
  assert.equal(expired.body.code, "expired");
  const revoked = await claim(s.base, B, gone.body.ticket, [B.bot.id]);
  assert.equal(revoked.status, 410);
  assert.equal(revoked.body.code, "revoked");
  assert.equal(count(), before, "no grant for a refused claim");
  assert.equal((await preview(s.base, gone.body.ticket)).body.code, "revoked");
});

test("a local room's link has no deadline: a week later it still previews and claims, until it is withdrawn", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const kept = await mint(s.base, A);
  const pulled = await mint(s.base, A);
  assert.equal(kept.body.expires_at, null);
  const row = s.platform.db.prepare("SELECT expires_at FROM local_room_invites WHERE ticket = ?").get(kept.body.ticket) as any;
  assert.equal(row.expires_at, "", "stored with no deadline");
  const real = s.platform.nowMs;
  s.platform.nowMs = () => real() + 7 * 24 * 60 * 60e3;
  try {
    const p = await preview(s.base, kept.body.ticket);
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.expires_at, null);
    assert.equal(p.body.claimed, false);
    const c = await claim(s.base, B, kept.body.ticket, [B.bot.id]);
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal(c.body.claimed, true);
    // Withdrawing still ends a link, however old.
    assert.equal((await revoke(s.base, A, pulled.body.ticket)).status, 204);
    const after = await claim(s.base, B, pulled.body.ticket, [B.bot.id]);
    assert.equal(after.status, 410);
    assert.equal(after.body.code, "revoked");
    // And a used link still works for the next person it is given to (#65).
    const C = await ownerWithBot(s.base, "cat");
    assert.equal((await claim(s.base, C, kept.body.ticket, [C.bot.id])).status, 200);
  } finally {
    s.platform.nowMs = real;
  }
});

test("#60: several live tickets for one room; revoking one leaves the other", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const C = await ownerWithBot(s.base, "cat");
  const one = await mint(s.base, A);
  const two = await mint(s.base, A);
  assert.notEqual(one.body.ticket, two.body.ticket);
  assert.equal((await revoke(s.base, A, one.body.ticket)).status, 204);
  assert.equal((await claim(s.base, B, one.body.ticket, [B.bot.id])).status, 410);
  assert.equal((await claim(s.base, C, two.body.ticket, [C.bot.id])).status, 200);
  assert.equal((await revoke(s.base, B, two.body.ticket)).status, 403, "a third owner cannot end it");
  assert.equal((await revoke(s.base, A, one.body.ticket)).status, 404, "a second revoke finds nothing");
});

test("#60: the claim is the room door — the pair talks naming that room, and nowhere else", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben"); // a stranger: no friendship, no shared Bot
  const C = await ownerWithBot(s.base, "cat");
  s.platform.enableCustody(owner(A), A.bot.id, { private_key_pem: A.kp.privateKeyPem });
  s.platform.enableCustody(owner(B), B.bot.id, { private_key_pem: B.kp.privateKeyPem });
  const m = await mint(s.base, A);
  // Before the claim the stranger cannot reach the inviter at all, with or without the room.
  assert.throws(() => s.platform.sendAsMember(owner(B), { from_bot_id: B.bot.id, to: A.handle, text: "knock", room_id: ROOM }), (e: any) => e.code === "room_not_shared");
  assert.equal((await claim(s.base, B, m.body.ticket, [B.bot.id])).status, 200);

  const ask = s.platform.sendAsMember(owner(B), { from_bot_id: B.bot.id, to: A.handle, text: "FLYBOT-ROOM-SHARE ask", room_id: ROOM });
  assert.equal(ask.message.status, "delivered");
  assert.deepEqual((ask.message as any).policy.reasons, ["room.context", "dlp.clean"]);
  const back = s.platform.sendAsMember(owner(A), { from_bot_id: A.bot.id, to: B.handle, text: "welcome to the group", room_id: ROOM });
  assert.equal(back.message.status, "delivered", "the inviter answers on the same door");
  const arrived = await B.bot.events(0);
  assert.ok(arrived.events.some((e: any) => e.event_type === "message.received" && e.from.handle === A.handle));

  // The claim is not a friendship: a 1:1 send, another room, or a third Bot are all still refused.
  assert.throws(() => s.platform.sendAsMember(owner(B), { from_bot_id: B.bot.id, to: A.handle, text: "plain" }), (e: any) => e.code === "no_relationship");
  assert.throws(() => s.platform.sendAsMember(owner(B), { from_bot_id: B.bot.id, to: A.handle, text: "x", room_id: "session-other" }), (e: any) => e.code === "room_not_shared");
  assert.throws(() => s.platform.sendAsMember(owner(B), { from_bot_id: B.bot.id, to: C.handle, text: "x", room_id: ROOM }), (e: any) => e.code === "room_not_shared");
  const rels = s.platform.db.prepare("SELECT status FROM relationships WHERE (requester_bot = ? AND target_bot = ?) OR (requester_bot = ? AND target_bot = ?)").all(A.bot.id, B.bot.id, B.bot.id, A.bot.id) as any[];
  assert.deepEqual(rels.map((r) => r.status), ["room"], "no friendship row is written");

  // The seat has no clock of its own.
  const real = s.platform.nowMs;
  s.platform.nowMs = () => real() + 60 * 60e3;
  assert.equal(s.platform.sendAsMember(owner(B), { from_bot_id: B.bot.id, to: A.handle, text: "an hour later", room_id: ROOM }).message.status, "delivered");
  s.platform.nowMs = real;

  // Withdrawn by the inviter (#65): nobody new can join, and the home that joined keeps its seat.
  assert.equal((await revoke(s.base, A, m.body.ticket)).status, 204);
  assert.equal(s.platform.sendAsMember(owner(B), { from_bot_id: B.bot.id, to: A.handle, text: "after", room_id: ROOM }).message.status, "delivered");
  const late = await claim(s.base, C, m.body.ticket, [C.bot.id]);
  assert.equal(late.status, 410);
  assert.equal(late.body.code, "revoked");
  // The inviter removing that guest ends its claim: the door is gone for that pair.
  assert.equal((await req(s.base, "DELETE", `/v1/local-room-invites/${m.body.ticket}/claims/${encodeURIComponent(C.handle)}`, tok(A))).status, 404, "a home that never joined has no claim to end");
  assert.equal((await req(s.base, "DELETE", `/v1/local-room-invites/${m.body.ticket}/claims/${encodeURIComponent(B.handle)}`, tok(B))).status, 403, "only the minter ends someone's claim");
  assert.equal((await req(s.base, "DELETE", `/v1/local-room-invites/${m.body.ticket}/claims/${encodeURIComponent(B.handle)}`, tok(A))).status, 204);
  assert.throws(() => s.platform.sendAsMember(owner(B), { from_bot_id: B.bot.id, to: A.handle, text: "after", room_id: ROOM }), (e: any) => e.code === "room_not_shared");
  assert.throws(() => s.platform.sendAsMember(owner(A), { from_bot_id: A.bot.id, to: B.handle, text: "after", room_id: ROOM }), (e: any) => e.code === "room_not_shared");
});

test("#60: the guest's own release ends its reach, and the inviter's other guest keeps theirs", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const C = await ownerWithBot(s.base, "cat");
  s.platform.enableCustody(owner(B), B.bot.id, { private_key_pem: B.kp.privateKeyPem });
  s.platform.enableCustody(owner(C), C.bot.id, { private_key_pem: C.kp.privateKeyPem });
  const forB = await mint(s.base, A);
  const forC = await mint(s.base, A);
  assert.equal((await claim(s.base, B, forB.body.ticket, [B.bot.id])).status, 200);
  assert.equal((await claim(s.base, C, forC.body.ticket, [C.bot.id])).status, 200);
  assert.equal((await revoke(s.base, B, forB.body.ticket)).status, 204, "the claimer may release its own claim");
  assert.throws(() => s.platform.sendAsMember(owner(B), { from_bot_id: B.bot.id, to: A.handle, text: "x", room_id: ROOM }), (e: any) => e.code === "room_not_shared");
  assert.equal(s.platform.sendAsMember(owner(C), { from_bot_id: C.bot.id, to: A.handle, text: "still here", room_id: ROOM }).message.status, "delivered");
  // A link stays open after a guest leaves (#65): that home may come back, and so may anyone else it is given to.
  const again = await claim(s.base, B, forB.body.ticket, [B.bot.id]);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(s.platform.sendAsMember(owner(B), { from_bot_id: B.bot.id, to: A.handle, text: "back", room_id: ROOM }).message.status, "delivered");
  const D = await ownerWithBot(s.base, "dan");
  assert.equal((await claim(s.base, D, forB.body.ticket, [D.bot.id])).status, 200);
});

test("#65: withdrawing with end_claims (the room is gone) ends every home's reach", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const C = await ownerWithBot(s.base, "cat");
  for (const o of [B, C]) s.platform.enableCustody(owner(o), o.bot.id, { private_key_pem: o.kp.privateKeyPem });
  const m = await mint(s.base, A);
  assert.equal((await claim(s.base, B, m.body.ticket, [B.bot.id])).status, 200);
  assert.equal((await claim(s.base, C, m.body.ticket, [C.bot.id])).status, 200);
  assert.equal((await req(s.base, "DELETE", `/v1/local-room-invites/${m.body.ticket}?end_claims=1`, tok(A))).status, 204);
  for (const o of [B, C]) {
    assert.throws(() => s.platform.sendAsMember(owner(o), { from_bot_id: o.bot.id, to: A.handle, text: "x", room_id: ROOM }), (e: any) => e.code === "room_not_shared");
  }
  assert.equal((await preview(s.base, m.body.ticket)).body.code, "revoked");
});

test("#69: creating local-room links does not spend the face-code attempt budget", async (t) => {
  const s = await startServer({
    faceRooms: {
      attemptsPerAccount: 3, attemptsPerIp: 3, attemptWindowMs: 600_000,
      createsPerAccount: 20, createsPerIp: 20,
      invitesPerAccount: 30, invitesPerIp: 30,
      failsBeforeLockout: 20,
    },
  });
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const ip = "203.0.113.69";
  let ticket = "";
  // More mints than either code-attempt cap (3). Each one is an ordinary owner action.
  for (let i = 0; i < 6; i += 1) {
    const m = await mint(s.base, A, {}, ip);
    assert.equal(m.status, 201, JSON.stringify(m.body));
    ticket = m.body.ticket;
  }
  assert.equal((await preview(s.base, ticket, undefined, ip)).status, 200, "mints are not in the per-address preview window");
  const joined = await req(s.base, "POST", "/v1/face-rooms/join", tok(A), { code: "696969", bots: [A.bot.id] }, { "x-forwarded-for": ip });
  assert.equal(joined.status, 200, "mints must not starve a code join");
  // Guesses from another address, so the per-IP window (one preview + one join) is not what refuses them.
  const guess = (code: string) => req(s.base, "POST", "/v1/face-rooms/join", tok(A), { code, bots: [A.bot.id] }, { "x-forwarded-for": "203.0.113.70" });
  assert.equal((await guess("12")).status, 400);
  assert.equal((await guess("34")).status, 400);
  const blocked = await guess("56");
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.code, "rate_limited");
  assert.equal(blocked.body.scope, "account", "the code-guess limiter still closes the account");
});

test("#69: invite-link mints have their own cap, and filling it still leaves code joins open", async (t) => {
  const s = await startServer({
    faceRooms: {
      invitesPerAccount: 3, invitesPerIp: 20, inviteMintWindowMs: 600_000,
      attemptsPerAccount: 2, attemptsPerIp: 20,
      createsPerAccount: 5, createsPerIp: 5,
    },
  });
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const ip = "203.0.113.71";
  for (let i = 0; i < 3; i += 1) assert.equal((await mint(s.base, A, {}, ip)).status, 201);
  const over = await mint(s.base, A, {}, ip);
  assert.equal(over.status, 429);
  assert.equal(over.body.code, "rate_limited");
  assert.equal(over.body.scope, "account_invite");
  assert.match(over.body.message, /invite/);
  assert.equal(typeof over.body.retry_after, "number");
  const joined = await req(s.base, "POST", "/v1/face-rooms/join", tok(A), { code: "717171", bots: [A.bot.id] }, { "x-forwarded-for": ip });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
});

test("#60: the public preview has its own per-address limit", async (t) => {
  const s = await startServer({ faceRooms: { attemptsPerIp: 3 } });
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const m = await mint(s.base, A);
  for (let i = 0; i < 3; i += 1) assert.equal((await preview(s.base, m.body.ticket, undefined, "203.0.113.9")).status, 200);
  const blocked = await preview(s.base, m.body.ticket, undefined, "203.0.113.9");
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.code, "rate_limited");
  assert.equal((await preview(s.base, m.body.ticket, undefined, "203.0.113.10")).status, 200, "another address is not blocked");
});
