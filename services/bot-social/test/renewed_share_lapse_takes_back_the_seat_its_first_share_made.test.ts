/**
 * A share that lapses by time after it was renewed must take back the seat its first share made.
 * Renewing marks the live row `superseded` and writes a new one, but the `grant_rooms` rows that made the guest seat
 * stay on the old row: the renewal has no usage of its own. `expireLapsedShares` only hands over rows that still hold
 * a usage, so a lapsed renewal gives the seat back to nobody — the guest stays in the room, the room-scoped grants
 * that seat wrote stay active, and `send_as_member` naming that room still delivers.
 * The neighbour control keeps this apart from a sweep that clears the whole room: a second bot brought in on another
 * share sits in the same room, and only the lapsed line's own seat may be taken back.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

async function req(base: string, method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}

async function share(base: string, from: any, to: any) {
  const rel = await req(base, "POST", "/v1/relationships", to.owner.token, {
    from_bot_id: to.bot.id, target_handle: from.handle, message: "hi", requested_capabilities: ["chat.public"],
  });
  assert.ok(rel.status < 300, JSON.stringify(rel.body));
  const c = await req(base, "POST", `/v1/relationships/${rel.body.relationship_id}/consent`, from.owner.token, {
    decision: "accept", grant_capabilities: [{ capability: "chat.public" }],
  });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  return rel.body.relationship_id as string;
}

test("a lapsed renewal takes back the seat its first share made", async (t) => {
  const s: any = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const F = await ownerWithBot(s.base, "fay");
  const G = await ownerWithBot(s.base, "gil");
  const custody = (o: any) => s.platform.enableCustody({ kind: "owner" as const, ownerId: o.owner_id }, o.bot.id, { private_key_pem: o.kp.privateKeyPem });
  custody(A); custody(B); custody(F); custody(G);
  const relationshipId = await share(s.base, F, A);
  await share(s.base, G, A);

  // B hosts; A brings A's own Bot, the Bot F shared and the Bot G shared into that room on those two shares.
  const code = "858586";
  const host = await req(s.base, "POST", "/v1/face-rooms/join", B.owner.token, { code, bots: [B.bot.id] });
  assert.equal(host.status, 200, JSON.stringify(host.body));
  const roomId = host.body.room_id as string;
  const brought = await req(s.base, "POST", "/v1/face-rooms/join", A.owner.token, { code, bots: [A.bot.id, F.bot.id, G.bot.id] });
  assert.equal(brought.status, 200, JSON.stringify(brought.body));

  const db = s.platform.db;
  const first = db.prepare("SELECT id FROM grants WHERE grantor_owner = ? AND grantee_bot = ? AND capability = 'chat.public'").get(F.owner_id, A.bot.id) as any;
  assert.ok(first, "the first share row exists");
  const firstUsage = db.prepare("SELECT room_id, ended_at FROM grant_rooms WHERE grant_id = ?").get(first.id) as any;
  assert.ok(firstUsage && firstUsage.ended_at == null, "the first share's usage is open while its bringer sits in the room");
  const neighbour = db.prepare("SELECT id, status FROM grants WHERE grantor_owner = ? AND grantee_bot = ? AND capability = 'chat.public'").get(G.owner_id, A.bot.id) as any;
  assert.ok(neighbour, "the neighbour's share row exists");

  // F renews before the lapse: the live row is replaced, and only the old row holds the seat.
  const renewed = await req(s.base, "POST", `/v1/relationships/${relationshipId}/grants`, F.owner.token, { capability: "chat.public" });
  assert.ok(renewed.status < 300, JSON.stringify(renewed.body));
  const renewedId = renewed.body.grant_id as string;
  const firstAfter = db.prepare("SELECT status FROM grants WHERE id = ?").get(first.id) as any;
  assert.equal(firstAfter.status, "superseded", "renewing left the first share without its live status");
  const renewedUsages = (db.prepare("SELECT COUNT(*) n FROM grant_rooms WHERE grant_id = ?").get(renewedId) as any).n;
  assert.equal(renewedUsages, 0, "the renewal never touched the room: only the first row holds that seat");

  // The renewal runs out of time, and a face-room door settles lapsed shares.
  db.prepare("UPDATE grants SET expires_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", renewedId);
  await req(s.base, "GET", "/v1/face-rooms", B.owner.token);

  const after = db.prepare("SELECT status FROM grants WHERE id = ?").get(renewedId) as any;
  assert.equal(after.status, "expired", "the renewal has lapsed");
  const seat = () => db.prepare("SELECT left_at FROM face_room_members WHERE room_id = ? AND bot_id = ?").get(roomId, F.bot.id) as any;
  assert.ok(seat() && seat().left_at != null, "the seat the first share made is gone once the line lapsed");
  const reach = (db.prepare(`SELECT COUNT(*) n FROM grants g JOIN relationships r ON r.id = g.relationship_id
    WHERE g.room_id = ? AND g.status = 'active' AND (r.requester_bot = ? OR r.target_bot = ?)`).get(roomId, F.bot.id, F.bot.id) as any).n;
  assert.equal(reach, 0, "no room-scoped grant of that seat is left active");
  const send = await req(s.base, "POST", `/v1/homes/${F.bot.id}/send`, F.owner.token, { from_bot_id: F.bot.id, to: B.bot.id, text: "after the lapse", room_id: roomId });
  assert.equal(send.status, 403, "a send naming that room is refused");
  assert.equal(send.body?.error?.code, "room_not_shared");

  // The neighbour's seat and share are not this line's to end.
  const neighbourSeat = db.prepare("SELECT left_at FROM face_room_members WHERE room_id = ? AND bot_id = ?").get(roomId, G.bot.id) as any;
  assert.ok(neighbourSeat && neighbourSeat.left_at == null, "the bot another share seated in the same room keeps its seat");
  const neighbourAfter = db.prepare("SELECT status FROM grants WHERE id = ?").get(neighbour.id) as any;
  assert.equal(neighbourAfter.status, "active", "the neighbour's share is untouched");
  const neighbourSend = await req(s.base, "POST", `/v1/homes/${G.bot.id}/send`, G.owner.token, { from_bot_id: G.bot.id, to: B.bot.id, text: "still here", room_id: roomId });
  assert.equal(neighbourSend.status, 202, JSON.stringify(neighbourSend.body));
});

/**
 * The other side of the same door: a lapse gives back only a line that ended.
 * A row can lapse and be flipped to `expired` in place by a plain reader (`findGrant`), with no sweep; the owner may
 * then renew the line again, so the lapsed row and a newer `active` row stand side by side. The seat still belongs to
 * the line -- the newer row carries the share -- so a sweep reached through an ancestor must not take it back.
 */
