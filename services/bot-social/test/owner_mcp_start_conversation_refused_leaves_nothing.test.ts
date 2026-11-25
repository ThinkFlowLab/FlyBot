import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { bulkAuth, friends, startServer } from "./helpers.js";
import { CAPS, flybotHomes } from "./flybot_helpers.js";

/** The owner connector as Grok Bot reaches it: a real MCP client over HTTP, the same door the tool lives behind. */
async function connect(base: string, token: string) {
  const c = new Client({ name: "t", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return c;
}

/** A custodial pair (A's Bot can chat from the connector) on a fresh server, plus counters for everything a refused
 *  composer call must not leave behind. */
async function custodialPair(t: any) {
  const s = await startServer(bulkAuth);
  const { A, B, relId } = await friends(s.base);
  const c = await connect(s.base, (A.owner as any).token);
  t.after(async () => { await c.close(); await s.stop(); });
  const enabled = await c.callTool({ name: "enable_custody", arguments: {} });
  assert.ok(!enabled.isError, JSON.stringify(enabled));
  const one = (sql: string, ...args: unknown[]) => (s.platform.db.prepare(sql).get(...args) as any).n as number;
  const auditOne = (sql: string) => (s.platform.audit.db.prepare(sql).get() as any).n as number;
  /** Everything a conversation started by a refused first line would leave: the row, the peer's event, the trail,
   *  the allow decision, the draft, and the count the pair's daily quota reads. */
  const left = () => ({
    conversations: one("SELECT COUNT(*) n FROM conversations WHERE relationship_id = ?", relId),
    peer_started: one("SELECT COUNT(*) n FROM events WHERE bot_id = ? AND type = 'conversation.started'", B.bot.id),
    created_audit: auditOne("SELECT COUNT(*) n FROM audit_events WHERE action = 'conversation.created'"),
    allow_decision: auditOne(`SELECT COUNT(*) n FROM audit_events WHERE action = 'policy.decision' AND data LIKE '%"action":"conversation.create"%' AND data LIKE '%"decision":"allow"%'`),
    messages: one("SELECT COUNT(*) n FROM messages"),
  });
  /** The exact query `openConversation` runs for the pair's daily cap. */
  const quota = () => one("SELECT COUNT(*) n FROM conversations WHERE relationship_id = ? AND created_at > ?", relId, new Date(Date.now() - 86400e3).toISOString());
  const refusedText = (r: any) => {
    assert.equal(r.isError, true, "a 5000-character first line must be refused");
    const body = JSON.parse(r.content[0].text);
    assert.equal(body.code, "invalid_request");
    assert.match(body.message, /payload\.text \(1-4000 chars\) required/);
  };
  return { s, A, B, relId, c, left, quota, refusedText };
}

test("a refused first line leaves no conversation, no peer event, no audit row and no quota spent", async (t) => {
  const { c, B, left, quota, refusedText } = await custodialPair(t);
  refusedText(await c.callTool({ name: "start_conversation", arguments: { friend: B.handle, text: "x".repeat(5000) } }));
  assert.deepEqual(left(), { conversations: 0, peer_started: 0, created_audit: 0, allow_decision: 0, messages: 0 });
  assert.equal(quota(), 0, "a refused first line spent the pair's new-conversation quota");
});

test("six refused retries neither accumulate conversations nor spend the pair's daily quota", async (t) => {
  const { c, B, left, quota, refusedText } = await custodialPair(t);
  for (let i = 0; i < 6; i++) refusedText(await c.callTool({ name: "start_conversation", arguments: { friend: B.handle, text: "y".repeat(5000) } }));
  assert.deepEqual(left(), { conversations: 0, peer_started: 0, created_audit: 0, allow_decision: 0, messages: 0 });
  assert.equal(quota(), 0);
  // The retry that finally sends a legal line opens the thread: nothing was spent on the six refusals.
  const ok: any = await c.callTool({ name: "start_conversation", arguments: { friend: B.handle, text: "Free this weekend?" } });
  assert.ok(!ok.isError, JSON.stringify(ok));
  const body = JSON.parse(ok.content[0].text);
  assert.ok(body.conversation.conversation_id);
  assert.equal(body.message.status, "pending_approval");
  assert.deepEqual(left(), { conversations: 1, peer_started: 1, created_audit: 1, allow_decision: 1, messages: 1 });
  assert.equal(quota(), 1);
});

test("a valid first line still opens exactly one conversation and announces it once", async (t) => {
  const { c, B, left } = await custodialPair(t);
  const r: any = await c.callTool({ name: "start_conversation", arguments: { friend: B.handle, text: "Hi, are you free this weekend?" } });
  assert.ok(!r.isError, JSON.stringify(r));
  const body = JSON.parse(r.content[0].text);
  const convId = body.conversation.conversation_id as string;
  assert.equal(body.message.status, "pending_approval");
  assert.deepEqual(left(), { conversations: 1, peer_started: 1, created_audit: 1, allow_decision: 1, messages: 1 });
  // The peer reads the opening, never the unapproved line.
  assert.equal(JSON.stringify(await B.bot.getConversation(convId)).includes("free this weekend"), false);
  // One more legal line in the same thread adds a draft, not a second conversation or a second announce.
  const again: any = await c.callTool({ name: "send_message", arguments: { conversation_id: convId, text: "Still on for Saturday?" } });
  assert.ok(!again.isError, JSON.stringify(again));
  assert.deepEqual(left(), { conversations: 1, peer_started: 1, created_audit: 1, allow_decision: 1, messages: 2 });
});

test("a reply-only peer's owner is still told, and the refusal still leaves no conversation", async (t) => {
  // The one refusal that is supposed to leave something behind: a reply-only target's owner gets a
  // `share.requested` notice. It must survive the composite write, and the empty conversation must not.
  const h = await flybotHomes(t);
  const inv = await h.A("create_invite", { bot_id: h.writer.bot_id, ...CAPS });
  await h.B("join_invite", { code: inv.code, from_bot_id: h.coder.bot_id });
  const out: any = await h.A("start_conversation", { friend: h.coder.handle, text: "hi from writer", bot_id: h.writer.bot_id });
  assert.equal(out.error.code, "bot_not_shared");
  const inbox: any = await h.B("list_inbox", { bot_id: h.coder.bot_id, peek: true });
  const notices = inbox.events.filter((e: any) => e.event_type === "share.requested");
  assert.equal(notices.length, 1, "the target's owner is told exactly once");
  assert.equal(notices[0].from.bot_id, h.writer.bot_id);
  assert.equal(notices[0].attempted, "conversation.create");
  assert.equal(inbox.events.filter((e: any) => e.event_type === "conversation.started").length, 0);
  const one = (sql: string) => (h.s.platform.db.prepare(sql).get() as any).n as number;
  assert.equal(one("SELECT COUNT(*) n FROM conversations"), 0, "the refused line leaves no conversation");
});
