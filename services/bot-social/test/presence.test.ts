import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";
import { mcp, post, req, CAPS } from "./flybot_helpers.js";

const clock = { t: Date.now() };
const startClocked = () => startServer({ now: () => clock.t });

/** Alice (chief) and Bob (coder) are FlyBot homes and friends; Carol is an unrelated third owner with a member. */
async function homes(t: any) {
  clock.t = Date.now();
  const s = await startClocked();
  t.after(s.stop);
  const a = (await post(s.base, "/v1/onboard/flybot", { display_name: "Alice" })).body;
  const b = (await post(s.base, "/v1/onboard/flybot", { display_name: "Bob" })).body;
  const c = (await post(s.base, "/v1/onboard/flybot", { display_name: "Carol" })).body;
  const A = (name: string, args: unknown = {}) => mcp(s.base, a.connector.token, name, args);
  const B = (name: string, args: unknown = {}) => mcp(s.base, b.connector.token, name, args);
  const C = (name: string, args: unknown = {}) => mcp(s.base, c.connector.token, name, args);
  const chief = await A("add_home_member", { home: a.home.bot_id, name: "chief", display_name: "Chief" });
  const coder = await B("add_home_member", { home: b.home.bot_id, name: "coder", display_name: "Coder" });
  const carol = await C("add_home_member", { home: c.home.bot_id, name: "carolbot", display_name: "Carolbot" });
  const alice2 = await A("add_home_member", { home: a.home.bot_id, name: "second", display_name: "Second" });
  const inv = await A("create_invite", { bot_id: chief.bot_id, ...CAPS });
  await B("join_invite", { code: inv.code ?? inv.invite?.code, from_bot_id: coder.bot_id });
  return { s, a, b, c, A, B, C, chief, coder, carol, alice2 };
}

test("platform lists presence as a feature", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const info = (await req(s.base, "GET", "/v1/platform")).body;
  assert.ok(info.features.includes("presence"));
  assert.ok(info.features.includes("mentions"));
});

test("direct: the peer's owner sees the thinking Bot; the writer's owner, others and strangers do not", async (t) => {
  const { A, B, C, chief, coder } = await homes(t);
  const set = await A("set_presence", { bot_id: chief.bot_id, to: coder.handle, state: "thinking" });
  assert.equal(set.state, "thinking");
  assert.equal(Date.parse(set.expires_at) - clock.t, 20_000);
  const seen = await B("list_presence", { bot_id: coder.bot_id });
  assert.equal(seen.presence.length, 1);
  const e = seen.presence[0];
  assert.deepEqual(Object.keys(e).sort(), ["bot", "expires_at", "scope", "state", "to"]);
  assert.equal(e.scope, "direct");
  assert.equal(e.bot.handle.toLowerCase(), chief.handle.toLowerCase());
  assert.equal(e.bot.display_name, "Chief");
  assert.deepEqual(Object.keys(e.bot).sort(), ["display_name", "handle"]);
  assert.equal(e.to.toLowerCase(), coder.handle.toLowerCase());
  assert.equal(e.state, "thinking");
  assert.deepEqual((await A("list_presence")).presence, []);
  assert.deepEqual((await C("list_presence")).presence, []);
  const stop = await A("set_presence", { bot_id: chief.bot_id, to: coder.handle, state: "idle" });
  assert.equal(stop.state, "idle");
  assert.deepEqual((await B("list_presence")).presence, []);
});

test("it expires on its own and a heartbeat extends it; ttl is clamped", async (t) => {
  const { A, B, chief, coder } = await homes(t);
  await A("set_presence", { bot_id: chief.bot_id, to: coder.handle, state: "thinking", ttl_seconds: 10 });
  clock.t += 9_000;
  assert.equal((await B("list_presence")).presence.length, 1);
  await A("set_presence", { bot_id: chief.bot_id, to: coder.handle, state: "thinking", ttl_seconds: 10 });
  clock.t += 9_000;
  assert.equal((await B("list_presence")).presence.length, 1);
  clock.t += 2_000;
  assert.deepEqual((await B("list_presence")).presence, []);
  const big = await A("set_presence", { bot_id: chief.bot_id, to: coder.handle, state: "thinking", ttl_seconds: 9999 });
  assert.equal(Date.parse(big.expires_at) - clock.t, 60_000);
  const small = await A("set_presence", { bot_id: chief.bot_id, to: coder.handle, state: "thinking", ttl_seconds: 1 });
  assert.equal(Date.parse(small.expires_at) - clock.t, 5_000);
});

