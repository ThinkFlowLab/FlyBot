/**
 * Quiet hours hold the announcement of a card that still waits: the ledger line is written, nothing is emitted, and
 * the batch leaves as one summary once the window ends. A card that settles while the window is open has no summary
 * to ride — that batch names only approvals whose status is still pending — so its line stayed undelivered for good
 * and the owner's designated outlet Bot heard nothing at all about a card that had already died.
 *
 * An expired card is terminal, so it is announced by the sweep that settles it instead of being held for a delivery
 * moment that will never name it: a 4h card inside a 9h night would otherwise be silent forever. That is also why the
 * event is not held until the window ends — a settlement is not an announcement quiet hours may postpone. The ledger
 * line is settled with it: a line that keeps saying "never delivered" for a card the outlet was told about cannot be
 * told apart from the defect.
 *
 * The expiry sweep reads the host clock, so a fixture moves a card's deadline into the past; the quiet window is read
 * on the platform clock in the owner's zone, set to UTC here so a fixed instant is a fixed wall time.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { generateEd25519 } from "../src/crypto.js";
import { friends, startServer } from "./helpers.js";

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
  const c = await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "quiet hours" });
  return c.conversation_id as string;
}

/** One pending card for the owner's own Bot, written into a chat with a friend. */
async function heldCard(bot: any, convId: string, text: string) {
  const d = await bot.draftMessage(convId, { text });
  assert.equal(d.status, "pending_approval", JSON.stringify(d));
  return d as { approval_id: string };
}

/** Move a card's deadline into the past, so the next sweep settles it. */
const expire = (s: any, approvalId: string) =>
  s.platform.db.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", approvalId);

test("a card that expires inside the quiet window still reaches the outlet, exactly once", async (t) => {
  const box: Box = { t: at(23, 30) };
  const s = await startServer({ now: () => box.t });
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const conv = await chat(A, B);
  const outlet = await outletBot(A.owner, "alice-outlet.bot");
  await settings(A.owner, { timezone: "UTC", notify_bot_id: outlet.id });
  await quiet(A.owner, "22:00", "07:00");

  const stale = await heldCard(A.bot, conv, "a line whose deadline passes before morning");
  const waiting = await heldCard(A.bot, conv, "a line that still waits");
  assert.deepEqual(ofType(s, outlet.id, "approval.created"), [], "nothing wakes the outlet inside the window");
  assert.equal(noteRow(s, stale.approval_id).delivered_at, null, "a held card is recorded, not delivered");

  expire(s, stale.approval_id);
  const queue = await A.owner.req("GET", "/v1/approvals?status=pending");
  assert.deepEqual(queue.approvals.map((a: any) => a.approval_id), [waiting.approval_id], "opening the queue settles the stale card");

  const told = ofType(s, outlet.id, "approval.decided");
  assert.equal(told.length, 1, "the outlet is told the card is settled");
  assert.equal(told[0].approval_id, stale.approval_id);
  assert.equal(told[0].decision, "expired");
  assert.ok(noteRow(s, stale.approval_id).delivered_at, "the ledger line is settled, not forever undelivered");
  assert.equal(noteRow(s, waiting.approval_id).delivered_at, null, "the card that still waits is not settled by its neighbour");
  const writer = ofType(s, A.bot.id, "approval.decided");
  assert.equal(writer.length, 1, "the Bot that drafted the card still hears its own decision");
  assert.equal(writer[0].approval_id, stale.approval_id);

  // The window ends: the card that waited leaves as its summary, and the expired one is never announced a second time.
  box.t = at(8, 0);
  await A.owner.req("GET", "/v1/approvals?status=pending");
  const digests = ofType(s, outlet.id, "approval.digest");
  assert.equal(digests.length, 1, "the batch of the night leaves once the window ends");
  assert.deepEqual(digests[0].approval_ids, [waiting.approval_id], "the settled card is not named in the summary");
  assert.equal(ofType(s, outlet.id, "approval.decided").length, 1, "the settled card is announced exactly once");
  assert.ok(noteRow(s, waiting.approval_id).delivered_at);
});

test("a card that expires when the outlet is also the drafting Bot is announced once, not twice", async (t) => {
  const box: Box = { t: at(23, 30) };
  const s = await startServer({ now: () => box.t });
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const conv = await chat(A, B);
  await settings(A.owner, { timezone: "UTC", notify_bot_id: A.bot.id });
  await quiet(A.owner, "22:00", "07:00");

  const stale = await heldCard(A.bot, conv, "a line whose deadline passes before morning");
  expire(s, stale.approval_id);
  await A.owner.req("GET", "/v1/approvals?status=pending");

  const decided = ofType(s, A.bot.id, "approval.decided").filter((e: any) => e.approval_id === stale.approval_id);
  assert.equal(decided.length, 1, "one Bot hears one decision, even when it is both writer and outlet");
  assert.equal(decided[0].decision, "expired");
  assert.ok(noteRow(s, stale.approval_id).delivered_at, "the outlet was told, so its ledger line is settled");

  box.t = at(8, 0);
  await A.owner.req("GET", "/v1/approvals?status=pending");
  assert.deepEqual(ofType(s, A.bot.id, "approval.digest"), [], "a settled card is not summarised in the morning");
});

test("outside the window a card is announced at creation, and its expiry adds nothing", async (t) => {
  const box: Box = { t: at(12, 0) };
  const s = await startServer({ now: () => box.t });
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const conv = await chat(A, B);
  const outlet = await outletBot(A.owner, "alice-outlet.bot");
  await settings(A.owner, { timezone: "UTC", notify_bot_id: outlet.id });

  const card = await heldCard(A.bot, conv, "a line at noon");
  assert.deepEqual(ofType(s, outlet.id, "approval.created").map((e: any) => e.approval_id), [card.approval_id], "a card outside the window is announced at once");
  assert.ok(noteRow(s, card.approval_id).delivered_at);

  expire(s, card.approval_id);
  await A.owner.req("GET", "/v1/approvals?status=pending");
  assert.deepEqual(ofType(s, outlet.id, "approval.decided"), [], "a card the outlet already heard about is not announced again when it expires");
  assert.ok(noteRow(s, card.approval_id).delivered_at);
});

test("a revoked outlet is skipped and the ledger keeps the record", async (t) => {
  const box: Box = { t: at(23, 30) };
  const s = await startServer({ now: () => box.t });
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const conv = await chat(A, B);
  const outlet = await outletBot(A.owner, "alice-outlet.bot");
  await settings(A.owner, { timezone: "UTC", notify_bot_id: outlet.id });
  await quiet(A.owner, "22:00", "07:00");

  const stale = await heldCard(A.bot, conv, "a line whose deadline passes before morning");
  // A setting written before the identity was revoked: the revocation door clears the outlet, this row is the state an
  // older build could leave behind, and the sweep must not write into a queue nobody can read.
  s.platform.db.prepare("UPDATE bots SET status = 'revoked' WHERE id = ?").run(outlet.id);

  expire(s, stale.approval_id);
  await A.owner.req("GET", "/v1/approvals?status=pending");

  assert.deepEqual(ofType(s, outlet.id, "approval.decided"), [], "a revoked identity is never written to");
  assert.equal(noteRow(s, stale.approval_id).delivered_at, null, "the ledger keeps the record of the announcement that could not be made");
});
