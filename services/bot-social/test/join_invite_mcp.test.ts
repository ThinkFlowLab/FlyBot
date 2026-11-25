import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ownerWithBot, startServer } from "./helpers.js";

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(); });
after(async () => { await S.stop(); });

const connect = async (token: string) => {
  const c = new Client({ name: "t", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${S.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return c;
};

/** #126: the owner's assistant reads this text before calling the tool, so it has to name both landing
 *  states and the fact that a join shares nothing by itself. Pinned as one snapshot: an edit has to be intentional. */
const JOIN_INVITE_DESCRIPTION = "Join someone else's invite code/URL to send a friend request from your bot. Joining spends one use of the link; a one-use link (the default) stops working for anyone else holding the same code. It lands in one of two states: `status: \"active\"` means the friendship is live now; `status: \"pending_requester_owner\"` (or `pending_target`) means it is still waiting, and `awaiting` says on whom — `your_owner_approval` = your owner must approve, `inviter_owner_consent` = the other owner must. Read `status` and `awaiting` in the response and tell your owner which one happened. A join is not a share: joining does not share either bot's chats, so do not say a chat will work until the other side shares; a 403 `bot_not_shared` means they have not, so tell your owner and do not retry.";

test("join_invite's description names both landing states and that joining does not share", async () => {
  const A = await ownerWithBot(S.base, "joiner");
  const ctk = (await A.owner.req("POST", "/v1/connector-tokens", { label: "test" })).token as string;
  const c = await connect(ctk);
  const tool = (await c.listTools()).tools.find((t) => t.name === "join_invite");
  assert.ok(tool, "tool listed");
  const description = tool!.description ?? "";
  assert.equal(description, JOIN_INVITE_DESCRIPTION, "full description snapshot");
  assert.match(description, /pending/);
  assert.match(description, /your owner must approve/);
  assert.match(description, /joining does not share/);
  assert.match(description, /bot_not_shared/);
  await c.close();
});

test("no other tool description changed alongside join_invite", async () => {
  const A = await ownerWithBot(S.base, "other");
  const ctk = (await A.owner.req("POST", "/v1/connector-tokens", { label: "test" })).token as string;
  const c = await connect(ctk);
  const tools = (await c.listTools()).tools;
  assert.ok(tools.length > 1);
  assert.equal(tools.filter((t) => (t.description ?? "").includes("joining does not share")).length, 1, "only join_invite carries the new wording");
  await c.close();
});
