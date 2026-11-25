/**
 * A link into a local room admits the Bots a home brings, and the claim that records it is the seat: while it is
 * live, the pair keeps its room-scoped grants. #90 ends the reach of the tickets a revoked member *minted*; it says
 * nothing about the other half — the seats its identity took through someone else's link. A revoked identity cannot
 * answer in that room any more, so its seat has to go with it: the claim loses that Bot (and is released when it
 * held no one else), and the pair grants that Bot's seat wrote stop being active. The link itself is not the
 * revoked identity's reach, so it stays live, other homes' claims on it are untouched, and a home whose claim held
 * another Bot keeps that Bot's seat. (Owner decision 2026-10-24 keeps the seats of a withdrawn link, not the seats
 * of a revoked identity.)
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { startServer } from "./helpers.js";

const ROOM = "session-b1f7c2a4-8d3e-4c15-9a60-7b2e4d9c1a03";

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

/** A FlyBot home plus its owner login token (these console routes refuse connector tokens). */
async function flyHome(base: string, name: string) {
  const onboard = await req(base, "POST", "/v1/onboard/flybot", undefined, { username: name, password: "secret-pw", display_name: name });
  assert.equal(onboard.status, 201, JSON.stringify(onboard.body));
  const login = await req(base, "POST", "/v1/auth/login", undefined, { username: name, password: "secret-pw" });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return { token: login.body.owner_token as string, homeId: onboard.body.home.bot_id as string, ownerId: onboard.body.owner_id as string };
}

async function addMember(base: string, o: { token: string; homeId: string }, name: string) {
  const r = await req(base, "POST", `/v1/homes/${o.homeId}/members`, o.token, { name, display_name: name.toUpperCase() });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { id: r.body.bot_id as string, handle: r.body.handle as string };
}

const mint = (base: string, o: { token: string }, inviterBot: string) =>
  req(base, "POST", "/v1/local-room-invites", o.token, { room_id: ROOM, name: "Launch plan", bot_id: inviterBot });
const claim = (base: string, o: { token: string }, ticket: string, bots: string[]) =>
  req(base, "POST", `/v1/local-room-invites/${encodeURIComponent(ticket)}/claim`, o.token, { bots });
const preview = (base: string, ticket: string, token: string) =>
  req(base, "GET", `/v1/local-room-invites/${encodeURIComponent(ticket)}`, token);
const removeMember = (base: string, o: { token: string; homeId: string }, botId: string) =>
  req(base, "DELETE", `/v1/homes/${o.homeId}/members/${botId}`, o.token);

const claimRow = (s: any, ticket: string, ownerId: string) =>
  s.platform.db.prepare("SELECT released_at, bots FROM local_room_invite_claims WHERE ticket = ? AND owner_id = ?").get(ticket, ownerId) as any;

/** The room-scoped grants the claim wrote for one pair: both directions, every default capability. */
const activePairGrants = (s: any, a: string, b: string) =>
  (s.platform.db.prepare(`SELECT COUNT(*) n FROM grants g JOIN relationships r ON r.id = g.relationship_id
    WHERE g.room_id = ? AND g.status = 'active'
      AND ((r.requester_bot = ? AND r.target_bot = ?) OR (r.requester_bot = ? AND r.target_bot = ?))`)
    .get(ROOM, a, b, b, a) as any).n as number;

const seated = (row: any) => JSON.parse(row.bots) as string[];

