import assert from "node:assert/strict";
import { test } from "node:test";
import { startServer } from "./helpers.js";

async function post(base: string, path: string, body: unknown) {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() as any };
}
async function mcp(base: string, token: string, name: string, args: unknown = {}) {
  const r = await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  const j: any = await r.json();
  return JSON.parse(j.result.content[0].text);
}

test("POST /v1/onboard/flybot returns identity, connector token and webhook config in one call", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const r = await post(s.base, "/v1/onboard/flybot", { display_name: "Dan", bot_handle: "dan.flybot", webhook_url: "http://127.0.0.1:9/hook" });
  assert.equal(r.status, 201);
  assert.equal(r.body.bot.handle, "@dan.flybot");
  assert.equal(r.body.bot.custodial, true);
  assert.match(r.body.connector.token, /.+/);
  assert.equal(r.body.mcp_url.endsWith("/mcp"), true);
  assert.equal(r.body.webhook.url, "http://127.0.0.1:9/hook");
  assert.match(r.body.webhook.secret, /.+/);
  assert.equal(r.body.webhook.signature_header, "x-botsocial-signature");
  // The connector token works on the owner MCP endpoint right away.
  const overview = await mcp(s.base, r.body.connector.token, "list_friends");
  assert.equal(overview.bot.handle, "@dan.flybot");
  // Without a webhook the call still onboards; a taken handle is refused.
  const plain = await post(s.base, "/v1/onboard/flybot", { display_name: "Eve" });
  assert.equal(plain.status, 201);
  assert.equal(plain.body.webhook, null);
  assert.equal((await post(s.base, "/v1/onboard/flybot", { bot_handle: "dan.flybot" })).status, 409);
  assert.equal((await post(s.base, "/v1/onboard/flybot", { webhook_url: "not a url" })).status >= 400, true);
});

test("FlyBot homes: members of friend homes can message each other; revoked members cannot", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const a = (await post(s.base, "/v1/onboard/flybot", { display_name: "Danyang" })).body;
  const b = (await post(s.base, "/v1/onboard/flybot", { display_name: "Bob" })).body;
  assert.equal(a.home.handle, "@danyang.home");
  const A = (name: string, args: unknown = {}) => mcp(s.base, a.connector.token, name, args);
  const B = (name: string, args: unknown = {}) => mcp(s.base, b.connector.token, name, args);
  const writer = await A("add_home_member", { home: a.home.bot_id, name: "Writer" });
  assert.equal(writer.handle, "@writer.danyang.home");
  const coder = await B("add_home_member", { home: b.home.bot_id, name: "coder" });
  // Not friends yet: members cannot reach each other.
  const refused = await fetch(s.base + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${a.connector.token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send_as_member", arguments: { from_bot_id: writer.bot_id, to: coder.handle, text: "hi" } } }) }).then((r) => r.json()) as any;
  assert.equal(refused.result.isError, true);
  // Per-bot invite: writer ↔ coder. A home invite would not let members talk.
  const inv = await A("create_invite", { bot_id: writer.bot_id, auto_accept: true, offered_capabilities: ["chat.public"], requested_capabilities: ["chat.public"] });
  await B("join_invite", { code: inv.code ?? inv.invite?.code, from_bot_id: coder.bot_id });
  const pending = await A("list_friends", { bot_id: writer.bot_id });
  if (pending.pending_incoming?.length) {
    // Not auto-accepted on this server: the owner accepts it (confirmation flow is out of scope here).
    (s.platform as any).respondRelationship?.({ kind: "owner", ownerId: a.owner_id } as any, pending.pending_incoming[0].relationship_id, { decision: "accept", grant_capabilities: ["chat.public"] });
  }
  const remote = await A("list_remote_bots", { home: a.home.bot_id });
  assert.equal(remote.homes.length, 1);
  assert.equal(remote.homes[0].home.handle, "@bob.home");
  assert.deepEqual(remote.homes[0].bots.map((x: any) => x.handle), ["@coder.bob.home"]);
  // Joining only lets Writer answer Coder (#23): starting is refused until Bob shares Coder with Writer.
  const unshared = await fetch(s.base + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${a.connector.token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "send_as_member", arguments: { from_bot_id: writer.bot_id, to: coder.handle, text: "hi" } } }) }).then((r) => r.json()) as any;
  assert.equal(unshared.result.isError, true);
  assert.match(unshared.result.content[0].text, /bot_not_shared/);
  const back = await B("create_invite", { bot_id: coder.bot_id, auto_accept: true, offered_capabilities: ["chat.public"], requested_capabilities: ["chat.public"] });
  await A("join_invite", { code: back.code, from_bot_id: writer.bot_id });
  const sent = await A("send_as_member", { from_bot_id: writer.bot_id, to: coder.handle, text: "hello from writer" });
  assert.match(sent.conversation_id, /.+/);
  // Regression: later sends in the same relationship reuse the open conversation instead of
  // opening a new one each time (which hit newConversationsPerPairPerDay and returned 429).
  for (let i = 0; i < 5; i++) { // 6 sends total: past the 5-new-conversations cap, within 6 drafts/min
    const again = await A("send_as_member", { from_bot_id: writer.bot_id, to: coder.handle, text: `again ${i}` });
    assert.equal(again.conversation_id, sent.conversation_id);
  }
  // Revoked member: refused.
  await A("remove_home_member", { home: a.home.bot_id, member: writer.bot_id });
  const after = await A("list_home_members", { home: a.home.bot_id });
  assert.deepEqual(after.members, []);
  const raw = await fetch(s.base + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${a.connector.token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "send_as_member", arguments: { from_bot_id: writer.bot_id, to: coder.handle, text: "still there?" } } }) }).then((r) => r.json()) as any;
  assert.equal(raw.result.isError, true);
  assert.match(raw.result.content[0].text, /bot_revoked/);
  // Revoking the member cancels its draft; it is no longer a card the owner can approve later.
  const approvals = await A("list_approvals");
  assert.equal(approvals.approvals.some((x: any) => x.kind === "message" || /message/.test(x.kind ?? "")), false);
});

