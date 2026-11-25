import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { markJoinGrantsReplyOnly, openDb } from "../src/db.js";
import { approveAll, expectApiError, friends, ownerWithBot, startServer } from "./helpers.js";
import { CAPS, flybotHomes, req } from "./flybot_helpers.js";

/** #23: Alice invites to her Bot; Bob joins with his Bot X. Alice shared her Bot; Bob shared nothing. */
async function joined(t: any) {
  const S = await startServer();
  t.after(S.stop);
  const A = await ownerWithBot(S.base, "inviter");
  const B = await ownerWithBot(S.base, "joiner");
  const inv = await A.owner.req("POST", "/v1/invites", { bot_id: A.bot.id, offered_capabilities: ["chat.public"] });
  const j = await B.owner.req("POST", `/v1/invites/${inv.code}/join`, { from_bot_id: B.bot.id });
  assert.equal(j.status, "active");
  return { S, A, B, relId: j.relationship_id as string };
}
const shareRequests = async (bot: any) => (await bot.events()).events.filter((e: any) => e.event_type === "share.requested");
const convCount = (S: any) => (S.platform.db.prepare("SELECT COUNT(*) n FROM conversations").get() as any).n;

test("the inviter's Bot cannot start a conversation with an unshared joiner Bot: 403 bot_not_shared, nothing stored, owner told", async (t) => {
  const { S, A, B, relId } = await joined(t);
  const e = await expectApiError(A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "hello" }), 403, "bot_not_shared");
  assert.equal(e.body.error.suggestion, "ask_owner_to_share");
  assert.equal(e.body.error.bot_id, B.bot.id);
  assert.equal(e.body.error.relationship_id, relId);
  assert.equal(e.body.error.owner_notified, true);
  assert.ok((await (await fetch(`${S.base}/v1/platform`)).json()).features.includes("reply_only_grants"), "discoverable");
  assert.match(e.body.error.message, /not shared with your Bot/);
  assert.equal(convCount(S), 0, "no conversation is stored");
  assert.equal((S.platform.db.prepare("SELECT COUNT(*) n FROM messages").get() as any).n, 0, "nothing is stored as delivered");

  const [ev, ...more] = await shareRequests(B.bot);
  assert.equal(more.length, 0);
  assert.equal(ev.trust, "platform");
  assert.equal(ev.bot_id, B.bot.id);
  assert.equal(ev.relationship_id, relId);
  assert.equal(ev.attempted, "conversation.create");
  assert.equal(ev.from.bot_id, A.bot.id);
  assert.equal(ev.from.handle, A.handle);
  assert.match(ev.note, /nothing is shared automatically/);
  assert.equal(ev.untrusted_content, undefined, "no peer content reaches the unshared Bot");
  assert.equal((await shareRequests(A.bot)).length, 0, "the sender learns it from the 403, not from an event");

  // Retrying is refused again but does not flood the owner (one notice per sender per day).
  await expectApiError(A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "again" }), 403, "bot_not_shared");
  assert.equal((await shareRequests(B.bot)).length, 1);
  // Nothing was granted: still refused, and the decision is audited as a deny.
  const audit = S.platform.auditEvents({ kind: "owner", ownerId: A.owner_id } as any, { limit: 200 }).events as any[];
  assert.ok(audit.some((x) => x.action === "policy.decision" && x.data?.decision === "deny" && x.data?.reasons?.includes("grant.reply_only:chat.public")), "the deny is audited");
});

test("the inviter's Bot can still reply in a conversation the joiner's Bot started", async (t) => {
  const { S, A, B } = await joined(t);
  const c = await B.bot.startConversation(A.bot.id, { type: "general_chat", summary: "hi from X" });
  const m1 = await B.bot.draftMessage(c.conversation_id, { text: "hello, can we talk?" });
  assert.equal(m1.status, "pending_approval");
  await approveAll(B.owner);
  const reply = await A.bot.draftMessage(c.conversation_id, { text: "sure, happy to" });
  assert.equal(reply.status, "pending_approval");
  await approveAll(A.owner);
  const got = (await B.bot.events()).events.filter((e: any) => e.event_type === "message.received");
  assert.equal(got.length, 1);
  assert.equal(got[0].untrusted_content.text, "sure, happy to");
  assert.equal((await shareRequests(B.bot)).length, 0);
  assert.equal(convCount(S), 1);
});

