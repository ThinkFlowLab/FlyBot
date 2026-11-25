import assert from "node:assert/strict";
import { test } from "node:test";
import { startServer } from "./helpers.js";
import { mcp, post, req } from "./flybot_helpers.js";

const CAPS = { auto_accept: true, offered_capabilities: ["chat.public"], requested_capabilities: ["chat.public"] };

/** Two FlyBot homes (A: Danyang, B: Bob), friends, one member each. */
async function pair(t: any) {
  const s = await startServer();
  t.after(s.stop);
  const a = (await post(s.base, "/v1/onboard/flybot", { display_name: "Danyang" })).body;
  const b = (await post(s.base, "/v1/onboard/flybot", { display_name: "Bob" })).body;
  const A = (name: string, args: unknown = {}) => mcp(s.base, a.connector.token, name, args);
  const B = (name: string, args: unknown = {}) => mcp(s.base, b.connector.token, name, args);
  const chief = await A("add_home_member", { home: a.home.bot_id, name: "chief", display_name: "Chief" });
  const coder = await B("add_home_member", { home: b.home.bot_id, name: "coder", display_name: "Coder" });
  const inv = await A("create_invite", { bot_id: chief.bot_id, ...CAPS });
  await B("join_invite", { code: inv.code ?? inv.invite?.code, from_bot_id: coder.bot_id });
  // Joining only lets Chief answer Coder (#23); Bob shares Coder with Chief too, so either side may start.
  const back = await B("create_invite", { bot_id: coder.bot_id, ...CAPS });
  await A("join_invite", { code: back.code, from_bot_id: chief.bot_id });
  const approve = (ownerId: string, aprId: string, extra: any = {}) => s.platform.decideApproval({ kind: "owner", ownerId }, aprId, { decision: "approved", ...extra });
  return { s, a, b, A, B, chief, coder, approve };
}

const received = async (B: any, coder: any) => (await B("list_inbox", { bot_id: coder.bot_id, peek: true })).events.filter((e: any) => e.event_type === "message.received");

test("direct chat: mentions are validated, kept to the conversation ends, delivered, countersigned; absent when not sent", async (t) => {
  const { s, a, A, B, chief, coder, approve } = await pair(t);
  const plain = await A("send_as_member", { from_bot_id: chief.bot_id, to: coder.handle, text: "no mention" });
  assert.equal(plain.message.mentions, undefined);
  await approve(a.owner_id, plain.message.approval_id);
  // upper case, missing @, duplicates, and a stranger: normalised, de-duplicated, stranger dropped
  const sent = await A("send_as_member", {
    from_bot_id: chief.bot_id, to: coder.handle, text: "Coder, please look", typed_by_owner: true,
    mentions: [coder.handle.toUpperCase(), coder.handle.replace(/^@/, ""), "@someone.else"],
  });
  assert.deepEqual(sent.message.mentions, [coder.handle.toLowerCase()]);
  assert.equal(sent.message.status, "delivered", "an owner-typed line goes out without a card");
  const ev = await received(B, coder);
  assert.equal(ev.length, 2);
  assert.equal("mentions" in ev[0], false);
  assert.deepEqual(ev[1].mentions, [coder.handle.toLowerCase()]);
  assert.equal(ev[1].typed_by_owner, true);
  assert.doesNotMatch(ev[1].untrusted_content, /mentions/);
  const conv = await B("get_conversation", { conversation_id: sent.conversation_id });
  const inbound = conv.messages.filter((m: any) => m.direction === "inbound");
  assert.equal(inbound[0].mentions, undefined);
  assert.deepEqual(inbound[1].mentions, [coder.handle.toLowerCase()]);
  const mine = await A("get_conversation", { conversation_id: sent.conversation_id });
  assert.deepEqual(mine.messages.find((m: any) => m.message_id === sent.message.message_id).mentions, [coder.handle.toLowerCase()]);
  // the platform countersignature covers it
  const row: any = s.platform.db.prepare("SELECT data FROM events WHERE type = 'message.received' ORDER BY seq DESC LIMIT 1").get();
  const d = JSON.parse(row.data);
  assert.deepEqual(d.mentions, [coder.handle.toLowerCase()]);
  assert.equal(s.platform.verifyCountersig(d), true);
  assert.equal(s.platform.verifyCountersig({ ...d, mentions: ["@chief.other"] }), false);
  const { mentions, ...rest } = d;
  void mentions;
  assert.equal(s.platform.verifyCountersig(rest), false);
});

