import assert from "node:assert/strict";
import { test } from "node:test";
import { CAPS, flybotHomes, req } from "./flybot_helpers.js";

/** Alice shares Writer with Bob's Coder through an invite. */
async function shared(t: any) {
  const h = await flybotHomes(t);
  const inv = await h.A("create_invite", { bot_id: h.writer.bot_id, ...CAPS });
  const joined = await h.B("join_invite", { code: inv.code, from_bot_id: h.coder.bot_id });
  assert.equal(joined.status, "active");
  const remote = await h.B("list_remote_bots");
  const item = remote.bots.find((x: any) => x.handle === h.writer.handle);
  assert.ok(item?.grant_id);
  return { ...h, inv, joined, grantId: item.grant_id as string };
}
const actions = (s: any, ownerId: string) => (s.platform.auditEvents({ kind: "owner", ownerId }, { limit: 500 }).events as any[]).map((e) => e.action);

test("grantee declines a grant (MCP): gone for both sides, only that direction ends, audited", async (t) => {
  const { s, a, b, A, B, writer, coder, grantId, joined } = await shared(t);
  const out = await B("decline_bot_grant", { grant_id: grantId, bot_id: writer.handle });
  assert.equal(out.status, "declined");
  assert.equal(out.granted_bot, writer.bot_id);
  assert.equal(out.grantee_bot, coder.bot_id);
  assert.ok(out.declined.length >= 2, "the whole bundle (chat.public + profile.read) ends");

  assert.deepEqual((await B("list_remote_bots")).bots, [], "the shared Bot disappears for the grantee");
  assert.deepEqual((await A("list_bot_grants", { bot_id: writer.bot_id })).grants, [], "and from the owner's Manage access");
  assert.equal(s.platform.findGrant(a.owner_id, coder.bot_id, "chat.public", writer.bot_id), null, "access is really gone");
  assert.throws(() => s.platform.profile({ kind: "owner", ownerId: b.owner_id } as any, writer.bot_id), /no such bot/);

  // the friendship and the grants the other way are untouched: Alice still sees Bob's Coder
  const aliceRemote = await A("list_remote_bots");
  assert.deepEqual(aliceRemote.bots.map((x: any) => x.handle), [coder.handle]);
  const rel = s.platform.listRelationships({ kind: "owner", ownerId: a.owner_id } as any) as any[];
  assert.equal(rel.find((r) => r.relationship_id === joined.relationship_id).status, "active");

  assert.ok(actions(s, b.owner_id).includes("grant.declined"));
  assert.ok(!actions(s, b.owner_id).includes("grant.revoked"));
  const row = s.platform.db.prepare("SELECT status, revoked_at FROM grants WHERE id = ?").get(grantId) as any;
  assert.equal(row.status, "declined");
  assert.ok(row.revoked_at);
  // the granted Bot is told (inbox event) so its client can refresh
  const ev = s.platform.listEvents({ kind: "bot", botId: writer.bot_id, ownerId: a.owner_id } as any, 0) as any;
  assert.ok(ev.events.some((e: any) => e.event_type === "grant.changed" && e.status === "declined"), JSON.stringify(ev.events));
});

test("REST DELETE /v1/remote-bots/:grantId with a connector token; a second call is grant_not_found", async (t) => {
  const { s, b, B, A, writer, grantId } = await shared(t);
  const wrongBot = await req(s.base, "DELETE", `/v1/remote-bots/${grantId}?bot_id=${b.home.bot_id}`, b.connector.token);
  assert.equal(wrongBot.status, 404);
  assert.equal(wrongBot.body.error.code, "grant_not_found");
  assert.equal((await B("list_remote_bots")).bots.length, 1, "a mismatching bot_id changes nothing");
  const del = await req(s.base, "DELETE", `/v1/remote-bots/${grantId}?bot_id=${writer.bot_id}`, b.connector.token);
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.equal(del.body.status, "declined");
  const again = await req(s.base, "DELETE", `/v1/remote-bots/${grantId}`, b.connector.token);
  assert.equal(again.status, 404);
  assert.equal(again.body.error.code, "grant_not_found");
  assert.deepEqual((await A("list_bot_grants", { bot_id: writer.bot_id })).grants, []);
});

