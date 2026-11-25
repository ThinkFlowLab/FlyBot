// Owner decision 2026-10-19 18:05: friend chats have no turn limit, and loop detection never blocks a
// line the owner typed. Regression for the paused "Hi" chat: the owner sent "Hi" twice (the first got no
// answer), loop detection paused the chat, Extend reopened it, and the next "Hi" paused it again.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startServer } from "./helpers.js";
import { mcp, post } from "./flybot_helpers.js";

const CAPS = { auto_accept: true, offered_capabilities: ["chat.public"], requested_capabilities: ["chat.public"] };

async function pair(t: any) {
  const s = await startServer();
  t.after(s.stop);
  const a = (await post(s.base, "/v1/onboard/flybot", { display_name: "Danyang" })).body;
  const b = (await post(s.base, "/v1/onboard/flybot", { display_name: "Friend" })).body;
  const A = (name: string, args: unknown = {}) => mcp(s.base, a.connector.token, name, args);
  const B = (name: string, args: unknown = {}) => mcp(s.base, b.connector.token, name, args);
  const chief = await A("add_home_member", { home: a.home.bot_id, name: "chief", display_name: "Chief" });
  const coder = await B("add_home_member", { home: b.home.bot_id, name: "coder", display_name: "测试" });
  const inv = await B("create_invite", { bot_id: coder.bot_id, ...CAPS });
  await A("join_invite", { code: inv.code ?? inv.invite?.code, from_bot_id: chief.bot_id });
  const back = await A("create_invite", { bot_id: chief.bot_id, ...CAPS });
  await B("join_invite", { code: back.code, from_bot_id: coder.bot_id });
  const approve = (ownerId: string, aprId: string) => s.platform.decideApproval({ kind: "owner", ownerId }, aprId, { decision: "approved" });
  return { s, a, b, A, B, chief, coder, approve };
}

test("the owner's own typed 'Hi', sent again and again, is never paused by loop detection", async (t) => {
  const { a, A, chief, coder, approve } = await pair(t);
  let cid = "";
  for (let i = 0; i < 4; i++) {
    const sent = await A("send_as_member", { from_bot_id: chief.bot_id, to: coder.handle, text: "Hi", typed_by_owner: true });
    assert.equal(sent.error, undefined, JSON.stringify(sent.error));
    assert.equal(sent.typed_by_owner, true);
    assert.equal(sent.message.status, "delivered", `send ${i + 1}`);
    if (cid) assert.equal(sent.conversation_id, cid, "same chat, never paused");
    cid = sent.conversation_id;
  }
  const conv = await A("get_conversation", { conversation_id: cid });
  assert.equal(conv.status, "open");
  assert.deepEqual(conv.turn, { count: 4, max: null });
});

test("owner-typed pleasantries in a row are not a loop either", async (t) => {
  const { a, A, chief, coder, approve } = await pair(t);
  let cid = "";
  for (const text of ["thanks", "ok", "bye", "thanks"]) {
    const sent = await A("send_as_member", { from_bot_id: chief.bot_id, to: coder.handle, text, typed_by_owner: true });
    assert.equal(sent.error, undefined, JSON.stringify(sent.error));
    cid = sent.conversation_id;
  }
  assert.equal((await A("get_conversation", { conversation_id: cid })).status, "open");
});

test("a Bot-written repeat still pauses the chat; the owner's next typed line opens a fresh chat and goes out", async (t) => {
  const { a, A, chief, coder, approve } = await pair(t);
  const first = await A("send_as_member", { from_bot_id: chief.bot_id, to: coder.handle, text: "status report: build is green" });
  await approve(a.owner_id, first.message.approval_id);
  const repeat = await A("send_as_member", { from_bot_id: chief.bot_id, to: coder.handle, text: "status report: build is green" });
  assert.equal(repeat.error?.code, "conversation_paused", JSON.stringify(repeat));
  assert.equal((await A("get_conversation", { conversation_id: first.conversation_id })).status, "paused_loop");
  const typed = await A("send_as_member", { from_bot_id: chief.bot_id, to: coder.handle, text: "Hi", typed_by_owner: true });
  assert.equal(typed.error, undefined, JSON.stringify(typed.error));
  assert.notEqual(typed.conversation_id, first.conversation_id);
  assert.equal(typed.message.status, "delivered");
});
