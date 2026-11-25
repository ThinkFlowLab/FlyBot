/**
 * Six reads were starting other homes' face rooms.
 *
 * `expireStale()` opened with `this.advanceFaceRooms()`, whose sweep is unscoped: every lapsed candidate room on the
 * platform was promoted by it — the room flipped to `open`, its 6-digit number was voided, its `face_room_codes`
 * rows deleted, a `room.started` event written and its members woken, an audit row appended. The same sweep also ends
 * lapsed shares, and that half is a read's own business: the share already ended on its clock, the read only writes
 * it down. So the sweep keeps the share half (`expireLapsedShares`) and drops the room half; a room is settled by the
 * room's own read and write doors, which call `advanceFaceRooms` themselves (#661).
 *
 * Both halves are asserted together on purpose. A change that stops the room sweep by stopping the whole sweep would
 * pass a room-only reading while quietly dropping the lapse announcement the read entries declare, so each of the six
 * doors below is read once and judged on both: the lapsed share is settled and announced exactly once, and another
 * home's lapsed candidate room keeps its status, its number, its chain and its members' quiet.
 *
 * The six reads that reach the sweep are `GET /v1/relationships`, `GET /v1/friends-overview`, `GET /v1/approvals`,
 * `GET /v1/bots/:id/grants`, `GET /v1/remote-bots` and the Bot's `GET /v1/events`. A stranger seated in no room at
 * all could start another home's room by asking any of them, and a member of the room could do it the same way,
 * because these six are not the room's doors.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { bulkAuth, ownerWithBot, startServer } from "./helpers.js";

const PAST = "2020-01-01T00:00:00.000Z";
const PUSH = "https://push.test/read-doors";

type S = Awaited<ReturnType<typeof startServer>>;

/** A server whose webhook POSTs are captured instead of sent, so a push is counted, not guessed. */
async function server() {
  const calls: { url: string; body: string }[] = [];
  const fetchImpl = (async (url: string, init: any) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  const s = await startServer({ ...bulkAuth, fetchImpl });
  return { s, calls };
}

const roomRow = (s: S, id: string) => s.platform.db.prepare("SELECT * FROM face_rooms WHERE id = ?").get(id) as any;
const codeRows = (s: S, id: string) => (s.platform.db.prepare("SELECT COUNT(*) n FROM face_room_codes WHERE room_id = ?").get(id) as any).n as number;
const startedEvents = (s: S, id: string) => (s.platform.db.prepare("SELECT COUNT(*) n FROM face_room_events WHERE room_id = ? AND type = 'room.started'").get(id) as any).n as number;
const startedAudits = (s: S, id: string) => ((s.platform.audit as any).db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action = 'face_room.started' AND subject = ?").get(id) as any).n as number;
const roomPushes = (calls: { body: string }[]) => calls.filter((c) => c.body.includes("face_room.started")).length;

/** Create a candidate room: the first join mints it, the second home joins the same number without starting it. */
async function candidate(s: S, creator: any, guest: any, code: string) {
  const made = await creator.owner.req("POST", "/v1/face-rooms/join", { code, bots: [creator.bot.id] });
  const roomId = made.room_id as string;
  assert.ok(roomId, JSON.stringify(made));
  const joined = await guest.owner.req("POST", "/v1/face-rooms/join", { code, bots: [guest.bot.id] });
  assert.equal(joined.room_id, roomId);
  assert.equal(roomRow(s, roomId).status, "candidate", "a second join does not start the room");
  return roomId as string;
}

/** Let the matching window lapse: the same row `advanceFaceRooms` promotes once it is due. */
function lapse(s: S, roomId: string) {
  s.platform.db.prepare("UPDATE face_rooms SET expires_at = ? WHERE id = ?").run(PAST, roomId);
}

/** Bob shares his Bot with Alice for a while, then the clock runs out on that share. */
async function lapsedShare(s: S, giver: any, taker: any) {
  const rel = await taker.owner.req("POST", "/v1/relationships", { from_bot_id: taker.bot.id, target_handle: giver.handle, message: "hi", requested_capabilities: ["chat.public"] });
  await giver.owner.req("POST", `/v1/relationships/${rel.relationship_id}/consent`, { decision: "accept", grant_capabilities: [] });
  const created = await giver.owner.req("POST", `/v1/relationships/${rel.relationship_id}/grants`, { capability: "chat.public", expires_in_days: 30 });
  const grantId = created.grant_id as string;
  s.platform.db.prepare("UPDATE grants SET expires_at = ? WHERE id = ?").run(PAST, grantId);
  const row = () => s.platform.db.prepare("SELECT * FROM grants WHERE id = ?").get(grantId) as any;
  const expiredAudits = () => (s.platform.auditEvents({ kind: "owner", ownerId: taker.owner_id }, { limit: 500 }).events as any[])
    .filter((e: any) => e.action === "grant.expired" && e.subject === grantId);
  const expiredAnnouncements = () => (s.platform.db.prepare("SELECT * FROM events WHERE bot_id = ? AND type = 'grant.changed'").all(taker.bot.id) as any[])
    .map((e: any) => JSON.parse(e.data) as any)
    .filter((e: any) => e.status === "expired");
  return { grantId, row, expiredAudits, expiredAnnouncements };
}

/** Drain the deliveries the setup itself queued (the joins and the grant push their own events). */
async function quiet(s: S, calls: { url: string }[]) {
  await s.platform.flushWebhooks();
  calls.length = 0;
}

/** The six reads that reach `expireStale()`, each called as the given owner/bot pair. */
const READ_DOORS: { name: string; call: (who: any) => Promise<any> }[] = [
  { name: "GET /v1/relationships", call: (who) => who.owner.req("GET", "/v1/relationships") },
  { name: "GET /v1/friends-overview", call: (who) => who.owner.req("GET", "/v1/friends-overview") },
  { name: "GET /v1/approvals", call: (who) => who.owner.req("GET", "/v1/approvals?status=all") },
  { name: "GET /v1/bots/:id/grants", call: (who) => who.owner.req("GET", `/v1/bots/${who.bot.id}/grants`) },
  { name: "GET /v1/remote-bots", call: (who) => who.owner.req("GET", "/v1/remote-bots") },
  { name: "GET /v1/events", call: (who) => who.bot.req("GET", "/v1/events") },
];

function assertRoomUntouched(s: S, roomId: string, code: string, calls: { body: string }[], where: string) {
  assert.equal(roomRow(s, roomId).status, "candidate", `${where} leaves the room a candidate`);
  assert.equal(roomRow(s, roomId).code, code, `${where} does not void the number`);
  assert.equal(codeRows(s, roomId), 1, `${where} keeps the number's row`);
  assert.equal(startedEvents(s, roomId), 0, `${where} wakes nobody`);
  assert.equal(startedAudits(s, roomId), 0, `${where} writes no start into the chain`);
  assert.equal(roomPushes(calls), 0, `${where} pushes no room start`);
}

test("each of the six read doors settles a lapsed share and leaves another home's candidate room alone", async (t) => {
  const codes = ["717171", "727272", "737373", "747474", "757575", "767676"];
  let i = 0;
  for (const door of READ_DOORS) {
    const code = codes[i++];
    const { s, calls } = await server();
    try {
      const A = await ownerWithBot(s.base, "ann", PUSH);
      const B = await ownerWithBot(s.base, "ben");
      const stranger = await ownerWithBot(s.base, "sam");
      const share = await lapsedShare(s, A, B);
      const roomId = await candidate(s, A, B, code);
      lapse(s, roomId);
      await quiet(s, calls);

      await door.call(stranger);
      await s.platform.flushWebhooks();

      // Half one: the share that ran out is settled and told once, by the same read.
      assert.equal(share.row().status, "expired", `${door.name} still settles the lapsed share`);
      const audits = share.expiredAudits();
      assert.equal(audits.length, 1, `${door.name} announces the lapse once, got ${JSON.stringify(audits)}`);
      assert.equal(audits[0].actor, "platform", `${door.name} credits the clock, not the reader`);
      const told = share.expiredAnnouncements();
      assert.equal(told.length, 1, `${door.name} tells the Bot that lost the access, got ${JSON.stringify(told)}`);

      // Half two: the candidate room the caller has no seat in keeps everything it had.
      assertRoomUntouched(s, roomId, code, calls, door.name);
    } finally {
      await s.stop();
    }
  }
});

test("a seated member's read of those doors leaves the room alone too: settlement belongs to the room's doors", async (t) => {
  const { s, calls } = await server();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann", PUSH);
  const B = await ownerWithBot(s.base, "ben");
  const roomId = await candidate(s, A, B, "777777");
  lapse(s, roomId);
  await quiet(s, calls);

  for (const door of READ_DOORS) {
    // `A` is seated in the room; the sweep is still not this door's business, because the door is not the room's.
    await door.call(A);
    await s.platform.flushWebhooks();
    assertRoomUntouched(s, roomId, "777777", calls, `${door.name} (seat or not)`);
  }
});

test("the room's own read still settles a lapsed candidate room", async (t) => {
  const { s, calls } = await server();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann", PUSH);
  const B = await ownerWithBot(s.base, "ben");
  const roomId = await candidate(s, A, B, "787878");
  lapse(s, roomId);
  await quiet(s, calls);

  await A.owner.req("GET", `/v1/face-rooms/${roomId}`);
  await s.platform.flushWebhooks();

  assert.equal(roomRow(s, roomId).status, "open", "the room is started");
  assert.equal(roomRow(s, roomId).code, null, "its number is voided");
  assert.equal(codeRows(s, roomId), 0, "the number's rows are gone");
  assert.equal(startedEvents(s, roomId), 1, "the members are woken");
  assert.equal(startedAudits(s, roomId), 1, "the chain records the start");
  assert.equal(roomPushes(calls), 1, "the seated Bot with a webhook is pushed once");
});

test("a room write door still settles a lapsed candidate room", async (t) => {
  const { s, calls } = await server();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann", PUSH);
  const B = await ownerWithBot(s.base, "ben");
  const roomId = await candidate(s, A, B, "797979");
  lapse(s, roomId);
  await quiet(s, calls);

  // The sweep runs before the door judges the request, so the room is settled whichever answer the start gets.
  await A.owner.req("POST", `/v1/face-rooms/${roomId}/start`).catch(() => {});
  await s.platform.flushWebhooks();

  assert.equal(roomRow(s, roomId).status, "open", "the write door starts the room");
  assert.equal(roomRow(s, roomId).code, null, "its number is voided");
  assert.equal(codeRows(s, roomId), 0, "the number's rows are gone");
  assert.equal(startedEvents(s, roomId), 1, "the members are woken once");
  assert.equal(startedAudits(s, roomId), 1, "the chain records the start once");
});