test("a lapse on a line that was renewed again keeps the seat the line still holds", async (t) => {
  const s: any = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const F = await ownerWithBot(s.base, "fay");
  const custody = (o: any) => s.platform.enableCustody({ kind: "owner" as const, ownerId: o.owner_id }, o.bot.id, { private_key_pem: o.kp.privateKeyPem });
  custody(A); custody(B); custody(F);
  const relationshipId = await share(s.base, F, A);

  const code = "858587";
  const host = await req(s.base, "POST", "/v1/face-rooms/join", B.owner.token, { code, bots: [B.bot.id] });
  assert.equal(host.status, 200, JSON.stringify(host.body));
  const roomId = host.body.room_id as string;
  const brought = await req(s.base, "POST", "/v1/face-rooms/join", A.owner.token, { code, bots: [A.bot.id, F.bot.id] });
  assert.equal(brought.status, 200, JSON.stringify(brought.body));

  const db = s.platform.db;
  const first = db.prepare("SELECT id FROM grants WHERE grantor_owner = ? AND grantee_bot = ? AND capability = 'chat.public'").get(F.owner_id, A.bot.id) as any;
  assert.ok(first, "the first share row exists");
  const firstUsage = () => db.prepare("SELECT ended_at FROM grant_rooms WHERE grant_id = ?").get(first.id) as any;

  // The first renewal: the live row is replaced, and only the first row holds the seat.
  const renewed = await req(s.base, "POST", `/v1/relationships/${relationshipId}/grants`, F.owner.token, { capability: "chat.public" });
  assert.ok(renewed.status < 300, JSON.stringify(renewed.body));
  const renewedId = renewed.body.grant_id as string;
  assert.ok(firstUsage() && firstUsage().ended_at == null, "the seat still hangs on the first row");

  // That renewal runs out; a plain reach check settles it where it stands, without any sweep.
  db.prepare("UPDATE grants SET expires_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", renewedId);
  assert.equal(s.platform.findGrant(F.owner_id, A.bot.id, "chat.public"), null, "a lapsed share is not a capability");
  const lapsed = db.prepare("SELECT status FROM grants WHERE id = ?").get(renewedId) as any;
  assert.equal(lapsed.status, "expired", "the reader settled the lapsed row in place");

  // The owner renews again after that lapse: a live row stands next to the lapsed one.
  const again = await req(s.base, "POST", `/v1/relationships/${relationshipId}/grants`, F.owner.token, { capability: "chat.public" });
  assert.ok(again.status < 300, JSON.stringify(again.body));
  const liveId = again.body.grant_id as string;
  assert.equal((db.prepare("SELECT status FROM grants WHERE id = ?").get(liveId) as any).status, "active");
  assert.equal((db.prepare("SELECT status FROM grants WHERE id = ?").get(renewedId) as any).status, "expired", "the lapsed row stayed where the reader left it");

  // A face-room door settles lapsed shares; the line is alive, so the seat is not this lapse's to take.
  await req(s.base, "GET", "/v1/face-rooms", B.owner.token);

  const seat = db.prepare("SELECT left_at FROM face_room_members WHERE room_id = ? AND bot_id = ?").get(roomId, F.bot.id) as any;
  assert.ok(seat && seat.left_at == null, "the seat stays while the line has a live row");
  assert.equal((db.prepare("SELECT status FROM grants WHERE id = ?").get(liveId) as any).status, "active", "the live row is untouched");
  assert.equal((db.prepare("SELECT status FROM grants WHERE id = ?").get(first.id) as any).status, "superseded", "the first row is untouched");
  assert.ok(firstUsage() && firstUsage().ended_at == null, "the first row's usage is untouched");
  const send = await req(s.base, "POST", `/v1/homes/${F.bot.id}/send`, F.owner.token, { from_bot_id: F.bot.id, to: B.bot.id, text: "still shared", room_id: roomId });
  assert.equal(send.status, 202, JSON.stringify(send.body));
});

