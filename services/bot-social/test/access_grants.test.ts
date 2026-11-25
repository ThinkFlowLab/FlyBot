import assert from "node:assert/strict";
import { test } from "node:test";
import { startServer } from "./helpers.js";

async function post(base: string, path: string, body: unknown, token?: string) {
  const r = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() as any };
}
async function req(base: string, method: string, path: string, token: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}
async function mcp(base: string, token: string, name: string, args: unknown = {}) {
  const r = await fetch(base + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const j: any = await r.json();
  if (j.result?.isError) return { error: JSON.parse(j.result.content[0].text) };
  return JSON.parse(j.result.content[0].text);
}

const CAPS = { auto_accept: true, offered_capabilities: ["chat.public", "profile.read"], requested_capabilities: ["chat.public", "profile.read"] };

async function twoHomes(t: any) {
  const s = await startServer();
  t.after(s.stop);
  const a = (await post(s.base, "/v1/onboard/flybot", { display_name: "Alice" })).body;
  const b = (await post(s.base, "/v1/onboard/flybot", { display_name: "Bob" })).body;
  const A = (name: string, args: unknown = {}) => mcp(s.base, a.connector.token, name, args);
  const B = (name: string, args: unknown = {}) => mcp(s.base, b.connector.token, name, args);
  const writer = await A("add_home_member", { home: a.home.bot_id, name: "writer", display_name: "Writer" });
  const chief = await A("add_home_member", { home: a.home.bot_id, name: "chief", display_name: "Chief" });
  const coder = await B("add_home_member", { home: b.home.bot_id, name: "coder", display_name: "Coder" });
  return { s, a, b, A, B, writer, chief, coder };
}

test("ungranted bots cannot be listed or reached (default deny, including home and Chief)", async (t) => {
  const { s, a, b, A, B, writer, chief, coder } = await twoHomes(t);
  const empty = await B("list_remote_bots", { home: b.home.bot_id });
  assert.deepEqual(empty.bots, []);
  assert.deepEqual(empty.homes, []);
  const restEmpty = await req(s.base, "GET", "/v1/remote-bots", b.connector.token);
  assert.equal(restEmpty.status, 200);
  assert.deepEqual(restEmpty.body.bots, []);

  const invHome = await A("create_invite", { bot_id: a.home.bot_id, ...CAPS });
  await B("join_invite", { code: invHome.code, from_bot_id: coder.bot_id });
  const afterHome = await B("list_remote_bots", { home: b.home.bot_id });
  assert.deepEqual(afterHome.bots.map((x: any) => x.handle), ["@alice.home"]);
  assert.ok(!afterHome.bots.some((x: any) => /chief|writer/.test(x.handle)));
  assert.throws(() => s.platform.profile({ kind: "owner", ownerId: b.owner_id } as any, writer.bot_id), /no such bot/);
  assert.throws(() => s.platform.profile({ kind: "owner", ownerId: b.owner_id } as any, chief.bot_id), /no such bot/);
  assert.throws(() => s.platform.activeRelationship(coder.bot_id, writer.bot_id), /no active relationship/);
  assert.throws(() => s.platform.activeRelationship(coder.bot_id, chief.bot_id), /no active relationship/);

  const invChief = await A("create_invite", { bot_id: chief.bot_id, ...CAPS });
  await B("join_invite", { code: invChief.code, from_bot_id: coder.bot_id });
  const afterChief = await B("list_remote_bots", { home: b.home.bot_id });
  assert.deepEqual(afterChief.bots.map((x: any) => x.handle).sort(), ["@alice.home", "@chief.alice.home"]);
  assert.ok(!afterChief.bots.some((x: any) => x.handle.includes("writer")));
  assert.throws(() => s.platform.profile({ kind: "owner", ownerId: b.owner_id } as any, writer.bot_id), /no such bot/);
});

test("list and revoke grants of one bot via REST (connector token) and MCP", async (t) => {
  const { s, a, b, A, B, writer, chief, coder } = await twoHomes(t);
  const invW = await A("create_invite", { bot_id: writer.bot_id, ...CAPS });
  await B("join_invite", { code: invW.code, from_bot_id: coder.bot_id });
  const invC = await A("create_invite", { bot_id: chief.bot_id, ...CAPS });
  await B("join_invite", { code: invC.code, from_bot_id: coder.bot_id });

  const listed = await req(s.base, "GET", `/v1/bots/${writer.bot_id}/grants`, a.connector.token);
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.bot.handle, "@writer.alice.home");
  assert.equal(listed.body.grants.length, 1);
  const g = listed.body.grants[0];
  assert.equal(g.grantee.handle, "@coder.bob.home");
  assert.equal(g.scope, "person");
  assert.ok(g.capabilities.includes("chat.public"));
  assert.ok(g.created_at);
  assert.ok(g.expires_at);

  const mcpList = await A("list_bot_grants", { bot_id: writer.bot_id });
  assert.equal(mcpList.grants.length, 1);
  assert.equal(mcpList.grants[0].grant_id, g.grant_id);

  const remote = await req(s.base, "GET", `/v1/homes/${b.home.bot_id}/remote-bots`, b.connector.token);
  assert.equal(remote.status, 200);
  assert.ok(remote.body.bots.some((x: any) => x.handle === "@writer.alice.home"));
  assert.ok(remote.body.bots.some((x: any) => x.handle === "@chief.alice.home"));

  const revoked = await req(s.base, "DELETE", `/v1/bots/${writer.bot_id}/grants/${g.grant_id}`, a.connector.token);
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  assert.equal(revoked.body.status, "revoked");

  const after = await A("list_bot_grants", { bot_id: writer.bot_id });
  assert.equal(after.grants.length, 0);
  const chiefGrants = await A("list_bot_grants", { bot_id: chief.bot_id });
  assert.equal(chiefGrants.grants.length, 1, "revoking Writer must not touch Chief");
  const remote2 = await B("list_remote_bots", { home: b.home.bot_id });
  assert.deepEqual(remote2.bots.map((x: any) => x.handle), ["@chief.alice.home"]);
  assert.equal(s.platform.findGrant(a.owner_id, coder.bot_id, "chat.public", writer.bot_id), null);
  assert.equal(s.platform.findGrant(a.owner_id, coder.bot_id, "chat.public", chief.bot_id)?.relationship_id, chiefGrants.grants[0].relationship_id);
  const mcpRevoke = await A("revoke_bot_grant", { grant_id: chiefGrants.grants[0].grant_id, bot_id: chief.bot_id });
  assert.equal(mcpRevoke.status, "revoked");
  assert.deepEqual((await B("list_remote_bots")).bots, []);
});

