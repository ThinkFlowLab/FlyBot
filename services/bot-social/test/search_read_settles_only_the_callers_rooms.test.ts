// A console search answers "find this chat or this room by its title", but `searchConsole` settled the whole server
// before it answered: its `advanceFaceRooms()` sweep is unscoped. Every lapsed candidate room on the platform was
// promoted by it — the room flipped to `open`, its 6-digit number voided, its `face_room_codes` rows deleted, a
// `room.started` event written, the members woken and an audit row appended — so a registered stranger seated in no
// room at all could start another home's room with one GET, and a server with two homes' lapsed rooms started both.
// The length check that refuses a query of the wrong size sits in front of all of it and must stay there.
//
// A search now settles only the rooms the caller holds a seat in, which is the seat rule the room list and the search
// hits already answer with. The share half of the same sweep stays as it is: a lapsed share is still ended and
// announced by the door that sweeps, whatever the caller's seats.
import assert from "node:assert/strict";
import { test } from "node:test";
import { expectApiError, ownerWithBot, startServer } from "./helpers.js";

const PAST = "2020-01-01T00:00:00.000Z";
const PUSH = "https://push.test/search-read";

type S = Awaited<ReturnType<typeof startServer>>;

/** A server whose webhook POSTs are captured instead of sent, so "0 pushes" and "1 push" are counted, not guessed. */
async function server() {
  const calls: { url: string; body: string }[] = [];
  const fetchImpl = (async (url: string, init: any) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  const s = await startServer({ fetchImpl });
  return { s, calls };
}

const roomRow = (s: S, id: string) => s.platform.db.prepare("SELECT * FROM face_rooms WHERE id = ?").get(id) as any;
const codeRows = (s: S, id: string) => (s.platform.db.prepare("SELECT COUNT(*) n FROM face_room_codes WHERE room_id = ?").get(id) as any).n as number;
const startedEvents = (s: S, id: string) => (s.platform.db.prepare("SELECT COUNT(*) n FROM face_room_events WHERE room_id = ? AND type = 'room.started'").get(id) as any).n as number;
const startedAudits = (s: S, id: string) => ((s.platform.audit as any).db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action = 'face_room.started' AND subject = ?").get(id) as any).n as number;
const pushes = (calls: { url: string }[]) => calls.filter((c) => c.url.startsWith(PUSH)).length;

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

/** Drain the deliveries the setup itself queued (the joins push their own events), so a later count is the read's. */
async function quiet(s: S, calls: { url: string; body: string }[]) {
  await s.platform.flushWebhooks();
  calls.length = 0;
}

const search = (who: any, q: string) => who.owner.req("GET", `/v1/search?q=${encodeURIComponent(q)}`);

test("a stranger's search leaves another home's candidate room and its number alone", async (t) => {
  const { s, calls } = await server();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "san", PUSH);
  const B = await ownerWithBot(s.base, "sbn");
  const C = await ownerWithBot(s.base, "scn");
  const stranger = await ownerWithBot(s.base, "ssn");
  const one = await candidate(s, A, B, "616161");
  const two = await candidate(s, C, B, "626262");
  lapse(s, one);
  lapse(s, two);
  await quiet(s, calls);

  const seen = await search(stranger, "zz");
  await s.platform.flushWebhooks();

  for (const [label, id, code] of [["first", one, "616161"], ["second", two, "626262"]] as const) {
    assert.equal(roomRow(s, id).status, "candidate", `${label}: a room the caller is not in is still a candidate`);
    assert.equal(roomRow(s, id).code, code, `${label}: its number is not voided`);
    assert.equal(codeRows(s, id), 1, `${label}: the number's row is still there`);
    assert.equal(startedEvents(s, id), 0, `${label}: nobody was woken`);
    assert.equal(startedAudits(s, id), 0, `${label}: the chain records no start`);
  }
  assert.equal(pushes(calls), 0, "no push went out");
  assert.deepEqual(seen.rooms, [], "and the search itself still answers");
});

test("a search still starts the candidate room the caller is seated in, and only that one", async (t) => {
  const { s, calls } = await server();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "sdn", PUSH);
  const B = await ownerWithBot(s.base, "sen");
  const other = await ownerWithBot(s.base, "sfn");
  const mine = await candidate(s, A, B, "636363");
  const theirs = await candidate(s, other, B, "646464");
  lapse(s, mine);
  lapse(s, theirs);
  await quiet(s, calls);

  await search(A, "zz");
  await s.platform.flushWebhooks();

  assert.equal(roomRow(s, mine).status, "open", "a candidate whose window lapsed is started");
  assert.equal(roomRow(s, mine).code, null, "its number is voided");
  assert.equal(codeRows(s, mine), 0, "the number's rows are gone");
  assert.equal(startedEvents(s, mine), 1, "the members are woken");
  assert.equal(startedAudits(s, mine), 1, "the chain records the start");
  assert.equal(pushes(calls), 1, "the seated Bot with a webhook is pushed once");

  assert.equal(roomRow(s, theirs).status, "candidate", "a lapsed room the caller has no seat in is left alone");
  assert.equal(roomRow(s, theirs).code, "646464", "and keeps its number");
  assert.equal(codeRows(s, theirs), 1);
  assert.equal(startedEvents(s, theirs), 0);
  assert.equal(startedAudits(s, theirs), 0);
});

