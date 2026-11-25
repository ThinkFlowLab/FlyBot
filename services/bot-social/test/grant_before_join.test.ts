// #30 / FlyBot #442: an invite join writes its grants before the join is confirmed. The friend's owner typed "Hi"
// seconds after joining, and the inviter's home refused it because it had not recorded the grant yet. The
// server now commits every grant before the relationship reads active and before relationship.changed goes out,
// carries the grants in that event and in the join answer, and lets a home that still could not take a message
// tell the sender (message.not_delivered), so the sender sees "Not sent" instead of silence.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startServer } from "./helpers.js";
import { mcp, post } from "./flybot_helpers.js";

const CAPS = { auto_accept: true, offered_capabilities: ["chat.public"], requested_capabilities: ["chat.public"] };

async function homes(t: any) {
  const s = await startServer();
  t.after(s.stop);
  const a = (await post(s.base, "/v1/onboard/flybot", { display_name: "Danyang" })).body;
  const b = (await post(s.base, "/v1/onboard/flybot", { display_name: "Friend" })).body;
  const c = (await post(s.base, "/v1/onboard/flybot", { display_name: "Carol" })).body;
  const A = (name: string, args: unknown = {}) => mcp(s.base, a.connector.token, name, args);
  const B = (name: string, args: unknown = {}) => mcp(s.base, b.connector.token, name, args);
  const C = (name: string, args: unknown = {}) => mcp(s.base, c.connector.token, name, args);
  const tester = await A("add_home_member", { home: a.home.bot_id, name: "tester", display_name: "测试" });
  const friend = await B("add_home_member", { home: b.home.bot_id, name: "friend", display_name: "Friend Bot" });
  const approve = (ownerId: string, aprId: string) => s.platform.decideApproval({ kind: "owner", ownerId }, aprId, { decision: "approved" });
  return { s, a, b, c, A, B, C, tester, friend, approve };
}
const activeGrant = (s: any, grantorOwner: string, granteeBot: string) =>
  s.platform.db.prepare("SELECT g.id FROM grants g WHERE g.grantor_owner = ? AND g.grantee_bot = ? AND g.capability = 'chat.public' AND g.status = 'active'").get(grantorOwner, granteeBot);

test("an invite join commits the grants before the join is confirmed or announced", async (t) => {
  const { s, a, b, A, B, tester, friend } = await homes(t);
  // What the inviter's home could see at the moment each relationship.changed was emitted.
  const seen: any[] = [];
  const emit = s.platform.emit.bind(s.platform);
  (s.platform as any).emit = (botId: string, type: string, data: any) => {
    if (type === "relationship.changed") {
      const rel = s.platform.db.prepare("SELECT status FROM relationships WHERE id = ?").get(data.relationship_id) as any;
      seen.push({ botId, data, relStatus: rel.status, inviterGrant: !!activeGrant(s, a.owner_id, friend.bot_id), joinerGrant: !!activeGrant(s, b.owner_id, tester.bot_id) });
    }
    return emit(botId, type, data);
  };
  const inv = await A("create_invite", { bot_id: tester.bot_id, ...CAPS });
  const joined = await B("join_invite", { code: inv.code, from_bot_id: friend.bot_id });
  assert.equal(joined.status, "active");
  assert.equal(joined.grants_ready, true);
  const toFriend = joined.grants.find((g: any) => g.granted_bot.bot_id === tester.bot_id);
  assert.equal(toFriend.grantee_bot.handle, friend.handle);
  assert.ok(toFriend.capabilities.includes("chat.public"));
  assert.equal(toFriend.reply_only, false, "the inviter shared its Bot");
  const back = joined.grants.find((g: any) => g.granted_bot.bot_id === friend.bot_id);
  assert.equal(back.reply_only, true, "what the joiner gives back is reply-only (#23)");

  assert.deepEqual(seen.map((x) => x.botId).sort(), [friend.bot_id, tester.bot_id].sort(), "both Bots are told");
  for (const x of seen) {
    assert.equal(x.relStatus, "active");
    assert.ok(x.inviterGrant && x.joinerGrant, "every grant is durable before the join is announced");
    assert.equal(x.data.grants_ready, true);
    assert.deepEqual(x.data.grants, joined.grants);
  }
  // The inviter's home can list the grant at once, and its inbox has the join before any message.
  const listed = await A("list_bot_grants", { bot_id: tester.bot_id });
  assert.ok(listed.grants.some((g: any) => g.grantee.handle === friend.handle));
});

