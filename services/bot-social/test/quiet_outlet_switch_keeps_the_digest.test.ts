// #423 promised that cards held through quiet hours leave together as one digest at the first delivery moment after
// the window. The ledger records the outlet that was set when each card was written; an owner who changes outlets
// while the batch waits must still receive the batch, at the outlet that is set when the window ends — otherwise the
// cards are addressed to a Bot nobody consults again and every one of them waits forever.
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
  s.platform.db.prepare("SELECT bot_id, delivered_at FROM approval_notifications WHERE approval_id = ?").get(approvalId) as any;

/** A second Bot of the same owner: the outlet the owner switches to while the batch waits. */
async function secondBot(owner: any, handle: string) {
  const kp = generateEd25519();
  const r: any = await owner.req("POST", "/v1/bots", { handle, public_key: { alg: "Ed25519", kid: "k1", value: kp.publicKey } });
  return r.bot_id as string;
}

/** One pending card for the sender's own Bot, written into a chat with a friend. */
async function heldCard(A: any, convId: string, text: string) {
  const d = await A.bot.draftMessage(convId, { text });
  assert.equal(d.status, "pending_approval", JSON.stringify(d));
  return d as { approval_id: string };
}

async function setup(t: any, hour = 23, minute = 30) {
  const box: Box = { t: at(hour, minute) };
  const s = await startServer({ now: () => box.t });
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  await settings(A.owner, { timezone: "UTC", notify_bot_id: A.bot.id });
  await quiet(A.owner, "22:00", "07:00");
  const conv = (await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "quiet outlet" })).conversation_id as string;
  return { s, A, B, box, conv };
}

test("the batch follows the outlet the owner has when the window ends", async (t) => {
  const { s, A, box, conv } = await setup(t);
  const card = await heldCard(A, conv, "a line at 23:30");
  assert.equal(noteRow(s, card.approval_id).delivered_at, null, "the card waits, recorded under the outlet of the moment");
  const next = await secondBot(A.owner, "ann1.next");
  const sw = await settings(A.owner, { notify_bot_id: next });
  assert.equal(sw.notify_bot_id, next, "the owner moved the outlet while the batch waited");

  box.t = at(8, 0);
  await A.owner.req("GET", "/v1/approvals?status=pending");
  await A.owner.req("GET", "/v1/approvals?status=pending");

  const digests = ofType(s, next, "approval.digest");
  assert.equal(digests.length, 1, "the batch leaves once, to the outlet that is now set");
  assert.equal(digests[0].count, 1);
  assert.deepEqual(digests[0].approval_ids, [card.approval_id], "the summary names the card that waited");
  assert.deepEqual(ofType(s, A.bot.id, "approval.digest"), [], "the replaced outlet is not woken for it");
  assert.ok(noteRow(s, card.approval_id).delivered_at, "the ledger records that the batch left");

  // A later delivery moment does not repeat it.
  box.t = at(9, 0);
  await A.owner.req("GET", "/v1/approvals?status=pending");
  assert.equal(ofType(s, next, "approval.digest").length, 1, "the same batch is never summarised twice");
});

test("clearing the outlet before naming the next one strands nothing", async (t) => {
  const { s, A, box, conv } = await setup(t);
  const card = await heldCard(A, conv, "a line at 23:30");
  await settings(A.owner, { notify_bot_id: null });
  const next = await secondBot(A.owner, "ann1.later");
  await settings(A.owner, { notify_bot_id: next });

  box.t = at(8, 0);
  await A.owner.req("GET", "/v1/approvals?status=pending");

  const digests = ofType(s, next, "approval.digest");
  assert.equal(digests.length, 1);
  assert.deepEqual(digests[0].approval_ids, [card.approval_id]);
  assert.ok(noteRow(s, card.approval_id).delivered_at);
});

