// A presence read answers "who is thinking toward me", but it used to settle the whole server before it answered:
// `listPresence` called `advanceFaceRooms()`, whose sweep is unscoped. Every lapsed candidate room on the platform was
// promoted by it - the room flipped to `open`, its 6-digit number was voided, its `face_room_codes` rows deleted, a
// `room.started` event written, the members woken and an audit row appended - so a stranger holding a token and seated
// in no room at all could start another home's room by reading.
//
// A read now settles only the rooms the caller's own Bots are already seated in, which is what the room doors and the
// owner connector's wording already promise. The last test keeps the Bot-side tool text honest: it must not claim a
// read writes nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp.js";
import { ownerWithBot, startServer } from "./helpers.js";

const PAST = "2020-01-01T00:00:00.000Z";
const PUSH = "https://push.test/presence-read";

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

test("a stranger's presence read leaves another home's candidate room and its number alone", async (t) => {
  const { s, calls } = await server();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann", PUSH);
  const B = await ownerWithBot(s.base, "ben");
  const stranger = await ownerWithBot(s.base, "sam");
  const roomId = await candidate(s, A, B, "616161");
  lapse(s, roomId);
  await quiet(s, calls);

  const seen = await stranger.owner.req("GET", "/v1/presence");
  await s.platform.flushWebhooks();

  assert.equal(roomRow(s, roomId).status, "candidate", "the room the caller is not in is still a candidate");
  assert.equal(roomRow(s, roomId).code, "616161", "its number is not voided");
  assert.equal(codeRows(s, roomId), 1, "the number's row is still there");
  assert.equal(startedEvents(s, roomId), 0, "nobody was woken");
  assert.equal(startedAudits(s, roomId), 0, "the chain records no start");
  assert.equal(pushes(calls), 0, "no push went out");
  assert.deepEqual(seen.presence, [], "and the read itself still answers");
});

test("the same read still starts the candidate room the caller's own Bot is seated in", async (t) => {
  const { s, calls } = await server();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann", PUSH);
  const B = await ownerWithBot(s.base, "ben");
  const other = await ownerWithBot(s.base, "sid");
  const mine = await candidate(s, A, B, "626262");
  const theirs = await candidate(s, other, B, "636363");
  lapse(s, mine);
  lapse(s, theirs);
  await quiet(s, calls);

  await A.owner.req("GET", "/v1/presence");
  await s.platform.flushWebhooks();

  assert.equal(roomRow(s, mine).status, "open", "a candidate whose window lapsed is started");
  assert.equal(roomRow(s, mine).code, null, "its number is voided");
  assert.equal(codeRows(s, mine), 0, "the number's rows are gone");
  assert.equal(startedEvents(s, mine), 1, "the members are woken");
  assert.equal(startedAudits(s, mine), 1, "the chain records the start");
  assert.equal(pushes(calls), 1, "the seated Bot with a webhook is pushed once");

  assert.equal(roomRow(s, theirs).status, "candidate", "a lapsed room the caller has no seat in is left alone");
  assert.equal(roomRow(s, theirs).code, "636363", "and keeps its number");
  assert.equal(codeRows(s, theirs), 1);
  assert.equal(startedEvents(s, theirs), 0);
  assert.equal(startedAudits(s, theirs), 0);
});

test("the Bot's list_presence no longer claims a read writes nothing", async (t) => {
  const { s } = await server();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const mcp = createMcpServer(A.bot);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverSide);
  const c = new Client({ name: "t", version: "0" });
  await c.connect(clientSide);
  t.after(async () => { await c.close(); });

  const tool = (await c.listTools()).tools.find((x: any) => x.name === "list_presence") as any;
  assert.ok(tool, "the tool is listed");
  const text = String(tool.description);
  assert.doesNotMatch(text, /writes nothing/i, "the read no longer claims to write nothing");
  assert.match(text, /candidate/i, "it names the candidate rooms it starts");
  assert.match(text, /start/i, "and says that it starts them");
});
