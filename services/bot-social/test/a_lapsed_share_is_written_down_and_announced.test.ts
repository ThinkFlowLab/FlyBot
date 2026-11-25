/**
 * A share that lapses on its own clock used to end in silence: `expireLapsedShares` flipped the row to `expired`
 * and gave its seats back, but wrote no audit row and told the peer Bot nothing. The shared Bot then disappeared
 * from `/v1/remote-bots` with no `grant.changed` to explain it, and no owner could see when the access ended.
 *
 * These readings pin the announcement: one `grant.expired` (actor `platform`, the grant as subject, both owners,
 * the capability and the grantee Bot) and one `grant.changed` with `status: "expired"` to the Bot that lost the
 * access. A lapse is announced once: a second sweep, another door that sweeps, and a lazy read that flipped the row
 * before the sweep must all end at the same single pair. A read on its own announces nothing, and the seat the
 * lapsed share paid for still goes back the way `grant.revoked` / `endGrantRooms` take it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

const PAST = "2020-01-01T00:00:00.000Z";

/** Alice's Bot holds a roomless `chat.public` share of Bob's Bot: Bob grants it, nobody has to move a seat. */
async function lapsedShare(t: any) {
  const s: any = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const rel = await A.owner.req("POST", "/v1/relationships", { from_bot_id: A.bot.id, target_handle: B.handle, message: "hi", requested_capabilities: ["chat.public"] });
  const relId = rel.relationship_id as string;
  await B.owner.req("POST", `/v1/relationships/${relId}/consent`, { decision: "accept", grant_capabilities: [] });
  const created = await B.owner.req("POST", `/v1/relationships/${relId}/grants`, { capability: "chat.public", expires_in_days: 30 });
  const grantId = created.grant_id as string;
  const row = () => s.platform.db.prepare("SELECT * FROM grants WHERE id = ?").get(grantId) as any;
  const lapse = () => s.platform.db.prepare("UPDATE grants SET expires_at = ? WHERE id = ?").run(PAST, grantId);
  /** Any face-room door runs the sweep; this is the one the existing lapse tests use. */
  const sweep = () => A.owner.req("GET", "/v1/face-rooms");
  const expiredAudits = () => (s.platform.auditEvents({ kind: "owner", ownerId: A.owner_id }, { limit: 500 }).events as any[])
    .filter((e: any) => e.action === "grant.expired" && e.subject === grantId);
  // Read the event queue with SQL: `platform.listEvents` runs `expireStale()`, and a reader that sweeps would hide
  // the very double announcement these readings are looking for.
  const changed = () => s.platform.db.prepare("SELECT * FROM events WHERE bot_id = ? AND type = 'grant.changed' ORDER BY seq").all(A.bot.id)
    .map((e: any) => JSON.parse(e.data) as any);
  const expiredEvents = () => changed().filter((e: any) => e.status === "expired");
  const allExpiredAudits = () => (s.platform.auditEvents({ kind: "owner", ownerId: A.owner_id }, { limit: 500 }).events as any[])
    .filter((e: any) => e.action === "grant.expired");
  const rowOf = (id: string) => s.platform.db.prepare("SELECT * FROM grants WHERE id = ?").get(id) as any;
  return { s, A, B, relId, grantId, row, rowOf, lapse, sweep, expiredAudits, allExpiredAudits, changed, expiredEvents };
}

test("a share that lapses on its clock writes one grant.expired and tells the Bot that lost the access", async (t) => {
  const { s, A, B, relId, grantId, row, lapse, sweep, expiredAudits, expiredEvents } = await lapsedShare(t);

  // Control: the share answers the reach check before the clock runs out.
  assert.ok(s.platform.findGrant(B.owner_id, A.bot.id, "chat.public"), "control: the share answers before the clock runs out");
  lapse();
  await sweep();

  const audits = expiredAudits();
  assert.equal(audits.length, 1, `one grant.expired for the lapse, got ${JSON.stringify(audits)}`);
  assert.equal(audits[0].actor, "platform", "the clock is the actor, as on relationship.expired");
  assert.equal(audits[0].subject, grantId, "the grant is the subject");
  assert.deepEqual(audits[0].owners, [A.owner_id, B.owner_id].sort(), "both owners can read the end of the access");
  assert.equal(audits[0].data.capability, "chat.public");
  assert.equal(audits[0].data.grantee_bot, A.bot.id);

  const events = expiredEvents();
  assert.equal(events.length, 1, `one grant.changed status:expired, got ${JSON.stringify(events)}`);
  assert.equal(events[0].relationship_id, relId);
  assert.equal(events[0].capability, "chat.public");

  const ended = row();
  assert.equal(ended.status, "expired", "the row itself still says expired");
  assert.equal(ended.revoked_at, PAST, "revoked_at records the moment the access really ended, not the sweep's clock");

  assert.equal(s.platform.findGrant(B.owner_id, A.bot.id, "chat.public"), null, "the lapsed capability no longer answers a reach check");
});