test("the seat a revoked identity took through another home's link is released with it", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await flyHome(s.base, "ann");
  const B = await flyHome(s.base, "ben");
  const writer = await addMember(s.base, A, "writer");
  const guest = await addMember(s.base, B, "guest");
  const minted = await mint(s.base, A, writer.id);
  assert.equal(minted.status, 201, JSON.stringify(minted.body));
  const ticket = minted.body.ticket as string;
  const joined = await claim(s.base, B, ticket, [guest.id]);
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  assert.equal(joined.body.claimed, true, "the guest's home joined with the link");
  assert.equal(activePairGrants(s, writer.id, guest.id), 4, "the seat is four room-scoped grants");

  const removed = await removeMember(s.base, B, guest.id);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.status, "revoked");

  const row = claimRow(s, ticket, B.ownerId);
  assert.ok(row.released_at, "the claim that held only the revoked Bot is released, not left live");
  assert.equal(activePairGrants(s, writer.id, guest.id), 0, "the room grants its seat wrote are not active any more");

  const asMinter = await preview(s.base, ticket, A.token);
  assert.equal(asMinter.status, 200, JSON.stringify(asMinter.body));
  assert.equal((asMinter.body.claimers as any[]).length, 0, "the preview no longer names the revoked identity as a claimer");
  const asGuestHome = await preview(s.base, ticket, B.token);
  assert.equal(asGuestHome.body.claimed, false, "the home no longer holds a seat on this link");

  // The link is not the revoked identity's reach: the same home brings a fresh Bot through it.
  const repl = await addMember(s.base, B, "repl");
  const again = await claim(s.base, B, ticket, [repl.id]);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.claimed, true, "a fresh Bot of that home joins again instead of 409 already_claimed");
  assert.equal(activePairGrants(s, writer.id, repl.id), 4, "the new seat writes its own room grants");
});

test("another home's claim on the same link keeps its seats", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await flyHome(s.base, "ann");
  const B = await flyHome(s.base, "ben");
  const C = await flyHome(s.base, "cat");
  const writer = await addMember(s.base, A, "writer");
  const guest = await addMember(s.base, B, "guest");
  const other = await addMember(s.base, C, "other");
  const minted = await mint(s.base, A, writer.id);
  assert.equal(minted.status, 201, JSON.stringify(minted.body));
  const ticket = minted.body.ticket as string;
  assert.equal((await claim(s.base, B, ticket, [guest.id])).status, 200);
  assert.equal((await claim(s.base, C, ticket, [other.id])).status, 200);
  assert.equal(activePairGrants(s, writer.id, other.id), 4);

  const removed = await removeMember(s.base, B, guest.id);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));

  assert.ok(claimRow(s, ticket, B.ownerId).released_at, "the revoked identity's own claim goes");
  const theirs = claimRow(s, ticket, C.ownerId);
  assert.equal(theirs.released_at, null, "another home's claim is not this home's business");
  assert.deepEqual(seated(theirs), [other.id], "that claim still seats its Bot");
  assert.equal(activePairGrants(s, writer.id, other.id), 4, "and keeps the room grants that seat wrote");
  assert.notEqual((s.platform as any).roomReach(other.id, writer.id, ROOM), null, "the third home still reaches the room");
  assert.equal((s.platform as any).roomReach(guest.id, writer.id, ROOM), null, "the revoked identity no longer reaches it");
});

test("one Bot leaving a claim keeps the seats of the Bots that stay", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await flyHome(s.base, "ann");
  const B = await flyHome(s.base, "ben");
  const writer = await addMember(s.base, A, "writer");
  const guest = await addMember(s.base, B, "guest");
  const sibling = await addMember(s.base, B, "sibling");
  const minted = await mint(s.base, A, writer.id);
  assert.equal(minted.status, 201, JSON.stringify(minted.body));
  const ticket = minted.body.ticket as string;
  const joined = await claim(s.base, B, ticket, [guest.id, sibling.id]);
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  assert.equal(activePairGrants(s, writer.id, sibling.id), 4);

  const removed = await removeMember(s.base, B, guest.id);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));

  const row = claimRow(s, ticket, B.ownerId);
  assert.equal(row.released_at, null, "the claim still holds the Bot that stayed");
  assert.deepEqual(seated(row), [sibling.id], "and names only the Bot that stayed");
  assert.equal(activePairGrants(s, writer.id, sibling.id), 4, "the staying Bot keeps its seat and its room grants");
  assert.equal(activePairGrants(s, writer.id, guest.id), 0, "the revoked Bot's own seat is gone");
  assert.notEqual((s.platform as any).roomReach(sibling.id, writer.id, ROOM), null, "the staying Bot still reaches the room");
});