test("a message sent right after the join arrives after relationship.changed in the inviter's inbox", async (t) => {
  const { b, A, B, tester, friend, approve } = await homes(t);
  const inv = await A("create_invite", { bot_id: tester.bot_id, ...CAPS });
  await B("join_invite", { code: inv.code, from_bot_id: friend.bot_id });
  const sent = await B("send_as_member", { from_bot_id: friend.bot_id, to: tester.handle, text: "Hi", typed_by_owner: true });
  assert.equal(sent.error, undefined, JSON.stringify(sent.error));
  assert.equal(sent.message.status, "delivered", "an owner-typed line does not wait for a card");
  assert.equal(sent.message.approval_id, undefined);
  const inbox = await A("list_inbox", { bot_id: tester.bot_id, peek: true });
  const types = inbox.events.map((e: any) => e.event_type);
  const joinAt = types.indexOf("relationship.changed");
  const msgAt = types.indexOf("message.received");
  assert.ok(joinAt >= 0 && msgAt > joinAt, `join before message: ${types.join(", ")}`);
  assert.equal(inbox.events[joinAt].grants_ready, true);
  assert.ok(inbox.events[joinAt].grants.some((g: any) => g.granted_bot.bot_id === tester.bot_id && g.grantee_bot.handle === friend.handle));
});

test("if writing a grant fails, the join is not confirmed: no relationship, no invite use, no event", async (t) => {
  const { s, A, B, tester, friend } = await homes(t);
  const inv = await A("create_invite", { bot_id: tester.bot_id, ...CAPS });
  const insert = (s.platform as any).insertGrant;
  (s.platform as any).insertGrant = function () { throw new Error("disk full"); };
  const failed = await B("join_invite", { code: inv.code, from_bot_id: friend.bot_id });
  (s.platform as any).insertGrant = insert;
  assert.ok(failed.error, "the join fails");
  assert.equal((s.platform.db.prepare("SELECT COUNT(*) n FROM relationships").get() as any).n, 0);
  assert.equal((s.platform.db.prepare("SELECT uses FROM invites WHERE code = ?").get(inv.code) as any).uses, 0);
  assert.equal((s.platform.db.prepare("SELECT COUNT(*) n FROM events WHERE type = 'relationship.changed'").get() as any).n, 0);
  const joined = await B("join_invite", { code: inv.code, from_bot_id: friend.bot_id });
  assert.equal(joined.status, "active", "the invite still works");
});

test("an invite that waits for the inviter's consent is confirmed with its grants on accept", async (t) => {
  const { s, a, A, B, tester, friend } = await homes(t);
  const inv = await A("create_invite", { bot_id: tester.bot_id, ...CAPS, auto_accept: false });
  const joined = await B("join_invite", { code: inv.code, from_bot_id: friend.bot_id });
  assert.equal(joined.status, "pending_target");
  assert.equal(joined.grants, undefined, "nothing is granted before consent");
  s.platform.consent({ kind: "owner", ownerId: a.owner_id } as any, joined.relationship_id, { decision: "accept" });
  const inbox = await A("list_inbox", { bot_id: tester.bot_id, peek: true });
  const changed = inbox.events.find((e: any) => e.event_type === "relationship.changed");
  assert.equal(changed.status, "active");
  assert.ok(changed.grants.some((g: any) => g.granted_bot.bot_id === tester.bot_id && g.grantee_bot.handle === friend.handle));
});

test("report_not_delivered: the recipient's owner tells the sender once; nobody else can", async (t) => {
  const { s, b, A, B, C, tester, friend, approve } = await homes(t);
  const inv = await A("create_invite", { bot_id: tester.bot_id, ...CAPS });
  await B("join_invite", { code: inv.code, from_bot_id: friend.bot_id });
  const sent = await B("send_as_member", { from_bot_id: friend.bot_id, to: tester.handle, text: "Hi" });
  assert.equal((await A("report_not_delivered", { message_id: sent.message.message_id })).error.code, "invalid_state", "not delivered yet");
  await approve(b.owner_id, sent.message.approval_id);
  const id = sent.message.message_id;
  assert.equal((await B("report_not_delivered", { message_id: id })).error.code, "message_not_found", "the sender's owner cannot");
  assert.equal((await C("report_not_delivered", { message_id: id })).error.code, "message_not_found", "a stranger cannot");
  assert.ok((await A("report_not_delivered", { message_id: id, reason: "anything" })).error, "only a known reason");

  const done = await A("report_not_delivered", { message_id: id });
  assert.deepEqual(done, { message_id: id, status: "not_delivered", reason: "not_shared_yet" });
  const again = await A("report_not_delivered", { message_id: id });
  assert.equal(again.already_reported, true);

  const events = (await B("list_inbox", { bot_id: friend.bot_id, peek: true })).events.filter((e: any) => e.event_type === "message.not_delivered");
  assert.equal(events.length, 1, "told once");
  assert.equal(events[0].message_id, id);
  assert.equal(events[0].trust, "platform");
  assert.equal(events[0].reason, "not_shared_yet");
  assert.equal(events[0].to.handle, tester.handle);
  // Nothing else changes: the grant and the friendship stay.
  assert.ok(activeGrant(s, (s.platform as any).bot(tester.bot_id).owner_id, friend.bot_id));
  assert.ok((await (await fetch(`${s.base}/v1/platform`)).json()).features.includes("report_not_delivered"));
});
