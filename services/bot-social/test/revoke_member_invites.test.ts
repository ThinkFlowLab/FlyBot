import assert from "node:assert/strict";
import { test } from "node:test";
import { expectApiError, ownerWithBot, startServer } from "./helpers.js";

// Bot Social #90: a revoked home member stays reachable through the room tickets it minted, and the two
// doors that hand an identity out (invite links, relationship requests) still answer for it.

const ROOM = "session-90b1c2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const owner = (o: any) => ({ kind: "owner" as const, ownerId: o.owner_id });

/** An owner with a FlyBot home and one local member, `writer`, that can mint room tickets. */
function seededHome(s: any, name: string) {
  const a = s.platform.onboardFlybot({ display_name: name });
  const A = owner(a);
  const writer = s.platform.addHomeMember(A, a.home.bot_id, { name: "writer", display_name: "Writer" });
  return { a, A, homeId: a.home.bot_id as string, writerId: writer.bot_id as string, writerHandle: writer.handle as string };
}

test("#90: removing a home member closes the local rooms it invited guests into", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const p = s.platform as any;
  const { A, homeId, writerId, writerHandle } = seededHome(s, "alice");
  const liveClaims = () => (s.platform.db.prepare("SELECT COUNT(*) n FROM local_room_invite_claims WHERE released_at IS NULL").get() as any).n as number;
  const activeGrants = () => (s.platform.db.prepare("SELECT COUNT(*) n FROM grants WHERE room_id = ? AND status = 'active'").get(ROOM) as any).n as number;

  const B = await ownerWithBot(s.base, "guest");
  const Bp = owner(B);
  p.enableCustody(Bp, B.bot.id, { private_key_pem: B.kp.privateKeyPem });

  const m = p.mintLocalRoomInvite(A, { room_id: ROOM, bot_id: writerId });
  assert.equal(p.claimLocalRoomInvite(Bp, m.ticket, { bots: [B.bot.id] }).claimed, true);
  assert.equal(p.sendAsMember(Bp, { from_bot_id: B.bot.id, to: writerHandle, text: "hello from the room", room_id: ROOM }).message.status, "delivered");

  // A second guest joined through a ticket that was withdrawn afterwards: a withdrawn link keeps the seats it
  // already made (owner decision 2024-10-24), so this pair is still reachable right up to the revocation.
  const C = await ownerWithBot(s.base, "quiet");
  const Cp = owner(C);
  const m2 = p.mintLocalRoomInvite(A, { room_id: ROOM, bot_id: writerId });
  assert.equal(p.claimLocalRoomInvite(Cp, m2.ticket, { bots: [C.bot.id] }).claimed, true);
  p.revokeLocalRoomInvite(A, m2.ticket);
  assert.notEqual(p.roomReach(C.bot.id, writerId, ROOM), null, "a withdrawn link keeps the guests already in");

  p.removeHomeMember(A, homeId, writerId);

  const row = s.platform.db.prepare("SELECT revoked_at FROM local_room_invites WHERE ticket = ?").get(m.ticket) as any;
  assert.ok(row.revoked_at, "the ticket is withdrawn with the identity that minted it");
  const withdrawn = s.platform.db.prepare("SELECT revoked_at FROM local_room_invites WHERE ticket = ?").get(m2.ticket) as any;
  assert.ok(withdrawn.revoked_at, "a ticket withdrawn earlier stays withdrawn");
  assert.equal(liveClaims(), 0, "no home keeps a live claim on the revoked member's tickets");
  assert.equal(activeGrants(), 0, "the room-scoped grants those claims wrote are ended");
  assert.equal(p.roomReach(B.bot.id, writerId, ROOM), null);
  assert.equal(p.roomReach(writerId, B.bot.id, ROOM), null);
  assert.equal(p.roomReach(C.bot.id, writerId, ROOM), null);

  // A second guest arriving with the ticket after the revocation is refused and writes nothing.
  const D = await ownerWithBot(s.base, "late");
  await expectApiError(Promise.resolve().then(() => p.claimLocalRoomInvite(owner(D), m.ticket, { bots: [D.bot.id] })), 410, "revoked");
  assert.equal((s.platform.db.prepare("SELECT COUNT(*) n FROM local_room_invite_claims WHERE ticket = ?").get(m.ticket) as any).n, 1, "the refused claim leaves no claim row");
  assert.equal(activeGrants(), 0, "a refused claim writes no grant");
});