test("mentions validation: wrong shapes are a 400 on MCP and REST; null and [] mean none", async (t) => {
  const { s, a, A, chief, coder } = await pair(t);
  const base = { from_bot_id: chief.bot_id, to: coder.handle, text: "x" };
  for (const bad of ["@coder", { h: 1 }, [1], [""], ["has space"], ["@a"], ["x".repeat(41)], Array.from({ length: 9 }, (_, i) => `@bot${i}.x`)]) {
    const r = await mcp(s.base, a.connector.token, "send_as_member", { ...base, mentions: bad });
    assert.ok(r.error, JSON.stringify(bad));
  }
  const login = await post(s.base, "/v1/auth/login", { username: a.username, password: a.generated_password });
  const restBad = await post(s.base, `/v1/homes/${a.home.bot_id}/send`, { ...base, mentions: "@coder" }, login.body.owner_token);
  assert.equal(restBad.status, 400);
  assert.equal(restBad.body.error.code, "invalid_request");
  const restBadItem = await post(s.base, `/v1/homes/${a.home.bot_id}/send`, { ...base, mentions: ["@ok.handle", "not a handle!"] }, login.body.owner_token);
  assert.equal(restBadItem.status, 400);
  for (const none of [null, []]) {
    const r = await A("send_as_member", { ...base, text: `none ${JSON.stringify(none)}: a fresh line each time`, mentions: none as any });
    assert.equal(r.message.mentions, undefined);
  }
  const restOk = await post(s.base, `/v1/homes/${a.home.bot_id}/send`, { ...base, text: "a different line over REST", mentions: [coder.handle] }, login.body.owner_token);
  assert.equal(restOk.status, 202);
  assert.deepEqual(restOk.body.message.mentions, [coder.handle.toLowerCase()]);
});

test("an owner edit at approval drops the mention list everywhere: delivery, stored copy, both conversation views", async (t) => {
  const { a, A, B, chief, coder, approve } = await pair(t);
  const sent = await A("send_as_member", { from_bot_id: chief.bot_id, to: coder.handle, text: "original", mentions: [coder.handle] });
  await approve(a.owner_id, sent.message.approval_id, { decision: "approved_with_edits", edited_payload: { text: "rewritten", mentions: ["@coder.evil"] } });
  const ev = await received(B, coder);
  assert.equal(ev.length, 1);
  assert.match(ev[0].untrusted_content, /rewritten/);
  assert.equal("mentions" in ev[0], false);
  for (const view of [await B("get_conversation", { conversation_id: sent.conversation_id }), await A("get_conversation", { conversation_id: sent.conversation_id })]) {
    assert.equal(view.messages.length, 1);
    assert.equal("mentions" in view.messages[0], false, "the stored list is gone, so no view shows it");
  }
});

test("the approval card shows the mentions the owner is approving (direct message and face room)", async (t) => {
  const { a, A, B, chief, coder } = await pair(t);
  const dm = await A("send_as_member", { from_bot_id: chief.bot_id, to: coder.handle, text: "card check", mentions: [coder.handle] });
  const room = await A("join_face_room", { code: "717171", bots: [chief.bot_id] });
  await B("join_face_room", { code: "717171", bots: [coder.bot_id] });
  await A("start_face_room", { room_id: room.room_id });
  const fr = await A("send_face_room_message", { room_id: room.room_id, text: "room card", bot_id: chief.bot_id, mentions: [coder.handle] });
  const plain = await A("send_as_member", { from_bot_id: chief.bot_id, to: coder.handle, text: "no list on this one" });
  const cards = (await A("list_approvals", {})).approvals ?? [];
  const byId = (id: string) => cards.find((c: any) => c.approval_id === id);
  assert.deepEqual(byId(dm.message.approval_id).message.mentions, [coder.handle.toLowerCase()]);
  assert.deepEqual(byId(fr.approval_id).face_room.mentions, [coder.handle.toLowerCase()]);
  assert.equal("mentions" in byId(plain.message.approval_id).message, false);
  void a;
});

