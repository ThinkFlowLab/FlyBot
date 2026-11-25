import assert from "node:assert/strict";
import { test } from "node:test";
import { avatarKind, validateAvatar, validateColor } from "../src/bot-look.js";
import { CAPS, flybotHomes, req } from "./flybot_helpers.js";

const PNG_1x1 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const pngHeader = (w: number, h: number, pad = 0) => {
  const b = Buffer.alloc(33 + pad);
  Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").copy(b);
  b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return "data:image/png;base64," + b.toString("base64");
};

test("validateAvatar / validateColor: allowlist, limits and clearing", () => {
  assert.equal(validateAvatar(null), null);
  assert.equal(validateAvatar(""), null);
  assert.equal(validateAvatar("star"), "star");
  assert.equal(validateAvatar("blue-whale_2"), "blue-whale_2");
  for (const e of ["🌟", "👍🏽", "👩‍💻", "🇨🇳", "❤️"]) assert.equal(validateAvatar(e), e, e);
  assert.equal(validateAvatar(PNG_1x1), PNG_1x1);
  assert.equal(avatarKind("star"), "preset");
  assert.equal(avatarKind("🌟"), "emoji");
  assert.equal(avatarKind(PNG_1x1), "image");
  assert.equal(avatarKind(null), null);
  const bad: unknown[] = [
    42, {}, ["star"], "Star", "has space", "a".repeat(33), "<script>alert(1)</script>", "javascript:alert(1)", "https://evil.example/a.png", "🌟🌟", "x🌟", "🌟\u202e",
    "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", "data:image/gif;base64,R0lGODlhAQABAAAAACw=", "data:text/html;base64,PGI+aGk8L2I+",
    "data:image/png;base64,not base64!", "data:image/png,rawbytes", "data:image/jpeg;base64," + Buffer.from("not a jpeg at all").toString("base64"),
    "data:image/png;base64," + Buffer.from("this is not a png at all, it is plain text").toString("base64"),
    "data:image/webp;base64," + PNG_1x1.split(",")[1],
    pngHeader(2000, 2000), pngHeader(0, 5), pngHeader(1, 1, 70_000),
    PNG_1x1.replace("gg==", "gh=="), // non-canonical base64 (stray trailing bits)
  ];
  for (const v of bad) assert.throws(() => validateAvatar(v), (e: any) => e.status === 400 && e.code === "invalid_avatar", String(v).slice(0, 60));
  assert.ok(validateAvatar(pngHeader(1024, 1024))?.startsWith("data:image/png"));
  assert.equal(validateColor("#ff8800"), "#ff8800");
  assert.equal(validateColor(null), null);
  for (const v of ["ff8800", "#FF8800", "#fff", "red", "#ff88001", 5, "url(x)"]) assert.throws(() => validateColor(v), (e: any) => e.code === "invalid_color", String(v));
});

