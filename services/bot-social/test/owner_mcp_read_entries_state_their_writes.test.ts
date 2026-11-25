import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { bulkAuth, friends, startServer } from "./helpers.js";

/** What each read entry must declare. The three list reads call `expireStale()`, which settles a lapsed grant and
 *  emits `grant.changed` (one webhook POST when the affected Bot has one), so they reach outside the server.
 *  `get_conversation` settles the same lapsed grant through `findGrant` silently — but both conversation reads also
 *  settle the lapsed cards of the chats they answer, which emits `approval.decided` and writes an audit row, so they
 *  reach outside the server too. None of them deletes or revokes anything: an expiry records a lapse that already
 *  happened. */
const DECLARED: Record<string, Record<string, boolean>> = {
  list_friends: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  list_bot_grants: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  list_remote_bots: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  list_conversations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  get_conversation: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
};

async function connect(base: string, token: string) {
  const c = new Client({ name: "t", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return c;
}
const parse = (r: any) => JSON.parse(r.content[0].text);
const call = async (c: any, name: string, args: any = {}) => { const r: any = await c.callTool({ name, arguments: args }); assert.ok(!r.isError, JSON.stringify(r)); return parse(r); };
const past = "2000-01-01T00:00:00.000Z";

test("the five read entries declare that reading settles lapsed access", async (t) => {
  const s = await startServer(bulkAuth);
  const { A } = await friends(s.base);
  const c = await connect(s.base, (A.owner as any).token);
  t.after(async () => { await c.close(); await s.stop(); });

  const tools: any[] = (await c.listTools()).tools;
  const seen: Record<string, Record<string, boolean | undefined>> = {};
  for (const name of Object.keys(DECLARED)) {
    const tool = tools.find((x) => x.name === name);
    assert.ok(tool, `${name} is registered`);
    seen[name] = { readOnlyHint: tool.annotations?.readOnlyHint, destructiveHint: tool.annotations?.destructiveHint, openWorldHint: tool.annotations?.openWorldHint };
  }
  // All five in one comparison: a red run names every tool that still lies, not just the first.
  assert.deepEqual(seen, DECLARED, "each read entry declares the write it performs");
  // Spelled out for the two conversation reads, so a future edit that puts them back to a free look names them.
  for (const name of ["list_conversations", "get_conversation"]) {
    assert.equal(seen[name].readOnlyHint, false, `${name} declares a read that writes`);
    assert.equal(seen[name].openWorldHint, true, `${name} declares its reach outside the server`);
  }
});

test("each read still performs the write it now declares", async (t) => {
  const sink = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => { hits.push(1); res.writeHead(200, { "content-type": "application/json" }).end("{}"); });
  });
  const hits: number[] = [];
  await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", () => resolve()));
  const hook = `http://127.0.0.1:${(sink.address() as any).port}/hook`;
  t.after(async () => { await new Promise<void>((r) => sink.close(() => r())); });

  // One server per tool, so one tool's sweep cannot settle the fixture prepared for the next.
  // `grantSettles` says whether that tool touches the lapsed grant at all (the list doors sweep it, the chat view's
  // reach check marks it expired, the chat list reports chats and never reads a grant); `grantSpeaks` says how loudly,
  // which is the only part `openWorldHint` was ever argued from. `withLapsedCard` adds a card that ran out in the chat
  // the tool answers about, which both conversation reads settle.
  const cases: { name: string; withConversation?: boolean; withLapsedCard?: boolean; grantSettles?: boolean; grantSpeaks?: boolean }[] = [
    { name: "list_friends", grantSettles: true, grantSpeaks: true },
    { name: "list_bot_grants", grantSettles: true, grantSpeaks: true },
    { name: "list_remote_bots", grantSettles: true, grantSpeaks: true },
    { name: "list_conversations", withConversation: true, withLapsedCard: true },
    { name: "get_conversation", withConversation: true, withLapsedCard: true, grantSettles: true },
  ];
  for (const spec of cases) {
    const s = await startServer({ ...bulkAuth, webhooks: { debounceMs: 0 } });
    const { A, B } = await friends(s.base, { freebusy: true });
    const conv = spec.withConversation ? await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "hi" }) : null;
    // A card that ran out in that chat: its own clock is what the conversation reads settle, so the fixture holds one
    // of each lapsed thing — a grant and a card — instead of the grant alone.
    const card = spec.withLapsedCard ? await A.bot.draftMessage((conv as any).conversation_id, { text: "a line whose card ran out" }) : null;
    if (card) s.platform.db.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?").run(past, (card as any).approval_id);
    // B granted A `calendar.freebusy.read`; the lapsed row is what each read settles.
    const grant = s.platform.db.prepare("SELECT id FROM grants WHERE grantee_bot = ? AND grantor_owner = ?").get(A.bot.id, B.owner_id) as any;
    assert.ok(grant, "the fixture holds one grant");
    s.platform.db.prepare("UPDATE grants SET expires_at = ? WHERE id = ?").run(past, grant.id);
    const c = await connect(s.base, (A.owner as any).token);
    await call(c, "set_webhook", { url: hook });
    await s.platform.webhooks.flush();
    hits.length = 0;

    const row = () => s.platform.db.prepare("SELECT status FROM grants WHERE id = ?").get(grant.id) as any;
    const events = () => (s.platform.db.prepare("SELECT COUNT(*) n FROM events").get() as any).n;
    const audit = () => s.platform.audit.list({ limit: 2000 }).length;
    const before = { status: row().status, events: events(), audit: audit() };
    assert.equal(before.status, "active", "the fixture starts live");

    if (spec.name === "list_bot_grants") await call(c, "list_bot_grants", { bot_id: A.bot.id });
    else if (spec.name === "get_conversation") await call(c, "get_conversation", { conversation_id: (conv as any).conversation_id });
    else await call(c, spec.name, {});
    await s.platform.webhooks.flush();

    assert.equal(row().status, spec.grantSettles ? "expired" : "active", spec.grantSettles
      ? `${spec.name} still settles the lapsed grant`
      : `${spec.name} reads chats, not access, so the lapsed grant is left for a door that owns it`);
    if (spec.withLapsedCard) {
      const settled = s.platform.db.prepare("SELECT status FROM approvals WHERE id = ?").get((card as any).approval_id) as any;
      assert.equal(settled.status, "expired", `${spec.name} settles the lapsed card of its own chat`);
    }
    // What each read leaves behind: the grant (loud on the list doors, silent on the chat view's reach check) and, when
    // the fixture holds one, the card — one event, one audit row and one webhook POST, exactly once each.
    const spoke = (spec.grantSpeaks ? 1 : 0) + (spec.withLapsedCard ? 1 : 0);
    assert.equal(events(), before.events + spoke, `${spec.name} emits what it settles`);
    assert.equal(audit(), before.audit + spoke, `${spec.name} writes an audit row for what it settles`);
    assert.equal(hits.length, spoke, `${spec.name} pushes one webhook per settlement`);
    await c.close();
    await s.stop();
  }
});
