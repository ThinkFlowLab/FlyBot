/**
 * `?end_claims=1` means the room itself is gone, so the sweep is by claim, not by live ticket: a claim this
 * home seated through a link it later withdrew plain (`DELETE` without `end_claims`) is still a live claim in
 * that room, and its reach must end with every other claim the room's ending ends. Scope stays the caller's own
 * tickets for this room: another home's ticket for the same `room_id`, and the caller's ticket for another room,
 * are untouched. `ended_claims` counts claims, so the withdrawn link's claim is in it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

const ROOM = "session-9c4e2a71-3b8d-4f60-9a5e-1c7d2b8e4f01";
const OTHER_ROOM = "session-4d7f1b93-6a2c-4e58-b0d9-3f5a8c1e7b26";

async function req(base: string, method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  const json = text ? JSON.parse(text) : {};
  return { status: r.status, body: json.error ? { ...json.error, error: undefined } : json };
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
const claimRow = (s: any, ticket: string, ownerId: string) =>
  s.platform.db.prepare("SELECT released_at, ended_by_owner_id FROM local_room_invite_claims WHERE ticket = ? AND owner_id = ?").get(ticket, ownerId) as any;

test("end_claims sweeps a live claim seated by a ticket withdrawn plain, and only the caller's own claims", async (t) => {
  const s: any = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const C = await ownerWithBot(s.base, "cat");
  const D = await ownerWithBot(s.base, "dan");
  const E = await ownerWithBot(s.base, "eve");
  for (const o of [B, C, D]) s.platform.enableCustody(owner(o), o.bot.id, { private_key_pem: o.kp.privateKeyPem });

  const tOld = await mint(s.base, A);              // A's link, seated, then withdrawn plain
  const t1 = await mint(s.base, A);                // A's other live link: the room is ended through this one
  const tE = await mint(s.base, E);                // another home's link for the same room
  const tOR = await mint(s.base, A, OTHER_ROOM);   // A's link for another room
  assert.equal((await claim(s.base, B, tOld.body.ticket, [B.bot.id])).status, 200);
  assert.equal((await claim(s.base, C, t1.body.ticket, [C.bot.id])).status, 200);
  assert.equal((await claim(s.base, D, tE.body.ticket, [D.bot.id])).status, 200);
  assert.equal((await claim(s.base, B, tOR.body.ticket, [B.bot.id])).status, 200);
  assert.equal((await req(s.base, "DELETE", `/v1/local-room-invites/${encodeURIComponent(tOld.body.ticket)}`, tok(A))).status, 204);

  console.log(`# control before: tOld revoked plain, claim released_at ${JSON.stringify(claimRow(s, tOld.body.ticket, B.owner_id).released_at)}`);
  console.log(`# control before: A-B grants ${roomGrants(s, ROOM, A.bot.id, B.bot.id)} | send ${send(s, B, A, "still here through the withdrawn link")}`);

  assert.equal((await req(s.base, "DELETE", `/v1/local-room-invites/${encodeURIComponent(t1.body.ticket)}?end_claims=1`, tok(A))).status, 204);

  const bRow = claimRow(s, tOld.body.ticket, B.owner_id);
  const cRow = claimRow(s, t1.body.ticket, C.owner_id);
  const dRow = claimRow(s, tE.body.ticket, D.owner_id);
  let bSend = "delivered";
  try { send(s, B, A, "after the room ended"); } catch (e: any) { bSend = e.code; }
  let dSend = "delivered";
  try { send(s, D, E, "another home's link still seats me"); } catch (e: any) { dSend = e.code; }
  const otherRoomSend = send(s, B, A, "the other room still works", OTHER_ROOM);
  const audited = (s.platform.audit.db.prepare("SELECT data FROM audit_events WHERE action = 'local_room.invite_revoked' ORDER BY seq DESC LIMIT 1").get() as any)?.data;
  console.log(`# tOld claim released_at ${JSON.stringify(bRow.released_at)} ended_by_owner_id ${JSON.stringify(bRow.ended_by_owner_id)}`);
  console.log(`# t1 claim released_at ${JSON.stringify(cRow.released_at)} | tE claim released_at ${JSON.stringify(dRow.released_at)}`);
  console.log(`# A-B grants ${roomGrants(s, ROOM, A.bot.id, B.bot.id)} | send after end ${bSend} | other home's send ${dSend}`);
  console.log(`# other room send ${otherRoomSend} | ended_claims ${audited ? JSON.parse(audited).ended_claims : "?"}`);

  assert.ok(bRow.released_at, "a claim on a ticket withdrawn plain is still a claim: end_claims must release it");
  assert.equal(bRow.ended_by_owner_id, A.owner_id, "and record it as ended by the minting home");
  assert.equal(roomGrants(s, ROOM, A.bot.id, B.bot.id), 0, "the withdrawn link's room reach ends with the room");
  assert.throws(() => send(s, B, A, "after the room ended, second try"), (e: any) => e.code === "room_not_shared", "B can no longer reach A through the ended room");
  assert.equal(cRow.ended_by_owner_id, A.owner_id, "control: the live link's claim ends as before");
  assert.equal(dRow.released_at, null, "control: another home's ticket for the same room is untouched");
  assert.equal(dSend, "delivered");
  assert.equal(otherRoomSend, "delivered", "control: the caller's ticket for another room is untouched");
  assert.equal(JSON.parse(audited).ended_claims, 2, "ended_claims counts claims: the withdrawn link's and the live link's");
});
