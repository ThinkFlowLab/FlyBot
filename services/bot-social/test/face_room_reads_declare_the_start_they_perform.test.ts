import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { bulkAuth, friends, startServer } from "./helpers.js";

/** The three read entries that advance the face rooms the caller is in. A lapsed share turns a candidate room into
 *  a started one, which voids the 6-digit number and deletes every `face_room_codes` row for the room, then wakes the
 *  members — so the wire must not offer them as free reads. */
const STARTS_A_ROOM: Record<string, Record<string, boolean>> = {
  list_face_rooms: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  get_face_room: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  list_presence: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
};

/** Tools that stay genuinely read-only. They all share the one `READ` object (`src/owner-mcp.ts:23`), so if a change
 *  had mutated that object instead of spreading it, every one of them would flip to write-plus-open-world.
 *  `list_conversations` is not one of them any more: it settles lapsed cards in the chats it lists, so it declares its
 *  own write and reach instead of sharing the read default. */
const STAYS_READ_ONLY: Record<string, Record<string, boolean>> = {
  whoami: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  list_invites: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  list_connector_tokens: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  get_bot_profile: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  custody_status: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  list_home_members: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  get_webhook: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  get_week_digest: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

/** The owner connector as a client reaches it: the door the annotation travels through. */
async function connect(base: string, token: string) {
  const c = new Client({ name: "t", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return c;
}

test("a face room read declares the start it performs", async (t) => {
  const s = await startServer(bulkAuth);
  const { A } = await friends(s.base);
  const c = await connect(s.base, (A.owner as any).token);
  t.after(async () => { await c.close(); await s.stop(); });

  const tools: any[] = (await c.listTools()).tools;
  assert.equal(tools.length, 51, "the fix moves annotations, not the tool set");
  const seen = Object.fromEntries(tools.map((x: any) => [x.name, x.annotations ?? {}]));

  for (const [name, annotations] of Object.entries(STARTS_A_ROOM)) {
    assert.deepEqual(seen[name], annotations, `${name} is advertised as a write that reaches out`);
    assert.equal((seen[name] as any).idempotentHint, undefined, `${name} says nothing about being idempotent`);
  }
});

test("the reads that start a room say so in their description", async (t) => {
  const s = await startServer(bulkAuth);
  const { A } = await friends(s.base);
  const c = await connect(s.base, (A.owner as any).token);
  t.after(async () => { await c.close(); await s.stop(); });

  const tools: any[] = (await c.listTools()).tools;
  for (const name of Object.keys(STARTS_A_ROOM)) {
    const tool = tools.find((x) => x.name === name);
    assert.ok(tool, `${name} is registered`);
    assert.match(String(tool.description), /codes?\b/, `${name} names the codes a read voids`);
  }
});

test("the shared read-only annotation is not mutated in place", async (t) => {
  const s = await startServer(bulkAuth);
  const { A } = await friends(s.base);
  const c = await connect(s.base, (A.owner as any).token);
  t.after(async () => { await c.close(); await s.stop(); });

  const tools: any[] = (await c.listTools()).tools;
  const seen = Object.fromEntries(tools.map((x: any) => [x.name, x.annotations ?? {}]));
  for (const [name, annotations] of Object.entries(STAYS_READ_ONLY)) {
    assert.deepEqual(seen[name], annotations, `${name} keeps the annotation it shared with the face room reads`);
  }
});
