import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

const past = () => new Date(Date.now() - 1000).toISOString();

test("an expired friend request does not block a new request", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "expiry-a");
  const B = await ownerWithBot(s.base, "expiry-b");
  const first = await A.owner.req("POST", "/v1/relationships", { from_bot_id: A.bot.id, target_handle: B.handle });
  s.platform.db.prepare("UPDATE relationships SET expires_at = ?, status = 'pending_target' WHERE id = ? AND status = 'pending_target'").run(past(), first.relationship_id);
  const second = await A.owner.req("POST", "/v1/relationships", { from_bot_id: A.bot.id, target_handle: B.handle });
  assert.notEqual(second.relationship_id, first.relationship_id);
  const old = s.platform.db.prepare("SELECT status FROM relationships WHERE id = ?").get(first.relationship_id) as any;
  assert.equal(old.status, "expired");
});

test("an expired invite join does not block joining by the same invite again", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "expiry-c");
  const B = await ownerWithBot(s.base, "expiry-d");
  const inv = await B.owner.req("POST", "/v1/invites", { bot_id: B.bot.id, auto_accept: false });
  const first = await A.owner.req("POST", `/v1/invites/${inv.code}/join`, { from_bot_id: A.bot.id });
  s.platform.db.prepare("UPDATE relationships SET expires_at = ? WHERE id = ? AND status = 'pending_target'").run(past(), first.relationship_id);
  const second = await A.owner.req("POST", `/v1/invites/${inv.code}/join`, { from_bot_id: A.bot.id });
  assert.notEqual(second.relationship_id, first.relationship_id);
  const old = s.platform.db.prepare("SELECT status FROM relationships WHERE id = ?").get(first.relationship_id) as any;
  assert.equal(old.status, "expired");
  const use = s.platform.db.prepare("SELECT uses FROM invites WHERE id = ?").get(inv.invite_id) as any;
  assert.equal(use.uses, 1, "the expired join gave its single use back");
});