test("only between Bots that may talk: no relationship, someone else's Bot, bad input", async (t) => {
  const { A, B, C, a, chief, coder, carol, alice2 } = await homes(t);
  const noRel = await A("set_presence", { bot_id: chief.bot_id, to: carol.handle, state: "thinking" });
  assert.equal(noRel.error.code, "no_relationship");
  assert.deepEqual((await C("list_presence")).presence, []);
  const notMine = await B("set_presence", { bot_id: chief.bot_id, to: coder.handle, state: "thinking" });
  assert.equal(notMine.error.code, "forbidden");
  // a Bot of mine without a relationship to the peer cannot claim one
  assert.equal((await A("set_presence", { bot_id: alice2.bot_id, to: coder.handle, state: "thinking" })).error.code, "no_relationship");
  assert.equal((await A("set_presence", { bot_id: chief.bot_id, to: "@nobody.home", state: "thinking" })).error.code, "bot_not_found");
  for (const args of [{}, { state: "typing", to: coder.handle }, { state: "thinking" }, { state: "thinking", to: coder.handle, room_id: "x" }, { state: "thinking", to: coder.handle, ttl_seconds: "soon" }]) {
    const r = await A("set_presence", { bot_id: chief.bot_id, ...args });
    assert.ok(r.error, JSON.stringify(args));
  }
  // nothing leaked by the refused calls
  assert.deepEqual((await B("list_presence")).presence, []);
  void a;
});

test("unfriending drops it at once and sending is refused", async (t) => {
  const { s, A, B, a, chief, coder } = await homes(t);
  await A("set_presence", { bot_id: chief.bot_id, to: coder.handle, state: "thinking" });
  assert.equal((await B("list_presence")).presence.length, 1);
  const rels = s.platform.listRelationships({ kind: "owner", ownerId: a.owner_id } as any) as any[];
  s.platform.removeRelationship({ kind: "owner", ownerId: a.owner_id } as any, rels[0].relationship_id);
  assert.deepEqual((await B("list_presence")).presence, []);
  assert.equal((await A("set_presence", { bot_id: chief.bot_id, to: coder.handle, state: "thinking" })).error.code, "no_relationship");
});

test("rate limit: 30 writes a minute per Bot", async (t) => {
  const { A, chief, coder } = await homes(t);
  for (let i = 0; i < 30; i++) assert.equal((await A("set_presence", { bot_id: chief.bot_id, to: coder.handle, state: "thinking" })).state, "thinking");
  const over = await A("set_presence", { bot_id: chief.bot_id, to: coder.handle, state: "thinking" });
  assert.equal(over.error.code, "rate_limited");
  clock.t += 61_000;
  assert.equal((await A("set_presence", { bot_id: chief.bot_id, to: coder.handle, state: "idle" })).state, "idle");
});

test("REST: a Bot token acts only as itself, an owner login or connector token as its own Bots", async (t) => {
  clock.t = Date.now();
  const s = await startClocked();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "pia");
  const B = await ownerWithBot(s.base, "pat");
  const rel = await A.owner.req("POST", "/v1/relationships", { from_bot_id: A.bot.id, target_handle: B.handle, message: "hi", requested_capabilities: ["chat.public"] });
  await B.owner.req("POST", `/v1/relationships/${rel.relationship_id}/consent`, { decision: "accept", grant_capabilities: [] });
  const botTok = (x: typeof A) => (x.reg.bot_token as string);
  const noAuth = await req(s.base, "PUT", "/v1/presence", undefined, { state: "thinking", to: B.handle });
  assert.equal(noAuth.status, 401);
  const put = await req(s.base, "PUT", "/v1/presence", botTok(A), { state: "thinking", to: B.handle });
  assert.equal(put.status, 200);
  const other = await req(s.base, "PUT", "/v1/presence", botTok(A), { bot_id: B.bot.id, state: "thinking", to: A.handle });
  assert.equal(other.status, 403);
  const got = await req(s.base, "GET", "/v1/presence", botTok(B));
  assert.equal(got.body.presence.length, 1);
  assert.equal(got.body.presence[0].bot.handle.toLowerCase(), A.handle.toLowerCase());
  assert.equal((await req(s.base, "GET", "/v1/presence", botTok(A))).body.presence.length, 0);
  const ownerSees = await req(s.base, "GET", `/v1/presence?bot_id=${B.bot.id}`, B.owner.token);
  assert.equal(ownerSees.body.presence.length, 1);
  assert.equal((await req(s.base, "PUT", "/v1/presence", A.owner.token, { state: "idle", to: B.handle })).status, 200);
  assert.equal((await req(s.base, "GET", "/v1/presence", botTok(B))).body.presence.length, 0);
});

async function room(t: any) {
  const h = await homes(t);
  const code = String(100000 + Math.floor(Math.random() * 800000));
  const jA = await h.A("join_face_room", { code, bots: [h.chief.bot_id] });
  const jB = await h.B("join_face_room", { code, bots: [h.coder.bot_id] });
  const jC = await h.C("join_face_room", { code: "999111", bots: [h.carol.bot_id] });
  return { ...h, roomId: jA.room_id as string, jB, jC };
}

