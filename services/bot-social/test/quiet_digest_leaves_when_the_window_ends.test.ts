/**
 * Quiet hours only postpone an announcement. The card's ledger row is written at creation and left undelivered until
 * the window closes, but the existing delivery moments are both "something else happens": a new card outside the
 * window, or the owner opening the approval queue. An owner who sleeps through the night and touches nothing in the
 * morning therefore never hears the batch: the cards expire in place and the outlet is only told they settled.
 *
 * These tests pin the missing delivery moment the platform owns: a flush that walks the undelivered ledger rows and
 * lets the batch leave when the window is closed. They are the hook `src/main.ts`'s hourly tick calls; the tests call
 * it directly, on a controllable platform clock, with the owner's zone set to UTC so a fixed instant is a fixed wall
 * time.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { friends, startServer } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));

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

/** The delivery moment the platform owns; absent on a tree that has not grown it yet, which is the red. */
const flush = (s: any) => (s.platform as any).flushHeldApprovals?.();

/** One pending card for the owner's own Bot, written into a chat with a friend. */
async function heldCard(A: any, convId: string, text: string) {
  const d = await A.bot.draftMessage(convId, { text });
  assert.equal(d.status, "pending_approval", JSON.stringify(d));
  return d as { approval_id: string };
}

async function nightQuietOwner(s: any) {
  const { A, B } = await friends(s.base);
  const conv = (await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "quiet hours" })).conversation_id as string;
  await settings(A.owner, { timezone: "UTC", notify_bot_id: A.bot.id });
  await quiet(A.owner, "22:00", "07:00");
  return { A, B, conv };
}

test("the batch held through the night leaves at the first flush after the window, once", async (t) => {
  const box: Box = { t: at(23, 30) };
  const s = await startServer({ now: () => box.t });
  t.after(s.stop);
  const { A, conv } = await nightQuietOwner(s);

  const night = await heldCard(A, conv, "a line at 23:30");
  assert.equal(ofType(s, A.bot.id, "approval.digest").length, 0, "nothing leaves inside the window");
  assert.equal(noteRow(s, night.approval_id).delivered_at, null, "the batch is recorded, not delivered");

  box.t = at(8, 0);
  flush(s);
  const digests = ofType(s, A.bot.id, "approval.digest");
  assert.equal(digests.length, 1, "the window ended and nobody touched the account: the batch still leaves, exactly once");
  assert.equal(digests[0].count, 1);
  assert.equal(digests[0].approval_ids.length, 1, "the summary names the card that waited");
  assert.equal(digests[0].approval_ids[0], night.approval_id);
  assert.ok(noteRow(s, night.approval_id).delivered_at, "the ledger line closes, so the card cannot be announced twice");
  assert.equal(ofType(s, A.bot.id, "approval.created").length, 0, "a summary, not a per-card announcement");

  // A second flush is a no-op: the ledger is closed, so the same batch is never summarised again.
  const closed = noteRow(s, night.approval_id).delivered_at;
  flush(s);
  assert.equal(ofType(s, A.bot.id, "approval.digest").length, 1, "the same batch is never summarised twice");
  assert.equal(noteRow(s, night.approval_id).delivered_at, closed, "the second flush leaves the closed ledger alone");
});

test("a flush inside the window leaves the batch where it is", async (t) => {
  const box: Box = { t: at(23, 30) };
  const s = await startServer({ now: () => box.t });
  t.after(s.stop);
  const { A, conv } = await nightQuietOwner(s);
  const night = await heldCard(A, conv, "a line at 23:30");

  box.t = at(6, 59);
  flush(s);
  assert.equal(ofType(s, A.bot.id, "approval.digest").length, 0, "06:59 is still inside the window");
  assert.equal(noteRow(s, night.approval_id).delivered_at, null, "a skipped flush does not close the ledger");

  box.t = at(8, 0);
  flush(s);
  const digests = ofType(s, A.bot.id, "approval.digest");
  assert.equal(digests.length, 1, "the same batch leaves at the first flush after the window");
  assert.equal(digests[0].approval_ids[0], night.approval_id, "the flush names the card that waited");
});

test("reading the event feed after the window is not a delivery moment", async (t) => {
  const box: Box = { t: at(23, 30) };
  const s = await startServer({ now: () => box.t });
  t.after(s.stop);
  const { A, conv } = await nightQuietOwner(s);
  const night = await heldCard(A, conv, "a line at 23:30");

  box.t = at(8, 0);
  await A.bot.req("GET", "/v1/events");
  await A.bot.req("GET", "/v1/events");
  assert.equal(ofType(s, A.bot.id, "approval.digest").length, 0, "a read never mints a digest");
  assert.equal(noteRow(s, night.approval_id).delivered_at, null, "a read does not close the ledger either");

  flush(s);
  assert.equal(ofType(s, A.bot.id, "approval.digest").length, 1, "only the flush delivers the batch");
});

test("a flush with an empty ledger writes nothing", async (t) => {
  const box: Box = { t: at(8, 0) };
  const s = await startServer({ now: () => box.t });
  t.after(s.stop);
  const { A } = await nightQuietOwner(s);

  const before = emitted(s, A.bot.id).length;
  flush(s);
  flush(s);
  assert.equal(emitted(s, A.bot.id).length, before, "nothing held means nothing to say");
  assert.equal(ofType(s, A.bot.id, "approval.digest").length, 0);
});

/** `src/main.ts` starts a listener, so the suite never imports it; the hourly tick that reaches the flush is pinned
 *  as source. A tick that throws must not take the interval down, so the call sits in its own try/catch like the
 *  attachment sweep beside it. */
test("the hourly tick calls the flush, guarded so a throw cannot end the timer", () => {
  const src = readFileSync(join(here, "..", "src", "main.ts"), "utf8");
  const start = src.indexOf("setInterval(");
  assert.ok(start >= 0, "main.ts still has an hourly interval");
  const body = src.slice(start, src.indexOf("}, 3600e3)", start));
  assert.match(body, /platform\.cleanupAttachments\(\)/, "the attachment sweep still runs on the same tick");
  assert.match(body, /try \{[\s\S]*?platform\.flushHeldApprovals\(\)[\s\S]*?\} catch/, "the flush runs in its own try/catch on that tick");
});