test("a reply-only grant cannot open with a first message in a conversation the inviter's Bot started", async (t) => {
  const { S, A, B, relId } = await joined(t);
  // A conversation started by the inviter's Bot before this rule (legacy data): its first message is refused too.
  const now = new Date().toISOString();
  S.platform.db.prepare("INSERT INTO conversations (id, type, relationship_id, initiator_bot, peer_bot, intent, status, max_turns, created_at, updated_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run("cnv_legacy", "direct", relId, A.bot.id, B.bot.id, JSON.stringify({ type: "general_chat", summary: "old" }), "open", 20, now, now, new Date(Date.now() + 3600e3).toISOString());
  const e = await expectApiError(A.bot.draftMessage("cnv_legacy", { text: "hi" }), 403, "bot_not_shared");
  assert.equal(e.body.error.bot_id, B.bot.id);
  assert.equal((S.platform.db.prepare("SELECT COUNT(*) n FROM messages").get() as any).n, 0);
  assert.equal((await shareRequests(B.bot))[0].attempted, "message.draft");
  // Once X has written in it, the inviter's Bot may answer there.
  await B.bot.draftMessage("cnv_legacy", { text: "oh hi" });
  await approveAll(B.owner);
  assert.equal((await A.bot.draftMessage("cnv_legacy", { text: "hi again" })).status, "pending_approval");
});

test("normal flows are unchanged: the joiner may start, and friend requests are not reply-only", async (t) => {
  const { A, B } = await joined(t);
  const c = await B.bot.startConversation(A.bot.id, { type: "general_chat", summary: "hi" });
  assert.equal(c.status, "open");
  // Friend request (no invite): both sides may start, as before.
  const S2 = await startServer();
  t.after(S2.stop);
  const f = await friends(S2.base);
  assert.equal((await f.A.bot.startConversation(f.B.bot.id, { type: "general_chat", summary: "a" })).status, "open");
  assert.equal((await f.B.bot.startConversation(f.A.bot.id, { type: "general_chat", summary: "b" })).status, "open");
  // Grants from a friend request are full (reply_only false in the relationship view).
  const rel = (await f.B.owner.req("GET", "/v1/relationships")).relationships[0];
  for (const g of rel.capabilities.me_on_peer) assert.equal(g.reply_only, false);
});

test("explicit sharing lifts the limit: a fresh invite for X, or an approved grant request", async (t) => {
  const { A, B, relId } = await joined(t);
  // B's owner shares X with A's Bot through an invite for X; A's owner joins it with the same Bot.
  const inv = await B.owner.req("POST", "/v1/invites", { bot_id: B.bot.id, offered_capabilities: ["chat.public"] });
  const j = await A.owner.req("POST", `/v1/invites/${inv.code}/join`, { from_bot_id: A.bot.id });
  assert.equal(j.relationship_id, relId);
  assert.equal(j.regranted, true);
  assert.equal((await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "now shared" })).status, "open");
  // And A's own share stays as it was: X can still start.
  assert.equal((await B.bot.startConversation(A.bot.id, { type: "general_chat", summary: "still fine" })).status, "open");

  const second = await joined(t);
  const r = await second.A.bot.requestGrant(second.relId, "chat.public", {}, "to start chats");
  assert.equal(r.status, "pending_owner_approval");
  await expectApiError(second.A.bot.startConversation(second.B.bot.id, { type: "general_chat", summary: "x" }), 403, "bot_not_shared");
  await approveAll(second.B.owner);
  assert.equal((await second.A.bot.startConversation(second.B.bot.id, { type: "general_chat", summary: "approved" })).status, "open");
});

