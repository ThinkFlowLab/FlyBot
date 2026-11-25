import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { approveAll, friends, startServer } from "./helpers.js";

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(); });
after(async () => { await S.stop(); });

const connect = async (token: string) => {
  const c = new Client({ name: "t", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${S.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return c;
};
const text = (r: any) => JSON.parse(r.content[0].text);
const errText = (r: any) => String(r.content[0].text);

/** Two friends with a chat Bot Social paused (a Bot repeated its line: loop detected), plus a connector token for B's owner. */
async function pausedChat() {
  const { A, B } = await friends(S.base);
  const cid = (await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "short" })).conversation_id as string;
  await A.bot.draftMessage(cid, { text: "message one about the plan" });
  await approveAll(A.owner);
  await assert.rejects(A.bot.draftMessage(cid, { text: "message one about the plan" }), /conversation_paused|loop detected/);
  assert.equal((await A.bot.getConversation(cid)).status, "paused_loop");
  const ctk = (await B.owner.req("POST", "/v1/connector-tokens", { label: "test" })).token as string;
  return { A, B, cid, ctk };
}

test("extend_conversation is listed as a human-decision tool", async () => {
  const { ctk } = await pausedChat();
  const c = await connect(ctk);
  const tool = (await c.listTools()).tools.find((t) => t.name === "extend_conversation");
  assert.ok(tool, "tool listed");
  assert.equal(tool!.annotations?.destructiveHint, true);
  assert.match(tool!.description ?? "", /HUMAN DECISION/);
  assert.deepEqual(Object.keys((tool!.inputSchema as any).properties).sort(), ["confirm_code", "conversation_id", "extra_turns"]);
  await c.close();
});

test("a connector token resumes a paused chat only after the owner's confirm code", async () => {
  const { A, B, cid, ctk } = await pausedChat();
  const c = await connect(ctk);
  const args = { conversation_id: cid, extra_turns: 2 };
  const s1 = text(await c.callTool({ name: "extend_conversation", arguments: args }));
  assert.equal(s1.status, "confirmation_required");
  assert.match(s1.confirm_code, /^[A-Z2-9]{6}$/);
  assert.equal(s1.summary.conversation.status, "paused_loop");
  assert.deepEqual(s1.summary.conversation.turn, { count: 1, max: null });
  // step 1 changed nothing
  assert.equal((await A.bot.getConversation(cid)).status, "paused_loop");
  // the code is bound to the exact arguments and burns on mismatch
  const wrong = await c.callTool({ name: "extend_conversation", arguments: { ...args, extra_turns: 20, confirm_code: s1.confirm_code } });
  assert.equal(wrong.isError, true);
  assert.match(errText(wrong), /invalid_confirm_code/);
  const reused = await c.callTool({ name: "extend_conversation", arguments: { ...args, confirm_code: s1.confirm_code } });
  assert.equal(reused.isError, true, "code is single use");
  const bogus = await c.callTool({ name: "extend_conversation", arguments: { ...args, confirm_code: "ZZZZZZ" } });
  assert.equal(bogus.isError, true);
  assert.equal((await A.bot.getConversation(cid)).status, "paused_loop", "failed confirmations change nothing");

  const s2 = text(await c.callTool({ name: "extend_conversation", arguments: args }));
  const done = await c.callTool({ name: "extend_conversation", arguments: { ...args, confirm_code: s2.confirm_code } });
  assert.ok(!done.isError, JSON.stringify(done));
  const r = text(done);
  assert.equal(r.status, "open");
  assert.equal(r.max_turns, null, "no turn limit: nothing is added");
  const conv = await A.bot.getConversation(cid);
  assert.equal(conv.status, "open");
  assert.deepEqual(conv.turn, { count: 1, max: null });
  const d = await A.bot.draftMessage(cid, { text: "three, after extension" });
  assert.equal(d.status, "pending_approval");
  const audit = JSON.stringify(S.platform.auditEvents({ kind: "owner", ownerId: B.owner_id }, { limit: 200 }));
  assert.match(audit, new RegExp(`owner:${B.owner_id}:mcp`));
  assert.match(audit, /conversation\.extended/);
  await c.close();
});

test("extend_conversation refuses foreign, unknown and closed chats before issuing a code", async () => {
  const { cid, ctk } = await pausedChat();
  const other = await pausedChat();
  const c = await connect(ctk);
  const foreign = await c.callTool({ name: "extend_conversation", arguments: { conversation_id: other.cid } });
  assert.equal(foreign.isError, true);
  assert.match(errText(foreign), /forbidden/);
  assert.doesNotMatch(errText(foreign), /confirm_code/);
  const unknown = await c.callTool({ name: "extend_conversation", arguments: { conversation_id: "conv_nope" } });
  assert.equal(unknown.isError, true);
  const bad = await c.callTool({ name: "extend_conversation", arguments: { conversation_id: cid, extra_turns: 50 } });
  assert.equal(bad.isError, true, "extra_turns is capped at 20");
  const cl = text(await c.callTool({ name: "close_conversation", arguments: { conversation_id: cid, outcome: "abandoned" } }));
  assert.ok(cl);
  const closed = await c.callTool({ name: "extend_conversation", arguments: { conversation_id: cid } });
  assert.equal(closed.isError, true);
  assert.match(errText(closed), /invalid_state/);
  await c.close();
});

test("REST extend stays closed to connector tokens and Bot tokens; /mcp refuses Bot tokens", async () => {
  const { A, cid, ctk } = await pausedChat();
  const rest = await fetch(`${S.base}/v1/conversations/${cid}/extend`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${ctk}` }, body: JSON.stringify({ extra_turns: 2 }) });
  assert.equal(rest.status, 403);
  const body = await rest.json();
  assert.equal(body.error.code, "connector_token_rest_forbidden");
  assert.match(body.error.message, /\/mcp/);
  const botRest = await fetch(`${S.base}/v1/conversations/${cid}/extend`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${A.reg.bot_token}` }, body: JSON.stringify({ extra_turns: 2 }) });
  assert.equal(botRest.status, 403);
  const botMcp = await fetch(`${S.base}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${A.reg.bot_token}` }, body: "{}" });
  assert.equal(botMcp.status, 403);
  assert.equal((await A.bot.getConversation(cid)).status, "paused_loop");
});
