import assert from "node:assert/strict";
import { after, before, test } from "node:test";
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

test("a Bot's face-room tool reads mentions: null as none, the way the REST door and the owner's tool do", async () => {
  const A = await ownerWithBot(S.base, "nullmentions");
  const c = await botMcp(A.bot);
  const joined: any = await c.callTool({ name: "join_face_room", arguments: { code: "912345" } });
  const room = bodyOf(joined).room_id as string;

  // The control: with the field absent the call drafts, so any refusal below is about the value, not the room.
  const absent: any = await c.callTool({ name: "draft_face_room_message", arguments: { room_id: room, text: "no list" } });
  assert.equal(absent.isError, undefined);
  assert.equal(bodyOf(absent).status, "pending_approval");

  // README "Mentions" says null, absent and [] all mean none, and this room's REST door takes the null as well.
  const viaRest = await fetch(S.base + `/v1/face-rooms/${room}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${(A.owner as any).token}`, "content-type": "application/json" },
    body: JSON.stringify({ text: "null list via REST", mentions: null }),
  });
  assert.equal(viaRest.status, 202);

  // So the Bot's own MCP surface must not be the one front-end that answers a protocol error for it.
  const viaNull: any = await c.callTool({ name: "draft_face_room_message", arguments: { room_id: room, text: "null list", mentions: null } });
  assert.equal(viaNull.isError, undefined, `null means none: ${JSON.stringify(viaNull?.content)}`);
  const drafted = bodyOf(viaNull);
  assert.equal(drafted.status, "pending_approval");
  assert.equal(drafted.mentions, undefined, "a null list stays empty: nothing to keep");
  await c.close();
});
