import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

// A guest that joined a face room with a ticket keeps the seat when the lead withdraws that ticket. Its retries
// then answer `410 revoked` (or `410 expired` on an older ticket), and both codes are in FACE_JOIN_OUTCOMES, so
// the retries spend the guest's account join budget. #336 gave the local-room `claim_ended` removal an exception
// and #338 gave the local-room ticket door the same rule for a home that had claimed the link; this is the same
// removal on the face-room ticket door, for a home the ticket already seated.

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
const joinByNumber = (base: string, o: any, code: string) => req(base, "POST", "/v1/face-rooms/join", tok(o), { code, bots: [o.bot.id] });
const joinByInvite = (base: string, o: any, ticket: string) => req(base, "POST", "/v1/face-rooms/join-invite", tok(o), { ticket, bots: [o.bot.id] });
const mintTicket = async (base: string, o: any, roomId: string) => {
  const r = await req(base, "POST", `/v1/face-rooms/${roomId}/invites`, tok(o), {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.ticket as string;
};
const revokeTicket = (base: string, o: any, roomId: string, ticket: string) =>
  req(base, "DELETE", `/v1/face-rooms/${roomId}/invites/${ticket}`, tok(o));
const leaveRoom = (base: string, o: any, roomId: string) => req(base, "POST", `/v1/face-rooms/${roomId}/leave`, tok(o), { bots: [o.bot.id] });
const outcomes = (s: any, ownerId: string) =>
  (s.platform.db.prepare("SELECT outcome, COUNT(*) n FROM face_room_attempts WHERE owner_id = ? GROUP BY outcome").all(ownerId) as any[]);
const statuses = (seen: any[]) => seen.map((x) => x[0]);

test("a guest whose face-room ticket was withdrawn keeps its join budget", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const C = await ownerWithBot(s.base, "cam");

  const room = await joinByNumber(s.base, A, "414141");
  assert.equal(room.status, 200, JSON.stringify(room.body));
  const ticket = await mintTicket(s.base, A, room.body.room_id);
  assert.equal((await joinByInvite(s.base, B, ticket)).status, 200);
  // An unrelated room seats a home that was never here, so the door itself is not the variable below.
  assert.equal((await joinByNumber(s.base, C, "525252")).status, 200);

  // The lead withdraws the ticket; the seat B already holds stays (the documented shape of a withdrawn link).
  assert.equal((await revokeTicket(s.base, A, room.body.room_id, ticket)).status, 200);

  const seen: any[] = [];
  for (let i = 0; i < 12; i++) {
    const r = await joinByInvite(s.base, B, ticket);
    seen.push([r.status, r.body.code]);
  }
  assert.deepEqual(statuses(seen), [410, 410, 410, 410, 410, 410, 410, 410, 410, 410, 410, 410], JSON.stringify(seen));
  assert.equal(seen[0][1], "revoked", JSON.stringify(seen));

  // A fresh peer is unaffected at the same moment.
  const peer = await ownerWithBot(s.base, "dee");
  assert.equal((await joinByNumber(s.base, peer, "636363")).status, 200);

  // The guest must still reach a room it was never in.
  const unrelated = await joinByNumber(s.base, B, "636363");
  assert.equal(unrelated.status, 200, `a guest must still reach an unrelated room; got ${unrelated.status} ${JSON.stringify(unrelated.body)} (attempts ${JSON.stringify(outcomes(s, B.owner_id))})`);
  assert.ok(outcomes(s, B.owner_id).some((r: any) => r.outcome === "revoked_after_seat"), JSON.stringify(outcomes(s, B.owner_id)));
});

test("a guest whose older ticket expired keeps its join budget", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const room = await joinByNumber(s.base, A, "717171");
  const ticket = await mintTicket(s.base, A, room.body.room_id);
  assert.equal((await joinByInvite(s.base, B, ticket)).status, 200);
  // The ticket's own deadline passes: the refused code is `expired`, the room and the seat stay.
  s.platform.db.prepare("UPDATE face_room_invites SET expires_at = ? WHERE ticket = ?").run("2020-01-01T00:00:00.000Z", ticket);

  const seen: any[] = [];
  for (let i = 0; i < 12; i++) {
    const r = await joinByInvite(s.base, B, ticket);
    seen.push([r.status, r.body.code]);
  }
  assert.deepEqual(statuses(seen), [410, 410, 410, 410, 410, 410, 410, 410, 410, 410, 410, 410], JSON.stringify(seen));
  assert.equal(seen[0][1], "expired", JSON.stringify(seen));
  const unrelated = await joinByNumber(s.base, B, "818181");
  assert.equal(unrelated.status, 200, `a guest must still reach an unrelated room; got ${unrelated.status} ${JSON.stringify(unrelated.body)} (attempts ${JSON.stringify(outcomes(s, B.owner_id))})`);
  assert.ok(outcomes(s, B.owner_id).some((r: any) => r.outcome === "expired_after_seat"), JSON.stringify(outcomes(s, B.owner_id)));
});

