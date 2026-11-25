/**
 * A card that settles while the owner's quiet window is open was announced to nobody: quiet hours hold the ledger
 * line instead of emitting, and the held batch only ever names cards that still wait, so a card that is cancelled
 * during the night is silence for good. An expired card is announced by the sweep that settles it (#557); a cancelled
 * one is settled by `cancelPendingFor`, which told the Bot that drafted the card and left the owner's designated
 * outlet with nothing.
 *
 * The settlement that reaches the outlet is the same event the drafting Bot gets, with the same `decision` and
 * `reason` it carries: `{decision: "cancelled", reason: "emergency_stop"}` for the stop, `"revoked"` when the share
 * ends, `"room_left"` when the sender walks out of the room the line was written in, and `"grant_revoked"` when the
 * share is taken back from the granting side. The ledger line is settled in the same breath, exactly as an expired
 * card's is, because a row that keeps saying "never delivered" for a card the outlet was told about cannot be told
 * apart from the defect.
 *
 * Two deliberate silences stay:
 *  - the two cancel paths that pass no `notify` (a revoked member's own drafts, and the stale-row defence when a
 *    card is decided) never tell the outlet, and their ledger line keeps NULL as the record of an announcement
 *    never made;
 *  - a card whose approval carries no drafting Bot (`bot_id` empty) cannot be told to that Bot, and the outlet is
 *    still told.
 *
 * The sweep reads the host clock, so the fixtures move a card's deadline only in the test that needs an expiry; the
 * quiet window and the ledger are read on the platform clock in the owner's zone, set to UTC here.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { generateEd25519 } from "../src/crypto.js";
import { expectApiError, friends, startServer } from "./helpers.js";

type Box = { t: number };
const at = (h: number, m = 0) => Date.UTC(2026, 10, 6, h, m);

const settings = (owner: any, body: any) => owner.req("PATCH", "/v1/me", body);
const quiet = (owner: any, start: string | null, end: string | null) => settings(owner, { quiet_start: start, quiet_end: end });

/** Everything the platform has stored for one Bot, in order. */
const emitted = (s: any, botId: string) =>
  (s.platform.db.prepare("SELECT type, data FROM events WHERE bot_id = ? ORDER BY seq").all(botId) as any[])
    .map((e) => ({ type: e.type, data: JSON.parse(e.data) }));
const ofType = (s: any, botId: string, type: string) => emitted(s, botId).filter((e) => e.type === type).map((e) => e.data);
const noteRow = (s: any, approvalId: string) =>
  s.platform.db.prepare("SELECT delivered_at FROM approval_notifications WHERE approval_id = ?").get(approvalId) as any;

/** A second Bot of the same owner, with no drafting duties: the owner's designated outlet. */
async function outletBot(owner: any, handle: string) {
  const kp = generateEd25519();
  const made = await owner.req("POST", "/v1/bots", { handle, public_key: { alg: "Ed25519", kid: "k1", value: kp.publicKey } });
  return { id: made.bot_id as string };
}

async function chat(A: any, B: any) {
  const c = await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "cancelled card" });
  return c.conversation_id as string;
}

/** One pending card for the owner's own Bot, written into a chat with a friend. */
async function heldCard(bot: any, convId: string, text: string) {
  const d = await bot.draftMessage(convId, { text });
  assert.equal(d.status, "pending_approval", JSON.stringify(d));
  return d as { approval_id: string };
}

test("a card the stop cancels inside the quiet window reaches the outlet, exactly once", async (t) => {
  const box: Box = { t: at(23, 30) };
  const s = await startServer({ now: () => box.t });
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const conv = await chat(A, B);
  const outlet = await outletBot(A.owner, "alice-outlet.bot");
  await settings(A.owner, { timezone: "UTC", notify_bot_id: outlet.id });
  await quiet(A.owner, "22:00", "07:00");

  const held = await heldCard(A.bot, conv, "a line the stop cancels in the night");
  assert.deepEqual(ofType(s, outlet.id, "approval.created"), [], "nothing wakes the outlet inside the window");
  assert.equal(noteRow(s, held.approval_id).delivered_at, null, "a held card is recorded, not delivered");

  await A.owner.req("POST", "/v1/emergency-stop", { bot_id: A.bot.id });

  const told = ofType(s, outlet.id, "approval.decided");
  assert.equal(told.length, 1, "the outlet hears the card was settled");
  assert.equal(told[0].approval_id, held.approval_id);
  assert.equal(told[0].decision, "cancelled");
  assert.equal(told[0].reason, "emergency_stop", "the outlet reads the same reason the drafting Bot reads");
  assert.ok(noteRow(s, held.approval_id).delivered_at, "the ledger line is settled, not forever undelivered");
  const writer = ofType(s, A.bot.id, "approval.decided").filter((e: any) => e.approval_id === held.approval_id);
  assert.equal(writer.length, 1, "the Bot that drafted the card still hears its own decision");

  box.t = at(8, 0);
  await A.owner.req("GET", "/v1/approvals?status=pending");
  assert.deepEqual(ofType(s, outlet.id, "approval.digest"), [], "a settled card is not summarised in the morning");
  assert.equal(ofType(s, outlet.id, "approval.decided").length, 1, "the settled card is announced exactly once");
});

