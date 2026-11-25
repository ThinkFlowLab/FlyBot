import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.js";
import { generateEd25519 } from "../src/crypto.js";
import { ownerWithBot, startServer } from "./helpers.js";

// The minting owner ends one home's claim to remove that guest from the room. The link stays open for other
// homes, but the removed home must not take its seat back with the same link.

const ROOM = "session-9d1c7e40-3a2b-4c5d-8e6f-1a2b3c4d5e60";

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
const mint = (base: string, o: any) => req(base, "POST", "/v1/local-room-invites", tok(o), { room_id: ROOM, name: "Launch plan", bot_id: o.bot.id });
const claim = (base: string, o: any, ticket: string, bots: string[]) => req(base, "POST", `/v1/local-room-invites/${encodeURIComponent(ticket)}/claim`, tok(o), { bots });
const endClaim = (base: string, o: any, ticket: string, home: string) =>
  req(base, "DELETE", `/v1/local-room-invites/${encodeURIComponent(ticket)}/claims/${encodeURIComponent(home)}`, tok(o));
const preview = (base: string, ticket: string, token?: string) => req(base, "GET", `/v1/local-room-invites/${encodeURIComponent(ticket)}`, token);
const revoke = (base: string, o: any, ticket: string) => req(base, "DELETE", `/v1/local-room-invites/${encodeURIComponent(ticket)}`, tok(o));

async function secondBot(base: string, o: any, suffix: string) {
  const kp = generateEd25519();
  const handle = `${o.handle.slice(1).replace(/\.bot$/, "")}${suffix}.bot`;
  const r = await o.owner.req("POST", "/v1/bots", { handle, public_key: { alg: "Ed25519", kid: "k1", value: kp.publicKey } });
  return { id: r.bot_id as string, handle: `@${handle}` };
}
function roomDoorClosed(s: any, from: any, toHandle: string, text: string) {
  assert.throws(
    () => s.platform.sendAsMember(owner(from), { from_bot_id: from.bot.id, to: toHandle, text, room_id: ROOM }),
    (e: any) => e.code === "room_not_shared",
  );
}

test("a home whose claim the minter ended cannot take its seat back with the same link", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  s.platform.enableCustody(owner(A), A.bot.id, { private_key_pem: A.kp.privateKeyPem });
  s.platform.enableCustody(owner(B), B.bot.id, { private_key_pem: B.kp.privateKeyPem });
  const B2 = await secondBot(s.base, B, "-two");

  const m = await mint(s.base, A);
  assert.equal(m.status, 201, JSON.stringify(m.body));
  assert.equal((await claim(s.base, B, m.body.ticket, [B.bot.id])).status, 200);
  assert.equal(s.platform.sendAsMember(owner(B), { from_bot_id: B.bot.id, to: A.handle, text: "hello", room_id: ROOM }).message.status, "delivered");

  // The minter removes that guest: the removal itself works.
  assert.equal((await endClaim(s.base, A, m.body.ticket, B.handle)).status, 204);
  roomDoorClosed(s, B, A.handle, "after removal");
  roomDoorClosed(s, A, B.handle, "back at the removed home");

  // The same link must not seat that home again — not with the same set, not with another one.
  const same = await claim(s.base, B, m.body.ticket, [B.bot.id]);
  assert.equal(same.status, 403, `the removed home claimed the link again: ${JSON.stringify(same.body)}`);
  assert.equal(same.body.code, "claim_ended");
  const other = await claim(s.base, B, m.body.ticket, [B2.id]);
  assert.equal(other.status, 403, `the removed home claimed the link with another Bot: ${JSON.stringify(other.body)}`);
  assert.equal(other.body.code, "claim_ended");
  roomDoorClosed(s, B, A.handle, "after the retry");
  assert.equal((await preview(s.base, m.body.ticket, tok(B))).body.claimed, false, "the preview must not claim a seat that is gone");
  assert.deepEqual((await preview(s.base, m.body.ticket, tok(A))).body.claimers, [], "the minter's list of joined homes no longer has that home");
});

