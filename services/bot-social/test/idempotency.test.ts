import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { friends, startServer } from "./helpers.js";

/** send_as_member signs with the Bot's custodial key. */
function custody(s: any, who: any) {
  s.platform.enableCustody({ kind: "owner", ownerId: who.owner_id }, who.bot.id, { private_key_pem: who.kp.privateKeyPem });
}

const KEY = "flybot-retry-0001";

test("#47: a replayed send_as_member returns the first answer and mints no second card", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  custody(s, A);
  const owner = { kind: "owner" as const, ownerId: A.owner_id };
  const body = { from_bot_id: A.bot.id, to: B.handle, text: "same line, retried", idempotency_key: KEY };

  const first = s.platform.sendAsMember(owner, body);
  assert.equal(first.message.status, "pending_approval");
  const pending = s.platform.listApprovals(owner, "pending");
  assert.equal(pending.length, 1, "one card for the first call");

  // The retry is the same call: no second message, no second card, the same ids.
  const again = s.platform.sendAsMember(owner, body);
  assert.deepEqual(again, first);
  assert.equal(s.platform.listApprovals(owner, "pending").length, 1, "the replay enqueued no second card");
  const count = (s.platform as any).get("SELECT COUNT(*) n FROM messages WHERE sender_bot = ? AND recipient_bot = ?", A.bot.id, B.bot.id).n;
  assert.equal(count, 1, "exactly one message row");
});

test("#47: the same key with a different payload is a conflict, and changes nothing", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  custody(s, A);
  const owner = { kind: "owner" as const, ownerId: A.owner_id };
  s.platform.sendAsMember(owner, { from_bot_id: A.bot.id, to: B.handle, text: "first", idempotency_key: KEY });
  const before = (s.platform as any).get("SELECT COUNT(*) n FROM messages").n;

  assert.throws(
    () => s.platform.sendAsMember(owner, { from_bot_id: A.bot.id, to: B.handle, text: "second, different", idempotency_key: KEY }),
    (e: any) => e.code === "idempotency_conflict" && e.status === 409,
  );
  assert.equal((s.platform as any).get("SELECT COUNT(*) n FROM messages").n, before, "no message was written");
  assert.equal(s.platform.listApprovals(owner, "pending").length, 1, "no second card");
});

test("#47: a replayed decide_approval answers the first outcome instead of invalid_state", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  custody(s, A);
  const owner = { kind: "owner" as const, ownerId: A.owner_id };
  const held = s.platform.sendAsMember(owner, { from_bot_id: A.bot.id, to: B.handle, text: "decide me" });
  const aprId = (held.message as any).approval_id as string;
  const body = { decision: "approved" as const, idempotency_key: "flybot-decide-1" };

  const first = s.platform.decideApproval(owner, aprId, body);
  assert.equal(first.decision, "approved");
  const again = s.platform.decideApproval(owner, aprId, body);
  assert.deepEqual(again, first, "the replay is the same answer, not already_decided");
  // The control: without a key the second call is refused as before.
  assert.throws(() => s.platform.decideApproval(owner, aprId, { decision: "approved" }), (e: any) => e.status === 409);
});

test("#47: two homes may use the same key string without interfering", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  custody(s, A);
  custody(s, B);
  const ownerA = { kind: "owner" as const, ownerId: A.owner_id };
  const ownerB = { kind: "owner" as const, ownerId: B.owner_id };
  const fromA = s.platform.sendAsMember(ownerA, { from_bot_id: A.bot.id, to: B.handle, text: "from A", idempotency_key: "shared-key-1" });
  const fromB = s.platform.sendAsMember(ownerB, { from_bot_id: B.bot.id, to: A.handle, text: "from B", idempotency_key: "shared-key-1" });
  assert.notEqual((fromA.message as any).message_id, (fromB.message as any).message_id, "each home got its own send");
  // The same key on another tool is another namespace too.
  const aprId = (fromA.message as any).approval_id as string;
  const decided = s.platform.decideApproval(ownerA, aprId, { decision: "approved", idempotency_key: "shared-key-1" });
  assert.equal(decided.decision, "approved");
});

