// The owner's MCP tool `start_face_room` is advertised as a plain write: its wire annotations were
// `{readOnlyHint:false, destructiveHint:false, openWorldHint:true}`. The door it calls is not one: `startFaceRoom`
// promotes a candidate room by clearing `face_rooms.code` and its matching deadline and then deleting every row in
// `face_room_codes` for that room, so the 6-digit number an owner already shared with other people stops working at
// once and nobody else can join. An assistant reading the annotations could reasonably pick that tool as the safe
// way to "open" a room. The annotation now says what the tool does — `destructiveHint:true`, the other two bits
// untouched — and the description says the codes are deleted. The behaviour itself is unchanged, and the shared
// annotation objects are not mutated: every other tool's wire annotations stay byte for byte what they were.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { bulkAuth, ownerWithBot, startServer } from "./helpers.js";

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(bulkAuth); });
after(async () => { await S.stop(); });

const connect = async (token: string) => {
  const c = new Client({ name: "t", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${S.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return c;
};

const text = (r: any) => JSON.parse(r.content[0].text);
const count = (sql: string, ...args: unknown[]) => (S.platform.db.prepare(sql).get(...args) as any).n as number;

test("the owner's start_face_room is advertised as destructive, and still a write", async () => {
  const A = await ownerWithBot(S.base, "ann");
  const c = await connect((A.owner as any).token);
  const tools = (await c.listTools()).tools;
  const tool = tools.find((t) => t.name === "start_face_room")!;
  assert.ok(tool, "start_face_room is listed");
  assert.equal(tool.annotations?.destructiveHint, true, "starting voids the room's 6-digit codes");
  assert.equal(tool.annotations?.readOnlyHint, false, "it writes");
  assert.equal(tool.annotations?.openWorldHint, true, "the other bits are untouched");
  assert.match(tool.description ?? "", /code/i, "the description says the codes stop working");
  await c.close();
});

test("starting a waiting room deletes its code rows and clears the room's code", async () => {
  const A = await ownerWithBot(S.base, "annrun");
  const c = await connect((A.owner as any).token);
  const joined = await A.bot.joinFaceRoom("318077");
  const room = joined.room_id as string;
  // A waiting room has one live number before it starts.
  assert.equal(count("SELECT COUNT(*) n FROM face_room_codes WHERE room_id = ?", room), 1);
  assert.ok(count("SELECT COUNT(*) n FROM face_rooms WHERE id = ? AND code = '318077'", room), "the room's code is the one joined");

  await c.callTool({ name: "start_face_room", arguments: { room_id: room } });

  const row = S.platform.db.prepare("SELECT status, code, expires_at FROM face_rooms WHERE id = ?").get(room) as any;
  assert.equal(row.status, "open");
  assert.equal(row.code, null, "the joined code is gone from the room");
  assert.equal(row.expires_at, "", "the matching deadline is cleared");
  assert.equal(count("SELECT COUNT(*) n FROM face_room_codes WHERE room_id = ?", room), 0, "every code row for the room is deleted");
  await c.close();
});

test("no other tool's wire annotations change when start_face_room is called", async () => {
  const A = await ownerWithBot(S.base, "annshare");
  const c = await connect((A.owner as any).token);
  const before = JSON.stringify((await c.listTools()).tools.map((t) => [t.name, t.annotations ?? null]).sort());
  const joined = await A.bot.joinFaceRoom("402551");
  await c.callTool({ name: "start_face_room", arguments: { room_id: joined.room_id } });
  const afterCall = JSON.stringify((await c.listTools()).tools.map((t) => [t.name, t.annotations ?? null]).sort());
  assert.equal(afterCall, before, "the shared annotation objects are not mutated by a call");
  const tools = (await c.listTools()).tools;
  const leaves = tools.find((t) => t.name === "leave_face_room")!;
  assert.equal(leaves.annotations?.destructiveHint, true);
  // list_invites is a neighbour that really is a read: every face room read now settles lapsed shares, so the
  // shared-object guard has to name a tool this family did not move.
  assert.equal(tools.find((t) => t.name === "list_invites")!.annotations?.readOnlyHint, true);
  await c.close();
});