test("FlyBot over MCP: send_as_member gets bot_not_shared with details; lists mark the reply-only grant; rooms refuse it", async (t) => {
  const h = await flybotHomes(t);
  const inv = await h.A("create_invite", { bot_id: h.writer.bot_id, ...CAPS });
  await h.B("join_invite", { code: inv.code, from_bot_id: h.coder.bot_id });

  const out = await h.A("send_as_member", { from_bot_id: h.writer.bot_id, to: h.coder.handle, text: "hi coder" });
  assert.equal(out.error.code, "bot_not_shared");
  assert.equal(out.error.suggestion, "ask_owner_to_share");
  assert.equal(out.error.bot_id, h.coder.bot_id);
  const inbox = await h.B("list_inbox", { bot_id: h.coder.bot_id, peek: true });
  const ev = inbox.events.filter((e: any) => e.event_type === "share.requested");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].from.handle, h.writer.handle);
  assert.equal(inbox.events.filter((e: any) => e.event_type === "message.received").length, 0);

  // Alice's view: Coder is listed (as before) and marked reply_only; Bob's view of Coder's grants says so too.
  const remote = await h.A("list_remote_bots");
  const coder = remote.bots.find((x: any) => x.handle === h.coder.handle);
  assert.equal(coder.reply_only, true);
  assert.equal(coder.side, "inviter");
  assert.equal(remote.homes[0].bots[0].reply_only, true);
  const bobGrants = await h.B("list_bot_grants", { bot_id: h.coder.bot_id });
  assert.equal(bobGrants.grants.length, 1);
  assert.equal(bobGrants.grants[0].reply_only, true);
  const writerSeen = (await h.B("list_remote_bots")).bots.find((x: any) => x.handle === h.writer.handle);
  assert.equal(writerSeen.reply_only, false, "Alice's share of Writer is a full grant");

  // Bringing Coder into a face room on the reply-only grant is refused the same way.
  const room = await req(h.s.base, "POST", "/v1/face-rooms/join", h.a.connector.token, { code: "515253", bots: [h.writer.bot_id, h.coder.bot_id] });
  assert.equal(room.status, 403, JSON.stringify(room.body));
  assert.equal(room.body.error.code, "bot_not_shared");

  // Bob grants a full non-chat capability on purpose: Coder is still not shared for talking or rooms.
  assert.ok(h.s.platform.addGrant({ kind: "owner", ownerId: h.b.owner_id } as any, coder.relationship_id, { capability: "calendar.freebusy.read" }).grant_id);
  assert.equal((await h.A("list_remote_bots")).bots.find((x: any) => x.handle === h.coder.handle).reply_only, true);
  assert.equal((await h.B("list_bot_grants", { bot_id: h.coder.bot_id })).grants[0].reply_only, true);
  const room2 = await req(h.s.base, "POST", "/v1/face-rooms/join", h.a.connector.token, { code: "515254", bots: [h.writer.bot_id, h.coder.bot_id] });
  assert.equal(room2.status, 403, JSON.stringify(room2.body));
  assert.equal(room2.body.error.code, "bot_not_shared");
  assert.equal((await h.A("send_as_member", { from_bot_id: h.writer.bot_id, to: h.coder.handle, text: "hi" })).error.code, "bot_not_shared");

  // Bob shares Coder (a fresh invite still works with that extra grant): everything is full now.
  const back = await h.B("create_invite", { bot_id: h.coder.bot_id, ...CAPS });
  await h.A("join_invite", { code: back.code, from_bot_id: h.writer.bot_id });
  assert.equal((await h.A("list_remote_bots")).bots.find((x: any) => x.handle === h.coder.handle).reply_only, false);
  assert.equal((await h.B("list_bot_grants", { bot_id: h.coder.bot_id })).grants[0].reply_only, false);
  const sent = await h.A("send_as_member", { from_bot_id: h.writer.bot_id, to: h.coder.handle, text: "hi coder" });
  assert.match(sent.conversation_id, /.+/);
});

