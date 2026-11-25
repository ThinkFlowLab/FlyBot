import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

// A join the door already completed, repeated because the answer was lost in transit, is not a guess: the seat is
// the proof that this home already got the room. `already_member` is written for exactly that repeat, and it sits in
// FACE_JOIN_OUTCOMES, so every repeat spends the home's account join budget and the tenth makes the door answer 429
// for every room in the window. The local-room door answers the same repeat with success ("the usual retry (the
// answer was lost)", src/platform.ts claimLocalRoomInvite) and charges nothing.

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
const outcomes = (s: any, ownerId: string) =>
  (s.platform.db.prepare("SELECT outcome, COUNT(*) n FROM face_room_attempts WHERE owner_id = ? GROUP BY outcome").all(ownerId) as any[]);
const countOf = (rows: any[], outcome: string) => rows.filter((r) => r.outcome === outcome).reduce((a, r) => a + r.n, 0);

test("a repeat of a join this home already completed keeps its join budget", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const C = await ownerWithBot(s.base, "cam");
  const room = await joinByNumber(s.base, A, "424242");
  assert.equal(room.status, 200, JSON.stringify(room.body));
  const minted = await req(s.base, "POST", `/v1/face-rooms/${room.body.room_id}/invites`, tok(A), {});
  assert.equal(minted.status, 201, JSON.stringify(minted.body));
  const ticket = minted.body.ticket as string;

  assert.equal((await joinByInvite(s.base, B, ticket)).status, 200);
  const seen: any[] = [];
  for (let i = 0; i < 11; i++) {
    const r = await joinByInvite(s.base, B, ticket);
    seen.push([r.status, r.body.code]);
  }
  // The answer does not change: the repeat still says "every Bot you brought is already in the room".
  assert.equal(seen[0][0], 409, JSON.stringify(seen));
  assert.equal(seen[0][1], "already_member", JSON.stringify(seen));
  // The refusals stay in the log.
  assert.ok(countOf(outcomes(s, B.owner_id), "already_member") >= 9, JSON.stringify(outcomes(s, B.owner_id)));

  // A room B was never in, joined the ordinary way: the door is not the variable.
  assert.equal((await joinByNumber(s.base, C, "555555")).status, 200);
  const unrelated = await joinByNumber(s.base, B, "555555");
  assert.equal(unrelated.status, 200, `a repeat of a completed join must not lock the home out of other rooms; got ${unrelated.status} ${JSON.stringify(unrelated.body)}`);
});

test("control: a ticket this home never redeemed still spends the budget", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const room = await joinByNumber(s.base, A, "626262");
  const minted = await req(s.base, "POST", `/v1/face-rooms/${room.body.room_id}/invites`, tok(A), {});
  const ticket = minted.body.ticket as string;
  assert.equal((await req(s.base, "DELETE", `/v1/face-rooms/${room.body.room_id}/invites/${encodeURIComponent(ticket)}`, tok(A))).status, 200);

  const seen: any[] = [];
  for (let i = 0; i < 11; i++) seen.push((await joinByInvite(s.base, B, ticket)).status);
  assert.equal(seen.at(-1), 429, `an unredeemed dead ticket must still cost the window; got ${JSON.stringify(seen)}`);
  assert.equal((await joinByNumber(s.base, B, "737373")).status, 429);
});
