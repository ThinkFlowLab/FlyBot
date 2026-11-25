import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp.js";
import { bulkAuth, friends, startServer } from "./helpers.js";

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(bulkAuth); });
after(async () => { await S.stop(); });

const one = (db: any, sql: string) => (db.prepare(sql).get() as any).n as number;
const messages = () => one(S.platform.db, "SELECT COUNT(*) n FROM messages");
const approvals = () => one(S.platform.db, "SELECT COUNT(*) n FROM approvals");
const draftedAuditRows = () => one(S.platform.audit.db, "SELECT COUNT(*) n FROM audit_events WHERE action = 'message.drafted'");

/** The Bot's own MCP server driven in memory: the tool surface an assistant sees over stdio, without a process. */
async function botMcp(bot: Parameters<typeof createMcpServer>[0]) {
  const server = createMcpServer(bot);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const c = new Client({ name: "t", version: "0" });
  await c.connect(clientSide);
  return c;
}

const bodyOf = (r: any) => JSON.parse(r.content?.[0]?.text ?? "null");

/** A REST draft carrying a null `structured`, signed by the Bot exactly as the MCP tool signs it. */
async function restDraft(bot: any, conversationId: string, payload: unknown) {
  const env = bot.envelope("message.draft", payload, { conversation_id: conversationId });
  const r = await fetch(`${S.base}/v1/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${bot.cred.token}`, "content-type": "application/json" },
    body: JSON.stringify(env),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}

test("a draft whose structured is null is the line the REST door already accepts", async () => {
  const { A, B } = await friends(S.base);
  const conv: any = await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "structured null" });
  const cid = conv.conversation_id as string;

  // The REST door takes the null today: "must be an object or null" is its documented and implemented contract.
  const beforeRest = { messages: messages(), approvals: approvals(), audit: draftedAuditRows() };
  const rest = await restDraft(A.bot, cid, { text: "null from REST", structured: null });
  assert.equal(rest.status, 202, JSON.stringify(rest.body));
  assert.equal(rest.body.status, "pending_approval");
  assert.equal(messages() - beforeRest.messages, 1, "a REST draft writes one message");
  assert.equal(approvals() - beforeRest.approvals, 1, "a REST draft writes one card");
  assert.equal(draftedAuditRows() - beforeRest.audit, 1, "a REST draft writes one audit line");

  // The tool description says "structured must be an object (or null)" and the REST door under it agrees, so the
  // Bot's own MCP surface must not be the one front-end that answers a protocol error for the same body.
  const c = await botMcp(A.bot);
  const beforeMcp = { messages: messages(), approvals: approvals(), audit: draftedAuditRows() };
  const viaNull: any = await c.callTool({ name: "draft_message", arguments: { conversation_id: cid, text: "null from MCP", structured: null } });
  const wrote = { messages: messages() - beforeMcp.messages, cards: approvals() - beforeMcp.approvals, audit: draftedAuditRows() - beforeMcp.audit };
  assert.equal(viaNull.isError, undefined, `null means the same thing here as at REST: ${JSON.stringify(viaNull?.content)}; writes: ${JSON.stringify(wrote)}`);
  assert.deepEqual(wrote, { messages: 1, cards: 1, audit: 1 }, "an MCP draft writes one message, one card and one audit line");
  const drafted = bodyOf(viaNull);
  assert.equal(drafted.status, "pending_approval");
  assert.ok(drafted.approval_id, "the draft puts up a card like any other");
  await c.close();
});

test("structured stays an object: an ordinary payload drafts, a string is refused and writes nothing", async () => {
  const { A, B } = await friends(S.base);
  const conv: any = await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "structured object" });
  const cid = conv.conversation_id as string;

  const c = await botMcp(A.bot);
  const object: any = await c.callTool({ name: "draft_message", arguments: { conversation_id: cid, text: "an object", structured: { schema: "meeting.proposal/1", slots: [{ start: "2026-11-20T09:00", end: "2026-11-20T09:30" }] } } });
  assert.equal(object.isError, undefined, `an object is the field's ordinary value: ${JSON.stringify(object?.content)}`);
  assert.equal(bodyOf(object).status, "pending_approval");

  // Nullable is not "anything": a string is still the wrong type for a machine-readable half, so it is refused
  // before any row is written — the same strictness the schema has today.
  const before = { messages: messages(), approvals: approvals(), audit: draftedAuditRows() };
  const string: any = await c.callTool({ name: "draft_message", arguments: { conversation_id: cid, text: "a string", structured: "oops" } });
  assert.equal(string.isError, true, "a string is not an object or null");
  assert.equal(messages() - before.messages, 0, "a refused draft writes no message");
  assert.equal(approvals() - before.approvals, 0, "a refused draft writes no card");
  assert.equal(draftedAuditRows() - before.audit, 0, "a refused draft writes no audit line");
  await c.close();
});