test("face room: mentions are kept to current members and reach room events, member pushes and get_face_room", async (t) => {
  const { s, a, b, A, B, chief, coder, approve } = await pair(t);
  const room = await A("join_face_room", { code: "515151", bots: [chief.bot_id] });
  await B("join_face_room", { code: "515151", bots: [coder.bot_id] });
  await A("start_face_room", { room_id: room.room_id });
  const plain = await A("send_face_room_message", { room_id: room.room_id, text: "plain line", bot_id: chief.bot_id });
  assert.equal(plain.mentions, undefined);
  await approve(a.owner_id, plain.approval_id);
  const sent = await A("send_face_room_message", {
    room_id: room.room_id, text: "Coder, you first", bot_id: chief.bot_id, typed_by_owner: true,
    mentions: [coder.handle.toUpperCase(), "@not.in.room"],
  });
  assert.deepEqual(sent.mentions, [coder.handle.toLowerCase()]);
  assert.equal(sent.typed_by_owner, true);
  await approve(a.owner_id, sent.approval_id);
  const view = await B("get_face_room", { room_id: room.room_id });
  const msgs = view.events.filter((e: any) => e.type === "room.message");
  assert.equal(msgs.length, 2);
  assert.equal("mentions" in msgs[0], false);
  assert.deepEqual(msgs[1].mentions, [coder.handle.toLowerCase()]);
  assert.equal(msgs[1].typed_by_owner, true);
  assert.doesNotMatch(JSON.stringify(msgs[1].untrusted_content), /mentions/);
  const pushed = (await B("list_inbox", { bot_id: coder.bot_id, peek: true })).events.filter((e: any) => e.event_type === "face_room.message");
  assert.equal(pushed.length, 2);
  assert.equal("mentions" in pushed[0], false);
  assert.deepEqual(pushed[1].mentions, [coder.handle.toLowerCase()]);
  // REST + malformed + edit
  const login = await post(s.base, "/v1/auth/login", { username: a.username, password: a.generated_password });
  const badRest = await post(s.base, `/v1/face-rooms/${room.room_id}/messages`, { text: "x", mentions: "coder" }, login.body.owner_token);
  assert.equal(badRest.status, 400);
  const edited = await A("send_face_room_message", { room_id: room.room_id, text: "orig", bot_id: chief.bot_id, mentions: [coder.handle] });
  await approve(a.owner_id, edited.approval_id, { decision: "approved_with_edits", edited_payload: { text: "changed" } });
  const after = (await B("get_face_room", { room_id: room.room_id })).events.filter((e: any) => e.type === "room.message");
  assert.equal(after.length, 3);
  assert.equal("mentions" in after[2], false);
  void b;
});

