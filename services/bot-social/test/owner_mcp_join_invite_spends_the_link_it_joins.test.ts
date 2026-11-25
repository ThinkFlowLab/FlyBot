// `join_invite` redeems a use of a link someone else minted. On the default one-use link — the shape
// `create_invite` mints unless it is told otherwise — that join spends the last use, and the code is dead for every
// other person it was shared with. An irreversible effect on a credential that was still valid belongs in the
// machine-readable hint clients act on, so these two tests pin the hint and the effect it stands for.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { bulkAuth, startServer } from "./helpers.js";

type S = Awaited<ReturnType<typeof startServer>>;

async function connect(base: string, token: string) {
  const c = new Client({ name: "t", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return c;
}

/** A sign-up as the connector sees it: the token it calls the MCP door with, and the Bot it acts as. */
async function onboard(s: S, who: string) {
  const r = await fetch(s.base + "/v1/onboard", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: who, password: "secret-pw", display_name: who }),
  });
  assert.equal(r.status, 201);
  const b: any = await r.json();
  return { token: b.connector.token as string, bot: b.bot.bot_id as string, owner: b.owner_id as string };
}
const parse = (r: any) => JSON.parse(r.content[0].text);

test("join_invite declares the link it spends: its annotation is destructive", async (t) => {
  const s = await startServer(bulkAuth);
  const A = await onboard(s, "hintinvite");
  const c = await connect(s.base, A.token);
  t.after(async () => { await c.close(); await s.stop(); });

  const listed: any = await c.listTools();
  assert.equal(listed.tools.length, 51, "the tool set this snapshot was written against");
  const tool = listed.tools.find((x: any) => x.name === "join_invite");
  assert.ok(tool, "join_invite is registered");
  // Redeeming the last use of a link voids a still-valid credential, so the hint clients act on must say so.
  assert.equal(tool.annotations?.readOnlyHint, false);
  assert.equal(tool.annotations?.destructiveHint, true, "join_invite spends a link's use, so destructiveHint must be true");
  assert.equal(tool.annotations?.openWorldHint, true, "joining writes grants and announces to the other owner");
  // The neighbours keep their hints. These are the write tools whose whole body is to create a row or to record a
  // value; if the shared write annotation were flipped in place instead of copied, every one of them would move too.
  for (const name of ["create_invite", "start_conversation", "send_message", "upload_attachment", "set_presence"]) {
    const other = listed.tools.find((x: any) => x.name === name);
    assert.ok(other, `${name} is registered`);
    assert.equal(other.annotations?.destructiveHint, false, `${name} was flipped by the same edit`);
    assert.equal(other.annotations?.readOnlyHint, false, `${name} is a write and stays one`);
  }
});

test("joining a one-use link spends it: the next person holding the same code is refused", async (t) => {
  const s = await startServer(bulkAuth);
  const A = await onboard(s, "invone"), B = await onboard(s, "invtwo"), C = await onboard(s, "invthree");
  const ca = await connect(s.base, A.token), cb = await connect(s.base, B.token), cc = await connect(s.base, C.token);
  t.after(async () => { await ca.close(); await cb.close(); await cc.close(); await s.stop(); });

  const made = parse(await ca.callTool({ name: "create_invite", arguments: { max_uses: 1, auto_accept: true, bot_id: A.bot } }));
  const spent = () => s.platform.db.prepare("SELECT uses, max_uses FROM invites WHERE code = ?").get(made.code) as any;
  assert.equal(spent().uses, 0, "the link starts unspent");

  const joined: any = await cb.callTool({ name: "join_invite", arguments: { code: made.code, from_bot_id: B.bot } });
  assert.ok(!joined.isError, JSON.stringify(joined.content?.[0]?.text));
  assert.equal(parse(joined).status, "active", "an auto-accept link connects at once");
  assert.deepEqual({ ...spent() }, { uses: 1, max_uses: 1 }, "the join spends the only use the link had");

  // This is the effect the hint stands for: a third owner still holding the same shared code can no longer join.
  const late: any = await cc.callTool({ name: "join_invite", arguments: { code: made.code, from_bot_id: C.bot } });
  assert.equal(late.isError, true, "the code is dead for everyone else after the last use");
  const refusal = parse(late);
  assert.equal(refusal.code, "invite_unavailable");
  assert.equal(refusal.invite_status, "used");
});
