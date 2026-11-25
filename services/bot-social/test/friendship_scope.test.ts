import assert from "node:assert/strict";
import { test } from "node:test";
import { migrateFriendshipScopes, openDb } from "../src/db.js";
import { startServer } from "./helpers.js";

async function post(base: string, path: string, body: unknown) {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return await r.json() as any;
}
async function call(base: string, token: string, name: string, args: unknown = {}) {
  const r = await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  return ((await r.json()) as any).result;
}
const CAPS = { auto_accept: true, offered_capabilities: ["chat.public", "profile.read"], requested_capabilities: ["chat.public", "profile.read"] };

/** Two FlyBot homes: Danyang (chief, writer) and Bob (coder, tester). */
async function twoHomes(t: any) {
  const s = await startServer();
  t.after(s.stop);
  const a = await post(s.base, "/v1/onboard/flybot", { display_name: "Danyang" });
  const b = await post(s.base, "/v1/onboard/flybot", { display_name: "Bob" });
  const ok = (token: string) => async (name: string, args: unknown = {}) => {
    const r = await call(s.base, token, name, args);
    assert.equal(r.isError, undefined, r.content?.[0]?.text);
    return JSON.parse(r.content[0].text);
  };
  const A = ok(a.connector.token), B = ok(b.connector.token);
  const rawA = (name: string, args: unknown) => call(s.base, a.connector.token, name, args);
  const rawB = (name: string, args: unknown) => call(s.base, b.connector.token, name, args);
  const chief = await A("add_home_member", { home: a.home.bot_id, name: "chief" });
  const writer = await A("add_home_member", { home: a.home.bot_id, name: "writer" });
  const coder = await B("add_home_member", { home: b.home.bot_id, name: "coder" });
  const tester = await B("add_home_member", { home: b.home.bot_id, name: "tester" });
  return { s, a, b, A, B, rawA, rawB, chief, writer, coder, tester };
}
const denied = (r: any) => { assert.equal(r.isError, true); assert.match(r.content[0].text, /no_relationship|bot_not_found/); };

test("member invite joined by a member: only those two bots see and reach each other", async (t) => {
  const { s, a, b, A, B, rawA, rawB, chief, writer, coder, tester } = await twoHomes(t);
  const inv = await A("create_invite", { bot_id: chief.bot_id, ...CAPS });
  assert.equal(inv.scope, "bot");
  const joined = await B("join_invite", { code: inv.code, from_bot_id: coder.bot_id });
  assert.equal(joined.status, "active");
  const rel = s.platform.db.prepare("SELECT * FROM relationships WHERE id = ?").get(joined.relationship_id) as any;
  assert.equal(rel.target_bot, chief.bot_id);
  assert.equal(rel.target_scope, "bot");
  assert.equal(rel.requester_scope, "bot");

  // Listing: each side sees only the other's granted bot, reachable via its own granted bot.
  const bobView = await B("list_remote_bots", { home: b.home.bot_id });
  assert.deepEqual(bobView.homes.map((h: any) => h.bots.map((x: any) => x.handle)), [["@chief.danyang.home"]]);
  assert.deepEqual(bobView.homes[0].via, ["@coder.bob.home"]);
  assert.equal(bobView.homes[0].scope, "member");
  const danView = await A("list_remote_bots", { home: a.home.bot_id });
  assert.deepEqual(danView.homes.map((h: any) => h.bots.map((x: any) => x.handle)), [["@coder.bob.home"]]);
  assert.deepEqual(danView.homes[0].via, ["@chief.danyang.home"]);

  // Messaging: coder <-> chief works; every other pair is refused, both directions.
  assert.match((await B("send_as_member", { from_bot_id: coder.bot_id, to: chief.handle, text: "hello chief, coder here" })).conversation_id, /.+/);
  assert.match((await A("send_as_member", { from_bot_id: chief.bot_id, to: coder.handle, text: "hello coder, how are the tests going" })).conversation_id, /.+/);
  denied(await rawB("send_as_member", { from_bot_id: coder.bot_id, to: writer.handle, text: "x" }));
  denied(await rawB("send_as_member", { from_bot_id: tester.bot_id, to: chief.handle, text: "x" }));
  denied(await rawA("send_as_member", { from_bot_id: writer.bot_id, to: coder.handle, text: "x" }));
  denied(await rawA("send_as_member", { from_bot_id: chief.bot_id, to: tester.handle, text: "x" }));
  assert.throws(() => s.platform.activeRelationship(coder.bot_id, a.home.bot_id), /no active relationship/);
  assert.throws(() => s.platform.activeRelationship(b.home.bot_id, chief.bot_id), /no active relationship/);

  // Profiles: the granted bot is visible to the friend; its housemates are not (owner or bot view).
  const bobOwner = { kind: "owner", ownerId: b.owner_id } as any;
  assert.equal(s.platform.profile(bobOwner, chief.bot_id).handle, "@chief.danyang.home");
  assert.throws(() => s.platform.profile(bobOwner, writer.bot_id), /no such bot/);
  assert.throws(() => s.platform.profile(bobOwner, a.home.bot_id), /no such bot/);
  assert.throws(() => s.platform.profile({ kind: "bot", botId: coder.bot_id, ownerId: b.owner_id } as any, writer.bot_id), /no active relationship/);
  assert.equal(s.platform.profile({ kind: "bot", botId: coder.bot_id, ownerId: b.owner_id } as any, chief.bot_id).handle, "@chief.danyang.home");
  // Grants made to the friend's bot do not spill over to its housemates.
  assert.ok(s.platform.findGrant(a.owner_id, coder.bot_id, "chat.public"));
  assert.equal(s.platform.findGrant(a.owner_id, tester.bot_id, "chat.public"), null);
});

