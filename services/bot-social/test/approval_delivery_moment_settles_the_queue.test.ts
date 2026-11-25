/**
 * Every door that writes an approval card also opens a delivery moment: the new card is announced, and outside the
 * owner's quiet window the cards held through the night go out with that announcement (`announceHeldApprovals`). A
 * card whose own deadline passed while it waited is not waiting any more, so that moment has to settle it through
 * the expiry path first. Without the sweep the morning summary names a card the owner can no longer decide, closes
 * its ledger line, and the settlement it was promised is suppressed for good — the same shape `#679` fixed for the
 * hourly flush, at the moment a card of our own is created.
 *
 * Four doors create a card of their own and did not sweep first: a grant request (`requestGrant`), a Bot-created
 * invite (`createInvite`), an action draft (`draftAction`) and a face-room draft (`draftFaceRoomMessage`).
 *
 * The expiry sweep reads the host clock (a fixture moves a deadline into the past); the quiet window is read on the
 * platform clock in the owner's zone, fixed to UTC here so a fixed instant is a fixed wall time.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { generateEd25519 } from "../src/crypto.js";
import { friends, startServer } from "./helpers.js";

type Box = { t: number };
const at = (h: number, m = 0) => Date.UTC(2026, 10, 6, h, m);

const settings = (owner: any, body: any) => owner.req("PATCH", "/v1/me", body);

/** Everything the platform has stored for one Bot, in order. */
const emitted = (s: any, botId: string) =>
  (s.platform.db.prepare("SELECT type, data FROM events WHERE bot_id = ? ORDER BY seq").all(botId) as any[])
    .map((e) => ({ type: e.type, ...JSON.parse(e.data) }));
const ofType = (s: any, botId: string, type: string) => emitted(s, botId).filter((e: any) => e.type === type);
const approvalRow = (s: any, approvalId: string) =>
  s.platform.db.prepare("SELECT status, decided_at FROM approvals WHERE id = ?").get(approvalId) as any;
const noteRow = (s: any, approvalId: string) =>
  s.platform.db.prepare("SELECT delivered_at FROM approval_notifications WHERE approval_id = ?").get(approvalId) as any;
/** Move a card's deadline into the past, so the next sweep settles it. */
const lapsed = (s: any, approvalId: string) =>
  s.platform.db.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", approvalId);

/** A second Bot of the same owner, with no drafting duties: the owner's designated outlet. */
async function outletBot(owner: any, handle: string) {
  const kp = generateEd25519();
  const made: any = await owner.req("POST", "/v1/bots", { handle, public_key: { alg: "Ed25519", kid: "k1", value: kp.publicKey } });
  return made.bot_id as string;
}

/** A sleeping owner: the named owner gets an outlet Bot and a 22:00-07:00 UTC quiet window. */
async function nightOwner(owner: any, handle: string) {
  const outlet = await outletBot(owner, handle);
  await settings(owner, { timezone: "UTC", notify_bot_id: outlet, quiet_start: "22:00", quiet_end: "07:00" });
  return outlet;
}

/** A card written during the window: recorded for the outlet, not delivered. */
async function heldCard(who: any, convId: string, text: string) {
  const d: any = await who.bot.draftMessage(convId, { text });
  assert.equal(d.status, "pending_approval", JSON.stringify(d));
  return d as { approval_id: string };
}

/** The claim under test: the held card settled, the outlet heard that settlement, and no summary named it instead. */
function assertSettledBeforeTheNewCard(s: any, held: { approval_id: string }) {
  const row = approvalRow(s, held.approval_id);
  assert.equal(row.status, "expired", "the card whose own clock ran out is settled, not announced as waiting");
  assert.ok(row.decided_at, "settled with the instant it happened");
  assert.ok(noteRow(s, held.approval_id).delivered_at, "its ledger line closes with the settlement");
}

function assertOutletHeardIt(s: any, outlet: string, held: { approval_id: string }) {
  const decided = ofType(s, outlet, "approval.decided").filter((e: any) => e.approval_id === held.approval_id);
  assert.equal(decided.length, 1, "the outlet hears the card settle once");
  assert.equal(decided[0].decision, "expired");
  const named = ofType(s, outlet, "approval.digest").filter((e: any) => (e.approval_ids ?? []).includes(held.approval_id));
  assert.equal(named.length, 0, "no summary names a card that already died");
}