test("the same lapse is announced once however many doors sweep, and however often", async (t) => {
  const { B, lapse, sweep, expiredAudits, expiredEvents } = await lapsedShare(t);
  lapse();
  await sweep();
  assert.equal(expiredAudits().length, 1);
  assert.equal(expiredEvents().length, 1);

  await sweep();
  // A different door: `listBotGrants` settles stale rows before it answers, so it sweeps too.
  await B.owner.req("GET", `/v1/bots/${B.bot.id}/grants`);
  await sweep();

  assert.equal(expiredAudits().length, 1, "a settled lapse is not written down again");
  assert.equal(expiredEvents().length, 1, "the Bot is not told twice");
});

test("a lazy read settles the row without announcing, and the sweep still announces that lapse exactly once", async (t) => {
  const { s, relId, grantId, row, lapse, sweep, expiredAudits, expiredEvents } = await lapsedShare(t);
  lapse();

  // The reader `GET /v1/relationships` uses: it flips the row in place and must stay silent.
  s.platform.grantsFor(relId, { includeExpired: true });
  assert.equal(row().status, "expired", "the read settles the status");
  assert.equal(row().revoked_at, null, "the read writes no revoked_at: it is not the announcement");
  assert.equal(expiredAudits().length, 0, "a read must not write an audit row");
  assert.equal(expiredEvents().length, 0, "a read must not tell the Bot");

  await sweep();
  assert.equal(expiredAudits().length, 1, `the sweep still announces the lapse the read only settled: ${JSON.stringify(expiredAudits())}`);
  assert.equal(expiredEvents().length, 1);
  assert.equal(row().revoked_at, PAST);
  assert.equal(row().status, "expired");
});

test("a lapsed share still gives back the seat it paid for, and its room rows still end as grant.revoked reason room_left", async (t) => {
  const s: any = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const F = await ownerWithBot(s.base, "fay");
  const custody = (o: any) => s.platform.enableCustody({ kind: "owner" as const, ownerId: o.owner_id }, o.bot.id, { private_key_pem: o.kp.privateKeyPem });
  custody(A); custody(B); custody(F);

  // Fay shares her Bot with Ann's: Ann's Bot may bring it into a room as a guest.
  const rel = await F.owner.req("POST", "/v1/relationships", { from_bot_id: F.bot.id, target_handle: A.handle, message: "hi", requested_capabilities: ["chat.public"] });
  const relId = rel.relationship_id as string;
  await A.owner.req("POST", `/v1/relationships/${relId}/consent`, { decision: "accept", grant_capabilities: [] });
  const created = await F.owner.req("POST", `/v1/relationships/${relId}/grants`, { capability: "chat.public", expires_in_days: 30 });
  const grantId = created.grant_id as string;

  const code = "848484";
  const host = await B.owner.req("POST", "/v1/face-rooms/join", { code, bots: [B.bot.id] });
  const roomId = host.room_id as string;
  const brought = await A.owner.req("POST", "/v1/face-rooms/join", { code, bots: [A.bot.id, F.bot.id] });
  assert.equal(brought.room_id, roomId, "control: Ann brought Fay's Bot into the host's room");
  await A.owner.req("POST", `/v1/face-rooms/${roomId}/leave`, {});

  const seat = () => s.platform.db.prepare("SELECT * FROM face_room_members WHERE room_id = ? AND bot_id = ?").get(roomId, F.bot.id) as any;
  assert.ok(seat().left_at == null, "control: the guest seat F's share paid for is still taken");

  s.platform.db.prepare("UPDATE grants SET expires_at = ? WHERE id = ?").run(PAST, grantId);
  await B.owner.req("GET", "/v1/face-rooms");

  const audits = (s.platform.auditEvents({ kind: "owner", ownerId: F.owner_id }, { limit: 500 }).events as any[]);
  assert.equal(audits.filter((e: any) => e.action === "grant.expired" && e.subject === grantId).length, 1, "the lapse is written down");
  assert.ok(seat().left_at != null, "the seat the lapsed share paid for is gone");
  assert.equal(s.platform.db.prepare("SELECT COUNT(*) n FROM grants WHERE room_id = ? AND status = 'active'").get(roomId).n, 0,
    "the room-scoped grants of that seat are ended");

  const roomRows = s.platform.db.prepare("SELECT * FROM grants WHERE room_id = ?").all(roomId) as any[];
  assert.ok(roomRows.length > 0);
  // The room rows between the host and the bringer are not on Fay's page: read the chain itself, by subject.
  const revoked = (s.platform.audit.db.prepare("SELECT * FROM audit_events WHERE action = 'grant.revoked'").all() as any[])
    .map((e: any) => ({ ...e, data: JSON.parse(e.data) }));
  for (const g of roomRows) {
    const audit = revoked.find((e: any) => e.subject === g.id);
    assert.ok(audit, `the room-scoped row ${g.id} still ends as grant.revoked`);
    assert.equal(audit.data.reason, "room_left", "the room rows keep the reason the share ends a seat for");
    assert.equal(audit.data.room_id, roomId);
    assert.equal(audit.actor, "platform");
  }

  const expired = (s.platform.db.prepare("SELECT * FROM events WHERE bot_id = ? AND type = 'grant.changed' ORDER BY seq").all(A.bot.id) as any[])
    .map((e: any) => JSON.parse(e.data) as any).filter((e: any) => e.status === "expired");
  assert.equal(expired.length, 1, "the grantee Bot is told once, as on the roomless case");
  assert.equal(expired[0].capability, "chat.public");
});

