/**
 * The hourly flush is the one delivery moment the platform owns when nobody opens the account. A card whose own
 * deadline passed while the batch waited is not waiting any more: the flush has to settle it through the expiry path
 * first, so the outlet hears `approval.decided` and its ledger line closes with that settlement. Without that, the
 * morning summary names a card that is already dead, closes its ledger line, and the expiry it was promised is
 * suppressed for good — the queue says "one item needs your decision" about a card the owner can no longer decide.
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
const noteRow = (s: any, approvalId: string) =>
  s.platform.db.prepare("SELECT delivered_at FROM approval_notifications WHERE approval_id = ?").get(approvalId) as any;
const approvalRow = (s: any, approvalId: string) =>
  s.platform.db.prepare("SELECT status, decided_at FROM approvals WHERE id = ?").get(approvalId) as any;
/** Move a card's deadline into the past, so the next sweep settles it. */
const lapsed = (s: any, approvalId: string) =>
  s.platform.db.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", approvalId);

/** A second Bot of the same owner, with no drafting duties: the owner's designated outlet. */
async function outletBot(owner: any, handle: string) {
  const kp = generateEd25519();
  const made: any = await owner.req("POST", "/v1/bots", { handle, public_key: { alg: "Ed25519", kid: "k1", value: kp.publicKey } });
  return made.bot_id as string;
}

/** A sleeping owner: a friend pair, a chat, and an outlet Bot inside a 22:00-07:00 UTC quiet window. */
async function nightOwner(s: any) {
  const { A, B } = await friends(s.base);
  const conv: any = await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "quiet flush" });
  const outlet = await outletBot(A.owner, "alice-outlet.bot");
  await settings(A.owner, { timezone: "UTC", notify_bot_id: outlet, quiet_start: "22:00", quiet_end: "07:00" });
  return { A, B, conv: conv.conversation_id as string, outlet };
}

/** One pending card for the owner's own Bot, written into a chat with a friend. */
async function heldCard(A: any, convId: string, text: string) {
  const d: any = await A.bot.draftMessage(convId, { text });
  assert.equal(d.status, "pending_approval", JSON.stringify(d));
  return d as { approval_id: string };
}

const flush = (s: any) => (s.platform as any).flushHeldApprovals();

test("the morning flush settles a card that lapsed while the batch waited, then summarises what still waits", async (t) => {
  const box: Box = { t: at(23, 30) };
  const s = await startServer({ now: () => box.t });
  t.after(s.stop);
  const { A, conv, outlet } = await nightOwner(s);

  const stale = await heldCard(A, conv, "a line whose deadline passes before morning");
  const waiting = await heldCard(A, conv, "a line that still waits");
  lapsed(s, stale.approval_id);
  assert.deepEqual(ofType(s, outlet, "approval.digest"), [], "inside the window nothing leaves");
  assert.equal(noteRow(s, stale.approval_id).delivered_at, null, "a held card is recorded, not delivered");

  box.t = at(8, 0);
  const flushed = flush(s);

  assert.equal(flushed, 1, "the still-waiting card's batch leaves");
  const row = approvalRow(s, stale.approval_id);
  assert.equal(row.status, "expired", "the flush settles the card whose own clock ran out");
  assert.ok(row.decided_at, "with the instant it settled");

  const decided = ofType(s, outlet, "approval.decided").filter((e: any) => e.approval_id === stale.approval_id);
  assert.equal(decided.length, 1, "the outlet hears the card settled, not that it waits");
  assert.equal(decided[0].decision, "expired");
  assert.ok(noteRow(s, stale.approval_id).delivered_at, "its ledger line is settled with that decision");

  const digests = ofType(s, outlet, "approval.digest");
  assert.equal(digests.length, 1, "the waiting card still leaves as one summary");
  assert.deepEqual(digests[0].approval_ids, [waiting.approval_id], "the summary names only cards that still wait");
  assert.equal(digests[0].count, 1);
  assert.equal(digests[0].pending_count, 1);
  assert.ok(noteRow(s, waiting.approval_id).delivered_at, "the waiting card's line closes with the summary");

  // The drafting Bot still hears its own card settle, exactly once.
  const mine = ofType(s, A.bot.id, "approval.decided").filter((e: any) => e.approval_id === stale.approval_id);
  assert.equal(mine.length, 1, "one decision for the Bot that wrote the line");
  assert.equal(mine[0].decision, "expired");

  // A second flush is a no-op for both cards.
  flush(s);
  assert.equal(ofType(s, outlet, "approval.digest").length, 1, "the batch is never summarised twice");
  assert.equal(ofType(s, outlet, "approval.decided").filter((e: any) => e.approval_id === stale.approval_id).length, 1, "one decision, not two");

  // The owner's queue: the lapsed card is gone from pending, and visible as expired.
  assert.deepEqual((await A.owner.req("GET", "/v1/approvals?status=pending")).approvals.map((a: any) => a.approval_id), [waiting.approval_id]);
  assert.ok((await A.owner.req("GET", "/v1/approvals?status=expired")).approvals.some((a: any) => a.approval_id === stale.approval_id));
});

test("a flush whose whole batch lapsed announces the settlement, not an empty summary", async (t) => {
  const box: Box = { t: at(23, 30) };
  const s = await startServer({ now: () => box.t });
  t.after(s.stop);
  const { A, conv, outlet } = await nightOwner(s);

  const stale = await heldCard(A, conv, "the only card in the batch lapses");
  lapsed(s, stale.approval_id);

  box.t = at(8, 0);
  const flushed = flush(s);

  assert.equal(flushed, 0, "no batch for a queue that no longer waits");
  assert.deepEqual(ofType(s, outlet, "approval.digest"), [], "the outlet is not asked to review a card that is gone");
  const decided = ofType(s, outlet, "approval.decided").filter((e: any) => e.approval_id === stale.approval_id);
  assert.equal(decided.length, 1, "the settlement is the announcement");
  assert.equal(decided[0].decision, "expired");
  assert.ok(noteRow(s, stale.approval_id).delivered_at);
  assert.deepEqual((await A.owner.req("GET", "/v1/approvals?status=pending")).approvals, []);
});