test("only the grantee's owner can decline (default deny): grantor, strangers, anonymous and bot tokens are refused", async (t) => {
  const { s, a, b, c, A, B, C, writer, grantId } = await shared(t);
  assert.equal((await A("decline_bot_grant", { grant_id: grantId })).error.code, "forbidden", "the granting owner must use revoke_bot_grant");
  assert.equal((await C("decline_bot_grant", { grant_id: grantId })).error.code, "forbidden");
  assert.equal((await B("decline_bot_grant", { grant_id: "grt_nope" })).error.code, "grant_not_found");
  assert.equal((await req(s.base, "DELETE", `/v1/remote-bots/${grantId}`, a.connector.token)).status, 403);
  assert.equal((await req(s.base, "DELETE", `/v1/remote-bots/${grantId}`, c.connector.token)).status, 403);
  assert.equal((await req(s.base, "DELETE", `/v1/remote-bots/${grantId}`)).status, 401);
  assert.equal((await req(s.base, "DELETE", `/v1/remote-bots/${grantId}`, "otk_invalid")).status, 401);
  // the grantee cannot use the owner-side revoke route, and the grantor cannot revoke through the decline route
  assert.equal((await req(s.base, "DELETE", `/v1/bots/${writer.bot_id}/grants/${grantId}`, b.connector.token)).status, 403);
  assert.equal((await B("revoke_bot_grant", { grant_id: grantId })).error.code, "forbidden");
  // nothing changed through all of that
  assert.equal((await A("list_bot_grants", { bot_id: writer.bot_id })).grants.length, 1);
  assert.equal((await B("list_remote_bots")).bots.length, 1);
  assert.ok(!actions(s, b.owner_id).includes("grant.declined"));
});

test("re-share after decline: a fresh invite restores access without relationship_exists", async (t) => {
  const { a, b, s, A, B, writer, coder, grantId, inv, joined } = await shared(t);
  // the same Bot cannot be joined again while the grant is live
  const live = await A("create_invite", { bot_id: writer.bot_id, ...CAPS });
  const dup = await B("join_invite", { code: live.code, from_bot_id: coder.bot_id });
  assert.equal(dup.error.code, "relationship_exists");
  assert.match(dup.error.message, /already connected/);

  await B("decline_bot_grant", { grant_id: grantId });
  // the old single-use invite is spent: clear, stable error code
  const old = await B("join_invite", { code: inv.code, from_bot_id: coder.bot_id });
  assert.equal(old.error.code, "invite_unavailable");
  assert.match(old.error.message, /used/);
  assert.equal((s.platform.db.prepare("SELECT uses, max_uses FROM invites WHERE code = ?").get(inv.code) as any).uses, 1);
  // an unused fresh invite (the one created above) re-grants
  const re = await B("join_invite", { code: `https://x.example/i/${live.code}`, from_bot_id: coder.bot_id });
  assert.equal(re.error, undefined, JSON.stringify(re));
  assert.equal(re.status, "active");
  assert.equal(re.regranted, true);
  assert.equal(re.relationship_id, joined.relationship_id, "same friendship, no duplicate");
  const remote = await B("list_remote_bots");
  assert.deepEqual(remote.bots.map((x: any) => x.handle), [writer.handle]);
  assert.notEqual(remote.bots[0].grant_id, grantId, "a new grant, the declined one stays declined");
  const grants = await A("list_bot_grants", { bot_id: writer.bot_id });
  assert.equal(grants.grants.length, 1);
  assert.equal(grants.grants[0].grantee.handle, coder.handle);
  assert.ok(grants.grants[0].capabilities.includes("chat.public"));
  assert.equal(s.platform.findGrant(a.owner_id, coder.bot_id, "chat.public", writer.bot_id)?.relationship_id, joined.relationship_id);
  // Bob's own grants to Alice were never duplicated
  const n = s.platform.db.prepare("SELECT COUNT(*) n FROM grants WHERE relationship_id = ? AND grantor_owner = ? AND status = 'active'").get(joined.relationship_id, b.owner_id) as any;
  assert.equal(n.n, 2);
  // and the new invite is spent
  assert.equal((await B("join_invite", { code: live.code, from_bot_id: coder.bot_id })).error.code, "invite_unavailable");
  assert.ok(actions(s, a.owner_id).includes("invite.joined"));
});