test("a card the stop cancels when the outlet is also the drafting Bot is announced once, not twice", async (t) => {
  const box: Box = { t: at(23, 30) };
  const s = await startServer({ now: () => box.t });
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const conv = await chat(A, B);
  await settings(A.owner, { timezone: "UTC", notify_bot_id: A.bot.id });
  await quiet(A.owner, "22:00", "07:00");

  const held = await heldCard(A.bot, conv, "a line the stop cancels");
  await A.owner.req("POST", "/v1/emergency-stop", { bot_id: A.bot.id });

  const decided = ofType(s, A.bot.id, "approval.decided").filter((e: any) => e.approval_id === held.approval_id);
  assert.equal(decided.length, 1, "one Bot hears one decision, even when it is both writer and outlet");
  assert.equal(decided[0].decision, "cancelled");
  assert.equal(decided[0].reason, "emergency_stop");
  assert.ok(noteRow(s, held.approval_id).delivered_at, "the outlet was told, so its ledger line is settled");
});

test("a card cancelled by the end of the share reaches the outlet named as revoked", async (t) => {
  const box: Box = { t: at(23, 30) };
  const s = await startServer({ now: () => box.t });
  t.after(s.stop);
  const { A, B, relId } = await friends(s.base);
  const conv = await chat(A, B);
  const outlet = await outletBot(A.owner, "alice-outlet.bot");
  await settings(A.owner, { timezone: "UTC", notify_bot_id: outlet.id });
  await quiet(A.owner, "22:00", "07:00");

  const held = await heldCard(A.bot, conv, "a line the end of the share cancels");
  await A.owner.req("DELETE", `/v1/relationships/${relId}`);

  const told = ofType(s, outlet.id, "approval.decided");
  assert.equal(told.length, 1, "the outlet hears the card was settled");
  assert.equal(told[0].approval_id, held.approval_id);
  assert.equal(told[0].decision, "cancelled");
  assert.equal(told[0].reason, "revoked");
  assert.ok(noteRow(s, held.approval_id).delivered_at, "the ledger line is settled with the announcement");
  assert.equal(ofType(s, A.bot.id, "approval.decided").filter((e: any) => e.approval_id === held.approval_id).length, 1);
});

test("a line the room drops when its sender walks out reaches the outlet named as room_left", async (t) => {
  const box: Box = { t: at(23, 30) };
  const s = await startServer({ now: () => box.t });
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const outlet = await outletBot(A.owner, "alice-outlet.bot");
  await settings(A.owner, { timezone: "UTC", notify_bot_id: outlet.id });
  await quiet(A.owner, "22:00", "07:00");

  // Both owners bring their Bot into one room, and A's Bot writes a line there during the night.
  const joined = await A.owner.req("POST", "/v1/face-rooms/join", { code: "616071", bots: [A.bot.id] });
  const roomId = joined.room_id as string;
  await B.owner.req("POST", "/v1/face-rooms/join", { code: "616071", bots: [B.bot.id] });
  await A.owner.req("POST", `/v1/face-rooms/${roomId}/start`);
  const held = await A.owner.req("POST", `/v1/face-rooms/${roomId}/messages`, { bot_id: A.bot.id, text: "a line the room drops in the night" });
  assert.equal(held.status, "pending_approval", JSON.stringify(held));
  assert.deepEqual(ofType(s, outlet.id, "approval.created"), [], "the held line waits for the morning, like any other card");

  await A.owner.req("POST", `/v1/face-rooms/${roomId}/leave`, { bots: [A.bot.id] });

  const told = ofType(s, outlet.id, "approval.decided");
  assert.equal(told.length, 1, "the outlet hears the line was settled");
  assert.equal(told[0].approval_id, held.approval_id);
  assert.equal(told[0].decision, "cancelled");
  assert.equal(told[0].reason, "room_left");
  assert.ok(noteRow(s, held.approval_id).delivered_at, "the ledger line is settled with the announcement");
  const writer = ofType(s, A.bot.id, "approval.decided").filter((e: any) => e.approval_id === held.approval_id);
  assert.equal(writer.length, 1, "the Bot that wrote the line still hears its own decision");
  assert.equal(writer[0].reason, told[0].reason, "the outlet reads the same reason the Bot reads");
});

