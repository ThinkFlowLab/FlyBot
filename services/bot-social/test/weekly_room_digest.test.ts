/**
 * What my Bots decided in face rooms this week.
 *
 * A face room that ends leaves one recap (`face_rooms.recap`, #428): why it ended, its note, one number per decision
 * and the seats. But the recap is per room and only its members' Bots ever read it, so an owner asking "what did my
 * Bots decide in rooms this week" still has to walk every room they were in and hope they remember which closed.
 *
 * This is that roll-up, read-only and derived from nothing but the recaps the rooms already carry:
 *
 * - `GET /v1/digest` returns the caller's rooms whose `closed_at` falls in the current UTC week (Monday 00:00 →
 *   next Monday 00:00), one line per room, plus the totals over those lines;
 * - each line carries only what the recap says — `reason`, `note`, the four decision counts and the members — never
 *   a line's text, never the transcript and never the approvals table;
 * - the caller decides the scope: an owner sees every room one of their seats sat in, a Bot token sees only its own
 *   seats — and a recap from a room the caller never sat in is not readable through the digest at all;
 * - an empty week is an explicit zero shape (`rooms: []`, all counters 0), not `null` and not an error;
 * - the same week reads the same object twice, field for field: nothing is written by reading it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { generateEd25519 } from "../src/crypto.js";
import { friends, ownerWithBot, startServer } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Wednesday noon of the fixture week (2026-10-05 → 2026-10-12, UTC). */
const WED = Date.parse("2026-10-07T12:00:00.000Z");
const WEEK = "2026-10-05";
const WEEK_START = Date.parse("2026-10-05T00:00:00.000Z");
const NEXT_START = Date.parse("2026-10-12T00:00:00.000Z");
/** Both sides of the UTC Monday boundary: a room closed on one side belongs to the week it was closed in. */
const SUNDAY_LAST_MINUTE = Date.parse("2026-10-11T23:59:00.000Z");
const MONDAY_FIRST_MINUTE = Date.parse("2026-10-12T00:01:00.000Z");

async function req(base: string, method: string, path: string, token: string, body?: unknown) {
  const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}