test("member invite joined by a home bot: only that home bot is granted, not its members", async (t) => {
  const { s, a, b, A, B, rawB, chief, writer, coder, tester } = await twoHomes(t);
  const inv = await A("create_invite", { bot_id: chief.bot_id, ...CAPS });
  const joined = await B("join_invite", { code: inv.code, from_bot_id: b.home.bot_id });
  const rel = s.platform.db.prepare("SELECT * FROM relationships WHERE id = ?").get(joined.relationship_id) as any;
  assert.deepEqual([rel.requester_scope, rel.target_scope], ["bot", "bot"]);
  const bobView = await B("list_remote_bots", { home: b.home.bot_id });
  assert.deepEqual(bobView.homes[0].bots.map((x: any) => x.handle), ["@chief.danyang.home"]);
  assert.match((await B("send_as_member", { from_bot_id: b.home.bot_id, to: chief.handle, text: "hi" })).conversation_id, /.+/);
  denied(await rawB("send_as_member", { from_bot_id: tester.bot_id, to: chief.handle, text: "x" }));
  denied(await rawB("send_as_member", { from_bot_id: coder.bot_id, to: writer.handle, text: "x" }));
  assert.throws(() => s.platform.profile({ kind: "owner", ownerId: b.owner_id } as any, writer.bot_id), /no such bot/);
});

test("home invite grants only the home bot; members and Chief stay default-deny", async (t) => {
  const { s, a, b, A, B, chief, writer, coder, tester } = await twoHomes(t);
  const inv = await A("create_invite", { bot_id: a.home.bot_id, ...CAPS });
  assert.equal(inv.scope, "bot");
  await B("join_invite", { code: inv.code, from_bot_id: b.home.bot_id });
  const bobView = await B("list_remote_bots", { home: b.home.bot_id });
  assert.deepEqual(bobView.homes[0].bots.map((x: any) => x.handle), ["@danyang.home"]);
  assert.ok(s.platform.activeRelationship(b.home.bot_id, a.home.bot_id));
  for (const [x, y] of [[coder, chief], [tester, writer], [chief, tester], [coder, a.home], [b.home, chief]]) {
    assert.throws(() => s.platform.activeRelationship(x.bot_id, y.bot_id), /no active relationship/);
  }
});

test("legacy home-scoped rows are ignored: members stay unreachable", async (t) => {
  const { s, a, B, A, b, chief, coder } = await twoHomes(t);
  const inv = await A("create_invite", { bot_id: a.home.bot_id, ...CAPS });
  const joined = await B("join_invite", { code: inv.code, from_bot_id: b.home.bot_id });
  s.platform.db.prepare("UPDATE relationships SET target_scope = 'home', requester_scope = 'home' WHERE id = ?").run(joined.relationship_id);
  assert.throws(() => s.platform.activeRelationship(coder.bot_id, chief.bot_id), /no active relationship/);
  assert.equal(s.platform.findGrant(b.owner_id, chief.bot_id, "chat.public"), null);
  const bobView = await B("list_remote_bots", { home: b.home.bot_id });
  assert.deepEqual(bobView.homes[0].bots.map((x: any) => x.handle), ["@danyang.home"]);
});

test("migration pins invite-born friendships to the invite's target; idempotent; others untouched", () => {
  const db = openDb(":memory:");
  const now = new Date().toISOString();
  db.prepare("INSERT INTO owners (id, username, display_name, password_hash, created_at) VALUES ('o1','u1','U1','x',?),('o2','u2','U2','x',?)").run(now, now);
  const bot = db.prepare("INSERT INTO bots (id, owner_id, handle, display_name, integration_type, webhook_secret, created_at, home_bot_id) VALUES (?,?,?,?,?,'s',?,?)");
  bot.run("h1", "o1", "h1.home", "H1", "flybot-home", now, null);
  bot.run("m1", "o1", "m.h1.home", "M1", "flybot-member", now, "h1");
  bot.run("h2", "o2", "h2.home", "H2", "flybot-home", now, null);
  const rel = db.prepare("INSERT INTO relationships (id, requester_bot, target_bot, requester_owner, target_owner, status, requested_caps, offered_caps, created_at, updated_at) VALUES (?,?,?,?,?,'active','[]','[]',?,?)");
  const inv = db.prepare("INSERT INTO invites (id, code, bot_id, owner_id, created_by, offered_caps, requested_caps, expires_at, created_at) VALUES (?,?,?,'o1','owner:o1','[]','[]',?,?)");
  rel.run("r_member", "h2", "m1", "o2", "o1", now, now); inv.run("i1", "c1", "m1", now, now);
  db.prepare("INSERT INTO relationship_invites VALUES ('r_member','i1')").run();
  rel.run("r_home", "h2", "h1", "o2", "o1", now, now); inv.run("i2", "c2", "h1", now, now);
  db.prepare("INSERT INTO relationship_invites VALUES ('r_home','i2')").run();
  rel.run("r_request", "h2", "h1", "o2", "o1", now, now); // plain friend request, no invite
  db.exec("UPDATE relationships SET target_scope = NULL, requester_scope = NULL; UPDATE invites SET scope = NULL");
  assert.equal(migrateFriendshipScopes(db), 2);
  const scopes = Object.fromEntries((db.prepare("SELECT id, requester_scope, target_scope FROM relationships").all() as any[]).map((r) => [r.id, [r.requester_scope, r.target_scope]]));
  assert.deepEqual(scopes, { r_member: [null, "bot"], r_home: [null, "home"], r_request: [null, null] });
  assert.deepEqual((db.prepare("SELECT id, scope FROM invites ORDER BY id").all() as any[]).map((i) => i.scope), ["bot", "home"]);
  assert.equal(migrateFriendshipScopes(db), 0);
  db.close();
});
