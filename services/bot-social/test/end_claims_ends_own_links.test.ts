/**
 * `?end_claims=1` means the room itself is gone, not just the ticket in the URL. The minting home's other live
 * links for the same `room_id` must go with it, with the claims they seated ended the same way the single-ticket
 * path ends them. A ticket another home minted for that `room_id` is not the caller's ticket and is left alone.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

const ROOM = "session-6b1e2d3c-4a5f-4b6c-8d7e-9f0a1b2c3d4e";
const OTHER_ROOM = "session-1f2e3d4c-5b6a-4978-8c7d-6e5f4a3b2c1d";

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
const mint = (base: string, o: any, room = ROOM) => req(base, "POST", "/v1/local-room-invites", tok(o), { room_id: room, name: "Launch plan", bot_id: o.bot.id });
const claim = (base: string, o: any, ticket: string, bots: string[]) => req(base, "POST", `/v1/local-room-invites/${encodeURIComponent(ticket)}/claim`, tok(o), { bots });
const send = (s: any, from: any, to: any, text: string, room = ROOM) =>
  s.platform.sendAsMember(owner(from), { from_bot_id: from.bot.id, to: to.handle, text, room_id: room }).message.status;
const roomGrants = (s: any, room: string, a: string, b: string) =>
  (s.platform.db.prepare(`SELECT COUNT(*) n FROM grants g JOIN relationships r ON r.id = g.relationship_id
    WHERE g.room_id = ? AND g.status = 'active'
      AND ((r.requester_bot = ? AND r.target_bot = ?) OR (r.requester_bot = ? AND r.target_bot = ?))`).get(room, a, b, b, a) as any).n as number;

test("end_claims ends the minter's own other live links for the room, and only those", async (t) => {
  const s: any = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const C = await ownerWithBot(s.base, "cat");
  const D = await ownerWithBot(s.base, "dan");
  const E = await ownerWithBot(s.base, "eve");
  for (const o of [B, C]) s.platform.enableCustody(owner(o), o.bot.id, { private_key_pem: o.kp.privateKeyPem });
  const t1 = await mint(s.base, A);
  const t2 = await mint(s.base, A);
  const t3 = await mint(s.base, E);
  const t4 = await mint(s.base, A, OTHER_ROOM);
  assert.equal((await claim(s.base, B, t1.body.ticket, [B.bot.id])).status, 200);
  assert.equal((await claim(s.base, C, t2.body.ticket, [C.bot.id])).status, 200);
  assert.equal((await claim(s.base, B, t4.body.ticket, [B.bot.id])).status, 200);
  assert.equal(roomGrants(s, ROOM, A.bot.id, C.bot.id), 4, "control: t2 seats C with four live room grants");
  assert.equal(send(s, C, A, "hello from t2"), "delivered");
  assert.equal(send(s, B, A, "hello from t4", OTHER_ROOM), "delivered", "control: the other room's link is live too");

  assert.equal((await req(s.base, "DELETE", `/v1/local-room-invites/${encodeURIComponent(t1.body.ticket)}?end_claims=1`, tok(A))).status, 204);

  assert.throws(() => send(s, C, A, "after the room ended"), (e: any) => e.code === "room_not_shared");
  assert.equal(roomGrants(s, ROOM, A.bot.id, C.bot.id), 0, "C's grants from t2 end with the other link");
  const row = s.platform.db.prepare("SELECT released_at, ended_by_owner_id FROM local_room_invite_claims WHERE ticket = ? AND owner_id = ?").get(t2.body.ticket, C.owner_id) as any;
  assert.ok(row.released_at, "t2's claim is released, not left live");
  assert.equal(row.ended_by_owner_id, A.owner_id, "and recorded as ended by the minting home");
  assert.equal((await req(s.base, "GET", `/v1/local-room-invites/${encodeURIComponent(t2.body.ticket)}`)).body.code, "revoked");
  assert.equal((await claim(s.base, D, t2.body.ticket, [D.bot.id])).status, 410, "a late home cannot claim the sibling link");
  assert.equal((await claim(s.base, D, t3.body.ticket, [D.bot.id])).status, 200, "another home's ticket for the same room is untouched");
  assert.equal(send(s, B, A, "the other room still works", OTHER_ROOM), "delivered", "a ticket for another room is not swept");

  assert.equal((await req(s.base, "DELETE", `/v1/local-room-invites/${encodeURIComponent(t4.body.ticket)}?end_claims=1`, tok(A))).status, 204);
  assert.throws(() => send(s, B, A, "lone ticket", OTHER_ROOM), (e: any) => e.code === "room_not_shared", "control: a lone ticket ends its claim as before");
});
