// A Bot that sits in a waiting room can open it from its own MCP server.
//
// The REST door is already open to a seated Bot's own token (#318's own-seat rule; measured on 9cae531c: a Bot
// token POST /v1/face-rooms/:id/start -> 200 status "open"), but the Bot's MCP server stopped at the per-room
// read, draft and leave tools, so the tool surface a Bot actually runs with had no way to reach it. These tests
// pin the added tool, the site invariants it inherits (a seat of your own, no leak of a room you are not in),
// and the fact that starting an already open room changes nothing.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp.js";
import { ownerWithBot, startServer } from "./helpers.js";

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(); });
after(async () => { await S.stop(); });

/** The Bot's own MCP server, driven in memory: the same tool surface an assistant sees over stdio, without a process. */
async function botMcp(bot: Parameters<typeof createMcpServer>[0]) {
  const server = createMcpServer(bot);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const c = new Client({ name: "t", version: "0" });
  await c.connect(clientSide);
  return c;
}

const bodyOf = (r: any) => JSON.parse(r.content?.[0]?.text ?? "null");
async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  try {
    const r: any = await c.callTool({ name, arguments: args });
    return { isError: Boolean(r.isError), body: bodyOf(r) };
  } catch (e) {
    // An unknown tool makes callTool reject; keep that as a failed call so an assertion can name it.
    return { isError: true, body: { code: "call_failed", message: String(e) } };
  }
}

test("the Bot's MCP server lists start_face_room next to the other room tools", async () => {
  const A = await ownerWithBot(S.base, "startlisted");
  const c = await botMcp(A.bot);
  const tool = (await c.listTools()).tools.find((t) => t.name === "start_face_room");
  assert.ok(tool, "start_face_room is listed");
  assert.match(tool!.description ?? "", /seat/i, "the description names the seat it needs");
  await c.close();
});

test("a seated Bot opens the waiting room: status open, started_at stamped, and the number stops working", async () => {
  const A = await ownerWithBot(S.base, "startseat");
  const c = await botMcp(A.bot);
  const joined = await call(c, "join_face_room", { code: "619204" });
  assert.equal(joined.isError, false);
  assert.equal(joined.body.status, "candidate");
  const room = joined.body.room_id as string;

  const started = await call(c, "start_face_room", { room_id: room });
  assert.equal(started.isError, false);
  assert.equal(started.body.status, "open");
  assert.ok(started.body.started_at, "starting stamps started_at");

  const reread = await A.bot.faceRoom(room);
  assert.equal(reread.status, "open", "the room the console reads is the room the Bot opened");
  assert.equal(reread.started_at, started.body.started_at);

  // The number was the waiting room's: a home that types the same six digits now opens a different room.
  const B = await ownerWithBot(S.base, "startcode");
  const cb = await botMcp(B.bot);
  const again = await call(cb, "join_face_room", { code: "619204" });
  assert.equal(again.isError, false);
  assert.notEqual(again.body.room_id, room, "a started room's number no longer points at it");
  assert.equal(again.body.status, "candidate");
  await cb.close();
  await c.close();
});

test("a Bot without a seat of its own gets 404 face_room_not_found", async () => {
  const A = await ownerWithBot(S.base, "startowner");
  const ca = await botMcp(A.bot);
  const joined = await call(ca, "join_face_room", { code: "705318" });
  assert.equal(joined.isError, false);
  const room = joined.body.room_id as string;

  const B = await ownerWithBot(S.base, "startother");
  const cb = await botMcp(B.bot);
  const refused = await call(cb, "start_face_room", { room_id: room });
  assert.equal(refused.isError, true);
  assert.equal(refused.body.code, "face_room_not_found", "a room you are not in is not even confirmed to exist");
  await cb.close();
  await ca.close();
});

test("starting a room that is already open changes nothing: same started_at, still open", async () => {
  const A = await ownerWithBot(S.base, "starttwice");
  const c = await botMcp(A.bot);
  const joined = await call(c, "join_face_room", { code: "834071" });
  const room = joined.body.room_id as string;

  const first = await call(c, "start_face_room", { room_id: room });
  assert.equal(first.body.status, "open");
  const second = await call(c, "start_face_room", { room_id: room });
  assert.equal(second.isError, false, "a second start is not a refusal");
  assert.equal(second.body.status, "open");
  assert.equal(second.body.started_at, first.body.started_at, "the room keeps the moment it opened");
  await c.close();
});
