/**
 * A quiet-hours summary is a list of cards that are waiting for the owner. A card that was settled during the
 * night — approved, rejected, or cancelled by the emergency stop — is no longer waiting, so naming it in the
 * morning summary asks the owner to review something the queue no longer holds. The summary therefore reads the
 * queue now: only cards whose approval is still pending are named, and only those ledger lines are marked
 * delivered. A card the owner decided during the night keeps its line undelivered, which is the price of never
 * deleting a ledger row. One settlement is not silent, though: an expired card is announced by the sweep that expires
 * it (`approval.decided`), because the batch only ever names cards that still wait and holding this one back would be
 * silence for good — so its line is settled with it.
 *
 * The clock is the platform's (`nowMs`), and the owner's zone is UTC, so a fixed instant is a fixed wall time.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { BotClient } from "../src/client.js";
import { generateEd25519 } from "../src/crypto.js";
import { friends, startServer } from "./helpers.js";

type Box = { t: number };
const at = (h: number, m = 0) => Date.UTC(2026, 10, 6, h, m);

const settings = (owner: any, body: any) => owner.req("PATCH", "/v1/me", body);
const quiet = (owner: any, start: string | null, end: string | null) => settings(owner, { quiet_start: start, quiet_end: end });

const emitted = (s: any, botId: string) =>
  (s.platform.db.prepare("SELECT type, data FROM events WHERE bot_id = ? ORDER BY seq").all(botId) as any[])
    .map((e) => ({ type: e.type, data: JSON.parse(e.data) }));
const ofType = (s: any, botId: string, type: string) => emitted(s, botId).filter((e) => e.type === type).map((e) => e.data);
const noteRow = (s: any, approvalId: string) =>
  s.platform.db.prepare("SELECT delivered_at FROM approval_notifications WHERE approval_id = ?").get(approvalId) as any;

async function chat(s: any, A: any, B: any) {
  const c = await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "quiet hours" });
  return c.conversation_id as string;
}

/** One pending card for the owner's own Bot, written into a chat with a friend. */
async function heldCard(bot: any, convId: string, text: string) {
  const d = await bot.draftMessage(convId, { text });
  assert.equal(d.status, "pending_approval", JSON.stringify(d));
  return d as { approval_id: string };
}

/** The owner's Bot named as the notification outlet, inside a 22:00–07:00 window, in UTC. */
async function nightOwner(s: any) {
  const { A, B } = await friends(s.base);
  const conv = await chat(s, A, B);
  await settings(A.owner, { timezone: "UTC", notify_bot_id: A.bot.id });
  await quiet(A.owner, "22:00", "07:00");
  return { A, B, conv };
}

test("a card approved during the quiet window is not named in the morning summary", async (t) => {
  const box: Box = { t: at(23, 30) };
  const s = await startServer({ now: () => box.t });
  t.after(s.stop);
  const { A, conv } = await nightOwner(s);

  const settled = await heldCard(A.bot, conv, "a line at 23:30");
  await A.owner.req("POST", `/v1/approvals/${settled.approval_id}/decision`, { decision: "approved" });
  const card = (await A.owner.req("GET", "/v1/approvals?status=all")).approvals.find((a: any) => a.approval_id === settled.approval_id);
  assert.equal(card.status, "approved", "the card left the queue");

  box.t = at(8, 0);
  const queue = await A.owner.req("GET", "/v1/approvals?status=pending");
  assert.deepEqual(queue.approvals.map((a: any) => a.approval_id), [], "the decided card is no longer in the queue");

  assert.deepEqual(ofType(s, A.bot.id, "approval.digest"), [], "the summary names no card that already left the queue");
  assert.equal(noteRow(s, settled.approval_id).delivered_at, null, "the settled card's ledger line stays undelivered");
});

test("a rejected card is not named, and the card still waiting is", async (t) => {
  const box: Box = { t: at(23, 30) };
  const s = await startServer({ now: () => box.t });
  t.after(s.stop);
  const { A, conv } = await nightOwner(s);

  const waiting = await heldCard(A.bot, conv, "a line that waits");
  const rejected = await heldCard(A.bot, conv, "a line the owner refuses");
  const decided = await A.owner.req("POST", `/v1/approvals/${rejected.approval_id}/decision`, { decision: "rejected" });
  assert.equal(decided.status, "rejected");

  box.t = at(8, 0);
  await A.owner.req("GET", "/v1/approvals?status=pending");

  const digests = ofType(s, A.bot.id, "approval.digest");
  assert.equal(digests.length, 1, "the night still leaves one summary");
  assert.equal(digests[0].count, 1, "the summary counts the cards that are still waiting");
  assert.deepEqual(digests[0].approval_ids, [waiting.approval_id], "the summary names only the card in the queue");
  assert.equal(digests[0].pending_count, 1);
  assert.ok(noteRow(s, waiting.approval_id).delivered_at, "the waiting card's line is marked delivered");
  assert.equal(noteRow(s, rejected.approval_id).delivered_at, null, "the rejected card's line is not marked delivered");

  // The delivery moment does not repeat the batch.
  box.t = at(9, 0);
  await A.owner.req("GET", "/v1/approvals?status=pending");
  assert.equal(ofType(s, A.bot.id, "approval.digest").length, 1, "the same batch is never summarised twice");
});