test("#47: a key whose first call is still running refuses to run the call twice", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  custody(s, A);
  const owner = { kind: "owner" as const, ownerId: A.owner_id };
  const body = { from_bot_id: A.bot.id, to: B.handle, text: "in flight", idempotency_key: "flybot-inflight-1" };
  // Another process claimed the key and has not stored an answer yet.
  const before = s.platform.sendAsMember(owner, { ...body, idempotency_key: "flybot-other-key-1" });
  assert.equal(before.message.status, "pending_approval");
  const hashRow = (s.platform as any).get("SELECT request_hash FROM idempotency_keys WHERE owner_id = ? AND tool = 'send_as_member' AND key = 'flybot-other-key-1'", A.owner_id);
  assert.ok(hashRow, "the finished call kept its key");
  (s.platform as any).run("INSERT INTO idempotency_keys (owner_id, tool, key, request_hash, response, created_at) VALUES (?,?,?,?,?,?)", A.owner_id, "send_as_member", "flybot-inflight-1", hashRow.request_hash, "", Date.now());
  assert.throws(
    () => s.platform.sendAsMember(owner, body),
    (e: any) => e.code === "idempotency_in_progress" && e.status === 409,
  );
  const cards = s.platform.listApprovals(owner, "pending").length;
  assert.equal(cards, 1, "the refused call enqueued nothing");
});

test("#47: a call that throws releases its key, so the same key can be retried", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  custody(s, A);
  const owner = { kind: "owner" as const, ownerId: A.owner_id };
  const bad = { from_bot_id: A.bot.id, to: "@nobody.nowhere.home", text: "goes nowhere", idempotency_key: "flybot-failed-1" };
  assert.throws(() => s.platform.sendAsMember(owner, bad), (e: any) => e.code === "bot_not_found");
  assert.equal((s.platform as any).get("SELECT COUNT(*) n FROM idempotency_keys").n, 0, "no key kept after a failure");
  // The retry with the same key is a fresh attempt, not a cached failure or an in-progress answer.
  assert.throws(() => s.platform.sendAsMember(owner, bad), (e: any) => e.code === "bot_not_found");
  void B;
});

test("#47: a key that is too short is refused, and an absent key behaves as before", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  custody(s, A);
  const owner = { kind: "owner" as const, ownerId: A.owner_id };
  assert.throws(
    () => s.platform.sendAsMember(owner, { from_bot_id: A.bot.id, to: B.handle, text: "x", idempotency_key: "short" }),
    (e: any) => e.status === 400,
  );
  const plain = s.platform.sendAsMember(owner, { from_bot_id: A.bot.id, to: B.handle, text: "no key" });
  const plain2 = s.platform.sendAsMember(owner, { from_bot_id: A.bot.id, to: B.handle, text: "no key either" });
  assert.notEqual((plain.message as any).message_id, (plain2.message as any).message_id, "two calls without a key are two sends");
});

/** The owner connector, as a client sees it: the confirmation step lives here, not in platform.*. */
const connect = async (base: string, token: string) => {
  const c = new Client({ name: "t", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return c;
};
const text = (r: any) => JSON.parse(r.content[0].text);

test("#47: an MCP decision retried with the same key replays instead of conflicting", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const c = await connect(s.base, (A.owner as any).token);
  t.after(() => c.close());
  const conv = await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "retry a decision" });
  await A.bot.draftMessage(conv.conversation_id, { text: "decide me twice" });
  const { approvals } = text(await c.callTool({ name: "list_approvals", arguments: {} }));
  const aprId = approvals.find((a: any) => a.kind === "outbound_message").approval_id;
  const args = { approval_id: aprId, decision: "approved", idempotency_key: "mcp-decision-retry-1" };

  const step1 = text(await c.callTool({ name: "decide_approval", arguments: args }));
  assert.equal(step1.status, "confirmation_required", "the first step only offers a code");
  const first = await c.callTool({ name: "decide_approval", arguments: { ...args, confirm_code: step1.confirm_code } });
  assert.ok(!first.isError, JSON.stringify(first));
  const answer = text(first);
  assert.equal(answer.decision, "approved");

  // The retry a real client makes after losing the answer: the same key, and a fresh confirm code because
  // the first one was consumed. Counting the code in the request hash turned this into idempotency_conflict.
  const step2 = text(await c.callTool({ name: "decide_approval", arguments: args }));
  assert.equal(step2.status, "confirmation_required");
  assert.notEqual(step2.confirm_code, step1.confirm_code, "a real retry always carries a new code");
  const replay = await c.callTool({ name: "decide_approval", arguments: { ...args, confirm_code: step2.confirm_code } });
  assert.ok(!replay.isError, `the retry must replay, not run: ${JSON.stringify(replay?.content)}`);
  assert.deepEqual(text(replay), answer, "the first answer, not idempotency_conflict and not invalid_state");
  // And the card is still decided once.
  const after = text(await c.callTool({ name: "list_approvals", arguments: { status: "all" } })).approvals.filter((a: any) => a.approval_id === aprId);
  assert.equal(after.length, 1);
  assert.equal(after[0].status, "approved");
});
