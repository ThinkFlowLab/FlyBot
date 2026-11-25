import assert from "node:assert/strict";
import { test } from "node:test";
import { joinSystemText, loadFaceRoomLimits, memberLabel, parseFaceCode, sanitizePeerName } from "../src/face-rooms.js";
import { bulkAuth, ownerWithBot, startServer } from "./helpers.js";

async function req(base: string, method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  const json = text ? JSON.parse(text) : {};
  return { status: r.status, body: json };
}
function ownerTok(o: { owner: { token: string } }) { return o.owner.token; }
async function join(base: string, owner: { owner: { token: string }; bot: { id: string } }, code: string, extra: Record<string, unknown> = {}, ip?: string) {
  return req(base, "POST", "/v1/face-rooms/join", ownerTok(owner), { code, bots: [owner.bot.id], ...extra }, ip ? { "x-forwarded-for": ip } : {});
}

test("sanitizePeerName strips @, controls and newlines, then caps length", () => {
  assert.equal(sanitizePeerName("Alice"), "Alice");
  assert.equal(sanitizePeerName("@bob.bot is here"), "bob.bot is here");
  assert.equal(sanitizePeerName("Ann\n@chief\x01\x1b"), "Annchief");
  assert.equal(sanitizePeerName("x".repeat(80)).length, 60);
  assert.equal(sanitizePeerName("   \n\t  ", "Bot"), "Bot");
  assert.equal(memberLabel("Writer", "Danyang"), "Writer · Danyang");
  assert.equal(joinSystemText("Danyang", "Writer"), "Danyang's Writer joined");
  assert.equal(joinSystemText("Danyang", "Writer").includes("published"), false);
  assert.equal(parseFaceCode("123456"), "123456");
  assert.throws(() => parseFaceCode("12345"), /6 digits/);
  assert.throws(() => parseFaceCode("abcdef"), /6 digits/);
});

test("face-room limits are configurable from env with safe fallbacks", () => {
  const d = loadFaceRoomLimits();
  assert.equal(d.maxMembers, 8);
  assert.equal(d.ttlMs, 600_000);
  assert.equal(d.invitesPerAccount, 30);
  assert.equal(d.invitesPerIp, 60);
  assert.equal(d.inviteMintWindowMs, 600_000);
  const o = loadFaceRoomLimits({ maxMembers: 3, ttlMs: 1000 });
  assert.equal(o.maxMembers, 3);
  assert.equal(o.ttlMs, 1000);
});

test("join by the same 6-digit code puts separate owners in one candidate room", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const a = await join(s.base, A, "424242");
  assert.equal(a.status, 200);
  assert.equal(a.body.status, "candidate");
  assert.equal(a.body.members.length, 1);
  assert.equal(a.body.members[0].handle, A.handle);
  assert.ok(a.body.expires_at);
  const b = await join(s.base, B, "424242");
  assert.equal(b.status, 200);
  assert.equal(b.body.room_id, a.body.room_id);
  assert.equal(b.body.members.length, 2);
  assert.ok(b.body.members.some((m: any) => m.handle === A.handle));
  assert.ok(b.body.members.some((m: any) => m.handle === B.handle));
  assert.ok(b.body.events.some((e: any) => e.type === "member.joined" && e.member.handle === B.handle));
  // Joiner sees the full member list immediately; no friendship is created.
  const friends = await A.owner.req("GET", "/v1/friends");
  assert.equal(friends.friends.length, 0);
  const rels = await A.owner.req("GET", "/v1/relationships");
  assert.equal(rels.relationships.length, 0);
});

test("one owner may bring several bots; siblings stay hidden", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "cara");
  const extra = await A.owner.req("POST", "/v1/bots", { handle: `${A.handle.replace(/^@/, "").replace(".bot", "")}-two.bot`, display_name: "Second" });
  const hidden = await A.owner.req("POST", "/v1/bots", { handle: `${A.handle.replace(/^@/, "").replace(".bot", "")}-hid.bot`, display_name: "Hidden" });
  const j = await req(s.base, "POST", "/v1/face-rooms/join", ownerTok(A), { code: "111111", bots: [A.bot.id, extra.bot_id] });
  assert.equal(j.status, 200);
  assert.equal(j.body.members.length, 2);
  assert.ok(!j.body.members.some((m: any) => m.bot_id === hidden.bot_id || m.handle.includes("hid")));
  assert.ok(j.body.members.every((m: any) => m.published === undefined));
});