test("re-share also works after the owner revoked, and chat works again", async (t) => {
  const { A, B, writer, coder, grantId, joined } = await shared(t);
  const g = (await A("list_bot_grants", { bot_id: writer.bot_id })).grants[0];
  assert.equal((await A("revoke_bot_grant", { grant_id: g.grant_id, bot_id: writer.bot_id })).status, "revoked");
  assert.equal((await B("decline_bot_grant", { grant_id: grantId })).error.code, "grant_not_found", "already gone: nothing to decline");
  const inv = await A("create_invite", { bot_id: writer.bot_id, ...CAPS });
  const re = await B("join_invite", { code: inv.code, from_bot_id: coder.bot_id });
  assert.equal(re.regranted, true);
  assert.equal(re.relationship_id, joined.relationship_id);
  const sent = await B("send_as_member", { from_bot_id: coder.bot_id, to: writer.handle, text: "hello writer, coder here again" });
  assert.match(sent.conversation_id, /.+/);
});

test("invites that need the inviter's manual consent are not auto re-granted", async (t) => {
  const { A, B, writer, coder, grantId } = await shared(t);
  await B("decline_bot_grant", { grant_id: grantId });
  const inv = await A("create_invite", { bot_id: writer.bot_id, ...CAPS, auto_accept: false });
  const re = await B("join_invite", { code: inv.code, from_bot_id: coder.bot_id });
  assert.equal(re.error.code, "relationship_exists");
  assert.deepEqual((await B("list_remote_bots")).bots, []);
});

test("declining a grant used in a face room removes that Bot from the room", async (t) => {
  const { s, b, A, B, writer, coder, grantId } = await shared(t);
  const join = await req(s.base, "POST", "/v1/face-rooms/join", b.connector.token, { code: "424243", bots: [coder.bot_id, writer.bot_id] });
  assert.equal(join.status, 200, JSON.stringify(join.body));
  assert.ok(join.body.members.some((m: any) => m.handle === writer.handle));
  const out = await B("decline_bot_grant", { grant_id: grantId });
  assert.ok(out.rooms_removed.includes(join.body.room_id), JSON.stringify(out));
  const room = await req(s.base, "GET", `/v1/face-rooms/${join.body.room_id}`, b.connector.token);
  assert.ok(!room.body.members.some((m: any) => m.handle === writer.handle));
  assert.ok(room.body.members.some((m: any) => m.handle === coder.handle));
  assert.deepEqual((await A("list_bot_grants", { bot_id: writer.bot_id })).grants, []);
});

test("backward compatible: revoke_bot_grant, list_remote_bots shapes and unfriending are unchanged", async (t) => {
  const { A, B, writer, grantId, joined, s, b } = await shared(t);
  const remote = await B("list_remote_bots");
  for (const k of ["bot_id", "handle", "display_name", "owner_display_name", "grant_id", "scope", "via", "created_at", "expires_at", "relationship_id"]) assert.ok(k in remote.bots[0], k);
  const g = (await A("list_bot_grants", { bot_id: writer.bot_id })).grants[0];
  assert.equal(g.grant_id, grantId);
  const bobOwner = { kind: "owner", ownerId: b.owner_id } as any;
  assert.equal((s.platform.removeRelationship(bobOwner, joined.relationship_id) as any).status, "revoked");
  assert.deepEqual((await B("list_remote_bots")).bots, []);
  assert.equal((await B("decline_bot_grant", { grant_id: grantId })).error.code, "grant_not_found");
});