test("a guest whose room ended keeps its join budget", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const room = await joinByNumber(s.base, A, "434343");
  const ticket = await mintTicket(s.base, A, room.body.room_id);
  assert.equal((await joinByInvite(s.base, B, ticket)).status, 200);
  // Everybody leaves, so the room ends; B was seated here and still holds the dead ticket.
  for (const home of [B, A]) {
    const left = await leaveRoom(s.base, home, room.body.room_id);
    assert.ok([200, 204].includes(left.status), JSON.stringify(left.body));
  }

  const seen: any[] = [];
  for (let i = 0; i < 12; i++) {
    const r = await joinByInvite(s.base, B, ticket);
    seen.push([r.status, r.body.code]);
  }
  assert.deepEqual(statuses(seen), [410, 410, 410, 410, 410, 410, 410, 410, 410, 410, 410, 410], JSON.stringify(seen));
  assert.equal(seen[0][1], "ended", JSON.stringify(seen));
  const unrelated = await joinByNumber(s.base, B, "454545");
  assert.equal(unrelated.status, 200, `a guest of an ended room must still reach an unrelated room; got ${unrelated.status} ${JSON.stringify(unrelated.body)} (attempts ${JSON.stringify(outcomes(s, B.owner_id))})`);
  assert.ok(outcomes(s, B.owner_id).some((r: any) => r.outcome === "ended_after_seat"), JSON.stringify(outcomes(s, B.owner_id)));
});

test("control: a home that never sat in the room still spends the budget on its ended ticket", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const room = await joinByNumber(s.base, A, "474747");
  const ticket = await mintTicket(s.base, A, room.body.room_id);
  const left = await leaveRoom(s.base, A, room.body.room_id);
  assert.ok([200, 204].includes(left.status), JSON.stringify(left.body));
  const seen: any[] = [];
  for (let i = 0; i < 11; i++) {
    const r = await joinByInvite(s.base, B, ticket);
    seen.push([r.status, r.body.code]);
  }
  assert.deepEqual(seen.at(-1), [429, "rate_limited"], JSON.stringify(seen));
  assert.equal((await joinByNumber(s.base, B, "484848")).status, 429, JSON.stringify(seen));
});

test("control: a home the ticket never seated still spends the budget on it", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const room = await joinByNumber(s.base, A, "919191");
  const ticket = await mintTicket(s.base, A, room.body.room_id);
  assert.equal((await revokeTicket(s.base, A, room.body.room_id, ticket)).status, 200);

  const seen: any[] = [];
  for (let i = 0; i < 11; i++) {
    const r = await joinByInvite(s.base, B, ticket);
    seen.push([r.status, r.body.code]);
  }
  assert.deepEqual(seen.at(-1), [429, "rate_limited"], JSON.stringify(seen));
  assert.equal((await joinByNumber(s.base, B, "828282")).status, 429, JSON.stringify(seen));
});

test("control: a home that never used an expired ticket still spends the budget on it", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const room = await joinByNumber(s.base, A, "939393");
  const ticket = await mintTicket(s.base, A, room.body.room_id);
  s.platform.db.prepare("UPDATE face_room_invites SET expires_at = ? WHERE ticket = ?").run("2020-01-01T00:00:00.000Z", ticket);
  const seen: any[] = [];
  for (let i = 0; i < 11; i++) {
    const r = await joinByInvite(s.base, B, ticket);
    seen.push([r.status, r.body.code]);
  }
  assert.deepEqual(seen.at(-1), [429, "rate_limited"], JSON.stringify(seen));
  assert.equal((await joinByNumber(s.base, B, "848484")).status, 429, JSON.stringify(seen));
});