test("migration: an existing database gets the column and its join-time joiner grants become reply-only", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bs-reply-only-"));
  const path = join(dir, "db.sqlite");
  const S = await startServer({ dbPath: path });
  const A = await ownerWithBot(S.base, "oldinv");
  const B = await ownerWithBot(S.base, "oldjoin");
  const inv = await A.owner.req("POST", "/v1/invites", { bot_id: A.bot.id, offered_capabilities: ["chat.public"] });
  const j = await B.owner.req("POST", `/v1/invites/${inv.code}/join`, { from_bot_id: B.bot.id });
  // A grant B's owner added later on purpose (here: freebusy) keeps full access.
  const later = await B.owner.req("POST", `/v1/relationships/${j.relationship_id}/grants`, { capability: "calendar.freebusy.read" });
  // A plain friend request (full grants both ways) later re-shared through an invite also gets a relationship_invites
  // link; its requester's grants must stay full.
  const C = await ownerWithBot(S.base, "plainreq");
  const D = await ownerWithBot(S.base, "plaintgt");
  const fr = await C.owner.req("POST", "/v1/relationships", { from_bot_id: C.bot.id, target_handle: D.handle, requested_capabilities: ["chat.public"] });
  await D.owner.req("POST", `/v1/relationships/${fr.relationship_id}/consent`, { decision: "accept", grant_capabilities: [] });
  const [dGrant] = (await C.owner.req("GET", "/v1/remote-bots")).bots;
  await C.owner.req("DELETE", `/v1/remote-bots/${dGrant.grant_id}`);
  const reshare = await D.owner.req("POST", "/v1/invites", { bot_id: D.bot.id });
  assert.equal((await C.owner.req("POST", `/v1/invites/${reshare.code}/join`, { from_bot_id: C.bot.id })).regranted, true);
  // An invite join whose chat.public was then granted through an approved grant.request (here within the same second).
  const E = await ownerWithBot(S.base, "reqinv");
  const F = await ownerWithBot(S.base, "reqjoin");
  const inv2 = await E.owner.req("POST", "/v1/invites", { bot_id: E.bot.id });
  const j2 = await F.owner.req("POST", `/v1/invites/${inv2.code}/join`, { from_bot_id: F.bot.id });
  await E.bot.requestGrant(j2.relationship_id, "chat.public", {}, "to start chats");
  await approveAll(F.owner);
  await S.stop();

  // Turn it into a database from before #23: no reply_only column, the later grant created a minute after the join.
  const raw = new Database(path);
  raw.prepare("UPDATE grants SET created_at = ? WHERE id = ?").run(new Date(Date.now() + 60e3).toISOString(), later.grant_id);
  raw.exec("ALTER TABLE grants DROP COLUMN reply_only");
  raw.close();

  const db = openDb(path);
  t.after(() => db.close());
  const rows = db.prepare("SELECT capability, grantor_owner, reply_only FROM grants WHERE status = 'active' ORDER BY capability").all() as any[];
  const bob = rows.filter((r) => r.grantor_owner === B.owner_id);
  const alice = rows.filter((r) => r.grantor_owner === A.owner_id);
  assert.deepEqual(bob.map((r) => [r.capability, r.reply_only]), [["calendar.freebusy.read", 0], ["chat.public", 1], ["profile.read", 1]]);
  assert.ok(alice.length > 0 && alice.every((r) => r.reply_only === 0), "the inviter's share stays full");
  const plain = db.prepare("SELECT reply_only FROM grants WHERE status = 'active' AND relationship_id = ?").all(fr.relationship_id) as any[];
  assert.ok(plain.length > 0 && plain.every((r) => r.reply_only === 0), "a re-shared plain friend request keeps full grants");
  const requested = db.prepare("SELECT capability, reply_only FROM grants WHERE status = 'active' AND relationship_id = ? AND grantor_owner = ? ORDER BY capability").all(j2.relationship_id, F.owner_id) as any[];
  assert.deepEqual(requested.map((r) => [r.capability, r.reply_only]), [["chat.public", 0], ["profile.read", 1]], "an approved grant request stays full");
  assert.equal(markJoinGrantsReplyOnly(db), 0, "idempotent");
});
