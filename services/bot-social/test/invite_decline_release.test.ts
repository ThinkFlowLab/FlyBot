import assert from "node:assert/strict";
import { test } from "node:test";
import { expectApiError, ownerWithBot, startServer } from "./helpers.js";

// P9: declining an invite-born request must give the invite's slot back. `expireStale` and a rejected
// approval already did; the decline branch was the one door that left a 1-use invite reading "used".

const owner = (o: any) => ({ kind: "owner" as const, ownerId: o.owner_id });

test("declining an invite-born request releases the invite's use", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const p = s.platform as any;
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const C = await ownerWithBot(s.base, "cat");
  const inv = p.createInvite(owner(A), { bot_id: A.bot.id, auto_accept: false, max_uses: 1 });
  const row = () => s.platform.db.prepare("SELECT uses, max_uses FROM invites WHERE code = ?").get(inv.code) as any;

  const join = p.joinInvite(owner(B), inv.code, { from_bot_id: B.bot.id });
  assert.equal(join.status, "pending_target", "a non-auto-accept invite waits for the inviter's owner");
  assert.deepEqual({ uses: row().uses, max_uses: row().max_uses }, { uses: 1, max_uses: 1 }, "the join spent the only slot");
  assert.equal(p.inviteInfo(inv.code).status, "used");
  await expectApiError(Promise.resolve().then(() => p.joinInvite(owner(C), inv.code, { from_bot_id: C.bot.id })), 410, "invite_unavailable");

  p.consent(owner(A), join.relationship_id, { decision: "decline" });

  assert.equal(row().uses, 0, "a declined join gives the slot back");
  assert.equal(p.inviteInfo(inv.code).status, "active", "so the link reads active again");
  const again = p.joinInvite(owner(C), inv.code, { from_bot_id: C.bot.id });
  assert.equal(again.status, "pending_target", "and the next owner can still use the same link");
  assert.equal(row().uses, 1);
});

test("the other doors keep their old answers: accept spends the slot, a 2-use link keeps a spare, a plain decline touches no invite", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const p = s.platform as any;
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const C = await ownerWithBot(s.base, "cat");
  const D = await ownerWithBot(s.base, "dan");

  // accept: the join stands, so the slot stays spent
  const one = p.createInvite(owner(A), { bot_id: A.bot.id, auto_accept: false, max_uses: 1 });
  const joined = p.joinInvite(owner(B), one.code, { from_bot_id: B.bot.id });
  p.consent(owner(A), joined.relationship_id, { decision: "accept", grant_capabilities: [] });
  assert.equal((s.platform.db.prepare("SELECT uses FROM invites WHERE code = ?").get(one.code) as any).uses, 1, "an accepted join keeps its slot");
  assert.equal(p.inviteInfo(one.code).status, "used");

  // max_uses 2: one decline gives back one slot, the link stays active either way
  const two = p.createInvite(owner(A), { bot_id: A.bot.id, auto_accept: false, max_uses: 2 });
  const second = p.joinInvite(owner(C), two.code, { from_bot_id: C.bot.id });
  assert.equal((s.platform.db.prepare("SELECT uses FROM invites WHERE code = ?").get(two.code) as any).uses, 1);
  p.consent(owner(A), second.relationship_id, { decision: "decline" });
  const left = s.platform.db.prepare("SELECT uses, max_uses FROM invites WHERE code = ?").get(two.code) as any;
  assert.deepEqual({ uses: left.uses, max_uses: left.max_uses }, { uses: 0, max_uses: 2 });
  assert.equal(p.inviteInfo(two.code).status, "active");

  // a plain request has no invite: declining it must not touch any link's use count
  const before = s.platform.db.prepare("SELECT code, uses FROM invites ORDER BY code").all() as any[];
  const plain = p.requestRelationship(owner(A), { from_bot_id: A.bot.id, target_handle: D.handle });
  assert.equal(plain.status, "pending_target");
  const declined = p.consent(owner(D), plain.relationship_id, { decision: "decline" });
  assert.equal(declined.status, "declined");
  assert.deepEqual(s.platform.db.prepare("SELECT code, uses FROM invites ORDER BY code").all(), before, "no invite is touched by a plain decline");
});
