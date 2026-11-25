import assert from "node:assert/strict";
import { test } from "node:test";
import { friends, ownerWithBot, startServer } from "./helpers.js";

// #67: the room envelope a seat sends to its inviter. The server's room door works end to end when the line names
// its room, card included -- so the reported card is a sender that named no room (#923's half). What this side owes
// is the other end: a room conversation whose room is gone must say so. It used to say `no active relationship
// between these bots`, which sends the owner looking for a friendship that was never the missing piece.

const owner = (o: any) => ({ kind: "owner" as const, ownerId: o.owner_id });
const ROOM = "session-67b0c1d2-3e4f-4a5b-8c9d-0e1f2a3b4c5d";

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

/** A host and a stranger whose Bot claimed a link to the host's local room: a seat, never a friendship. */
async function seated(s: any) {
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  s.platform.enableCustody(owner(A), A.bot.id, { private_key_pem: A.kp.privateKeyPem });
  s.platform.enableCustody(owner(B), B.bot.id, { private_key_pem: B.kp.privateKeyPem });
  const minted = await req(s.base, "POST", "/v1/local-room-invites", A.owner.token, { room_id: ROOM, name: "Launch plan", bot_id: A.bot.id });
  const claimed = await req(s.base, "POST", `/v1/local-room-invites/${encodeURIComponent(minted.body.ticket)}/claim`, B.owner.token, { bots: [B.bot.id] });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  return { A, B, ticket: minted.body.ticket as string };
}

const received = async (b: any) => (await b.bot.events(0)).events.filter((e: any) => e.event_type === "message.received");

test("#67: a room envelope that names its room leaves without a card and arrives", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await seated(s);
  const sent = s.platform.sendAsMember(owner(B), { from_bot_id: B.bot.id, to: A.handle, text: "FLYBOT-ROOM-SHARE group update", room_id: ROOM });
  assert.equal(sent.message.status, "delivered", JSON.stringify(sent.message));
  assert.deepEqual((sent.message as any).policy.reasons, ["room.context", "dlp.clean"]);
  assert.equal((await received(A)).length, 1, "the host's Bot got the group record");
});

test("#67: no room_id from a room-only pair is still refused, and writes nothing", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await seated(s);
  const before = s.platform.listApprovals(owner(B), "pending").length;
  assert.throws(
    () => s.platform.sendAsMember(owner(B), { from_bot_id: B.bot.id, to: A.handle, text: "out of the blue" }),
    (e: any) => e.code === "no_relationship" && e.status === 403,
  );
  assert.equal(s.platform.listApprovals(owner(B), "pending").length, before, "no card, no message");
});

test("#67: a named-room envelope held by a finding is released by the room grant", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await seated(s);
  await req(s.base, "PATCH", "/v1/me", B.owner.token, { sensitive_terms: ["swordfish"] });
  const held = s.platform.sendAsMember(owner(B), { from_bot_id: B.bot.id, to: A.handle, text: "the swordfish code", room_id: ROOM });
  assert.equal(held.message.status, "pending_approval");
  assert.ok((held.message as any).policy.reasons.includes("dlp.owner.sensitive_term"));
  const done = s.platform.decideApproval(owner(B), (held.message as any).approval_id, { decision: "approved" });
  assert.equal((done as any).status, "delivered");
  assert.equal((await received(A)).length, 1);
});

test("#67: a retried approval delivers once", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await seated(s);
  await req(s.base, "PATCH", "/v1/me", B.owner.token, { sensitive_terms: ["swordfish"] });
  const held = s.platform.sendAsMember(owner(B), { from_bot_id: B.bot.id, to: A.handle, text: "the swordfish code", room_id: ROOM });
  const aprId = (held.message as any).approval_id;
  const first = s.platform.decideApproval(owner(B), aprId, { decision: "approved", idempotency_key: "same-approval" });
  const again = s.platform.decideApproval(owner(B), aprId, { decision: "approved", idempotency_key: "same-approval" });
  assert.deepEqual(again, first);
  assert.equal((await received(A)).length, 1, "one delivery for two identical approvals");
});

