import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { bulkAuth, friends, startServer } from "./helpers.js";

/** The owner connector as a client reaches it: a real MCP client over HTTP, the door the annotation travels through. */
async function connect(base: string, token: string) {
  const c = new Client({ name: "t", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return c;
}

test("list_inbox declares the write it does: its annotation is not read-only", async (t) => {
  const s = await startServer(bulkAuth);
  const { A } = await friends(s.base);
  const c = await connect(s.base, (A.owner as any).token);
  t.after(async () => { await c.close(); await s.stop(); });

  const listed: any = await c.listTools();
  const tool = listed.tools.find((x: any) => x.name === "list_inbox");
  assert.ok(tool, "list_inbox is registered");
  // The default call advances the custody cursor, so the machine-readable hint clients act on must say so.
  assert.equal(tool.annotations?.readOnlyHint, false, "list_inbox writes a cursor, so readOnlyHint must be false");
  // It is not destructive and it reaches nothing outside the server.
  assert.equal(tool.annotations?.destructiveHint, false);
  assert.equal(tool.annotations?.openWorldHint, false);
  // A genuinely read-only neighbour keeps its hint: the fix is scoped to the cursored tool. `whoami` never writes,
  // so it outlives every read-entry fix; `list_friends` was the neighbour here until it too declared its sweep.
  const readOnly = listed.tools.find((x: any) => x.name === "whoami");
  assert.equal(readOnly.annotations?.readOnlyHint, true);
});

test("peek keeps the cursor where it was and the default call advances it", async (t) => {
  const s = await startServer(bulkAuth);
  const { A, B } = await friends(s.base);
  const c = await connect(s.base, (A.owner as any).token);
  t.after(async () => { await c.close(); await s.stop(); });

  const en: any = await c.callTool({ name: "enable_custody", arguments: {} });
  assert.ok(!en.isError, JSON.stringify(en));
  // Something to read on A's Bot: B opens a conversation with it.
  await B.bot.startConversation(A.bot.id, { type: "general_chat", summary: "probe" });

  const cursor = () => (s.platform.db.prepare("SELECT events_cursor FROM bot_custody WHERE bot_id = ?").get(A.bot.id) as any).events_cursor;
  const parse = (r: any) => JSON.parse(r.content[0].text);

  const peek: any = parse(await c.callTool({ name: "list_inbox", arguments: { peek: true } }));
  assert.ok(peek.events.length > 0, "the fixture leaves something to read");
  assert.equal(cursor(), 0, "peek=true is the pure read: it must not advance the cursor");

  const first: any = parse(await c.callTool({ name: "list_inbox", arguments: {} }));
  assert.equal(first.events.length, peek.events.length, "a read after a peek returns the same events");
  assert.equal(cursor(), first.next_cursor, "the default call advances the cursor it reports");
  assert.ok(first.next_cursor > 0);

  const second: any = parse(await c.callTool({ name: "list_inbox", arguments: {} }));
  assert.equal(second.events.length, 0, "the cursor advanced, so the next default call is empty");
});