test("face-room join has no published flag; system text is just who joined", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const onboard = await req(s.base, "POST", "/v1/onboard/flybot", undefined, { display_name: "Dana" });
  assert.equal(onboard.status, 201);
  const token = onboard.body.connector.token as string;
  const p = { kind: "owner" as const, ownerId: onboard.body.owner_id as string, scope: "connector" as const };
  const added = s.platform.addHomeMember(p, onboard.body.home.bot_id, { name: "writer", display_name: "Writer" });
  const j = await req(s.base, "POST", "/v1/face-rooms/join", token, { code: "222222", bots: [added.bot_id] });
  assert.equal(j.status, 200, JSON.stringify(j.body));
  assert.equal(j.body.members[0].published, undefined);
  assert.equal(j.body.events[0].text, "Dana's Writer joined");
  assert.equal(JSON.stringify(j.body).includes("published"), false);
});

test("peer-controlled names are sanitized before they are stored or shown", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "erin");
  await A.owner.req("PATCH", "/v1/me", { display_name: "Eve\n@admin\x01" });
  s.platform.updateBotProfile({ kind: "owner", ownerId: A.owner_id }, A.bot.id, { display_name: "Bot @chief\nline" });
  const j = await join(s.base, A, "333333");
  assert.equal(j.status, 200);
  const m = j.body.members[0];
  assert.equal(m.display_name.includes("@"), false);
  assert.equal(m.display_name.includes("\n"), false);
  assert.equal(m.owner_name.includes("@"), false);
  assert.equal(m.owner_name.includes("\n"), false);
  assert.equal(j.body.events[0].text.includes("@"), false);
});

test("cap of 8 is enforced and no second room is opened (including concurrent joins)", async (t) => {
  const s = await startServer({ ...bulkAuth, faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200, createsPerIp: 50, createsPerAccount: 20 } });
  t.after(s.stop);
  const owners = [];
  for (let i = 0; i < 10; i++) owners.push(await ownerWithBot(s.base, `cap${i}`));
  const results = await Promise.all(owners.map((o) => join(s.base, o, "888888")));
  const ok = results.filter((r) => r.status === 200);
  const full = results.filter((r) => r.status === 409 && r.body.error?.code === "room_full");
  assert.equal(ok.length, 8, `ok=${ok.length} full=${full.length} other=${results.filter((r) => r.status !== 200 && r.body.error?.code !== "room_full").map((r) => r.body.error).length}`);
  assert.equal(full.length, 2);
  const roomIds = new Set(ok.map((r) => r.body.room_id));
  assert.equal(roomIds.size, 1);
  const roomId = [...roomIds][0];
  const view = await req(s.base, "GET", `/v1/face-rooms/${roomId}`, ownerTok(owners[ok.findIndex((r) => r.status === 200)]));
  assert.equal(view.body.members.length, 8);
  // A 11th attempt still cannot open a second room for this number.
  const extra = await ownerWithBot(s.base, "late");
  const late = await join(s.base, extra, "888888");
  assert.equal(late.status, 409);
  assert.equal(late.body.error.code, "room_full");
  assert.equal(late.body.members, undefined);
});

test("start voids the number; later joiners do not enter that room", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "fay");
  const B = await ownerWithBot(s.base, "gus");
  const C = await ownerWithBot(s.base, "hal");
  const a = await join(s.base, A, "555555");
  await join(s.base, B, "555555");
  const started = await req(s.base, "POST", `/v1/face-rooms/${a.body.room_id}/start`, ownerTok(A));
  assert.equal(started.status, 200);
  assert.equal(started.body.status, "open");
  assert.ok(started.body.events.some((e: any) => e.type === "room.started"));
  const c = await join(s.base, C, "555555");
  assert.equal(c.status, 200);
  assert.notEqual(c.body.room_id, a.body.room_id, "voided number must not add anyone to the started room");
  const old = await req(s.base, "GET", `/v1/face-rooms/${a.body.room_id}`, ownerTok(A));
  assert.equal(old.body.members.length, 2);
  assert.ok(!old.body.members.some((m: any) => m.handle === C.handle));
});