test("revoking a grant removes the bot from rooms where the grantee added it", async (t) => {
  const { s, a, b, A, B, writer, coder } = await twoHomes(t);
  const inv = await A("create_invite", { bot_id: writer.bot_id, ...CAPS });
  await B("join_invite", { code: inv.code, from_bot_id: coder.bot_id });

  const join = await req(s.base, "POST", "/v1/face-rooms/join", b.connector.token, { code: "424242", bots: [coder.bot_id, writer.bot_id] });
  assert.equal(join.status, 200, JSON.stringify(join.body));
  assert.equal(join.body.members.length, 2);
  assert.ok(join.body.members.some((m: any) => m.handle === writer.handle));

  const grants = await A("list_bot_grants", { bot_id: writer.bot_id });
  const person = grants.grants.find((g: any) => g.scope === "person" || g.scope === "group");
  assert.ok(person, JSON.stringify(grants.grants));
  assert.ok((person.rooms?.length ?? 0) >= 1 || person.room, JSON.stringify(person));
  const audit = s.platform.auditEvents({ kind: "owner", ownerId: a.owner_id }, { limit: 500 });
  assert.ok(audit.events.some((e: any) => e.action === "grant.used_in_room"), audit.events.map((e: any) => e.action).join(","));
  assert.ok(audit.events.some((e: any) => e.action === "grant.created"));

  const revoked = await A("revoke_bot_grant", { grant_id: person.grant_id, bot_id: writer.bot_id });
  assert.equal(revoked.status, "revoked");
  assert.ok(revoked.rooms_removed?.includes(join.body.room_id));
  const room = await req(s.base, "GET", `/v1/face-rooms/${join.body.room_id}`, b.connector.token);
  assert.equal(room.status, 200);
  assert.ok(!room.body.members.some((m: any) => m.handle === writer.handle), JSON.stringify(room.body.members));
  assert.ok(room.body.members.some((m: any) => m.handle === coder.handle));
  const afterRevoke = s.platform.auditEvents({ kind: "owner", ownerId: a.owner_id }, { limit: 500 });
  assert.ok(afterRevoke.events.some((e: any) => e.action === "grant.revoked"));
});

test("face-room own-bot join is an implicit room-scoped grant that ends on leave", async (t) => {
  const { s, a, b, A, B, writer, coder } = await twoHomes(t);
  const ja = await req(s.base, "POST", "/v1/face-rooms/join", a.connector.token, { code: "656565", bots: [writer.bot_id] });
  const jb = await req(s.base, "POST", "/v1/face-rooms/join", b.connector.token, { code: "656565", bots: [coder.bot_id] });
  assert.equal(jb.status, 200);
  assert.equal(jb.body.room_id, ja.body.room_id);
  const grants = await A("list_bot_grants", { bot_id: writer.bot_id });
  assert.ok(grants.grants.some((g: any) => g.scope === "room" && g.grantee.handle === coder.handle), JSON.stringify(grants.grants));
  const remote = await B("list_remote_bots");
  assert.ok(remote.bots.some((x: any) => x.handle === writer.handle && x.scope === "room"));
  await req(s.base, "POST", `/v1/face-rooms/${ja.body.room_id}/leave`, a.connector.token, { bots: [writer.bot_id] });
  const after = await A("list_bot_grants", { bot_id: writer.bot_id });
  assert.ok(!after.grants.some((g: any) => g.scope === "room" && g.grantee.handle === coder.handle));
});