test("face room: only an open room, only members; the other members' owners see it, not the writer's owner or outsiders", async (t) => {
  const { A, B, C, chief, coder, carol, roomId } = await room(t);
  // a waiting (candidate) room has no chat yet
  assert.equal((await A("set_presence", { bot_id: chief.bot_id, room_id: roomId, state: "thinking" })).error.code, "room_not_started");
  await A("start_face_room", { room_id: roomId });
  assert.equal((await A("set_presence", { bot_id: chief.bot_id, room_id: roomId, state: "thinking" })).state, "thinking");
  const seen = await B("list_presence", { room_id: roomId });
  assert.equal(seen.presence.length, 1);
  assert.equal(seen.presence[0].scope, "face_room");
  assert.equal(seen.presence[0].room_id, roomId);
  assert.equal(seen.presence[0].bot.display_name, "Chief");
  assert.deepEqual(Object.keys(seen.presence[0]).sort(), ["bot", "expires_at", "room_id", "scope", "state"]);
  assert.deepEqual((await A("list_presence")).presence, []);
  assert.deepEqual((await C("list_presence")).presence, []);
  assert.deepEqual((await C("list_presence", { room_id: roomId })).presence, []);
  // an outsider cannot write into the room, and learns nothing about it
  assert.equal((await C("set_presence", { bot_id: carol.bot_id, room_id: roomId, state: "thinking" })).error.code, "face_room_not_found");
  assert.equal((await C("set_presence", { bot_id: carol.bot_id, room_id: "nope", state: "thinking" })).error.code, "face_room_not_found");
  // the room filter scopes the answer
  assert.deepEqual((await B("list_presence", { room_id: "other" })).presence, []);
  // leaving drops it at once
  await A("leave_face_room", { room_id: roomId });
  assert.deepEqual((await B("list_presence")).presence, []);
  assert.equal((await A("set_presence", { bot_id: chief.bot_id, room_id: roomId, state: "thinking" })).error.code, "face_room_not_found");
  void coder;
});

test("presence is memory only: no events, audit rows or approvals come from it", async (t) => {
  const { s, A, B, chief, coder } = await homes(t);
  const count = () => ({
    events: (s.platform.db.prepare("SELECT COUNT(*) n FROM events").get() as any).n,
    audit: (s.platform.audit.db.prepare("SELECT COUNT(*) n FROM audit_events").get() as any).n,
    approvals: (s.platform.db.prepare("SELECT COUNT(*) n FROM approvals").get() as any).n,
  });
  const before = count();
  await A("set_presence", { bot_id: chief.bot_id, to: coder.handle, state: "thinking" });
  await A("set_presence", { bot_id: chief.bot_id, to: coder.handle, state: "idle" });
  await B("list_presence");
  assert.deepEqual(count(), before);
  const inbox = await B("list_inbox", { bot_id: coder.bot_id, peek: true });
  assert.ok(!inbox.events.some((e: any) => /presence|thinking/.test(JSON.stringify(e))));
});

test("a removed Bot is reported as revoked, not as an emergency-stopped one", async (t) => {
  const { s, a, B, chief, coder, alice2 } = await homes(t);
  void B;
  const ownerTok = (await post(s.base, "/v1/auth/login", { username: a.username, password: a.generated_password })).body.owner_token as string;
  const p = s.platform;
  const A = { kind: "owner" as const, ownerId: a.owner_id };

  // Control: the kill switch still answers as frozen on both presence routes.
  await req(s.base, "POST", "/v1/emergency-stop", ownerTok, { bot_id: alice2.bot_id });
  const frozenSet = await req(s.base, "PUT", "/v1/presence", ownerTok, { bot_id: alice2.bot_id, state: "thinking", to: coder.handle });
  assert.equal(frozenSet.status, 403);
  assert.equal(frozenSet.body.error.code, "bot_frozen");
  const frozenList = await req(s.base, "GET", `/v1/presence?bot_id=${alice2.bot_id}`, ownerTok);
  assert.equal(frozenList.status, 403);
  assert.equal(frozenList.body.error.code, "bot_frozen");

  // A Bot removed from its home is revoked, and presence says so instead of offering a Resume.
  p.removeHomeMember(A, a.home.bot_id, chief.bot_id);
  assert.equal(p.bot(chief.bot_id).status, "revoked");
  const set = await req(s.base, "PUT", "/v1/presence", ownerTok, { bot_id: chief.bot_id, state: "thinking", to: coder.handle });
  assert.equal(set.status, 403);
  assert.equal(set.body.error.code, "bot_revoked");
  assert.match(set.body.error.message, /revoked/);
  const list = await req(s.base, "GET", `/v1/presence?bot_id=${chief.bot_id}`, ownerTok);
  assert.equal(list.status, 403);
  assert.equal(list.body.error.code, "bot_revoked");
  assert.match(list.body.error.message, /revoked/);
});