test("#90: a claim is refused while the inviting Bot is not active, even on a ticket never withdrawn", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const p = s.platform as any;
  const { A, writerId } = seededHome(s, "alice");
  const B = await ownerWithBot(s.base, "guest");
  const Bp = owner(B);
  const m = p.mintLocalRoomInvite(A, { room_id: ROOM, bot_id: writerId });
  // A revocation that did not reach this ticket (another instance, or a row revoked before #90): the claim itself
  // must still not write grants to a Bot that is no longer active.
  s.platform.db.prepare("UPDATE bots SET status = 'revoked' WHERE id = ?").run(writerId);

  const err = await expectApiError(Promise.resolve().then(() => p.claimLocalRoomInvite(Bp, m.ticket, { bots: [B.bot.id] })), 403, "bot_revoked");
  assert.match(String(err.message), /revoked/i, "the refusal says the inviting Bot was revoked");
  assert.ok(String(err.message).length < 160, "one clear sentence");
  assert.equal((s.platform.db.prepare("SELECT COUNT(*) n FROM local_room_invite_claims WHERE ticket = ?").get(m.ticket) as any).n, 0, "no claim row is written");
  assert.equal((s.platform.db.prepare("SELECT COUNT(*) n FROM grants WHERE room_id = ?").get(ROOM) as any).n, 0, "no grant is written");
});

test("#90: re-adding the removed member does not reopen the room it used to share", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const p = s.platform as any;
  const { A, homeId, writerId, writerHandle } = seededHome(s, "alice");
  const B = await ownerWithBot(s.base, "guest");
  const Bp = owner(B);
  p.enableCustody(Bp, B.bot.id, { private_key_pem: B.kp.privateKeyPem });
  const m = p.mintLocalRoomInvite(A, { room_id: ROOM, bot_id: writerId });
  assert.equal(p.claimLocalRoomInvite(Bp, m.ticket, { bots: [B.bot.id] }).claimed, true);
  p.removeHomeMember(A, homeId, writerId);

  const again = p.addHomeMember(A, homeId, { name: "writer" });
  assert.equal(again.bot_id, writerId, "the same identity comes back");
  assert.equal(again.reactivated, true);
  assert.equal(again.handle, writerHandle);

  const row = s.platform.db.prepare("SELECT revoked_at FROM local_room_invites WHERE ticket = ?").get(m.ticket) as any;
  assert.ok(row.revoked_at, "the old ticket stays withdrawn across the re-add");
  assert.equal(p.roomReach(B.bot.id, writerId, ROOM), null, "nothing restores the old room's reach");
  assert.equal((s.platform.db.prepare("SELECT COUNT(*) n FROM grants WHERE room_id = ? AND status = 'active'").get(ROOM) as any).n, 0);
  assert.throws(
    () => p.sendAsMember(Bp, { from_bot_id: B.bot.id, to: writerHandle, text: "still here?", room_id: ROOM }),
    (e: any) => e.status === 403 && e.code === "room_not_shared",
  );
});

test("#90: a revoked Bot can no longer mint invite links, and asking for it answers like a handle that never existed", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const p = s.platform as any;
  const { A, homeId, writerId, writerHandle } = seededHome(s, "alice");
  p.removeHomeMember(A, homeId, writerId);

  await expectApiError(Promise.resolve().then(() => p.createInvite(A, { bot_id: writerId })), 403, "bot_revoked");

  const C = await ownerWithBot(s.base, "asker");
  const Cp = owner(C);
  const revoked = await expectApiError(
    Promise.resolve().then(() => p.requestRelationship(Cp, { from_bot_id: C.bot.id, target_handle: writerHandle })),
    404, "bot_not_found",
  );
  const ghostHandle = "@nobody.gone";
  const ghost = await expectApiError(
    Promise.resolve().then(() => p.requestRelationship(Cp, { from_bot_id: C.bot.id, target_handle: ghostHandle })),
    404, "bot_not_found",
  );
  // Byte-identical but for the handle the caller itself typed: same status, same code, same field set, same text.
  const shape = (e: any, handle: string) => ({
    status: e.status,
    code: e.code,
    fields: Object.getOwnPropertyNames(e).filter((k) => k !== "stack").sort(),
    message: String(e.message).split(handle).join("<handle>"),
  });
  assert.deepEqual(shape(revoked, writerHandle), shape(ghost, ghostHandle));
  assert.equal(/revok/i.test(String(revoked.message)), false, "the refusal never says the Bot once existed");
  assert.equal((s.platform.db.prepare("SELECT COUNT(*) n FROM relationships WHERE target_bot = ?").get(writerId) as any).n, 0, "no pending request is written to a revoked Bot");
});