test("a share that has not lapsed is not announced at all", async (t) => {
  const { row, sweep, expiredAudits, expiredEvents } = await lapsedShare(t);
  await sweep();
  await sweep();
  assert.equal(expiredAudits().length, 0, "a live share writes no grant.expired");
  assert.equal(expiredEvents().length, 0);
  assert.equal(row().status, "active");
  assert.equal(row().revoked_at, null);
});

test("a row renewed after its lapse is settled silently, and the announcement lands on the live row when that one ends", async (t) => {
  const { s, B, relId, grantId, rowOf, lapse, sweep, allExpiredAudits, expiredEvents } = await lapsedShare(t);
  lapse();
  // The reader `GET /v1/relationships` uses flips the row to expired before any sweep sees it. A renewal then writes
  // a new active row and leaves this one `expired`: supersede only touches `active` rows.
  s.platform.grantsFor(relId, { includeExpired: true });
  assert.equal(rowOf(grantId).status, "expired");
  const renewed = await B.owner.req("POST", `/v1/relationships/${relId}/grants`, { capability: "chat.public", expires_in_days: 30 });
  const liveId = renewed.grant_id as string;
  assert.notEqual(liveId, grantId);
  assert.equal(rowOf(liveId).status, "active");
  assert.equal(rowOf(grantId).status, "expired", "the old row stays history");

  await sweep();
  assert.equal(allExpiredAudits().length, 0, "a row renewed before the sweep is not announced: the line never lost the access");
  assert.equal(expiredEvents().length, 0, "the peer Bot holds the capability, so it is not told it lost it");
  assert.equal(rowOf(grantId).revoked_at, PAST, "the old row is settled silently, so no later sweep can announce it");
  assert.equal(rowOf(liveId).status, "active");

  // Now the live row ends on its own clock: that lapse is the line's, and it is the one that is announced.
  const LATER = "2020-02-02T00:00:00.000Z";
  s.platform.db.prepare("UPDATE grants SET expires_at = ? WHERE id = ?").run(LATER, liveId);
  await sweep();
  const audits = allExpiredAudits();
  assert.equal(audits.length, 1, `one announcement for the line, got ${JSON.stringify(audits)}`);
  assert.equal(audits[0].subject, liveId, "it names the live row, never the ancestor a renewal left behind");
  assert.equal(audits.filter((e: any) => e.subject === grantId).length, 0, "the settled ancestor is never announced later");
  assert.equal(rowOf(liveId).revoked_at, LATER);
  assert.equal(rowOf(grantId).revoked_at, PAST, "the ancestor keeps the moment it lapsed");
  assert.equal(expiredEvents().length, 1);
});
