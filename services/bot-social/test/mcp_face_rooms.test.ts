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
const bare = (h: unknown) => String(h ?? "").replace(/^@/, "");

async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  const r: any = await c.callTool({ name, arguments: args });
  return { isError: Boolean(r.isError), body: bodyOf(r) };
}

test("list_face_rooms is empty until the Bot joins a room", async () => {
  const A = await ownerWithBot(S.base, "mcpfaceroom");
  const c = await botMcp(A.bot);
  const listed = await call(c, "list_face_rooms");
  assert.equal(listed.isError, false);
  assert.deepEqual(listed.body.rooms, []);
  await c.close();
});

test("join_face_room enters with a 6-digit code and seats the Bot", async () => {
  const A = await ownerWithBot(S.base, "joincode");
  const c = await botMcp(A.bot);
  const joined = await call(c, "join_face_room", { code: "742193" });
  assert.equal(joined.isError, false);
  assert.ok(joined.body.room_id, "the answer names the room");
  assert.equal(joined.body.status, "candidate");
  assert.equal(joined.body.members.length, 1);
  assert.equal(bare(joined.body.members[0].handle), bare(A.handle));

  const listed = await call(c, "list_face_rooms");
  assert.equal(listed.body.rooms.length, 1);
  assert.equal(listed.body.rooms[0].room_id, joined.body.room_id);
  assert.deepEqual(listed.body.rooms[0].my_bots.map((b: any) => bare(b.handle)), [bare(A.handle)]);
  await c.close();
});

test("draft_face_room_message is a held draft, and read_face_room shows it once the owner approves", async () => {
  const A = await ownerWithBot(S.base, "draftface");
  const c = await botMcp(A.bot);
  const joined = await call(c, "join_face_room", { code: "813502" });
  assert.equal(joined.isError, false);
  const room = joined.body.room_id as string;

  const draft = await call(c, "draft_face_room_message", { room_id: room, text: "hello from my own MCP" });
  assert.equal(draft.isError, false);
  assert.equal(draft.body.status, "pending_approval");
  assert.ok(draft.body.approval_id, "a held draft names its approval");

  const pending = await A.owner.req("GET", "/v1/approvals?status=pending");
  const mine = (pending.approvals as any[]).find((a) => a.approval_id === draft.body.approval_id);
  assert.ok(mine, "the owner's own queue carries the Bot's room draft");
  assert.equal(mine.kind, "face_room_message");

  await A.owner.req("POST", `/v1/approvals/${draft.body.approval_id}/decision`, { decision: "approved" });

  const read = await call(c, "read_face_room", { room_id: room });
  assert.equal(read.isError, false);
  assert.equal(read.body.room_id, room);
  const text = JSON.stringify(read.body);
  assert.match(text, /hello from my own MCP/, "the approved line is in the room the Bot reads");
  await c.close();
});

test("leave_face_room takes the seat back out of the Bot's room list", async () => {
  const A = await ownerWithBot(S.base, "leaveface");
  const c = await botMcp(A.bot);
  const joined = await call(c, "join_face_room", { code: "509914" });
  assert.equal(joined.isError, false);
  const room = joined.body.room_id as string;

  const left = await call(c, "leave_face_room", { room_id: room });
  assert.equal(left.isError, false);
  const listed = await call(c, "list_face_rooms");
  assert.deepEqual(listed.body.rooms, []);

  const again = await call(c, "draft_face_room_message", { room_id: room, text: "still here?" });
  assert.equal(again.isError, true);
  assert.equal(again.body.code, "face_room_not_found");
  await c.close();
});

test("a Bot outside the room cannot read it or draft in it", async () => {
  const A = await ownerWithBot(S.base, "roomowner");
  const B = await ownerWithBot(S.base, "outsider");
  const ca = await botMcp(A.bot);
  const cb = await botMcp(B.bot);
  const joined = await call(ca, "join_face_room", { code: "337205" });
  assert.equal(joined.isError, false);
  const room = joined.body.room_id as string;

  const draft = await call(cb, "draft_face_room_message", { room_id: room, text: "not mine" });
  assert.equal(draft.isError, true);
  assert.equal(draft.body.code, "face_room_not_found");

  const read = await call(cb, "read_face_room", { room_id: room });
  assert.equal(read.isError, true);
  assert.equal(read.body.code, "face_room_not_found");
  await ca.close();
  await cb.close();
});