test("#67: once the room door is gone, the refusal names the room, not a missing friendship", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B, ticket } = await seated(s);
  await req(s.base, "PATCH", "/v1/me", B.owner.token, { sensitive_terms: ["swordfish"] });
  const held = s.platform.sendAsMember(owner(B), { from_bot_id: B.bot.id, to: A.handle, text: "the swordfish code", room_id: ROOM });
  assert.equal(held.message.status, "pending_approval");
  // the host ends the seat before the card is approved
  assert.equal((await req(s.base, "DELETE", `/v1/local-room-invites/${encodeURIComponent(ticket)}/claims/${encodeURIComponent(B.handle)}`, A.owner.token)).status, 204);
  assert.throws(
    () => s.platform.decideApproval(owner(B), (held.message as any).approval_id, { decision: "approved" }),
    (e: any) => e.status === 403 && /the room grant is gone/.test(String(e.message)),
  );
  assert.equal((await received(A)).length, 0, "nothing was delivered");
});

test("#67: a face room that ends before approval keeps saying the room grant is gone", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "cat");
  const B = await ownerWithBot(s.base, "dan");
  s.platform.enableCustody(owner(A), A.bot.id, { private_key_pem: A.kp.privateKeyPem });
  s.platform.enableCustody(owner(B), B.bot.id, { private_key_pem: B.kp.privateKeyPem });
  const room = await req(s.base, "POST", "/v1/face-rooms/join", A.owner.token, { code: "676767", bots: [A.bot.id] });
  const roomId = room.body.room_id as string;
  const ticket = await req(s.base, "POST", `/v1/face-rooms/${roomId}/invites`, A.owner.token);
  assert.equal((await req(s.base, "POST", "/v1/face-rooms/join-invite", B.owner.token, { ticket: ticket.body.ticket, bots: [B.bot.id] })).status, 200);
  await req(s.base, "PATCH", "/v1/me", B.owner.token, { sensitive_terms: ["swordfish"] });
  const held = s.platform.sendAsMember(owner(B), { from_bot_id: B.bot.id, to: A.handle, text: "the swordfish code", room_id: roomId });
  assert.equal(held.message.status, "pending_approval");
  assert.equal((await req(s.base, "POST", `/v1/face-rooms/${roomId}/leave`, B.owner.token, { bots: [B.bot.id] })).status, 200);
  assert.throws(
    () => s.platform.decideApproval(owner(B), (held.message as any).approval_id, { decision: "approved" }),
    (e: any) => e.status === 403 && /the room grant is gone/.test(String(e.message)),
  );
});

// The Reviewer found this one on the first tip: the room door closing must not take away the friendship door. A pair
// that is both friends and seated keeps settling through the friendship, as it did before the change.
test("#67: a card that outlives its room still settles for a pair that is also friends", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  s.platform.enableCustody(owner(A), A.bot.id, { private_key_pem: A.kp.privateKeyPem });
  s.platform.enableCustody(owner(B), B.bot.id, { private_key_pem: B.kp.privateKeyPem });
  const minted = await req(s.base, "POST", "/v1/local-room-invites", A.owner.token, { room_id: ROOM, name: "Launch plan", bot_id: A.bot.id });
  assert.equal((await req(s.base, "POST", `/v1/local-room-invites/${encodeURIComponent(minted.body.ticket)}/claim`, B.owner.token, { bots: [B.bot.id] })).status, 200);
  await req(s.base, "PATCH", "/v1/me", B.owner.token, { sensitive_terms: ["swordfish"] });
  const held = s.platform.sendAsMember(owner(B), { from_bot_id: B.bot.id, to: A.handle, text: "the swordfish code", room_id: ROOM });
  assert.equal(held.message.status, "pending_approval");
  // the room ends before the card is approved; the friendship stays
  assert.equal((await req(s.base, "DELETE", `/v1/local-room-invites/${encodeURIComponent(minted.body.ticket)}?end_claims=1`, A.owner.token)).status, 204);
  const done = s.platform.decideApproval(owner(B), (held.message as any).approval_id, { decision: "approved" });
  assert.equal((done as any).status, "delivered");
  assert.equal((await received(A)).length, 1);
});