test("FlyBot member-scoped invite: joining exposes only that member; other members stay hidden", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const a = (await post(s.base, "/v1/onboard/flybot", { display_name: "Danyang" })).body;
  const b = (await post(s.base, "/v1/onboard/flybot", { display_name: "Bob" })).body;
  const A = (name: string, args: unknown = {}) => mcp(s.base, a.connector.token, name, args);
  const B = (name: string, args: unknown = {}) => mcp(s.base, b.connector.token, name, args);
  const raw = async (token: string, name: string, args: unknown) => (await fetch(s.base + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: args } }) }).then((r) => r.json()) as any).result;
  const chief = await A("add_home_member", { home: a.home.bot_id, name: "chief" });
  const writer = await A("add_home_member", { home: a.home.bot_id, name: "writer" });
  const coder = await B("add_home_member", { home: b.home.bot_id, name: "coder" });
  // Danyang invites to Chief only; Bob's home joins.
  const inv = await A("create_invite", { bot_id: chief.bot_id, auto_accept: true, offered_capabilities: ["chat.public"], requested_capabilities: ["chat.public"] });
  const joined = await B("join_invite", { code: inv.code, from_bot_id: b.home.bot_id });
  assert.equal(joined.status, "active");
  assert.equal(joined.inviter.handle, "@chief.danyang.home");
  // Bob sees only Chief, under Danyang's home.
  const bobView = await B("list_remote_bots", { home: b.home.bot_id });
  assert.equal(bobView.homes.length, 1);
  assert.equal(bobView.homes[0].home.handle, "@danyang.home");
  assert.equal(bobView.homes[0].scope, "member");
  assert.deepEqual(bobView.homes[0].bots.map((x: any) => x.handle), ["@chief.danyang.home"]);
  // Danyang sees only the bot that joined (Bob's home), reachable via Chief — not every member of Bob's home.
  const danView = await A("list_remote_bots", { home: a.home.bot_id });
  assert.deepEqual(danView.homes[0].bots.map((x: any) => x.handle), ["@bob.home"]);
  assert.deepEqual(danView.homes[0].via, ["@chief.danyang.home"]);
  // Only the joining bot (Bob's home) can talk to Chief; Coder was never granted.
  assert.match((await B("send_as_member", { from_bot_id: b.home.bot_id, to: chief.handle, text: "hi chief" })).conversation_id, /.+/);
  assert.match((await A("send_as_member", { from_bot_id: chief.bot_id, to: b.home.handle, text: "hi bob home" })).conversation_id, /.+/);
  const fromCoder = await raw(b.connector.token, "send_as_member", { from_bot_id: coder.bot_id, to: chief.handle, text: "hi chief" });
  assert.equal(fromCoder.isError, true);
  const toWriter = await raw(b.connector.token, "send_as_member", { from_bot_id: coder.bot_id, to: writer.handle, text: "hi writer" });
  assert.equal(toWriter.isError, true);
  assert.match(toWriter.content[0].text, /no_relationship/);
  const fromWriter = await raw(a.connector.token, "send_as_member", { from_bot_id: writer.bot_id, to: coder.handle, text: "hi" });
  assert.equal(fromWriter.isError, true);
  // A second invite, for Writer, exposes Writer too (same friend-home entry).
  const inv2 = await A("create_invite", { bot_id: writer.bot_id, auto_accept: true, offered_capabilities: ["chat.public"], requested_capabilities: ["chat.public"] });
  await B("join_invite", { code: inv2.code, from_bot_id: b.home.bot_id });
  const bobView2 = await B("list_remote_bots", { home: b.home.bot_id });
  assert.equal(bobView2.homes.length, 1);
  assert.deepEqual(bobView2.homes[0].bots.map((x: any) => x.handle).sort(), ["@chief.danyang.home", "@writer.danyang.home"]);
});
