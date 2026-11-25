import assert from "node:assert/strict";
import { test } from "node:test";
import { startServer } from "./helpers.js";

async function post(base: string, path: string, body: unknown) {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() as any };
}
async function get(base: string, path: string, token: string) {
  const r = await fetch(base + path, { headers: { authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.json() as any };
}
async function mcp(base: string, token: string, name: string, args: unknown = {}) {
  const r = await fetch(base + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const j: any = await r.json();
  if (j.result?.isError) throw new Error(j.result.content[0].text);
  return JSON.parse(j.result.content[0].text);
}
const CAPS = { auto_accept: true, offered_capabilities: ["chat.public", "profile.read"], requested_capabilities: ["chat.public", "profile.read"] };

/** The FlyBot#383 setup: Alice shares Chief with Bob (Bob's Coder joins), then Alice's Chief joins Bob's Helper invite. */
async function twoJoins(t: any) {
  const s = await startServer();
  t.after(s.stop);
  const a = (await post(s.base, "/v1/onboard/flybot", { display_name: "Alice" })).body;
  const b = (await post(s.base, "/v1/onboard/flybot", { display_name: "Bob" })).body;
  const A = (name: string, args: unknown = {}) => mcp(s.base, a.connector.token, name, args);
  const B = (name: string, args: unknown = {}) => mcp(s.base, b.connector.token, name, args);
  const chief = await A("add_home_member", { home: a.home.bot_id, name: "chief", display_name: "Chief" });
  const coder = await B("add_home_member", { home: b.home.bot_id, name: "coder", display_name: "Coder" });
  const inv1 = await A("create_invite", { bot_id: chief.bot_id, ...CAPS });
  const rel1 = (await B("join_invite", { code: inv1.code, from_bot_id: coder.bot_id })).relationship_id as string;
  const helper = await B("add_home_member", { home: b.home.bot_id, name: "helper", display_name: "Helper" });
  const inv2 = await B("create_invite", { bot_id: helper.bot_id, ...CAPS });
  const rel2 = (await A("join_invite", { code: inv2.code, from_bot_id: chief.bot_id })).relationship_id as string;
  assert.notEqual(rel1, rel2);
  return { s, a, b, A, B, chief, coder, helper, rel1, rel2 };
}

test("list_bot_grants tells a share (inviter side) from a talk-through grant (joiner side)", async (t) => {
  const { s, a, A, chief, coder, helper, rel1, rel2 } = await twoJoins(t);
  const { grants } = await A("list_bot_grants", { bot_id: chief.bot_id });
  const byRel = Object.fromEntries(grants.map((g: any) => [g.relationship_id, [g.grantee.bot_id, g.side]]));
  // rel1: Alice invited, so her grant to Coder is the real share; rel2: Alice joined Helper's invite, so her grant to Helper is talk-through.
  assert.deepEqual(byRel, { [rel1]: [coder.bot_id, "inviter"], [rel2]: [helper.bot_id, "joiner"] }, JSON.stringify(grants));
  const rest = await get(s.base, `/v1/bots/${chief.bot_id}/grants`, a.connector.token);
  assert.equal(rest.status, 200);
  assert.deepEqual(Object.fromEntries(rest.body.grants.map((g: any) => [g.relationship_id, [g.grantee.bot_id, g.side]])), byRel);
});

test("list_remote_bots carries side on bots, home entries and relationship_sides", async (t) => {
  const { s, b, A, B, chief, helper, rel1, rel2 } = await twoJoins(t);
  const bob = await B("list_remote_bots");
  const ch = bob.bots.find((x: any) => x.bot_id === chief.bot_id);
  assert.equal(ch.relationship_id, rel1);
  assert.equal(ch.side, "joiner", "Bob joined Alice's Chief invite");
  const home = bob.homes.find((h: any) => h.bots.some((x: any) => x.bot_id === chief.bot_id));
  assert.equal(home.side, "joiner");
  assert.equal(home.relationship_sides[rel1], "joiner");
  assert.equal(home.bots.find((x: any) => x.bot_id === chief.bot_id).side, "joiner");
  const alice = await A("list_remote_bots");
  const he = alice.bots.find((x: any) => x.bot_id === helper.bot_id);
  assert.equal(he.relationship_id, rel2);
  assert.equal(he.side, "joiner", "Alice joined Bob's Helper invite, so Helper is a real share to her");
  const rest = await get(s.base, "/v1/remote-bots", b.connector.token);
  assert.equal(rest.body.bots.find((x: any) => x.bot_id === chief.bot_id).side, "joiner");
});

test("list_friends and relationships carry the owner's side; old relationships are classified too", async (t) => {
  const { s, a, b, A, B, chief, rel1, rel2 } = await twoJoins(t);
  const fa = await A("list_friends", { bot_id: chief.bot_id });
  const sides = Object.fromEntries(fa.friends.map((f: any) => [f.relationship_id, f.side]));
  assert.equal(sides[rel1], "inviter");
  assert.equal(sides[rel2], "joiner");
  const rels = s.platform.listRelationships({ kind: "owner", ownerId: b.owner_id } as any) as any[];
  assert.equal(rels.find((r) => r.relationship_id === rel1).side, "joiner");
  assert.equal(rels.find((r) => r.relationship_id === rel2).side, "inviter");
  // Relationships from before the invite link table was filled are still classified (side comes from requester/target).
  (s.platform as any).db.prepare("DELETE FROM relationship_invites").run();
  const { grants } = await A("list_bot_grants", { bot_id: chief.bot_id });
  assert.deepEqual(grants.map((g: any) => g.side).sort(), ["inviter", "joiner"]);
  assert.equal((await B("list_remote_bots")).bots.find((x: any) => x.bot_id === chief.bot_id).side, "joiner");
  void a;
});