test("owner sets avatar/color via MCP and REST (connector token); profile and own listings return them", async (t) => {
  const { s, a, A, writer } = await flybotHomes(t);
  // backward compatible: Bots start without a look, and display_name-only updates still work
  const before = await A("get_bot_profile", { bot_id: writer.bot_id });
  assert.equal(before.avatar, null);
  assert.equal(before.color, null);
  assert.equal(before.avatar_kind, null);
  assert.equal(before.avatar_updated_at, null);
  const renamed = await A("update_bot_profile", { bot_id: writer.bot_id, display_name: "Scribe" });
  assert.equal(renamed.display_name, "Scribe");
  assert.equal(renamed.avatar, null);

  const set = await A("update_bot_profile", { bot_id: writer.bot_id, avatar: "star", color: "#ff8800" });
  assert.equal(set.display_name, "Scribe", "display_name untouched when omitted");
  assert.equal(set.avatar, "star");
  assert.equal(set.avatar_kind, "preset");
  assert.equal(set.color, "#ff8800");
  assert.ok(set.avatar_updated_at);
  const prof = await A("get_bot_profile", { bot_id: writer.bot_id });
  assert.equal(prof.avatar, "star");
  assert.equal(prof.color, "#ff8800");

  const rest = await req(s.base, "PATCH", `/v1/bots/${writer.bot_id}/profile`, a.connector.token, { avatar: "🌟" });
  assert.equal(rest.status, 200, JSON.stringify(rest.body));
  assert.equal(rest.body.avatar, "🌟");
  assert.equal(rest.body.avatar_kind, "emoji");
  assert.equal(rest.body.color, "#ff8800", "color untouched when omitted");
  const img = await req(s.base, "PATCH", `/v1/bots/${writer.bot_id}/profile`, a.connector.token, { avatar: PNG_1x1 });
  assert.equal(img.status, 200);
  assert.equal(img.body.avatar_kind, "image");

  const homeMembers = { body: await A("list_home_members", { home: a.home.bot_id }) };
  assert.equal(homeMembers.body.members.find((m: any) => m.handle === writer.handle).avatar, PNG_1x1);
  const me = await A("whoami");
  assert.equal(me.bots.find((b: any) => b.id === writer.bot_id).color, "#ff8800");

  const cleared = await A("update_bot_profile", { bot_id: writer.bot_id, avatar: null, color: null });
  assert.equal(cleared.avatar, null);
  assert.equal(cleared.color, null);
  const audit = s.platform.auditEvents({ kind: "owner", ownerId: a.owner_id }, { limit: 500 });
  const upd = audit.events.filter((e: any) => e.action === "bot.profile_updated");
  assert.ok(upd.length >= 4);
  assert.ok(!JSON.stringify(audit.events).includes("iVBORw0KGgo"), "audit never stores image bytes");
});