test("ending the claim through a Bot that home brought refuses that home the same way", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  s.platform.enableCustody(owner(B), B.bot.id, { private_key_pem: B.kp.privateKeyPem });
  const B2 = await secondBot(s.base, B, "-two");

  const m = await mint(s.base, A);
  assert.equal((await claim(s.base, B, m.body.ticket, [B.bot.id, B2.id])).status, 200);
  assert.equal(s.platform.sendAsMember(owner(B), { from_bot_id: B.bot.id, to: A.handle, text: "hi", room_id: ROOM }).message.status, "delivered");

  // The minter names the guest by a Bot it brought in, not by the home handle.
  assert.equal((await endClaim(s.base, A, m.body.ticket, B2.handle)).status, 204);
  roomDoorClosed(s, B, A.handle, "after the carried Bot was named");
  const back = await claim(s.base, B, m.body.ticket, [B.bot.id]);
  assert.equal(back.status, 403, `the removed home claimed the link again: ${JSON.stringify(back.body)}`);
  assert.equal(back.body.code, "claim_ended");
});

test("the link still admits another home after one home's claim is ended", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const C = await ownerWithBot(s.base, "cat");
  s.platform.enableCustody(owner(C), C.bot.id, { private_key_pem: C.kp.privateKeyPem });
  const m = await mint(s.base, A);
  assert.equal((await claim(s.base, B, m.body.ticket, [B.bot.id])).status, 200);
  assert.equal((await endClaim(s.base, A, m.body.ticket, B.handle)).status, 204);
  // Ending one claim is not withdrawing the link: the next home it is given to joins.
  assert.equal((await claim(s.base, C, m.body.ticket, [C.bot.id])).status, 200);
  assert.equal(s.platform.sendAsMember(owner(C), { from_bot_id: C.bot.id, to: A.handle, text: "another guest", room_id: ROOM }).message.status, "delivered");
});

test("a home that released its own claim can come back with the same link", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  s.platform.enableCustody(owner(B), B.bot.id, { private_key_pem: B.kp.privateKeyPem });
  const m = await mint(s.base, A);
  assert.equal((await claim(s.base, B, m.body.ticket, [B.bot.id])).status, 200);
  assert.equal((await revoke(s.base, B, m.body.ticket)).status, 204, "the claimer releases its own claim");
  roomDoorClosed(s, B, A.handle, "after its own release");
  const back = await claim(s.base, B, m.body.ticket, [B.bot.id]);
  assert.equal(back.status, 200, `a self-released claim must be able to return: ${JSON.stringify(back.body)}`);
  assert.equal(s.platform.sendAsMember(owner(B), { from_bot_id: B.bot.id, to: A.handle, text: "back", room_id: ROOM }).message.status, "delivered");
});

test("an existing database gains the claim-end marker on open", (t) => {
  const path = join(mkdtempSync(join(tmpdir(), "bs-claim-removal-")), "old.db");
  const old = openDb(path);
  // The shape of a database written before this change: no marker column, and a claim that was released.
  old.exec("ALTER TABLE local_room_invite_claims DROP COLUMN ended_by_owner_id");
  old.prepare("INSERT INTO local_room_invite_claims (ticket, owner_id, bots, claimed_at, released_at) VALUES (?,?,?,?,?)")
    .run("t".repeat(22), "own_old", "[]", new Date().toISOString(), new Date().toISOString());
  old.close();

  const db = openDb(path);
  t.after(() => db.close());
  const cols = (db.prepare("PRAGMA table_info(local_room_invite_claims)").all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes("ended_by_owner_id"), "the marker column is added to an existing database");
  const row = db.prepare("SELECT * FROM local_room_invite_claims WHERE owner_id = ?").get("own_old") as any;
  assert.equal(row.ended_by_owner_id, null, "a released claim written before the column existed is never read as the minter ending it");
});