test("candidate room becomes a normal group when the matching window expires", async (t) => {
  let now = Date.now();
  const s = await startServer({ now: () => now, faceRooms: { ttlMs: 60_000 } });
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ivy");
  const B = await ownerWithBot(s.base, "jay");
  const a = await join(s.base, A, "666666");
  assert.equal(a.body.status, "candidate");
  now += 61_000;
  const view = await req(s.base, "GET", `/v1/face-rooms/${a.body.room_id}`, ownerTok(A));
  assert.equal(view.body.status, "open");
  assert.ok(view.body.events.some((e: any) => e.type === "room.started" && e.reason === "expired"));
  const b = await join(s.base, B, "666666");
  assert.notEqual(b.body.room_id, a.body.room_id);
});

test("new members only see events from their join point", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "kim");
  const B = await ownerWithBot(s.base, "leo");
  const a = await join(s.base, A, "777777");
  await A.owner.req("PATCH", "/v1/me", { auto_approve_face_rooms: true });
  const sent = await req(s.base, "POST", `/v1/face-rooms/${a.body.room_id}/messages`, ownerTok(A), { text: "secret before B joined", bot_id: A.bot.id });
  assert.equal(sent.status, 202);
  assert.equal(sent.body.status, "delivered");
  const b = await join(s.base, B, "777777");
  assert.ok(!JSON.stringify(b.body.events).includes("secret before B joined"));
  assert.ok(b.body.events.every((e: any) => e.type !== "room.message"));
  const again = await req(s.base, "GET", `/v1/face-rooms/${a.body.room_id}`, ownerTok(B));
  assert.ok(!JSON.stringify(again.body.events).includes("secret before B joined"));
});

test("leave removes the member and posts a system event; leavers cannot read or post", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "mia");
  const B = await ownerWithBot(s.base, "ned");
  const a = await join(s.base, A, "101010");
  await join(s.base, B, "101010");
  const left = await req(s.base, "POST", `/v1/face-rooms/${a.body.room_id}/leave`, ownerTok(A), {});
  assert.equal(left.status, 200);
  assert.deepEqual(left.body.left, [A.handle]);
  const b = await req(s.base, "GET", `/v1/face-rooms/${a.body.room_id}`, ownerTok(B));
  assert.equal(b.body.members.length, 1);
  assert.ok(b.body.events.some((e: any) => e.type === "member.left" && e.member.handle === A.handle));
  const gone = await req(s.base, "GET", `/v1/face-rooms/${a.body.room_id}`, ownerTok(A));
  assert.equal(gone.status, 404);
  assert.equal(gone.body.error.code, "face_room_not_found");
  const post = await req(s.base, "POST", `/v1/face-rooms/${a.body.room_id}/messages`, ownerTok(A), { text: "still here?" });
  assert.equal(post.status, 404);
});

