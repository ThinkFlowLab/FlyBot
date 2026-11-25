/**
 * A query key sent twice reaches the route as an array. Two routes read a single value out of that array and both
 * got it wrong in their own way: `DELETE /v1/local-room-invites/{ticket}?end_claims=1&end_claims=1` compared an
 * array against `"1"`, answered 204 and ended nothing, and `GET /v1/audit-events?subject=a&subject=b` handed the
 * array to SQLite and answered 500. A key that may only carry one value is now refused with a 400 that names it,
 * and a key sent once keeps doing exactly what it did.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

const ROOM = "session-7d2f4e6a-1b3c-4d5e-8f90-1a2b3c4d5e6f";

const ownerOf = (o: any) => ({ kind: "owner" as const, ownerId: o.owner_id });
async function http(base: string, method: string, path: string, token: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  const json = text ? JSON.parse(text) : {};
  return { status: r.status, body: json.error ? json.error : json };
}
const mint = (s: any, o: any) => http(s.base, "POST", "/v1/local-room-invites", o.owner.token, { room_id: ROOM, name: "Launch plan", bot_id: o.bot.id });
const claim = (s: any, o: any, ticket: string) => http(s.base, "POST", `/v1/local-room-invites/${encodeURIComponent(ticket)}/claim`, o.owner.token, { bots: [o.bot.id] });
const del = (s: any, o: any, ticket: string, query: string) => http(s.base, "DELETE", `/v1/local-room-invites/${encodeURIComponent(ticket)}${query}`, o.owner.token);
const audit = (s: any, o: any, query = "") => http(s.base, "GET", `/v1/audit-events${query}`, o.owner.token);
const send = (s: any, from: any, to: any, text: string) =>
  s.platform.sendAsMember(ownerOf(from), { from_bot_id: from.bot.id, to: to.handle, text, room_id: ROOM }).message.status;
const roomGrants = (s: any, a: string, b: string) =>
  (s.platform.db.prepare(`SELECT COUNT(*) n FROM grants g JOIN relationships r ON r.id = g.relationship_id
    WHERE g.room_id = ? AND g.status = 'active'
      AND ((r.requester_bot = ? AND r.target_bot = ?) OR (r.requester_bot = ? AND r.target_bot = ?))`).get(ROOM, a, b, b, a) as any).n as number;
const claimRow = (s: any, ticket: string, ownerId: string) =>
  s.platform.db.prepare("SELECT released_at FROM local_room_invite_claims WHERE ticket = ? AND owner_id = ?").get(ticket, ownerId) as any;

test("a repeated end_claims is refused instead of answering 204 with nothing ended", async (t) => {
  const s: any = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  s.platform.enableCustody(ownerOf(B), B.bot.id, { private_key_pem: B.kp.privateKeyPem });
  const ticket = (await mint(s, A)).body.ticket;
  assert.equal((await claim(s, B, ticket)).status, 200, "control: the guest claims the ticket");
  assert.equal(roomGrants(s, A.bot.id, B.bot.id), 4, "control: the guest is seated with four live room grants");
  assert.equal(send(s, B, A, "hello from the guest"), "delivered", "control: the guest can write with the room_id");

  const refused = await del(s, A, ticket, "?end_claims=1&end_claims=1");
  assert.equal(refused.status, 400, "the repeated flag is refused rather than answered 204");
  assert.equal(refused.body.code, "invalid_request");
  assert.equal(refused.body.message, "end_claims must be sent once");

  assert.equal(claimRow(s, ticket, B.owner_id).released_at, null, "a refused request does not release the claim");
  assert.equal(roomGrants(s, A.bot.id, B.bot.id), 4, "the guest's grants are still live");
  assert.equal(send(s, B, A, "still here"), "delivered", "the guest can still write to the room");

  assert.equal((await del(s, A, ticket, "?end_claims=1")).status, 204, "control: one flag is still the end of the room");
  assert.ok(claimRow(s, ticket, B.owner_id).released_at, "and it releases the claim");
});

test("a repeated subject is a refusal, not an internal error", async (t) => {
  const s: any = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const refused = await audit(s, A, "?subject=a&subject=b");
  assert.equal(refused.status, 400, "a 500 here blames the server for a malformed request");
  assert.equal(refused.body.code, "invalid_request");
  assert.equal(refused.body.message, "subject must be sent once");
  assert.ok((await audit(s, A)).body.events.length > 0, "control: the unfiltered read still answers");
});

test("one end_claims and one subject keep doing exactly what they did", async (t) => {
  const s: any = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  s.platform.enableCustody(ownerOf(B), B.bot.id, { private_key_pem: B.kp.privateKeyPem });
  const ticket = (await mint(s, A)).body.ticket;
  assert.equal((await claim(s, B, ticket)).status, 200);
  assert.equal(send(s, B, A, "hello"), "delivered");

  const all: any[] = (await audit(s, A)).body.events;
  const counts = new Map<string, number>();
  for (const e of all) if (e.subject) counts.set(e.subject, (counts.get(e.subject) ?? 0) + 1);
  const subject = [...counts.entries()].sort((x, y) => y[1] - x[1])[0][0];
  const expected = all.filter((e) => e.subject === subject || JSON.stringify(e.data ?? {}).includes(subject));
  const filtered: any[] = (await audit(s, A, `?subject=${encodeURIComponent(subject)}`)).body.events;
  assert.ok(expected.length > 0, "control: the fixture wrote audit rows about one subject");
  assert.deepEqual(filtered.map((e) => e.id), expected.map((e) => e.id), "one subject still returns exactly the rows that name it");

  assert.equal((await del(s, A, ticket, "?end_claims=1")).status, 204);
  assert.ok(claimRow(s, ticket, B.owner_id).released_at, "one flag still ends the claim");
  assert.throws(() => send(s, B, A, "after the room ended"), (e: any) => e.code === "room_not_shared", "and the guest's reach is gone");
});