test("#35: declining a full share keeps coexisting reply-only rows; replies still work", async (t) => {
  const h = await flybotHomes(t);
  // Alice invites Writer; Bob joins with Coder → Alice full to Coder, Bob reply-only to Writer.
  const inv = await h.A("create_invite", { bot_id: h.writer.bot_id, ...CAPS });
  const joined = await h.B("join_invite", { code: inv.code, from_bot_id: h.coder.bot_id });
  assert.equal(joined.status, "active");

  // Bob adds a full non-chat capability on the same (grantor, grantee) as the reply-only join grants.
  // Declining that full row must not wipe the reply-only rows (#35).
  const replyRows = h.s.platform.db.prepare(
    "SELECT id, capability, reply_only FROM grants WHERE relationship_id = ? AND grantor_owner = ? AND grantee_bot = ? AND status = 'active' AND reply_only = 1"
  ).all(joined.relationship_id, h.b.owner_id, h.writer.bot_id) as any[];
  assert.ok(replyRows.length >= 1, "join created reply-only rows from Bob to Writer");

  const cal = h.s.platform.addGrant({ kind: "owner", ownerId: h.b.owner_id } as any, joined.relationship_id, { capability: "calendar.freebusy.read" });
  assert.ok(cal.grant_id);
  assert.equal((h.s.platform.db.prepare("SELECT reply_only FROM grants WHERE id = ?").get(cal.grant_id) as any).reply_only, 0);

  const out = await h.A("decline_bot_grant", { grant_id: cal.grant_id, bot_id: h.coder.handle });
  assert.equal(out.status, "declined");
  assert.ok(out.declined.includes(cal.grant_id));
  assert.ok(!out.declined.some((id: string) => replyRows.some((r) => r.id === id)), "reply-only ids must not be in declined");

  for (const r of replyRows) {
    const row = h.s.platform.db.prepare("SELECT status, reply_only FROM grants WHERE id = ?").get(r.id) as any;
    assert.equal(row.status, "active", `reply-only ${r.capability} must stay active`);
    assert.equal(row.reply_only, 1);
  }
  assert.equal((h.s.platform.db.prepare("SELECT status FROM grants WHERE id = ?").get(cal.grant_id) as any).status, "declined");

  // Coder starts a chat; Writer can still reply (reply-only survived). Writer still cannot start a fresh chat with Coder.
  const started = await h.B("send_as_member", { from_bot_id: h.coder.bot_id, to: h.writer.handle, text: "hi writer from coder" });
  assert.match(started.conversation_id, /.+/);
  h.s.platform.decideApproval({ kind: "owner", ownerId: h.b.owner_id } as any, started.message.approval_id, { decision: "approved" });
  const msg = await h.A("send_message", { conversation_id: started.conversation_id, text: "sure, happy to talk" });
  assert.equal(msg.error, undefined, JSON.stringify(msg));
  assert.ok(msg.status === "pending_approval" || msg.approval_id || msg.message, JSON.stringify(msg));

  const remote = await h.A("list_remote_bots");
  const coder = remote.bots.find((x: any) => x.handle === h.coder.handle);
  assert.ok(coder, "reply-only access to Coder remains visible");
  assert.equal(coder.reply_only, true);
});

test("#35: declining a reply-only-only grant is refused; rows stay active", async (t) => {
  const h = await flybotHomes(t);
  const inv = await h.A("create_invite", { bot_id: h.writer.bot_id, ...CAPS });
  await h.B("join_invite", { code: inv.code, from_bot_id: h.coder.bot_id });
  // Alice sees Coder as reply_only (Bob's join grant).
  const remote = await h.A("list_remote_bots");
  const coder = remote.bots.find((x: any) => x.handle === h.coder.handle);
  assert.equal(coder.reply_only, true);
  const err = await h.A("decline_bot_grant", { grant_id: coder.grant_id });
  assert.equal(err.error.code, "grant_not_found");
  assert.match(err.error.message, /reply-only/i);
  const still = await h.A("list_remote_bots");
  assert.equal(still.bots.find((x: any) => x.handle === h.coder.handle).grant_id, coder.grant_id);
  const active = h.s.platform.db.prepare(
    "SELECT COUNT(*) n FROM grants WHERE id = ? AND status = 'active' AND reply_only = 1"
  ).get(coder.grant_id) as any;
  assert.equal(active.n, 1);
});

test("#35: Remove this Bot (decline full share) leaves the other direction's reply-only grants active", async (t) => {
  const { s, b, B, writer, grantId, joined } = await shared(t);
  const out = await B("decline_bot_grant", { grant_id: grantId });
  assert.equal(out.status, "declined");
  // Bob's reply-only grants to Writer (other direction) stay active — friendship reply path intact.
  const reply = s.platform.db.prepare(
    "SELECT id, status, reply_only FROM grants WHERE relationship_id = ? AND grantor_owner = ? AND grantee_bot = ? AND status = 'active'"
  ).all(joined.relationship_id, b.owner_id, writer.bot_id) as any[];
  assert.ok(reply.length >= 1 && reply.every((r) => r.reply_only === 1), JSON.stringify(reply));
  // Alice's full share to Coder is gone.
  assert.deepEqual((await B("list_remote_bots")).bots, []);
  assert.ok(!out.declined.some((id: string) => reply.some((r) => r.id === id)));
});