test("profile update validation and authorization", async (t) => {
  const { s, a, b, A, B, writer } = await flybotHomes(t);
  const bad = await A("update_bot_profile", { bot_id: writer.bot_id, avatar: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" });
  assert.equal(bad.error.code, "invalid_avatar");
  assert.equal((await A("update_bot_profile", { bot_id: writer.bot_id, color: "orange" })).error.code, "invalid_color");
  assert.equal((await A("update_bot_profile", { bot_id: writer.bot_id })).error.code, "invalid_request");
  assert.equal((await A("update_bot_profile", { bot_id: writer.bot_id, display_name: "  " })).error.code, "invalid_request");
  assert.equal((await A("get_bot_profile", { bot_id: writer.bot_id })).avatar, null, "a rejected update changes nothing");
  const big = await req(s.base, "PATCH", `/v1/bots/${writer.bot_id}/profile`, a.connector.token, { avatar: pngHeader(1, 1, 70_000) });
  assert.equal(big.status, 400);
  assert.equal(big.body.error.code, "invalid_avatar");

  // another owner cannot change my bot's look; anonymous callers and bot tokens cannot either
  const other = await B("update_bot_profile", { bot_id: writer.bot_id, avatar: "skull" });
  assert.equal(other.error.code, "forbidden");
  const rest = await req(s.base, "PATCH", `/v1/bots/${writer.bot_id}/profile`, b.connector.token, { avatar: "skull" });
  assert.equal(rest.status, 403);
  assert.equal((await req(s.base, "PATCH", `/v1/bots/${writer.bot_id}/profile`, undefined, { avatar: "skull" })).status, 401);
  assert.equal(s.platform.bot(writer.bot_id).avatar, null);
});

test("peers see the look only where they may already see the Bot (default deny, no new exposure)", async (t) => {
  const { s, a, b, c, A, B, C, writer, chief, coder } = await flybotHomes(t);
  await A("update_bot_profile", { bot_id: writer.bot_id, avatar: "star", color: "#ff8800" });
  await A("update_bot_profile", { bot_id: chief.bot_id, avatar: PNG_1x1, color: "#3366ff" });
  await B("update_bot_profile", { bot_id: coder.bot_id, avatar: "🐳" });

  // nothing granted yet: Bob and Carol see nothing of Alice's bots
  assert.deepEqual((await B("list_remote_bots")).bots, []);
  assert.throws(() => s.platform.profile({ kind: "owner", ownerId: b.owner_id } as any, writer.bot_id), /no such bot/);

  // public invite preview carries no look
  const inv = await A("create_invite", { bot_id: writer.bot_id, ...CAPS });
  const preview = await req(s.base, "GET", `/v1/invites/${inv.code}`);
  assert.equal(preview.status, 200);
  assert.equal("avatar" in preview.body.inviter, false);
  assert.equal("color" in preview.body.inviter, false);

  await B("join_invite", { code: inv.code, from_bot_id: coder.bot_id });
  // Bob (granted Writer): REST and MCP, flat and grouped by home
  const remote = await B("list_remote_bots", { home: b.home.bot_id });
  const w = remote.bots.find((x: any) => x.handle === writer.handle);
  assert.deepEqual([w.avatar, w.avatar_kind, w.color], ["star", "preset", "#ff8800"]);
  assert.ok(w.avatar_updated_at);
  assert.ok(!remote.bots.some((x: any) => x.handle === chief.handle), "Chief was not granted");
  assert.equal(remote.homes[0].bots[0].avatar, "star");
  const restRemote = await req(s.base, "GET", "/v1/remote-bots", b.connector.token);
  assert.equal(restRemote.body.bots[0].avatar, "star");
  // the granted Bot's profile (profile.read) and the friend list carry it; Chief's profile stays hidden
  const profile = s.platform.profile({ kind: "owner", ownerId: b.owner_id } as any, writer.bot_id) as any;
  assert.equal(profile.avatar, "star");
  assert.throws(() => s.platform.profile({ kind: "owner", ownerId: b.owner_id } as any, chief.bot_id), /no such bot/);
  const friends = await B("list_friends", { bot_id: coder.bot_id });
  assert.equal(friends.friends[0].peer.avatar, "star");
  const rels = s.platform.listRelationships({ kind: "owner", ownerId: b.owner_id } as any) as any[];
  assert.equal(rels[0].peer.avatar, "star");
  // Alice sees Coder as a friend and as a grantee in Manage access
  const aliceGrants = await A("list_bot_grants", { bot_id: writer.bot_id });
  assert.equal(aliceGrants.grants[0].grantee.avatar, "🐳");
  const aliceRemote = await A("list_remote_bots");
  assert.equal(aliceRemote.bots.find((x: any) => x.handle === coder.handle).avatar, "🐳");
  // an unrelated owner sees none of it
  assert.deepEqual((await C("list_remote_bots")).bots, []);
  assert.throws(() => s.platform.profile({ kind: "owner", ownerId: c.owner_id } as any, writer.bot_id), /no such bot/);

  assert.ok(a.owner_id);
});

test("friend request from a stranger exposes no look until the friendship is active", async (t) => {
  const { s, a, b, B, writer, coder } = await flybotHomes(t);
  await B("update_bot_profile", { bot_id: coder.bot_id, avatar: "skull" });
  // Bob sends a REST friend request to Alice's writer (owner login needed for REST; use platform directly)
  const bobOwner = { kind: "owner", ownerId: b.owner_id } as any;
  const aliceOwner = { kind: "owner", ownerId: a.owner_id } as any;
  s.platform.requestRelationship(bobOwner, { from_bot_id: coder.bot_id, target_handle: writer.handle });
  const pending = (s.platform.listRelationships(aliceOwner) as any[]).find((r) => r.status === "pending_target");
  assert.ok(pending);
  assert.equal("avatar" in pending.peer, false);
  const overview = s.platform.friendsOverview(aliceOwner, writer.bot_id) as any;
  assert.equal("avatar" in overview.pending_incoming[0].peer, false);
  const events = s.platform.listEvents({ kind: "bot", botId: writer.bot_id, ownerId: a.owner_id } as any, 0) as any;
  assert.ok(events.events.length >= 1);
  assert.ok(!JSON.stringify(events).includes("skull"));
});

test("face rooms: members of the room see each other's look; events and non-members do not", async (t) => {
  const { s, a, b, c, A, B, writer, coder } = await flybotHomes(t);
  await A("update_bot_profile", { bot_id: writer.bot_id, avatar: "star", color: "#ff8800" });
  await B("update_bot_profile", { bot_id: coder.bot_id, avatar: "🐳", color: "#3366ff" });
  const ja = await req(s.base, "POST", "/v1/face-rooms/join", a.connector.token, { code: "735100", bots: [writer.bot_id] });
  assert.equal(ja.status, 200, JSON.stringify(ja.body));
  assert.equal(ja.body.members[0].avatar, "star");
  assert.equal(ja.body.members[0].color, "#ff8800");
  const jb = await req(s.base, "POST", "/v1/face-rooms/join", b.connector.token, { code: "735100", bots: [coder.bot_id] });
  assert.equal(jb.status, 200);
  const byHandle = (r: any, h: string) => r.body.members.find((m: any) => m.handle === h);
  assert.equal(byHandle(jb, writer.handle).avatar, "star", "the joiner sees the Bot that was already there");
  assert.equal(byHandle(jb, coder.handle).avatar, "🐳");
  const room = await req(s.base, "GET", `/v1/face-rooms/${ja.body.room_id}`, a.connector.token);
  assert.equal(byHandle(room, coder.handle).avatar, "🐳", "the first member now sees the joiner");
  assert.equal(byHandle(room, coder.handle).avatar_kind, "emoji");
  const mcpRoom = await A("get_face_room", { room_id: ja.body.room_id });
  assert.equal(mcpRoom.members.find((m: any) => m.handle === coder.handle).color, "#3366ff");
  const rooms = await A("list_face_rooms");
  assert.equal(rooms.rooms[0].my_bots[0].avatar, "star");
  // events stay small: no avatar inside persisted/pushed events
  for (const ev of room.body.events) assert.equal(ev.member && "avatar" in ev.member, false, JSON.stringify(ev));

  // a new avatar shows up on the next poll (no stale snapshot)
  await B("update_bot_profile", { bot_id: coder.bot_id, avatar: "robot" });
  const again = await A("get_face_room", { room_id: ja.body.room_id });
  assert.equal(again.members.find((m: any) => m.handle === coder.handle).avatar, "robot");

  // an outsider cannot read the room
  const out = await req(s.base, "GET", `/v1/face-rooms/${ja.body.room_id}`, c.connector.token);
  assert.equal(out.status, 404);
});

test("bot creation and home-member creation accept the look; invalid look is rejected", async (t) => {
  const { s, a, A } = await flybotHomes(t);
  const m = await A("add_home_member", { home: a.home.bot_id, name: "tester", display_name: "Tester", avatar: "fox", color: "#112233" });
  const list = await A("list_home_members", { home: a.home.bot_id });
  const tester = list.members.find((x: any) => x.bot_id === m.bot_id);
  assert.deepEqual([tester.avatar, tester.color], ["fox", "#112233"]);
  const re = await A("add_home_member", { home: a.home.bot_id, name: "tester", avatar: "owl" });
  assert.equal(re.reactivated, true);
  assert.equal(s.platform.bot(m.bot_id).avatar, "owl");
  assert.equal((await A("add_home_member", { home: a.home.bot_id, name: "bad", avatar: "<b>" })).error.code, "invalid_avatar");

  // POST /v1/bots with an owner login token
  const u = (await req(s.base, "POST", "/v1/owners", undefined, { username: "dave1", password: "secret-pw", display_name: "Dave" })).body;
  const login = (await req(s.base, "POST", "/v1/auth/login", undefined, { username: "dave1", password: "secret-pw" })).body;
  assert.ok(u.owner_id);
  const created = await req(s.base, "POST", "/v1/bots", login.owner_token, { handle: "dave.bot", avatar: "🚀", color: "#abcdef" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.avatar, "🚀");
  const bots = await req(s.base, "GET", "/v1/bots", login.owner_token);
  assert.deepEqual([bots.body.bots[0].avatar, bots.body.bots[0].color, bots.body.bots[0].avatar_kind], ["🚀", "#abcdef", "emoji"]);
  const bad = await req(s.base, "POST", "/v1/bots", login.owner_token, { handle: "dave2.bot", avatar: "https://x/y.png" });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, "invalid_avatar");
  const plain = await req(s.base, "POST", "/v1/bots", login.owner_token, { handle: "dave3.bot" });
  assert.equal(plain.status, 201, "old clients that send no look still work");
  assert.equal(plain.body.avatar, null);
});