/**
 * The same live line, with the seat on the lapsed row itself.
 * A renewal before the guest joins is what seats the guest, so `grant_rooms` records the usage on the row that was
 * active then. That row can lapse, be flipped to `expired` by a plain reader, and be renewed again, leaving the seat
 * on the lapsed row while a newer row is live. The line still holds the share, so this lapse gives nothing back.
 */
test("a lapse on a live line gives back a seat the lapsed row itself made", async (t) => {
  const s: any = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const F = await ownerWithBot(s.base, "fay");
  const custody = (o: any) => s.platform.enableCustody({ kind: "owner" as const, ownerId: o.owner_id }, o.bot.id, { private_key_pem: o.kp.privateKeyPem });
  custody(A); custody(B); custody(F);
  const relationshipId = await share(s.base, F, A);

  // The first renewal happens before the guest joins, so the seat is recorded on the renewed row.
  const renewed = await req(s.base, "POST", `/v1/relationships/${relationshipId}/grants`, F.owner.token, { capability: "chat.public" });
  assert.ok(renewed.status < 300, JSON.stringify(renewed.body));
  const renewedId = renewed.body.grant_id as string;

  const code = "858588";
  const host = await req(s.base, "POST", "/v1/face-rooms/join", B.owner.token, { code, bots: [B.bot.id] });
  assert.equal(host.status, 200, JSON.stringify(host.body));
  const roomId = host.body.room_id as string;
  const brought = await req(s.base, "POST", "/v1/face-rooms/join", A.owner.token, { code, bots: [A.bot.id, F.bot.id] });
  assert.equal(brought.status, 200, JSON.stringify(brought.body));

  const db = s.platform.db;
  const first = db.prepare("SELECT id FROM grants WHERE grantor_owner = ? AND grantee_bot = ? AND capability = 'chat.public' AND status = 'superseded'").get(F.owner_id, A.bot.id) as any;
  assert.ok(first, "the share the renewal replaced is still there as the superseded row");
  const ownUsage = () => db.prepare("SELECT ended_at FROM grant_rooms WHERE grant_id = ?").get(renewedId) as any;
  assert.ok(ownUsage(), "the seat hangs on the row that was active when the guest joined");
  assert.equal(ownUsage().ended_at, null, "that usage is still open");
  const firstUsages = (db.prepare("SELECT COUNT(*) n FROM grant_rooms WHERE grant_id = ?").get(first.id) as any).n;
  assert.equal(firstUsages, 0, "the replaced row holds no seat of its own");

  // That row runs out; a plain reach check settles it in place, without any sweep, then the owner renews again.
  db.prepare("UPDATE grants SET expires_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", renewedId);
  assert.equal(s.platform.findGrant(F.owner_id, A.bot.id, "chat.public"), null, "a lapsed share is not a capability");
  assert.equal((db.prepare("SELECT status FROM grants WHERE id = ?").get(renewedId) as any).status, "expired", "the reader settled the lapsed row in place");
  const again = await req(s.base, "POST", `/v1/relationships/${relationshipId}/grants`, F.owner.token, { capability: "chat.public" });
  assert.ok(again.status < 300, JSON.stringify(again.body));
  const liveId = again.body.grant_id as string;
  assert.equal((db.prepare("SELECT status FROM grants WHERE id = ?").get(liveId) as any).status, "active");

  // A face-room door settles lapsed shares; the line is alive, so the seat the lapsed row made stays.
  await req(s.base, "GET", "/v1/face-rooms", B.owner.token);

  const seat = db.prepare("SELECT left_at FROM face_room_members WHERE room_id = ? AND bot_id = ?").get(roomId, F.bot.id) as any;
  assert.ok(seat && seat.left_at == null, "the seat the lapsed row made stays while the line has a live row");
  assert.equal((db.prepare("SELECT status FROM grants WHERE id = ?").get(liveId) as any).status, "active", "the live row is untouched");
  assert.equal((db.prepare("SELECT status FROM grants WHERE id = ?").get(first.id) as any).status, "superseded", "the replaced row is untouched");
  assert.equal(ownUsage().ended_at, null, "the lapsed row's usage is untouched");
  const send = await req(s.base, "POST", `/v1/homes/${F.bot.id}/send`, F.owner.token, { from_bot_id: F.bot.id, to: B.bot.id, text: "still shared", room_id: roomId });
  assert.equal(send.status, 202, JSON.stringify(send.body));
});

