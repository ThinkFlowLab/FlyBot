import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

// P1: cancelling a join that is still waiting must give the invite's slot back, exactly as `consent` decline,
// `expireStale` and a rejected approval already do. The Remove button (DELETE /v1/relationships/:id) took the row
// to `revoked` and left the link reading "used" for a relationship that never existed, so a 1-use link was gone.

const owner = (o: any) => ({ kind: "owner" as const, ownerId: o.owner_id });
const inviteState = async (base: string, code: string) => (await (await fetch(`${base}/v1/invites/${code}`)).json() as any).status;

test("cancelling a pending join releases the invite's use", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const p = s.platform as any;
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const C = await ownerWithBot(s.base, "cat");
  const inv = p.createInvite(owner(A), { bot_id: A.bot.id, auto_accept: false, max_uses: 1 });
  const uses = () => (s.platform.db.prepare("SELECT uses FROM invites WHERE code = ?").get(inv.code) as any).uses;

  const join = p.joinInvite(owner(B), inv.code, { from_bot_id: B.bot.id });
  assert.equal(join.status, "pending_target", "a non-auto-accept invite waits for the inviter's owner");
  assert.equal(uses(), 1, "the join spent the only slot");
  assert.equal(await inviteState(s.base, inv.code), "used");

  // The joiner's owner withdraws the request through the door the console's Remove button uses.
  const cancelled = await B.owner.req("DELETE", `/v1/relationships/${join.relationship_id}`);
  assert.equal(cancelled.status, "revoked");

  assert.equal(uses(), 0, "a cancelled join gives the slot back");
  assert.equal(await inviteState(s.base, inv.code), "active", "so the link reads active again");
  const again = p.joinInvite(owner(C), inv.code, { from_bot_id: C.bot.id });
  assert.equal(again.status, "pending_target", "and the next owner can still use the same link");
  assert.equal(uses(), 1);
});

test("a Bot-initiated join waiting on its own owner releases the use when cancelled", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const p = s.platform as any;
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const inv = p.createInvite(owner(A), { bot_id: A.bot.id, auto_accept: false, max_uses: 1 });
  const uses = () => (s.platform.db.prepare("SELECT uses FROM invites WHERE code = ?").get(inv.code) as any).uses;

  // The Bot asks through its own token: the request now waits on its owner, not on the inviter's.
  const join = await B.bot.signed(`/v1/invites/${inv.code}/join`, "invite.join", { code: inv.code });
  assert.equal(join.status, "pending_requester_owner");
  assert.equal(uses(), 1);

  await B.owner.req("DELETE", `/v1/relationships/${join.relationship_id}`);

  assert.equal(uses(), 0, "cancelling a pending_requester_owner join gives the slot back");
  assert.equal(await inviteState(s.base, inv.code), "active");
});

test("the other doors keep their answers: decline still gives the slot back, an active join keeps it", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const p = s.platform as any;
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const usesOf = (code: string) => (s.platform.db.prepare("SELECT uses FROM invites WHERE code = ?").get(code) as any).uses;

  // decline: the control this rule was taken from; the request is refused, not cancelled, and the link comes back.
  const declined = p.createInvite(owner(A), { bot_id: A.bot.id, auto_accept: false, max_uses: 1 });
  const join = p.joinInvite(owner(B), declined.code, { from_bot_id: B.bot.id });
  assert.equal(usesOf(declined.code), 1);
  p.consent(owner(A), join.relationship_id, { decision: "decline" });
  assert.equal(usesOf(declined.code), 0, "a declined join still gives the slot back");
  assert.equal(await inviteState(s.base, declined.code), "active");

  // active: the join became a friendship, so the use it paid for stays spent even after Remove.
  const accepted = p.createInvite(owner(A), { bot_id: A.bot.id, auto_accept: false, max_uses: 1 });
  const joined = p.joinInvite(owner(B), accepted.code, { from_bot_id: B.bot.id });
  p.consent(owner(A), joined.relationship_id, { decision: "accept", grant_capabilities: [] });
  assert.equal(usesOf(accepted.code), 1);
  const removed = await B.owner.req("DELETE", `/v1/relationships/${joined.relationship_id}`);
  assert.equal(removed.status, "revoked");
  assert.equal(usesOf(accepted.code), 1, "an active join's slot is not refunded by ending it");
  assert.equal(await inviteState(s.base, accepted.code), "used");
});

test("a repeated cancel refunds only the one slot it spent", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const p = s.platform as any;
  const A = await ownerWithBot(s.base, "ann");
  const C = await ownerWithBot(s.base, "cat");
  const D = await ownerWithBot(s.base, "dan");
  const inv = p.createInvite(owner(A), { bot_id: A.bot.id, auto_accept: false, max_uses: 2 });
  const uses = () => (s.platform.db.prepare("SELECT uses FROM invites WHERE code = ?").get(inv.code) as any).uses;

  const first = p.joinInvite(owner(C), inv.code, { from_bot_id: C.bot.id });
  const second = p.joinInvite(owner(D), inv.code, { from_bot_id: D.bot.id });
  assert.equal(uses(), 2, "both waits spent their slots");
  assert.equal(await inviteState(s.base, inv.code), "used");

  await C.owner.req("DELETE", `/v1/relationships/${first.relationship_id}`);
  assert.equal(uses(), 1, "the cancelled wait gives its slot back");
  assert.equal(await inviteState(s.base, inv.code), "active", "a 2-use link is live again with one slot free");

  // Same request cancelled again: the row is already terminal, so it must not refund a second slot.
  const again = await C.owner.req("DELETE", `/v1/relationships/${first.relationship_id}`);
  assert.equal(again.status, "revoked");
  assert.equal(uses(), 1, "a second Remove of the same row refunds nothing");

  await D.owner.req("DELETE", `/v1/relationships/${second.relationship_id}`);
  assert.equal(uses(), 0, "the second cancelled wait gives its own slot back");
});
