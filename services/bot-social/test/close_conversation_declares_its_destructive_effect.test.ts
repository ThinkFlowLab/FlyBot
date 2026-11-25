import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { bulkAuth, friends, startServer } from "./helpers.js";

const connect = async (base: string, token: string) => {
  const c = new Client({ name: "t", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return c;
};

/**
 * `close_conversation` ends a chat and cancels every card hanging off it, telling the Bot that owned the card why
 * (platform.ts: `cancelPendingFor(..., "conversation_closed", { notify: true })`). A client that reads
 * `destructiveHint: false` on the wire is told the opposite -- that calling it is safe to retry and destroys nothing --
 * so the hint must say true. The behaviour itself is pinned below so the annotation cannot drift away from what the
 * door does, and the neighbours are pinned so the shared WRITE object is copied, never mutated in place.
 */
test("the closing door declares the destruction it does: destructiveHint is true", async (t) => {
  const s = await startServer(bulkAuth);
  const { A } = await friends(s.base);
  const c = await connect(s.base, (A.owner as any).token);
  t.after(async () => { await c.close(); await s.stop(); });

  const listed: any = await c.listTools();
  const close: any = listed.tools.find((x: any) => x.name === "close_conversation");
  assert.ok(close, "close_conversation is registered on the owner connector");
  assert.equal(close.annotations?.destructiveHint, true, "closing a chat cancels its pending cards, so destructiveHint must be true");
  // The other two hints are unchanged: it is still a write, and it still reaches outside this server.
  assert.equal(close.annotations?.readOnlyHint, false, "readOnlyHint stays false");
  assert.equal(close.annotations?.openWorldHint, true, "openWorldHint stays true");
  // The description says what it destroys, next to the outcomes it already named.
  assert.match(close.description ?? "", /cancel/i, "the description names the cards it cancels");
  assert.match(close.description ?? "", /closed|close/i);

  // A neighbour that shares the same WRITE defaults keeps its own hint: the fix copies the object, it does not
  // rewrite the constant every write tool is built from.
  const send: any = listed.tools.find((x: any) => x.name === "send_message");
  assert.ok(send, "send_message is registered");
  assert.equal(send.annotations?.destructiveHint, false, "another write tool is unaffected");
  assert.equal(send.annotations?.readOnlyHint, false);
  const inbox: any = listed.tools.find((x: any) => x.name === "list_inbox");
  assert.equal(inbox.annotations?.readOnlyHint, false);
  assert.equal(inbox.annotations?.destructiveHint, false);
  const readNeighbour: any = listed.tools.find((x: any) => x.name === "list_invites");
  assert.equal(readNeighbour.annotations?.readOnlyHint, true, "a read-only neighbour keeps the read defaults");
  assert.equal(readNeighbour.annotations?.destructiveHint, false);
});

test("the behaviour the hint describes: closing cancels the peer's pending card and tells its Bot why", async (t) => {
  const s = await startServer(bulkAuth);
  const { A, B } = await friends(s.base);
  const c = await connect(s.base, (A.owner as any).token);
  t.after(async () => { await c.close(); await s.stop(); });

  const cid = (await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "close declaration" })).conversation_id as string;
  const draft = await B.bot.draftMessage(cid, { text: "peer line still waiting for approval" });
  assert.equal(draft.status, "pending_approval");

  const res: any = await c.callTool({ name: "close_conversation", arguments: { conversation_id: cid, outcome: "abandoned", summary: "probe" } });
  assert.ok(!res.isError, "the close succeeds: " + res.content[0].text);

  const row = s.platform.db.prepare("SELECT status, outcome FROM conversations WHERE id = ?").get(cid) as any;
  assert.equal(row.status, "closed", "the conversation is closed");
  assert.equal(row.outcome, "abandoned");

  const card: any = (await B.owner.req("GET", "/v1/approvals?status=cancelled")).approvals.find((a: any) => a.approval_id === draft.approval_id);
  assert.ok(card, "the peer's waiting card is cancelled, not left pending");
  assert.equal(card.decision, "conversation_closed", "and it carries the reason the Bot reads");

  // The Bot that owned the card is told, exactly once: this is the notification destructiveHint:false denied.
  const evs = (await B.bot.events()).events.filter((e: any) => e.event_type === "approval.decided" && e.approval_id === draft.approval_id);
  assert.equal(evs.length, 1, "the owning Bot is notified once");
  assert.equal(evs[0].decision, "cancelled");
  assert.equal(evs[0].reason, "conversation_closed");
});