test("outbound room messages follow approval rules (held when auto-approve is off)", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ola");
  const B = await ownerWithBot(s.base, "pat");
  const a = await join(s.base, A, "121212");
  await join(s.base, B, "121212");
  const draft = await req(s.base, "POST", `/v1/face-rooms/${a.body.room_id}/messages`, ownerTok(A), { text: "hello room", bot_id: A.bot.id });
  assert.equal(draft.status, 202);
  assert.equal(draft.body.status, "pending_approval");
  assert.match(draft.body.approval_id, /^apr_/);
  const bBefore = await req(s.base, "GET", `/v1/face-rooms/${a.body.room_id}`, ownerTok(B));
  assert.ok(!bBefore.body.events.some((e: any) => e.type === "room.message"));
  const { approvals } = await A.owner.req("GET", "/v1/approvals?status=pending");
  const card = approvals.find((x: any) => x.kind === "face_room_message");
  assert.ok(card);
  assert.equal(card.face_room.room_id, a.body.room_id);
  await A.owner.req("POST", `/v1/approvals/${card.approval_id}/decision`, { decision: "approved" });
  const bAfter = await req(s.base, "GET", `/v1/face-rooms/${a.body.room_id}`, ownerTok(B));
  const msg = bAfter.body.events.find((e: any) => e.type === "room.message");
  assert.ok(msg);
  assert.equal(msg.untrusted_content.text, "hello room");
  assert.equal(msg.trust, "peer_untrusted");
  // Rejected drafts stay invisible.
  const held = await req(s.base, "POST", `/v1/face-rooms/${a.body.room_id}/messages`, ownerTok(A), { text: "nope", bot_id: A.bot.id });
  const { approvals: pending } = await A.owner.req("GET", "/v1/approvals?status=pending");
  const card2 = pending.find((x: any) => x.approval_id === held.body.approval_id);
  await A.owner.req("POST", `/v1/approvals/${card2.approval_id}/decision`, { decision: "rejected" });
  const bRej = await req(s.base, "GET", `/v1/face-rooms/${a.body.room_id}`, ownerTok(B));
  assert.ok(!JSON.stringify(bRej.body.events).includes("nope"));
  // Auto-approve delivers immediately when the owner turns it on.
  await A.owner.req("PATCH", "/v1/me", { auto_approve_face_rooms: true });
  const auto = await req(s.base, "POST", `/v1/face-rooms/${a.body.room_id}/messages`, ownerTok(A), { text: "auto ok", bot_id: A.bot.id });
  assert.equal(auto.body.status, "delivered");
  assert.equal(auto.body.auto_approved, true);
  const bAuto = await req(s.base, "GET", `/v1/face-rooms/${a.body.room_id}`, ownerTok(B));
  assert.ok(bAuto.body.events.some((e: any) => e.type === "room.message" && e.untrusted_content?.text === "auto ok"));
});

test("rate limits and lockout after failed attempts; contents are never revealed on failure", async (t) => {
  const s = await startServer({
    faceRooms: {
      attemptsPerAccount: 6, attemptsPerIp: 40, attemptWindowMs: 600_000,
      failsBeforeLockout: 3, lockoutMs: 60_000,
      createsPerAccount: 2, createsPerIp: 20, createWindowMs: 3_600_000,
    },
  });
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "quin");
  const aIp = "203.0.113.10";
  const bad1 = await join(s.base, A, "12", {}, aIp);
  assert.equal(bad1.status, 400);
  assert.equal(bad1.body.error.code, "invalid_code");
  assert.equal(bad1.body.members, undefined);
  const bad2 = await join(s.base, A, "abcdef", {}, aIp);
  assert.equal(bad2.status, 400);
  const bad3 = await join(s.base, A, "99", {}, aIp);
  assert.equal(bad3.status, 400);
  const locked = await join(s.base, A, "123456", {}, aIp);
  assert.equal(locked.status, 429);
  assert.equal(locked.body.error.code, "locked_out");
  assert.equal(locked.body.members, undefined);
  const B = await ownerWithBot(s.base, "ray");
  const ok = await join(s.base, B, "123456", {}, "203.0.113.20");
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  // Room-creation cap: two rooms already? B created one. Make B create another, then a third fails.
  const c2 = await join(s.base, B, "123457", {}, "203.0.113.20");
  assert.equal(c2.status, 200);
  const c3 = await join(s.base, B, "123458", {}, "203.0.113.20");
  assert.equal(c3.status, 429);
  assert.equal(c3.body.error.code, "rate_limited");
  assert.match(c3.body.error.scope, /create/);
});