test("a stranger's search still ends and announces a share that lapsed on its own clock", async (t) => {
  const { s } = await server();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "sga");
  const B = await ownerWithBot(s.base, "sgb");
  const stranger = await ownerWithBot(s.base, "sgc");
  const rel = await A.owner.req("POST", "/v1/relationships", { from_bot_id: A.bot.id, target_handle: B.handle, message: "hi", requested_capabilities: ["chat.public"] });
  const relId = rel.relationship_id as string;
  await B.owner.req("POST", `/v1/relationships/${relId}/consent`, { decision: "accept", grant_capabilities: [] });
  const created = await B.owner.req("POST", `/v1/relationships/${relId}/grants`, { capability: "chat.public", expires_in_days: 30 });
  const grantId = created.grant_id as string;
  s.platform.db.prepare("UPDATE grants SET expires_at = ? WHERE id = ?").run(PAST, grantId);

  await search(stranger, "zz");

  const row = s.platform.db.prepare("SELECT * FROM grants WHERE id = ?").get(grantId) as any;
  assert.equal(row.status, "expired", "the share is ended by its clock, whoever swept");
  assert.equal(row.revoked_at, PAST, "and records the moment the access really ended");
  const audits = (s.platform.auditEvents({ kind: "owner", ownerId: A.owner_id }, { limit: 500 }).events as any[])
    .filter((e: any) => e.action === "grant.expired" && e.subject === grantId);
  assert.equal(audits.length, 1, `one grant.expired for the lapse, got ${JSON.stringify(audits)}`);
  assert.equal(audits[0].actor, "platform", "the clock is the actor");
  const changed = (s.platform.db.prepare("SELECT * FROM events WHERE bot_id = ? AND type = 'grant.changed' ORDER BY seq").all(A.bot.id) as any[])
    .map((e: any) => JSON.parse(e.data) as any).filter((e: any) => e.status === "expired");
  assert.equal(changed.length, 1, "the Bot that lost the access is told once");
  assert.equal(changed[0].capability, "chat.public");
});

test("a refused search writes nothing at all", async (t) => {
  const { s, calls } = await server();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "sha", PUSH);
  const B = await ownerWithBot(s.base, "shb");
  const roomId = await candidate(s, A, B, "656565");
  lapse(s, roomId);
  await quiet(s, calls);

  for (const q of ["", "z", "z".repeat(101)]) {
    const err = await expectApiError(search(A, q), 400, "invalid_query");
    assert.match(err.message, /q must be 2-100 characters/, JSON.stringify(q));
  }
  await s.platform.flushWebhooks();
  assert.equal(roomRow(s, roomId).status, "candidate", "the length check runs before the sweep: nothing was started");
  assert.equal(roomRow(s, roomId).code, "656565", "the number is still valid");
  assert.equal(codeRows(s, roomId), 1);
  assert.equal(startedEvents(s, roomId), 0);
  assert.equal(startedAudits(s, roomId), 0);
  assert.equal(pushes(calls), 0);
});