const meetingIntent = () => ({ type: "schedule_meeting", summary: "quiet moment", params: { duration_minutes: 30, window: { start: "2026-11-07T09:00:00.000Z", end: "2026-11-07T10:00:00.000Z" } } });

test("a grant request settles the card that lapsed while the batch waited, before announcing its own", async (t) => {
  const box: Box = { t: at(23, 30) };
  const s = await startServer({ now: () => box.t });
  t.after(s.stop);
  const { A, B, relId } = await friends(s.base);
  const conv: any = await A.bot.startConversation(B.bot.id, meetingIntent());
  // The card a grant request writes belongs to the peer owner, so the peer owner is the one asleep.
  const outlet = await nightOwner(B.owner, "bob-outlet.bot");

  const held = await heldCard(B, conv.conversation_id, "a line held through the night");
  lapsed(s, held.approval_id);
  assert.deepEqual(ofType(s, outlet, "approval.digest"), [], "inside the window nothing leaves");

  box.t = at(8, 0);
  const req: any = await A.bot.requestGrant(relId, "calendar.freebusy.read");

  assertSettledBeforeTheNewCard(s, held);
  assertOutletHeardIt(s, outlet, held);
  assert.equal(approvalRow(s, req.approval_id).status, "pending", "the card just written still waits");
});

test("a Bot-created invite settles the card that lapsed while the batch waited, before announcing its own", async (t) => {
  const box: Box = { t: at(23, 30) };
  const s = await startServer({ now: () => box.t });
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const conv: any = await A.bot.startConversation(B.bot.id, meetingIntent());
  const outlet = await nightOwner(A.owner, "alice-outlet.bot");

  const held = await heldCard(A, conv.conversation_id, "a line held through the night");
  lapsed(s, held.approval_id);

  box.t = at(8, 0);
  const inv: any = await A.bot.signed("/v1/invites", "invite.create", { auto_accept: false, max_uses: 1 });

  assertSettledBeforeTheNewCard(s, held);
  assertOutletHeardIt(s, outlet, held);
  assert.equal(approvalRow(s, inv.approval_id).status, "pending", "the card just written still waits");
});

test("an action draft settles the card that lapsed while the batch waited, before announcing its own", async (t) => {
  const box: Box = { t: at(23, 30) };
  const s = await startServer({ now: () => box.t });
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const conv: any = await A.bot.startConversation(B.bot.id, meetingIntent());
  const outlet = await nightOwner(A.owner, "alice-outlet.bot");

  const held = await heldCard(A, conv.conversation_id, "a line held through the night");
  lapsed(s, held.approval_id);

  box.t = at(8, 0);
  const drafted: any = await A.bot.draftAction(conv.conversation_id, "calendar.book",
    { title: "Sync", start: "2026-11-07T10:00:00.000Z", end: "2026-11-07T11:00:00.000Z", attendees: [B.bot.id] }, "plan the week");

  assertSettledBeforeTheNewCard(s, held);
  assertOutletHeardIt(s, outlet, held);
  assert.equal(approvalRow(s, drafted.approval_id).status, "pending", "the card just written still waits");
});

test("a face-room draft settles the card that lapsed while the batch waited, before announcing its own", async (t) => {
  const box: Box = { t: at(23, 30) };
  const s = await startServer({ now: () => box.t });
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const conv: any = await A.bot.startConversation(B.bot.id, meetingIntent());
  const outlet = await nightOwner(A.owner, "alice-outlet.bot");

  // One open room holding both owners' Bots.
  const ownerA = { kind: "owner" as const, ownerId: A.owner_id };
  const ownerB = { kind: "owner" as const, ownerId: B.owner_id };
  const first = s.platform.joinFaceRoom(ownerA, { code: "840202", bots: [A.bot.id] });
  const second = s.platform.joinFaceRoom(ownerB, { code: "840202", bots: [B.bot.id] });
  assert.equal(second.room_id, first.room_id, "both owners are in the same room");
  s.platform.startFaceRoom(ownerA, first.room_id);
  const roomId = first.room_id as string;

  const held = await heldCard(A, conv.conversation_id, "a line held through the night");
  lapsed(s, held.approval_id);

  box.t = at(8, 0);
  const drafted: any = s.platform.draftFaceRoomMessage(ownerA, roomId, { text: "hello room" });

  assertSettledBeforeTheNewCard(s, held);
  assertOutletHeardIt(s, outlet, held);
  assert.equal(approvalRow(s, drafted.approval_id).status, "pending", "the card just written still waits");
});