test("audit log records join, leave, start and lockout", async (t) => {
  const s = await startServer({ faceRooms: { failsBeforeLockout: 2, attemptsPerAccount: 20 } });
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "sam");
  const B = await ownerWithBot(s.base, "tess");
  const a = await join(s.base, A, "141414", {}, "198.51.100.10");
  await join(s.base, B, "141414", {}, "198.51.100.11");
  await req(s.base, "POST", `/v1/face-rooms/${a.body.room_id}/start`, ownerTok(A));
  await req(s.base, "POST", `/v1/face-rooms/${a.body.room_id}/leave`, ownerTok(B), {});
  await join(s.base, A, "12", {}, "198.51.100.10");
  await join(s.base, A, "34", {}, "198.51.100.10");
  const audit = s.platform.auditEvents({ kind: "owner", ownerId: A.owner_id }, { limit: 500 });
  const actions = audit.events.map((e: any) => e.action);
  assert.ok(actions.includes("face_room.lockout"), actions.join(","));
  assert.ok(actions.includes("face_room.created"));
  assert.ok(actions.includes("face_room.started"));
  const bAudit = s.platform.auditEvents({ kind: "owner", ownerId: B.owner_id }, { limit: 500 });
  assert.ok(bAudit.events.some((e: any) => e.action === "face_room.joined"));
  assert.ok(bAudit.events.some((e: any) => e.action === "face_room.left"));
  assert.equal(audit.chain.ok, true);
});

test("non-members cannot read or post; connector tokens work on the REST face-room routes", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const fly = await req(s.base, "POST", "/v1/onboard/flybot", undefined, { display_name: "Uma" });
  const token = fly.body.connector.token as string;
  const member = s.platform.addHomeMember({ kind: "owner", ownerId: fly.body.owner_id, scope: "connector" }, fly.body.home.bot_id, { name: "chief", display_name: "Chief" });
  const j = await req(s.base, "POST", "/v1/face-rooms/join", token, { code: "161616", bots: [member.bot_id] });
  assert.equal(j.status, 200, JSON.stringify(j.body));
  const stranger = await ownerWithBot(s.base, "vic");
  const peek = await req(s.base, "GET", `/v1/face-rooms/${j.body.room_id}`, ownerTok(stranger));
  assert.equal(peek.status, 404);
  const shout = await req(s.base, "POST", `/v1/face-rooms/${j.body.room_id}/messages`, ownerTok(stranger), { text: "hi" });
  assert.equal(shout.status, 404);
  const listed = await req(s.base, "GET", "/v1/face-rooms", token);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.rooms.length, 1);
});

test("MCP tools join, poll, start, leave and hold room messages", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const flyA = await req(s.base, "POST", "/v1/onboard/flybot", undefined, { display_name: "Wes" });
  const flyB = await req(s.base, "POST", "/v1/onboard/flybot", undefined, { display_name: "Xan" });
  const mcp = async (token: string, name: string, args: unknown = {}) => {
    const r = await fetch(s.base + "/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(10_000),
    });
    const j: any = await r.json();
    if (j.result?.isError) return { error: JSON.parse(j.result.content[0].text) };
    return JSON.parse(j.result.content[0].text);
  };
  const aMem = s.platform.addHomeMember({ kind: "owner", ownerId: flyA.body.owner_id, scope: "connector" }, flyA.body.home.bot_id, { name: "w", display_name: "W" });
  const bMem = s.platform.addHomeMember({ kind: "owner", ownerId: flyB.body.owner_id, scope: "connector" }, flyB.body.home.bot_id, { name: "x", display_name: "X" });
  const joined = await mcp(flyA.body.connector.token, "join_face_room", { code: "171717", bots: [aMem.bot_id] });
  assert.equal(joined.status, "candidate");
  const b = await mcp(flyB.body.connector.token, "join_face_room", { code: "171717", bots: [bMem.bot_id] });
  assert.equal(b.room_id, joined.room_id);
  const draft = await mcp(flyA.body.connector.token, "send_face_room_message", { room_id: joined.room_id, text: "via mcp", bot_id: aMem.bot_id });
  assert.equal(draft.status, "pending_approval");
  const got = await mcp(flyB.body.connector.token, "get_face_room", { room_id: joined.room_id });
  assert.ok(!got.events.some((e: any) => e.type === "room.message"));
  await mcp(flyA.body.connector.token, "start_face_room", { room_id: joined.room_id });
  const left = await mcp(flyB.body.connector.token, "leave_face_room", { room_id: joined.room_id });
  assert.ok(left.left || left.status);
});