const digestOf = async (base: string, token: string) => {
  const r = await req(base, "GET", "/v1/digest", token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};

/** Two homes with one Bot each, in one started room with a note. */
async function roomWithTwoHomes(s: any, code: string, note: string, owners?: { A: any; B: any }) {
  const { A, B } = owners ?? (await friends(s.base));
  const opened = await req(s.base, "POST", "/v1/face-rooms/join", A.owner.token, { code, bots: [A.bot.id] });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  const joined = await req(s.base, "POST", "/v1/face-rooms/join", B.owner.token, { code, bots: [B.bot.id] });
  assert.equal(joined.body.room_id, opened.body.room_id);
  const roomId = opened.body.room_id as string;
  assert.equal((await req(s.base, "POST", `/v1/face-rooms/${roomId}/start`, A.owner.token)).status, 200);
  assert.equal((await req(s.base, "POST", `/v1/face-rooms/${roomId}/note`, A.owner.token, { note })).status, 200);
  return { A, B, roomId };
}

/** Draft one room line and decide it. */
async function decidedLine(s: any, o: any, roomId: string, text: string, decision: "approved" | "rejected") {
  const sent = await req(s.base, "POST", `/v1/face-rooms/${roomId}/messages`, o.owner.token, { text, bot_id: o.bot.id });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  const decided = await req(s.base, "POST", `/v1/approvals/${sent.body.approval_id}/decision`, o.owner.token, { decision });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  return sent.body;
}

/** The last seat out closes the room; every owner named leaves all of their seats. */
async function closeRoom(s: any, owners: any[], roomId: string) {
  for (const o of owners) assert.equal((await req(s.base, "POST", `/v1/face-rooms/${roomId}/leave`, o.owner.token, {})).status, 200);
}

/** The room row's stored recap (the digest must be that object, not a second reading of the room). */
const recapOf = (s: any, roomId: string) => {
  const row = s.platform.db.prepare("SELECT recap FROM face_rooms WHERE id = ?").get(roomId) as any;
  return row?.recap ? JSON.parse(row.recap) : null;
};

/** A second Bot for an owner that already has one, so one home can hold two seats. */
async function addBot(s: any, o: any, name: string) {
  const kp = generateEd25519();
  const r = await o.owner.req("POST", "/v1/bots", { handle: `${name}.bot`, public_key: { alg: "Ed25519", kid: "k1", value: kp.publicKey } });
  return { bot_id: r.bot_id as string, token: r.bot_token as string };
}

const keysOf = (value: any, out: Set<string> = new Set()) => {
  if (Array.isArray(value)) for (const v of value) keysOf(v, out);
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { out.add(k); keysOf(v, out); }
  return out;
};
const stringsOf = (value: any, out: string[] = []) => {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsOf(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) stringsOf(v, out);
  return out;
};

test("the digest is this week's closed rooms, one line each, exactly from their recaps", async () => {
  const clock = { t: WED };
  const s = await startServer({ now: () => clock.t });
  const NOTE1 = "Plan the May trip and nothing else.";
  const NOTE2 = "Quarterly sync.";
  const LINE1 = "Let us meet on the 12th of May.";
  const LINE2 = "Bring the dog to the meeting.";
  try {
    const { A, B } = await friends(s.base);
    const first = await roomWithTwoHomes(s, "920001", NOTE1, { A, B });
    await decidedLine(s, A, first.roomId, LINE1, "approved");
    await decidedLine(s, B, first.roomId, LINE2, "rejected");
    await closeRoom(s, [A, B], first.roomId);

    const second = await roomWithTwoHomes(s, "920002", NOTE2, { A, B });
    await decidedLine(s, A, second.roomId, "One more line", "approved");
    await closeRoom(s, [A, B], second.roomId);

    const digest = await digestOf(s.base, A.owner.token);
    assert.equal(digest.week, WEEK);
    assert.deepEqual(digest.period, { start: "2026-10-05T00:00:00.000Z", end: "2026-10-12T00:00:00.000Z" });
    assert.equal(digest.rooms.length, 2, "one line per room that ended this week");
    assert.deepEqual(digest.rooms.map((r: any) => r.room_id), [first.roomId, second.roomId], "ordered by when they closed");

    // Each line is the stored recap, field for field: no second reading of the room and no extra field.
    for (const [i, roomId] of [first.roomId, second.roomId].entries()) {
      const recap = recapOf(s, roomId);
      const line = digest.rooms[i];
      assert.deepEqual(Object.keys(line).sort(), ["closed_at", "decisions", "members", "note", "reason", "room_id"], "a line is exactly the recap's fields");
      assert.deepEqual(line.decisions, recap.decisions);
      assert.equal(line.reason, recap.reason);
      assert.equal(line.note, recap.note);
      assert.equal(line.closed_at, recap.closed_at);
      assert.deepEqual(line.members, recap.members);
      assert.equal(line.room_id, recap.room_id);
    }

    // Totals are the sum over the lines.
    assert.deepEqual(digest.counts, { rooms: 2, approved: 2, rejected: 1, cancelled: 0, expired: 0 });
    assert.equal(digest.rooms[0].note, NOTE1);

    // Reading twice is the same object: nothing is written by reading it, and no room is listed twice.
    assert.deepEqual(await digestOf(s.base, A.owner.token), digest);

    // It is a roll-up of counts and names, never a transcript: no line's text travels.
    const strings = stringsOf(digest);
    for (const line of [LINE1, LINE2]) assert.ok(!strings.some((x) => x.includes(line)), `the digest must not carry ${JSON.stringify(line)}`);
    const keys = keysOf(digest);
    for (const forbidden of ["text", "body", "transcript", "message", "payload", "approval_id"]) {
      assert.ok(!keys.has(forbidden), `the digest must not carry a ${forbidden} field`);
    }
  } finally { await s.stop(); }
});

test("a week with no room ending is an explicit zero shape, not null", async () => {
  const clock = { t: WED };
  const s = await startServer({ now: () => clock.t });
  try {
    const A = await ownerWithBot(s.base, "quietweek");
    const digest = await digestOf(s.base, A.owner.token);
    assert.deepEqual(digest, {
      digest_version: 1,
      week: WEEK,
      period: { start: "2026-10-05T00:00:00.000Z", end: "2026-10-12T00:00:00.000Z" },
      rooms: [],
      counts: { rooms: 0, approved: 0, rejected: 0, cancelled: 0, expired: 0 },
    }, "an empty week is the same shape with zeroes, so a client never has to special-case null");

    // A room that is still open is not in it either, and neither is one closed in another week.
    clock.t = NEXT_START + 60_000;
    const next = await digestOf(s.base, A.owner.token);
    assert.equal(next.week, "2026-10-12");
    assert.deepEqual(next.counts, { rooms: 0, approved: 0, rejected: 0, cancelled: 0, expired: 0 });
  } finally { await s.stop(); }
});

test("the caller sees only the rooms it sat in: owner and Bot scopes, and no leak either way", async () => {
  const clock = { t: WED };
  const s = await startServer({ now: () => clock.t });
  try {
    const { A, B } = await friends(s.base);
    const C = await ownerWithBot(s.base, "carol");

    const shared = await roomWithTwoHomes(s, "920003", "A and B", { A, B });
    await closeRoom(s, [A, B], shared.roomId);

    const other = await roomWithTwoHomes(s, "920004", "B and C", { A: B, B: C });
    await closeRoom(s, [B, C], other.roomId);

    const seenBy = async (token: string) => (await digestOf(s.base, token)).rooms.map((r: any) => r.room_id);
    assert.deepEqual(await seenBy(A.owner.token), [shared.roomId], "A sees the room A sat in, and not the one they never entered");
    assert.deepEqual(await seenBy(C.owner.token), [other.roomId], "C sees only their own room");
    assert.deepEqual((await seenBy(B.owner.token)).sort(), [shared.roomId, other.roomId].sort(), "B sat in both, so B sees both");

    // The reverse control: the room A never entered contributes nothing to A's totals or notes.
    const digest = await digestOf(s.base, A.owner.token);
    assert.equal(digest.counts.rooms, 1);
    assert.ok(!JSON.stringify(digest).includes("B and C"), "a room the caller never sat in is not readable through the digest");

    // A Bot token sees only its own seats, even inside one owner's account.
    assert.deepEqual(await seenBy(A.reg.bot_token), [shared.roomId], "A's Bot sees the room it sat in");
  } finally { await s.stop(); }
});

test("one owner with two seats in a room gets one line, and each Bot sees only its own seats", async () => {
  const clock = { t: WED };
  const s = await startServer({ now: () => clock.t });
  try {
    const A = await ownerWithBot(s.base, "twoseats");
    const B = await ownerWithBot(s.base, "peerseat");
    const extra = await addBot(s, A, "twoseats2");
    await A.owner.req("POST", "/v1/relationships", { from_bot_id: A.bot.id, target_handle: B.handle });
    const rel = await A.owner.req("GET", "/v1/relationships");
    await B.owner.req("POST", `/v1/relationships/${rel.relationships[0].relationship_id}/consent`, { decision: "accept" });

    const opened = await req(s.base, "POST", "/v1/face-rooms/join", A.owner.token, { code: "920005", bots: [A.bot.id, extra.bot_id] });
    await req(s.base, "POST", "/v1/face-rooms/join", B.owner.token, { code: "920005", bots: [B.bot.id] });
    const roomId = opened.body.room_id as string;
    await req(s.base, "POST", `/v1/face-rooms/${roomId}/start`, A.owner.token);
    await closeRoom(s, [A, B], roomId);

    const ownerDigest = await digestOf(s.base, A.owner.token);
    assert.deepEqual(ownerDigest.rooms.map((r: any) => r.room_id), [roomId]);
    assert.equal(ownerDigest.counts.rooms, 1, "two seats in one room are one room, not two");

    assert.deepEqual((await digestOf(s.base, A.reg.bot_token)).rooms.map((r: any) => r.room_id), [roomId]);
    assert.deepEqual((await digestOf(s.base, extra.token)).rooms.map((r: any) => r.room_id), [roomId]);
    assert.deepEqual((await digestOf(s.base, B.reg.bot_token)).rooms.map((r: any) => r.room_id), [roomId]);
  } finally { await s.stop(); }
});

test("the week is UTC Monday 00:00, and a room belongs to the week it closed in", async () => {
  const clock = { t: WED };
  const s = await startServer({ now: () => clock.t });
  try {
    const { A, B } = await friends(s.base);
    const sunday = await roomWithTwoHomes(s, "920006", "Closes on Sunday", { A, B });
    const monday = await roomWithTwoHomes(s, "920007", "Closes on Monday", { A, B });

    clock.t = SUNDAY_LAST_MINUTE;
    await closeRoom(s, [A, B], sunday.roomId);
    clock.t = MONDAY_FIRST_MINUTE;
    await closeRoom(s, [A, B], monday.roomId);

    clock.t = MONDAY_FIRST_MINUTE + 30 * 60e3;
    const thisWeek = await digestOf(s.base, A.owner.token);
    assert.equal(thisWeek.week, "2026-10-12");
    assert.deepEqual(thisWeek.rooms.map((r: any) => r.room_id), [monday.roomId], "the Sunday room belongs to the week that ended");

    clock.t = SUNDAY_LAST_MINUTE + 30e3;
    const lastWeek = await digestOf(s.base, A.owner.token);
    assert.equal(lastWeek.week, WEEK);
    assert.deepEqual(lastWeek.rooms.map((r: any) => r.room_id), [sunday.roomId], "and the Monday room to the week that started");
    assert.equal(lastWeek.rooms[0].closed_at, recapOf(s, sunday.roomId).closed_at, "the line carries the recap's own close time");
  } finally { await s.stop(); }
});

test("the console Home shows this week's rooms in one card", async () => {
  const clock = { t: WED };
  const s = await startServer({ now: () => clock.t });
  const NOTE = "Plan the May trip and nothing else.";
  try {
    const { A, B } = await friends(s.base);
    const room = await roomWithTwoHomes(s, "920008", NOTE, { A, B });
    await decidedLine(s, A, room.roomId, "Approved in the room", "approved");
    await closeRoom(s, [A, B], room.roomId);

    const home = loadHome(s.base, A.owner.token);
    const html = await home();
    assert.match(html, /Face rooms this week/, "the Home page has one card for the week's rooms");
    assert.ok(html.includes(NOTE), "the card names what each room was about");
    assert.match(html, /1 approved/, "the card shows the decision counts");

    // An owner with no closed room this week reads the empty sentence, not an empty card.
    const C = await ownerWithBot(s.base, "nochats");
    const quiet = await loadHome(s.base, C.owner.token)();
    assert.match(quiet, /No room ended this week/);
  } finally { await s.stop(); }
});

test("the read-only MCP tool answers the same week as the route", async () => {
  const clock = { t: WED };
  const s = await startServer({ now: () => clock.t });
  try {
    const { A, B } = await friends(s.base);
    const room = await roomWithTwoHomes(s, "920009", "MCP week", { A, B });
    await closeRoom(s, [A, B], room.roomId);

    const client = new Client({ name: "digest", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${s.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${A.owner.token}` } } }));
    try {
      const res: any = await client.callTool({ name: "get_week_digest", arguments: {} });
      const overMcp = JSON.parse(res.content[0].text);
      assert.deepEqual(overMcp, await digestOf(s.base, A.owner.token), "the tool answers what GET /v1/digest answers");
      assert.deepEqual(overMcp.rooms.map((r: any) => r.room_id), [room.roomId]);
    } finally { await client.close(); }
  } finally { await s.stop(); }
});

/** public/ui.js without boot(), signed in as this owner, with fetch pointed at the test server; renders Home. */
function loadHome(base: string, token: string) {
  const src = readFileSync(join(here, "..", "public", "ui.js"), "utf8")
    .replace(/\nboot\(\);\s*$/, "\n;globalThis.__ui = { PAGES, setMe: (m) => (me = m) };\n");
  const ctx: any = {
    localStorage: { getItem: (k: string) => (k === "bs_owner_token" ? token : null), setItem() {}, removeItem() {} },
    window: { addEventListener() {} },
    document: { querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, createElement: () => ({ setAttribute() {}, appendChild() {}, style: {}, classList: { add() {}, remove() {} } }) },
    location: { hash: "#/", origin: "https://example.test" },
    fetch: (path: string, init?: any) => fetch(base + path, init),
    setInterval() {}, setTimeout, clearTimeout, URLSearchParams, Intl, Date, console, prompt: () => null, confirm: () => true,
  };
  vm.runInNewContext(src, ctx);
  return async () => {
    const me = await (await fetch(base + "/v1/me", { headers: { authorization: `Bearer ${token}` } })).json();
    ctx.__ui.setMe(me);
    const v: any = { innerHTML: "", querySelector: () => null, querySelectorAll: () => [] };
    await ctx.__ui.PAGES[""](v);
    return v.innerHTML as string;
  };
}