test("two cards held for one owner leave as one digest after an outlet switch", async (t) => {
  const { s, A, box, conv } = await setup(t);
  const first = await heldCard(A, conv, "a line at 23:30");
  box.t = at(0, 30);
  const second = await heldCard(A, conv, "a line at 00:30");
  const next = await secondBot(A.owner, "ann1.next2");
  await settings(A.owner, { notify_bot_id: next });

  box.t = at(8, 0);
  await A.owner.req("GET", "/v1/approvals?status=pending");

  const digests = ofType(s, next, "approval.digest");
  assert.equal(digests.length, 1, "one batch, not one digest per card");
  assert.equal(digests[0].count, 2);
  assert.deepEqual(digests[0].approval_ids, [first.approval_id, second.approval_id], "both cards are named, in the order they waited");
  assert.ok(noteRow(s, first.approval_id).delivered_at);
  assert.ok(noteRow(s, second.approval_id).delivered_at);
});

test("control: without a switch the batch still leaves once, at the same outlet", async (t) => {
  const { s, A, box, conv } = await setup(t);
  const card = await heldCard(A, conv, "a line at 23:30");
  box.t = at(8, 0);
  await A.owner.req("GET", "/v1/approvals?status=pending");
  await A.owner.req("GET", "/v1/approvals?status=pending");

  const digests = ofType(s, A.bot.id, "approval.digest");
  assert.equal(digests.length, 1);
  assert.deepEqual(digests[0], { count: 1, approval_ids: [card.approval_id], pending_count: 1 }, "the summary is the same one it always was");
  assert.ok(noteRow(s, card.approval_id).delivered_at);
});

test("control: another owner's held card is not swept by this flush", async (t) => {
  const box: Box = { t: at(23, 30) };
  const s = await startServer({ now: () => box.t });
  t.after(s.stop);
  const one = await friends(s.base);
  const two = await friends(s.base);
  for (const h of [one, two]) {
    await settings(h.A.owner, { timezone: "UTC", notify_bot_id: h.A.bot.id });
    await quiet(h.A.owner, "22:00", "07:00");
  }
  const convOne = (await one.A.bot.startConversation(one.B.bot.id, { type: "general_chat", summary: "quiet outlet" })).conversation_id as string;
  const convTwo = (await two.A.bot.startConversation(two.B.bot.id, { type: "general_chat", summary: "quiet outlet" })).conversation_id as string;
  const cardOne = await heldCard(one.A, convOne, "one owner's line");
  const cardTwo = await heldCard(two.A, convTwo, "the other owner's line");

  box.t = at(8, 0);
  await one.A.owner.req("GET", "/v1/approvals?status=pending");
  assert.ok(noteRow(s, cardOne.approval_id).delivered_at, "the owner who read the queue was told");
  assert.equal(noteRow(s, cardTwo.approval_id).delivered_at, null, "another owner's batch is still theirs and still waiting");
  assert.deepEqual(ofType(s, two.A.bot.id, "approval.digest"), []);

  await two.A.owner.req("GET", "/v1/approvals?status=pending");
  const theirs = ofType(s, two.A.bot.id, "approval.digest");
  assert.equal(theirs.length, 1);
  assert.deepEqual(theirs[0].approval_ids, [cardTwo.approval_id], "each owner's batch names only their own card");
  assert.ok(noteRow(s, cardTwo.approval_id).delivered_at);
});

test("control: inside the window nothing leaves, whatever the outlet", async (t) => {
  const { s, A, box, conv } = await setup(t);
  const card = await heldCard(A, conv, "a line at 23:30");
  const next = await secondBot(A.owner, "ann1.stillquiet");
  await settings(A.owner, { notify_bot_id: next });
  await A.owner.req("GET", "/v1/approvals?status=pending");
  await A.owner.req("GET", "/v1/approvals?status=pending");

  assert.deepEqual(ofType(s, next, "approval.digest"), [], "the window has not ended");
  assert.deepEqual(ofType(s, A.bot.id, "approval.digest"), []);
  assert.equal(noteRow(s, card.approval_id).delivered_at, null);
});