test("a line a revoked share settles reaches the outlet named as grant_revoked", async (t) => {
  const box: Box = { t: at(23, 30) };
  const s = await startServer({ now: () => box.t });
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const conv = await chat(A, B);
  const outlet = await outletBot(A.owner, "alice-outlet.bot");
  await settings(A.owner, { timezone: "UTC", notify_bot_id: outlet.id });
  await quiet(A.owner, "22:00", "07:00");

  const held = await heldCard(A.bot, conv, "a line the revoked share settles");
  const grant = s.platform.db.prepare("SELECT id FROM grants WHERE grantor_owner = ? AND grantee_bot = ? AND capability = 'chat.public' AND IFNULL(room_id, '') = '' AND status = 'active'").get(B.owner_id, A.bot.id) as any;
  assert.ok(grant, "B's owner shared chat.public when the pair became friends");
  await B.owner.req("DELETE", `/v1/grants/${grant.id}`);

  const told = ofType(s, outlet.id, "approval.decided");
  assert.equal(told.length, 1, "the outlet hears the line was settled");
  assert.equal(told[0].approval_id, held.approval_id);
  assert.equal(told[0].decision, "cancelled");
  assert.equal(told[0].reason, "grant_revoked");
  assert.ok(noteRow(s, held.approval_id).delivered_at, "the ledger line is settled with the announcement");
  const writer = ofType(s, A.bot.id, "approval.decided").filter((e: any) => e.approval_id === held.approval_id);
  assert.equal(writer.length, 1, "the Bot that wrote the line still hears its own decision");
  assert.equal(writer[0].reason, told[0].reason, "the outlet reads the same reason the Bot reads");
});

test("a cancelled card whose approval names no drafting Bot still reaches the outlet", async (t) => {
  const box: Box = { t: at(23, 30) };
  const s = await startServer({ now: () => box.t });
  t.after(s.stop);
  const { A, B, relId } = await friends(s.base);
  const conv = await chat(A, B);
  const outlet = await outletBot(A.owner, "alice-outlet.bot");
  await settings(A.owner, { timezone: "UTC", notify_bot_id: outlet.id });
  await quiet(A.owner, "22:00", "07:00");

  const held = await heldCard(A.bot, conv, "a row an older build left without its writer");
  // The torn row: a card without a drafting Bot cannot be told to that Bot, but the owner's outlet is a different
  // Bot and the settlement is still news for it.
  s.platform.db.prepare("UPDATE approvals SET bot_id = NULL WHERE id = ?").run(held.approval_id);
  await A.owner.req("DELETE", `/v1/relationships/${relId}`);

  const told = ofType(s, outlet.id, "approval.decided");
  assert.equal(told.length, 1, "the outlet is told even when no drafting Bot could be");
  assert.equal(told[0].approval_id, held.approval_id);
  assert.equal(told[0].decision, "cancelled");
  assert.equal(told[0].reason, "revoked");
  assert.ok(noteRow(s, held.approval_id).delivered_at, "the ledger line is settled with the announcement");
});

test("outside the window the outlet already heard the card, so cancelling adds nothing", async (t) => {
  const box: Box = { t: at(12, 0) };
  const s = await startServer({ now: () => box.t });
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const conv = await chat(A, B);
  const outlet = await outletBot(A.owner, "alice-outlet.bot");
  await settings(A.owner, { timezone: "UTC", notify_bot_id: outlet.id });

  const held = await heldCard(A.bot, conv, "a line at noon");
  assert.deepEqual(ofType(s, outlet.id, "approval.created").map((e: any) => e.approval_id), [held.approval_id], "a card outside the window is announced at once");
  assert.ok(noteRow(s, held.approval_id).delivered_at);

  await A.owner.req("POST", "/v1/emergency-stop", { bot_id: A.bot.id });

  assert.deepEqual(ofType(s, outlet.id, "approval.decided"), [], "a card the outlet already heard about is not announced again when it is cancelled");
  assert.ok(noteRow(s, held.approval_id).delivered_at);
});

test("a cancel path that passes no notify leaves the outlet silent and the ledger line undelivered", async (t) => {
  const box: Box = { t: at(23, 30) };
  const s = await startServer({ now: () => box.t });
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const conv = await chat(A, B);
  const outlet = await outletBot(A.owner, "alice-outlet.bot");
  await settings(A.owner, { timezone: "UTC", notify_bot_id: outlet.id });
  await quiet(A.owner, "22:00", "07:00");

  const held = await heldCard(A.bot, conv, "a stale card of a Bot that no longer runs");
  // The row an older build leaves pending after its sender stopped: deciding it cancels it without `notify`, which
  // is deliberate — the drafting Bot has no token to read the decision with, and the outlet is not the addressee of
  // a silent sweep. The NULL ledger line is the record that nothing was announced.
  s.platform.db.prepare("UPDATE bots SET status = 'frozen' WHERE id = ?").run(A.bot.id);
  await expectApiError(A.owner.req("POST", `/v1/approvals/${held.approval_id}/decision`, { decision: "approve" }), 409, "invalid_state");

  assert.deepEqual(ofType(s, outlet.id, "approval.decided"), [], "the silent sweep does not wake the outlet");
  assert.equal(noteRow(s, held.approval_id).delivered_at, null, "the ledger keeps the record of the announcement never made");
  const row = s.platform.db.prepare("SELECT status FROM approvals WHERE id = ?").get(held.approval_id) as any;
  assert.equal(row.status, "cancelled", "the tick still records the silent cancellation");
});
