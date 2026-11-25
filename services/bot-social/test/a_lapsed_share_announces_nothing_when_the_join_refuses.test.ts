import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

/**
 * The lapse sweep, end to end: a share that has lapsed is claimed and announced inside the transaction that next
 * looks at it, and that transaction then fails on a later write.
 *
 * The claim (`revoked_at`), the `grant.expired` record and the guest seat the lapse pays for all belong to the one
 * write. When the transaction rolls back, the claim and the seat come back — and the audit row must come back with
 * them, or the log says a share lapsed that is still live. The next committed sweep then announces it exactly once.
 *
 * The failure is injected with a trigger that refuses the join's seat insert, because no reachable request refuses
 * that write after the sweep has run: every refusal in the join door is a `return` that commits.
 */

test("a lapse swept in a transaction that then throws writes nothing, and the next committed sweep writes once", async (t) => {
  const s: any = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const F = await ownerWithBot(s.base, "fay");

  // Fay shares her Bot with Ann's, so Ann's Bot may seat it as a guest.
  const rel = await F.owner.req("POST", "/v1/relationships", { from_bot_id: F.bot.id, target_handle: A.handle, message: "hi", requested_capabilities: ["chat.public"] });
  const relId = rel.relationship_id as string;
  await A.owner.req("POST", `/v1/relationships/${relId}/consent`, { decision: "accept", grant_capabilities: [] });
  const grant = await F.owner.req("POST", `/v1/relationships/${relId}/grants`, { capability: "chat.public", expires_in_days: 30 });
  const grantId = grant.grant_id as string;

  const room = await B.owner.req("POST", "/v1/face-rooms/join", { code: "858585", bots: [B.bot.id] });
  const seated = await A.owner.req("POST", "/v1/face-rooms/join", { code: "858585", bots: [A.bot.id, F.bot.id] });
  assert.equal(seated.room_id, room.room_id, "control: the share seated Fay's Bot as a guest");
  const seat = () => s.platform.db.prepare("SELECT * FROM face_room_members WHERE room_id = ? AND bot_id = ?").get(room.room_id, F.bot.id) as any;
  assert.equal(seat().left_at, null, "control: the guest seat is taken");

  s.platform.db.prepare("UPDATE grants SET expires_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", grantId);
  const expiredAudits = () => (s.platform.audit.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action = 'grant.expired' AND subject = ?").get(grantId) as any).n as number;
  const expiredEvents = () => (s.platform.db.prepare("SELECT COUNT(*) n FROM events WHERE type = 'grant.changed' AND bot_id = ? AND data LIKE '%\"expired\"%'").get(A.bot.id) as any).n as number;

  // The sweep runs at the top of a join transaction, and the join itself is refused below it.
  s.platform.db.exec("CREATE TRIGGER refuse_member_insert BEFORE INSERT ON face_room_members BEGIN SELECT RAISE(ABORT, 'store refused the seat'); END");
  await assert.rejects(
    A.owner.req("POST", "/v1/face-rooms/join", { code: "868686", bots: [A.bot.id] }),
    (e: any) => e.status === 500,
    "the join whose transaction carried the sweep was refused",
  );
  s.platform.db.exec("DROP TRIGGER refuse_member_insert");

  const row = () => s.platform.db.prepare("SELECT * FROM grants WHERE id = ?").get(grantId) as any;
  assert.equal(row().revoked_at, null, "the lapse claim rolled back with the transaction");
  assert.equal(expiredAudits(), 0, "no grant.expired row survives a sweep that did not commit");
  assert.equal(expiredEvents(), 0, "and nothing was announced about it");
  assert.equal(seat().left_at, null, "the seat the rolled-back lapse paid for is still taken");

  // The same sweep, committed this time, announces the lapse exactly once.
  await B.owner.req("GET", "/v1/face-rooms");
  assert.equal(expiredAudits(), 1, "the next sweep announces the lapse once");
  assert.equal(expiredEvents(), 1);
  assert.notEqual(row().revoked_at, null);
  assert.notEqual(seat().left_at, null, "and the seat goes with it");
  assert.equal(s.platform.audit.verify().ok, true);
});
