import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { bulkAuth, friends, startServer } from "./helpers.js";

/** Tools that are genuinely read-only and that no open fix is queued to move. They all share the one `READ` object,
 *  so if a change mutated that object in place, every one of them would flip — asserting each one byte-for-byte pins
 *  the shared constant without making this test fail when an unrelated annotation fix lands on another tool.
 *  `list_conversations` left this list on purpose: it settles lapsed cards in the chats it lists, so it no longer
 *  shares `READ` and declares its own write and reach below. */
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

/** The owner connector as a client reaches it: a real MCP client over HTTP, the door the annotation travels through. */
async function connect(base: string, token: string) {
  const c = new Client({ name: "t", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return c;
}

test("list_approvals declares the sweep and the webhook that a read performs", async (t) => {
  const s = await startServer(bulkAuth);
  const { A } = await friends(s.base);
  const c = await connect(s.base, (A.owner as any).token);
  t.after(async () => { await c.close(); await s.stop(); });

  const tools: any[] = (await c.listTools()).tools;
  const tool = tools.find((x) => x.name === "list_approvals");
  assert.ok(tool, "list_approvals is registered");

  // Reading the queue expires lapsed cards and pushes the digest to the outlet's webhook, so neither hint may say
  // otherwise: `readOnlyHint` means "does not modify its environment", `openWorldHint` means "reaches outside".
  assert.deepEqual(
    { readOnlyHint: tool.annotations?.readOnlyHint, openWorldHint: tool.annotations?.openWorldHint },
    { readOnlyHint: false, openWorldHint: true },
    "a read of the queue writes approvals and POSTs a webhook",
  );
  // It retires a card; it neither deletes the card nor revokes anything, so destructiveness stays false.
  assert.equal(tool.annotations?.destructiveHint, false, "an expiry is a settlement, not a deletion");
});

test("the shared read-only annotation is not mutated in place", async (t) => {
  const s = await startServer(bulkAuth);
  const { A } = await friends(s.base);
  const c = await connect(s.base, (A.owner as any).token);
  t.after(async () => { await c.close(); await s.stop(); });

  const tools: any[] = (await c.listTools()).tools;
  assert.equal(tools.length, 51, "the fix moves one annotation, not the tool set");
  const seen = Object.fromEntries(tools.map((x: any) => [x.name, x.annotations ?? {}]));
  for (const [name, annotations] of Object.entries(STAYS_READ_ONLY)) {
    assert.deepEqual(seen[name], annotations, `${name} keeps the annotation it shared with list_approvals`);
  }
  // The chat list is out of that constant because its read settles lapsed cards: it must say so, not inherit a lie.
  assert.deepEqual(seen.list_conversations, { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    "list_conversations declares the settlement its own read performs");
});

test("one read of the queue expires a lapsed card and pushes exactly one webhook", async (t) => {
  const hits: { body: string }[] = [];
  const sink = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => { hits.push({ body }); res.writeHead(200, { "content-type": "application/json" }).end("{}"); });
  });
  await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", () => resolve()));
  const port = (sink.address() as any).port;

  const s = await startServer({ ...bulkAuth, webhooks: { debounceMs: 0 } });
  const { A, B } = await friends(s.base);
  const c = await connect(s.base, (A.owner as any).token);
  t.after(async () => { await c.close(); await s.stop(); await new Promise<void>((r) => sink.close(() => r())); });

  const conv: any = await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "hi" });
  await A.bot.draftMessage(conv.conversation_id, { text: "hello" });
  const card = s.platform.db.prepare("SELECT id, status FROM approvals WHERE owner_id = ? AND status = 'pending' ORDER BY created_at DESC").get(A.owner_id) as any;
  assert.ok(card, "the draft leaves one pending card");
  // The card lapses without the caller doing anything: only the read is left to sweep it.
  s.platform.db.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", card.id);

  const wired: any = await c.callTool({ name: "set_webhook", arguments: { url: `http://127.0.0.1:${port}/hook` } });
  assert.ok(!wired.isError, JSON.stringify(wired));
  await s.platform.webhooks.flush();
  hits.length = 0;

  type Row = { status?: string; n?: number };
  const row = (sql: string, ...args: any[]) => s.platform.db.prepare(sql).get(...args) as Row;
  const before = {
    status: row("SELECT status FROM approvals WHERE id = ?", card.id).status,
    events: row("SELECT COUNT(*) n FROM events").n,
    audit: s.platform.audit.list({ limit: 2000 }).length,
  };
  assert.equal(before.status, "pending");

  const r: any = await c.callTool({ name: "list_approvals", arguments: {} });
  assert.ok(!r.isError, JSON.stringify(r));
  await s.platform.webhooks.flush();

  const after = {
    status: row("SELECT status FROM approvals WHERE id = ?", card.id).status,
    events: row("SELECT COUNT(*) n FROM events").n,
    audit: s.platform.audit.list({ limit: 2000 }).length,
  };
  // The behaviour is master's and stays: this test pins the read-time sweep the annotation must describe.
  assert.equal(after.status, "expired", "the read settles the lapsed card");
  assert.equal(after.events, (before.events ?? 0) + 1, "the read emits one event");
  assert.equal(after.audit, before.audit + 1, "the read writes one audit row");
  assert.equal(hits.length, 1, "the read pushes exactly one webhook");
  const delivered = JSON.parse(hits[0].body);
  assert.equal(delivered.type, "botsocial.wake");
  assert.equal(delivered.event_count, 1);
  assert.deepEqual(delivered.counts, { "approval.decided": 1 }, "the pushed batch is the settlement the read performed");
  const newest = s.platform.db.prepare("SELECT type, data FROM events ORDER BY seq DESC LIMIT 1").get() as any;
  assert.equal(newest.type, "approval.decided");
  assert.equal(JSON.parse(newest.data).decision, "expired", "the event names the settlement the read performed");
});