test("face room: a mentioned Bot that leaves while the line waits is dropped at delivery, from the card, the events and the stored copy", async (t) => {
  const { s, a, A, B, chief, coder, approve } = await pair(t);
  const room = await A("join_face_room", { code: "818181", bots: [chief.bot_id] });
  await B("join_face_room", { code: "818181", bots: [coder.bot_id] });
  await A("start_face_room", { room_id: room.room_id });
  const sent = await A("send_face_room_message", { room_id: room.room_id, text: "Coder and Chief", bot_id: chief.bot_id, mentions: [coder.handle, chief.handle] });
  assert.deepEqual(sent.mentions, [coder.handle.toLowerCase(), chief.handle.toLowerCase()]);
  await B("leave_face_room", { room_id: room.room_id });
  const card = ((await A("list_approvals", {})).approvals ?? []).find((c: any) => c.approval_id === sent.approval_id);
  assert.deepEqual(card.face_room.mentions, [chief.handle.toLowerCase()], "the card shows who is still in the room");
  await approve(a.owner_id, sent.approval_id);
  const msg = (await A("get_face_room", { room_id: room.room_id })).events.filter((e: any) => e.type === "room.message");
  assert.equal(msg.length, 1);
  assert.deepEqual(msg[0].mentions, [chief.handle.toLowerCase()]);
  const pushed = (await A("list_inbox", { bot_id: chief.bot_id, peek: true })).events.filter((e: any) => e.event_type === "face_room.message");
  assert.ok(pushed.every((e: any) => !(e.mentions ?? []).includes(coder.handle.toLowerCase())));
  const stored: any = s.platform.db.prepare("SELECT mentions FROM face_room_drafts WHERE id = ?").get(sent.message_id);
  assert.deepEqual(JSON.parse(stored.mentions), [chief.handle.toLowerCase()]);
});

test("face room: an owner edit clears the stored list too", async (t) => {
  const { s, a, A, B, chief, coder, approve } = await pair(t);
  const room = await A("join_face_room", { code: "919191", bots: [chief.bot_id] });
  await B("join_face_room", { code: "919191", bots: [coder.bot_id] });
  await A("start_face_room", { room_id: room.room_id });
  const sent = await A("send_face_room_message", { room_id: room.room_id, text: "orig", bot_id: chief.bot_id, mentions: [coder.handle] });
  await approve(a.owner_id, sent.approval_id, { decision: "approved_with_edits", edited_payload: { text: "changed" } });
  const stored: any = s.platform.db.prepare("SELECT mentions FROM face_room_drafts WHERE id = ?").get(sent.message_id);
  assert.equal(stored.mentions, null);
});

test("a Bot's own token can send a mention list in a face room (not attested: the host decides what to trust)", async (t) => {
  const { s, a, B, chief, coder, approve, A } = await pair(t);
  const room = await A("join_face_room", { code: "616161", bots: [chief.bot_id] });
  await B("join_face_room", { code: "616161", bots: [coder.bot_id] });
  await A("start_face_room", { room_id: room.room_id });
  const botTok = s.platform.rotateBotToken({ kind: "owner", ownerId: a.owner_id }, chief.bot_id).bot_token;
  const r = await post(s.base, `/v1/face-rooms/${room.room_id}/messages`, { text: "hey", mentions: [coder.handle] }, botTok);
  assert.equal(r.status, 202);
  await approve(a.owner_id, r.body.approval_id);
  const m = (await B("get_face_room", { room_id: room.room_id })).events.filter((e: any) => e.type === "room.message")[0];
  assert.deepEqual(m.mentions, [coder.handle.toLowerCase()]);
  assert.equal(m.typed_by_owner, undefined);
});

test("platform info advertises the mentions feature next to typed_by_owner", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const info = (await req(s.base, "GET", "/v1/platform")).body;
  assert.ok(info.features.includes("mentions"));
  assert.ok(info.features.includes("typed_by_owner"));
});

test("migration: a database from before the field gains the columns and old rows read as no mentions", async (t) => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { Platform } = await import("../src/platform.js");
  const dir = mkdtempSync(join(tmpdir(), "bs-mig-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const opts = { dbPath: join(dir, "x.db"), auditPath: join(dir, "audit.log"), kmsKey: Buffer.alloc(32, 7) };
  const p1 = new Platform(opts);
  p1.onboardFlybot({ display_name: "Old" });
  p1.db.exec("ALTER TABLE messages DROP COLUMN mentions; ALTER TABLE face_room_drafts DROP COLUMN mentions;");
  p1.close();
  const p2 = new Platform(opts);
  t.after(() => p2.close());
  assert.ok(p2.db.prepare("SELECT mentions FROM messages LIMIT 1").all() !== undefined);
  assert.ok(p2.db.prepare("SELECT mentions FROM face_room_drafts LIMIT 1").all() !== undefined);
});
