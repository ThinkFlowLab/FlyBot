// A Bot that asks "what did my rooms decide this week" has no tool for it: the week roll-up (#428) answers
// `GET /v1/digest` for a Bot token, and the owner's connector already lists `get_week_digest`, but the Bot's own
// MCP server stops at the per-room tools. These tests pin the added read tool, the scope it inherits (only the
// rooms this Bot's own seats sat in), and the empty week's zero shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp.js";
import { friends, ownerWithBot, startServer } from "./helpers.js";

/** Wednesday noon of the fixture week (2026-10-05 -> 2026-10-12, UTC): the week the REST digest test pins. */
const WED = Date.parse("2026-10-07T12:00:00.000Z");
const WEEK = "2026-10-05";
const WEEK_START = "2026-10-05T00:00:00.000Z";

/** The Bot's own MCP server, driven in memory: the same tool surface an assistant sees over stdio, no process. */
async function botMcp(bot: Parameters<typeof createMcpServer>[0]) {
  const server = createMcpServer(bot);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const c = new Client({ name: "t", version: "0" });
  await c.connect(clientSide);
  return c;
}

const bodyOf = (r: any) => {
  const text = String(r.content?.[0]?.text ?? "null");
  try { return JSON.parse(text); } catch { return { code: "unparsed", text }; }
};
async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  try {
    const r: any = await c.callTool({ name, arguments: args });
    return { isError: Boolean(r.isError), body: bodyOf(r) };
  } catch (e) {
    // An unknown tool makes callTool reject; keep that as a failed call so an assertion can name it.
    return { isError: true, body: { code: "call_failed", message: String(e) } };
  }
}

async function req(base: string, method: string, path: string, token: string, body?: unknown) {
  const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}

/** Two homes with one Bot each, in one started room with a note. */
async function roomWithTwoHomes(s: any, code: string, note: string, pair?: { A: any; B: any }) {
  const { A, B } = pair ?? (await friends(s.base));
  const opened = await req(s.base, "POST", "/v1/face-rooms/join", A.owner.token, { code, bots: [A.bot.id] });
  const joined = await req(s.base, "POST", "/v1/face-rooms/join", B.owner.token, { code, bots: [B.bot.id] });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.equal(joined.body.room_id, opened.body.room_id);
  const roomId = opened.body.room_id as string;
  assert.equal((await req(s.base, "POST", `/v1/face-rooms/${roomId}/start`, A.owner.token, {})).status, 200);
  assert.equal((await req(s.base, "POST", `/v1/face-rooms/${roomId}/note`, A.owner.token, { note })).status, 200);
  return { A, B, roomId };
}

/** Draft one room line and decide it. */
async function decidedLine(s: any, o: any, roomId: string, text: string, decision: "approved" | "rejected") {
  const sent = await req(s.base, "POST", `/v1/face-rooms/${roomId}/messages`, o.owner.token, { text, bot_id: o.bot.id });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  const decided = await req(s.base, "POST", `/v1/approvals/${sent.body.approval_id}/decision`, o.owner.token, { decision });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
}

/** The last seat out closes the room; every owner named leaves all of their seats. */
async function closeRoom(s: any, owners: any[], roomId: string) {
  for (const o of owners) assert.equal((await req(s.base, "POST", `/v1/face-rooms/${roomId}/leave`, o.owner.token, {})).status, 200);
}

test("the Bot's MCP server lists get_week_digest next to the room tools", async () => {
  const s = await startServer();
  try {
    const { A } = await friends(s.base);
    const c = await botMcp(A.bot);
    const tools = (await c.listTools()).tools;
    const tool = tools.find((t: any) => t.name === "get_week_digest");
    assert.ok(tool, "get_week_digest is listed");
    assert.match(String(tool.description), /week/i, "the description says which week it answers");
  } finally { await s.stop(); }
});

test("each home reads only the rooms its own seat sat in: two owners, two different digests", async () => {
  const clock = { t: WED };
  const s = await startServer({ now: () => clock.t });
  try {
    const { A, B } = await friends(s.base);
    const C = await ownerWithBot(s.base, "carol");

    // Three rooms over three homes. Each room's note is unique, so a line from a room the caller never sat in
    // cannot hide inside a total.
    const ab = await roomWithTwoHomes(s, "960001", "A and B this week", { A, B });
    await decidedLine(s, ab.A, ab.roomId, "line that was approved", "approved");
    await decidedLine(s, ab.A, ab.roomId, "line that was rejected", "rejected");

    const bc = await roomWithTwoHomes(s, "960002", "B and C only", { A: B, B: C });
    const ac = await roomWithTwoHomes(s, "960003", "A and C only", { A, B: C });

    for (const room of [ab, bc, ac]) await closeRoom(s, [room.A, room.B], room.roomId);

    const digestOf = async (bot: any) => {
      const got = await call(await botMcp(bot), "get_week_digest");
      assert.equal(got.isError, false, JSON.stringify(got.body));
      return got.body;
    };

    const aDigest = await digestOf(ab.A.bot);
    assert.equal(aDigest.week, WEEK, "the digest names the UTC week it rolls up");
    assert.equal(aDigest.period?.start, WEEK_START);
    assert.deepEqual(aDigest.rooms.map((r: any) => r.room_id).sort(), [ab.roomId, ac.roomId].sort(), "A's Bot reads the two rooms it sat in");
    assert.equal(aDigest.counts.rooms, 2);
    assert.equal(aDigest.counts.approved, 1, "the totals are the lines' own counts, not a second reading");
    assert.equal(aDigest.counts.rejected, 1);
    const abLine = aDigest.rooms.find((r: any) => r.room_id === ab.roomId);
    assert.equal(abLine.note, "A and B this week", "the line carries the room's own note");
    assert.equal(abLine.decisions.approved, 1);
    assert.equal(abLine.decisions.rejected, 1);
    assert.equal(abLine.decisions.cancelled, 0);
    assert.equal(abLine.decisions.expired, 0);
    assert.ok(!JSON.stringify(aDigest).includes("B and C only"), "a room A's Bot never sat in is not readable here");

    const bDigest = await digestOf(ab.B.bot);
    assert.deepEqual(bDigest.rooms.map((r: any) => r.room_id).sort(), [ab.roomId, bc.roomId].sort(), "B's Bot reads its own two rooms");
    assert.equal(bDigest.counts.rooms, 2);
    assert.ok(!JSON.stringify(bDigest).includes("A and C only"), "B's digest does not reach A and C's room either");

    const cDigest = await digestOf(C.bot);
    assert.deepEqual(cDigest.rooms.map((r: any) => r.room_id).sort(), [bc.roomId, ac.roomId].sort(), "C's Bot reads its own two rooms");
  } finally { await s.stop(); }
});

test("an empty week answers zeroes, and reading it twice answers the same object", async () => {
  const clock = { t: WED };
  const s = await startServer({ now: () => clock.t });
  try {
    const shared = await roomWithTwoHomes(s, "960004", "still matching");
    // Still open: not a closed room, so this week has nothing to roll up yet.
    const c = await botMcp(shared.A.bot);
    const first = await call(c, "get_week_digest");
    assert.equal(first.isError, false, JSON.stringify(first.body));
    assert.deepEqual(first.body.rooms, [], "an empty week is an empty list, never null");
    assert.deepEqual(first.body.counts, { rooms: 0, approved: 0, rejected: 0, cancelled: 0, expired: 0 });
    assert.equal(first.body.week, WEEK);
    const second = await call(c, "get_week_digest");
    assert.deepEqual(second.body, first.body, "reading it writes nothing, so the same week reads the same object");
  } finally { await s.stop(); }
});