/**
 * The same live line, gone quiet twice: once the newest row runs out too, the seat follows.
 * While a newer row is alive, a lapse on an older row gives nothing back. When the newest row runs out in its turn
 * the line has no live row left, and the sweep reached through that row must reach the seat an older row made.
 */
test("a line whose last live row lapses gives the seat back", async (t) => {
  const s: any = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const F = await ownerWithBot(s.base, "fay");
  const custody = (o: any) => s.platform.enableCustody({ kind: "owner" as const, ownerId: o.owner_id }, o.bot.id, { private_key_pem: o.kp.privateKeyPem });
  custody(A); custody(B); custody(F);
  const relationshipId = await share(s.base, F, A);

  // The first renewal happens before the guest joins, so the seat is recorded on the renewed row.
  const renewed = await req(s.base, "POST", `/v1/relationships/${relationshipId}/grants`, F.owner.token, { capability: "chat.public" });
  assert.ok(renewed.status < 300, JSON.stringify(renewed.body));
  const renewedId = renewed.body.grant_id as string;

  const code = "858589";
  const host = await req(s.base, "POST", "/v1/face-rooms/join", B.owner.token, { code, bots: [B.bot.id] });
  assert.equal(host.status, 200, JSON.stringify(host.body));
  const roomId = host.body.room_id as string;
  const brought = await req(s.base, "POST", "/v1/face-rooms/join", A.owner.token, { code, bots: [A.bot.id, F.bot.id] });
  assert.equal(brought.status, 200, JSON.stringify(brought.body));

  const db = s.platform.db;
  const ownUsage = () => db.prepare("SELECT ended_at FROM grant_rooms WHERE grant_id = ?").get(renewedId) as any;
  assert.ok(ownUsage(), "the seat hangs on the row that was active when the guest joined");
  assert.equal(ownUsage().ended_at, null, "that usage is still open");

  // That row runs out; a plain reach check settles it in place, then the owner renews once more.
  db.prepare("UPDATE grants SET expires_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", renewedId);
  assert.equal(s.platform.findGrant(F.owner_id, A.bot.id, "chat.public"), null, "a lapsed share is not a capability");
  assert.equal((db.prepare("SELECT status FROM grants WHERE id = ?").get(renewedId) as any).status, "expired", "the reader settled the lapsed row in place");
  const again = await req(s.base, "POST", `/v1/relationships/${relationshipId}/grants`, F.owner.token, { capability: "chat.public" });
  assert.ok(again.status < 300, JSON.stringify(again.body));
  const liveId = again.body.grant_id as string;
  assert.equal((db.prepare("SELECT status FROM grants WHERE id = ?").get(liveId) as any).status, "active");

  const seat = () => db.prepare("SELECT left_at FROM face_room_members WHERE room_id = ? AND bot_id = ?").get(roomId, F.bot.id) as any;

  // The line still has a live row, so this lapse gives the seat back to nobody.
  await req(s.base, "GET", "/v1/face-rooms", B.owner.token);
  assert.ok(seat() && seat().left_at == null, "the seat stays while the line has a live row");
  const firstSend = await req(s.base, "POST", `/v1/homes/${F.bot.id}/send`, F.owner.token, { from_bot_id: F.bot.id, to: B.bot.id, text: "still shared", room_id: roomId });
  assert.equal(firstSend.status, 202, JSON.stringify(firstSend.body));

  // Then the last live row runs out too: nothing on the line is live, so the next door takes the seat back.
  db.prepare("UPDATE grants SET expires_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", liveId);
  await req(s.base, "GET", "/v1/face-rooms", B.owner.token);

  assert.equal((db.prepare("SELECT status FROM grants WHERE id = ?").get(liveId) as any).status, "expired", "the last live row has lapsed");
  assert.ok(seat() && seat().left_at != null, "the seat an older row made is gone once the line has no live row");
  assert.notEqual(ownUsage().ended_at, null, "the lapsed row's usage is closed");
  const secondSend = await req(s.base, "POST", `/v1/homes/${F.bot.id}/send`, F.owner.token, { from_bot_id: F.bot.id, to: B.bot.id, text: "after the second lapse", room_id: roomId });
  assert.equal(secondSend.status, 403, "a send naming that room is refused");
  assert.equal(secondSend.body?.error?.code, "room_not_shared");
});
