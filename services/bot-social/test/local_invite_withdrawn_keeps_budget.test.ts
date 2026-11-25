import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

// A home that joined with a local-room link keeps its reach when the minting owner withdraws the whole link, and
// an older ticket's deadline passing does not take it out either: withdrawing a link ends its claims, not the
// seats they made. Its retries then answer `410 revoked` / `410 expired` — a dead ticket, not a door check — so
// those `410`s are recorded but do not spend the account join budget a guessed ticket pays. #336 gave the sibling
// refusal `claim_ended` that exception for the minting owner's removal; these two are a dead end rather than a
// removal, for a home the link had already seated, so that home keeps its budget, while a caller that never held
// a claim on the ticket keeps counting (docs/FACE_ROOMS.md:144, the anti-enumeration window).

const ROOM = "session-3f5c1d20-9b47-4a6e-8c11-2d4e6f8a0b13";

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
const mint = (base: string, o: any) => req(base, "POST", "/v1/local-room-invites", tok(o), { room_id: ROOM, name: "Launch plan", bot_id: o.bot.id });
const claim = (base: string, o: any, ticket: string, bots: string[]) => req(base, "POST", `/v1/local-room-invites/${encodeURIComponent(ticket)}/claim`, tok(o), { bots });
const endClaim = (base: string, o: any, ticket: string, home: string) =>
  req(base, "DELETE", `/v1/local-room-invites/${encodeURIComponent(ticket)}/claims/${encodeURIComponent(home)}`, tok(o));
const revoke = (base: string, o: any, ticket: string) => req(base, "DELETE", `/v1/local-room-invites/${encodeURIComponent(ticket)}`, tok(o));
const joinByNumber = (base: string, o: any, code: string) => req(base, "POST", "/v1/face-rooms/join", tok(o), { code, bots: [o.bot.id] });
const outcomes = (s: any, ownerId: string) =>
  (s.platform.db.prepare("SELECT outcome, COUNT(*) n FROM face_room_attempts WHERE owner_id = ? GROUP BY outcome").all(ownerId) as any[]);

test("a home whose link was withdrawn keeps its join budget and still reaches an unrelated room", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const C = await ownerWithBot(s.base, "cam");

  const m = await mint(s.base, A);
  assert.equal(m.status, 201, JSON.stringify(m.body));
  assert.equal((await claim(s.base, B, m.body.ticket, [B.bot.id])).status, 200);
  // An unrelated room seats a home that was never in this one, so the door itself is not the variable below.
  assert.equal((await joinByNumber(s.base, C, "313131")).status, 200);

  // The minting owner withdraws the link: B's retries are the withdrawn home's retries.
  const rv = await revoke(s.base, A, m.body.ticket);
  assert.ok(rv.status === 204 || rv.status === 200, JSON.stringify(rv.body));

  const seen: any[] = [];
  for (let i = 0; i < 12; i++) {
    const r = await claim(s.base, B, m.body.ticket, [B.bot.id]);
    seen.push([r.status, r.body.code]);
  }
  assert.deepEqual(seen.map((x) => x[0]), [410, 410, 410, 410, 410, 410, 410, 410, 410, 410, 410, 410], JSON.stringify(seen));

  // A fresh peer is unaffected at the same moment.
  const peer = await ownerWithBot(s.base, "dee");
  assert.equal((await joinByNumber(s.base, peer, "727272")).status, 200);

  // The home whose link died must still reach a room it was never in.
  const unrelated = await joinByNumber(s.base, B, "727272");
  assert.equal(unrelated.status, 200, `a withdrawn home must still reach an unrelated room; got ${unrelated.status} ${JSON.stringify(unrelated.body)}`);
  // The refusal is still recorded: the attempt keeps a row, it just is not a failed guess.
  assert.ok(outcomes(s, B.owner_id).some((r: any) => r.outcome === "revoked_after_claim"), JSON.stringify(outcomes(s, B.owner_id)));
});

test("a caller that never held a claim on the withdrawn ticket still spends its budget", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const m = await mint(s.base, A);
  assert.equal(m.status, 201, JSON.stringify(m.body));
  assert.ok((await revoke(s.base, A, m.body.ticket)).status === 204);

  // B never joined with this link: the answer must keep costing the same as a guessed ticket (docs:144).
  const seen: any[] = [];
  for (let i = 0; i < 11; i++) {
    const r = await claim(s.base, B, m.body.ticket, [B.bot.id]);
    seen.push([r.status, r.body.code]);
  }
  assert.deepEqual(seen.at(-1), [429, "rate_limited"], JSON.stringify(seen));
  const unrelated = await joinByNumber(s.base, B, "828282");
  assert.equal(unrelated.status, 429, JSON.stringify(unrelated.body));
});

test("a home the owner removed keeps its budget when that older ticket also expires", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const m = await mint(s.base, A);
  assert.equal(m.status, 201, JSON.stringify(m.body));
  assert.equal((await claim(s.base, B, m.body.ticket, [B.bot.id])).status, 200);
  // The minting owner ends this home's claim (#336), and the ticket it used carries an older deadline.
  assert.equal((await endClaim(s.base, A, m.body.ticket, B.handle)).status, 204);
  s.platform.db.prepare("UPDATE local_room_invites SET expires_at = ? WHERE ticket = ?").run("2020-01-01T00:00:00.000Z", m.body.ticket);

  // `expired` is answered before the `claim_ended` rule, so this home's retries are the `expired` shape.
  const seen: any[] = [];
  for (let i = 0; i < 12; i++) {
    const r = await claim(s.base, B, m.body.ticket, [B.bot.id]);
    seen.push([r.status, r.body.code]);
  }
  assert.deepEqual(seen.map((x) => x[0]), [410, 410, 410, 410, 410, 410, 410, 410, 410, 410, 410, 410], JSON.stringify(seen));
  assert.equal(seen[0][1], "expired", JSON.stringify(seen));
  const unrelated = await joinByNumber(s.base, B, "919191");
  assert.equal(unrelated.status, 200, `a removed home must still reach an unrelated room; got ${unrelated.status} ${JSON.stringify(unrelated.body)}`);
  assert.ok(outcomes(s, B.owner_id).some((r: any) => r.outcome === "expired_after_claim"), JSON.stringify(outcomes(s, B.owner_id)));
});

test("a caller that never claimed an expired ticket still spends its budget", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const m = await mint(s.base, A);
  assert.equal(m.status, 201, JSON.stringify(m.body));
  s.platform.db.prepare("UPDATE local_room_invites SET expires_at = ? WHERE ticket = ?").run("2020-01-01T00:00:00.000Z", m.body.ticket);
  const seen: any[] = [];
  for (let i = 0; i < 11; i++) {
    const r = await claim(s.base, B, m.body.ticket, [B.bot.id]);
    seen.push([r.status, r.body.code]);
  }
  assert.deepEqual(seen.at(-1), [429, "rate_limited"], JSON.stringify(seen));
  assert.equal((await joinByNumber(s.base, B, "929292")).status, 429);
});

test("the sibling `claim_ended` removal keeps the budget it was given in #336", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const m = await mint(s.base, A);
  assert.equal(m.status, 201, JSON.stringify(m.body));
  assert.equal((await claim(s.base, B, m.body.ticket, [B.bot.id])).status, 200);
  assert.equal((await endClaim(s.base, A, m.body.ticket, B.handle)).status, 204);
  for (let i = 0; i < 12; i++) assert.equal((await claim(s.base, B, m.body.ticket, [B.bot.id])).body.code, "claim_ended");
  assert.equal((await joinByNumber(s.base, B, "626262")).status, 200);
});
