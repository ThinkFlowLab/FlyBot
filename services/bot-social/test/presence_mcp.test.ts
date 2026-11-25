// A Bot sitting in an open room can list it, read it, start it and draft in it, but it cannot see who is thinking
// toward that room: the console's presence line and the owner's connector (`list_presence`, src/owner-mcp.ts) both
// already read it, the Bot's own MCP server stops at the room tools. These tests pin the added read tool, that it
// answers the same door with the same readout, and the three edges that door already has: another home's Bot is
// visible, the caller's own home never is, and a room the caller's Bot has no seat in stays empty.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp.js";
import { friends, ownerWithBot, startServer } from "./helpers.js";

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

/** One open room with both homes' own Bots seated: each Bot is seated by its own owner. */
async function openRoom(s: any, code: string, pair: { A: any; B: any }) {
  const opened = await req(s.base, "POST", "/v1/face-rooms/join", pair.A.owner.token, { code, bots: [pair.A.bot.id] });
  const joined = await req(s.base, "POST", "/v1/face-rooms/join", pair.B.owner.token, { code, bots: [pair.B.bot.id] });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.equal(joined.body.room_id, opened.body.room_id);
  assert.equal((await req(s.base, "POST", `/v1/face-rooms/${opened.body.room_id}/start`, pair.A.owner.token, {})).status, 200);
  return opened.body.room_id as string;
}

test("the Bot's MCP server lists list_presence next to the room tools", async () => {
  const s = await startServer();
  try {
    const { A } = await friends(s.base);
    const c = await botMcp(A.bot);
    const tools = (await c.listTools()).tools;
    const tool = tools.find((t: any) => t.name === "list_presence");
    assert.ok(tool, "list_presence is listed");
    assert.match(String(tool.description), /presence|thinking/i, "the description says what it reads");
    assert.equal((tool.inputSchema as any).required, undefined, "room_id is optional: the room is the caller's choice");
  } finally { await s.stop(); }
});

test("a Bot sees the other home's thinking line in the room it sits in, and nothing from a room it is not in", async () => {
  const s = await startServer();
  try {
    const { A, B } = await friends(s.base);
    const C = await ownerWithBot(s.base, "carol");
    const ab = await openRoom(s, "980001", { A, B });
    const bc = await openRoom(s, "980002", { A: B, B: C });

    // B's Bot is thinking toward the shared room; A's own Bot is thinking there too, which must stay out of A's view.
    assert.equal((await req(s.base, "PUT", "/v1/presence", B.reg.bot_token, { state: "thinking", room_id: ab })).status, 200);
    assert.equal((await req(s.base, "PUT", "/v1/presence", A.reg.bot_token, { state: "thinking", room_id: ab })).status, 200);

    // The door the tool must reach, read directly with A's Bot token on the same server: the control reading.
    const direct = await req(s.base, "GET", `/v1/presence?room_id=${ab}`, A.reg.bot_token);
    assert.equal(direct.status, 200, JSON.stringify(direct.body));
    assert.equal(direct.body.presence.length, 1, "one other home is thinking toward the room");
    assert.equal(direct.body.presence[0].state, "thinking");
    assert.equal(direct.body.presence[0].bot.handle, B.handle.replace(/^@/, "@"), "it is B's Bot, by handle");
    assert.equal(direct.body.presence[0].room_id, ab);

    const c = await botMcp(A.bot);
    const got = await call(c, "list_presence", { room_id: ab });
    assert.equal(got.isError, false, JSON.stringify(got.body));
    assert.deepEqual(got.body.presence, direct.body.presence, "the tool answers the same readout the console's presence line uses");
    assert.ok(!JSON.stringify(got.body.presence).includes(String(A.handle).replace(/^@/, "")), "A's own home is never in its own view");
    assert.ok(!JSON.stringify(got.body.presence).includes("carol"), "a home outside the room does not appear");

    // A's Bot has no seat in B and C's room: naming that room still answers nothing, not another home's line.
    assert.equal((await req(s.base, "PUT", "/v1/presence", B.reg.bot_token, { state: "thinking", room_id: bc })).status, 200);
    const outside = await call(c, "list_presence", { room_id: bc });
    assert.equal(outside.isError, false, JSON.stringify(outside.body));
    assert.deepEqual(outside.body.presence, [], "a room the caller's Bot has no seat in stays empty");
  } finally { await s.stop(); }
});

test("an empty presence read is an empty list, and reading it twice answers the same", async () => {
  const s = await startServer();
  try {
    const D = await ownerWithBot(s.base, "dave");
    const c = await botMcp(D.bot);
    const first = await call(c, "list_presence");
    assert.equal(first.isError, false, JSON.stringify(first.body));
    assert.deepEqual(first.body.presence, [], "nobody is thinking toward a Bot that sits in no room");
    assert.equal(typeof first.body.server_time, "string");
    const second = await call(c, "list_presence");
    assert.deepEqual(second.body.presence, first.body.presence, "reading it writes nothing, so the same empty week reads the same list");
  } finally { await s.stop(); }
});