test("a card cancelled by the emergency stop is not named", async (t) => {
  const box: Box = { t: at(23, 30) };
  const s = await startServer({ now: () => box.t });
  t.after(s.stop);
  const { A, conv } = await nightOwner(s);

  const stopped = await heldCard(A.bot, conv, "a line before the kill switch");
  const stop = await A.owner.req("POST", "/v1/emergency-stop", { bot_id: A.bot.id });
  assert.equal(stop.status, "frozen");

  box.t = at(8, 0);
  await A.owner.req("GET", "/v1/approvals?status=pending");

  assert.deepEqual(ofType(s, A.bot.id, "approval.digest"), [], "a cancelled card is not waiting, so there is nothing to summarise");
  // The outlet is told a cancellation rather than left waiting for a summary that will never name the card, so the
  // ledger line is settled with that announcement (the same rule #557 applies to an expired card).
  assert.ok(noteRow(s, stopped.approval_id).delivered_at, "the outlet is told the card settled, so its ledger line is settled too");
});

test("a card that expired before the window ended is not named", async (t) => {
  const box: Box = { t: at(23, 30) };
  const s = await startServer({ now: () => box.t });
  t.after(s.stop);
  const { A, conv } = await nightOwner(s);

  const stale = await heldCard(A.bot, conv, "a line whose deadline passes");
  // The expiry sweep reads the host clock, not the platform's movable one, so the deadline is moved into the past.
  s.platform.db.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", stale.approval_id);

  box.t = at(8, 0);
  const queue = await A.owner.req("GET", "/v1/approvals?status=all");
  const row = queue.approvals.find((a: any) => a.approval_id === stale.approval_id);
  assert.equal(row.status, "expired", "opening the queue runs the expiry sweep");

  assert.deepEqual(ofType(s, A.bot.id, "approval.digest"), [], "an expired card is not waiting, so there is nothing to summarise");
  assert.ok(noteRow(s, stale.approval_id).delivered_at, "the outlet is told the card settled, so its ledger line is settled too");
  const told = ofType(s, A.bot.id, "approval.decided").filter((e: any) => e.approval_id === stale.approval_id);
  assert.equal(told.length, 1, "one decision, not two: here the outlet is also the Bot that drafted the card");
});

test("a settled card of the owner's other Bot is not named either", async (t) => {
  const box: Box = { t: at(23, 30) };
  const s = await startServer({ now: () => box.t });
  t.after(s.stop);
  const { A, B, conv } = await nightOwner(s);

  // A second Bot of the same owner: the ledger line is written for the owner's notification outlet, so the
  // summary reads it beside the first Bot's cards; only the queue decides whether it is still waiting.
  const kp = generateEd25519();
  const made = await A.owner.req("POST", "/v1/bots", { handle: "alice-two.bot", public_key: { alg: "Ed25519", kid: "k1", value: kp.publicKey } });
  const second = new BotClient({ base: s.base, botId: made.bot_id, token: made.bot_token, kid: "k1", privateKeyPem: kp.privateKeyPem });
  const rel = await A.owner.req("POST", "/v1/relationships", { from_bot_id: second.id, target_handle: B.handle, message: "hi", requested_capabilities: ["chat.public"] });
  await B.owner.req("POST", `/v1/relationships/${rel.relationship_id}/consent`, { decision: "accept", grant_capabilities: [] });
  const other = await second.startConversation(B.bot.id, { type: "general_chat", summary: "second bot" });

  const waiting = await heldCard(A.bot, conv, "a line that waits");
  const settled = await heldCard(second, other.conversation_id, "a line from the other Bot");
  await A.owner.req("POST", `/v1/approvals/${settled.approval_id}/decision`, { decision: "approved" });
  const settledCard = (await A.owner.req("GET", "/v1/approvals?status=all")).approvals.find((a: any) => a.approval_id === settled.approval_id);
  assert.equal(settledCard.status, "approved");

  box.t = at(8, 0);
  await A.owner.req("GET", "/v1/approvals?status=pending");

  const digests = ofType(s, A.bot.id, "approval.digest");
  assert.equal(digests.length, 1);
  assert.equal(digests[0].count, 1, "the summary counts only what waits");
  assert.deepEqual(digests[0].approval_ids, [waiting.approval_id], "the other Bot's settled card is not named");
  assert.equal(digests[0].pending_count, 1);
  assert.ok(noteRow(s, waiting.approval_id).delivered_at);
  assert.equal(noteRow(s, settled.approval_id).delivered_at, null);
});

test("a night with nothing decided is summarised exactly as before", async (t) => {
  const box: Box = { t: at(23, 30) };
  const s = await startServer({ now: () => box.t });
  t.after(s.stop);
  const { A, conv } = await nightOwner(s);

  const first = await heldCard(A.bot, conv, "a line at 23:30");
  box.t = at(6, 59);
  const second = await heldCard(A.bot, conv, "a line at 06:59");

  box.t = at(8, 0);
  await A.owner.req("GET", "/v1/approvals?status=pending");

  const digests = ofType(s, A.bot.id, "approval.digest");
  assert.equal(digests.length, 1);
  assert.equal(digests[0].count, 2);
  assert.deepEqual(digests[0].approval_ids, [first.approval_id, second.approval_id]);
  assert.equal(digests[0].pending_count, 2);
  assert.ok(noteRow(s, first.approval_id).delivered_at);
  assert.ok(noteRow(s, second.approval_id).delivered_at);
});
