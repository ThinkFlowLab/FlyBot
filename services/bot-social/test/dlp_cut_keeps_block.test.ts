/*
 * #506 — a `block` finding past the DLP scan cut must still refuse the draft.
 *
 * `Platform.dlp` reads one text through `dlpText`, which used to cut it at 64 KiB (#495/#504). The cut was reported as
 * `{category: "dlp.truncated", action: "approve"}`, and the action doors refuse only a finding whose action is
 * `block` (`draftAction`, and the edited-params door in `executeAction`). A secret past the cut was therefore never
 * seen by either refusal: `311b987f` answered `422 dlp_blocked`, `d007e14` answered `202 pending_approval` on the
 * same `justification`. `justification` has no length assert of its own and is bounded only by the 256 KiB request
 * body, so the offset is reachable in one call.
 *
 * The scanner is linear now (test/dlp_scan_is_linear.test.ts); 64 KiB buys nothing it once did. The cap is lifted to
 * the request-body ceiling, and a text that is still cut fails closed: the block rules read every character, so a
 * finding can never hide past the cut. A cut with no block finding stays approvable, with `dlp.truncated` recorded.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { friends, inDays, startServer } from "./helpers.js";

const KiB = 1024;
const SECRET = " sk-" + "a".repeat(40); // `secret.api_key`, action `block`

const meetingIntent = () => ({ type: "schedule_meeting", summary: "plan", params: { duration_minutes: 30, window: { start: inDays(1, 0), end: inDays(5, 23) } } });
const rows = (s: any) => ({
  actions: (s.platform.db.prepare("SELECT COUNT(*) n FROM actions").get() as any).n as number,
  approvals: (s.platform.db.prepare("SELECT COUNT(*) n FROM approvals").get() as any).n as number,
});

test("#506: a secret past the 64 KiB cut still blocks the action draft", async (t) => {
  const s = await startServer(); t.after(s.stop);
  const { A, B } = await friends(s.base);
  const cid = (await A.bot.startConversation(B.bot.id, meetingIntent())).conversation_id as string;
  const justification = "x".repeat(66000) + SECRET; // the secret sits past 64 KiB

  await assert.rejects(
    A.bot.draftAction(cid, "calendar.book", { title: "Plan", start: inDays(2, 10), end: inDays(2, 11), attendees: [B.bot.id] }, justification),
    (e: any) => {
      assert.equal(e.status, 422, `a secret past the cut must be a 422, not a ${e.status} (${e.message})`);
      assert.equal(e.code, "dlp_blocked");
      return true;
    },
  );
  assert.deepEqual(rows(s), { actions: 0, approvals: 0 }, "a refused draft writes neither the card nor its action row");
});

test("#506: a secret that straddles the old cut is still seen", async (t) => {
  const s = await startServer(); t.after(s.stop);
  const { A, B } = await friends(s.base);
  const cid = (await A.bot.startConversation(B.bot.id, meetingIntent())).conversation_id as string;
  // `sk-` starts 4 characters before the old 64 KiB cut, so neither the head nor the tail alone holds the whole key.
  const justification = "x".repeat(64 * KiB - 4) + SECRET;

  await assert.rejects(
    A.bot.draftAction(cid, "calendar.book", { title: "Plan", start: inDays(2, 10), end: inDays(2, 11), attendees: [B.bot.id] }, justification),
    (e: any) => {
      assert.equal(e.status, 422, `a straddling secret must be a 422, not a ${e.status} (${e.message})`);
      assert.equal(e.code, "dlp_blocked");
      return true;
    },
  );
  assert.deepEqual(rows(s), { actions: 0, approvals: 0 });
});

test("#506: a block finding exactly at a scan boundary still refuses", async (t) => {
  const s = await startServer(); t.after(s.stop);
  const { A, B } = await friends(s.base);
  const cid = (await A.bot.startConversation(B.bot.id, meetingIntent())).conversation_id as string;
  // The secret ends exactly on the old 64 KiB boundary, and on the 256 KiB request-body boundary is the API's own 413.
  const justification = "x".repeat(64 * KiB - SECRET.length) + SECRET;
  assert.equal(justification.length, 64 * KiB);

  await assert.rejects(
    A.bot.draftAction(cid, "calendar.book", { title: "Plan", start: inDays(2, 10), end: inDays(2, 11), attendees: [B.bot.id] }, justification),
    (e: any) => {
      assert.equal(e.status, 422, `a secret ending on the boundary must be a 422, not a ${e.status} (${e.message})`);
      assert.equal(e.code, "dlp_blocked");
      return true;
    },
  );
});

test("#506: the block rules read a text past the cap in full, and a clean cut stays approvable", async (t) => {
  const s = await startServer(); t.after(s.stop);
  const { A } = await friends(s.base);
  const dlp = (text: string) => (s.platform as any).dlp(A.owner_id, { text }) as Array<{ category: string; action: string }>;

  // Over the cap with no block finding: still a cut, still no refusal — a long-but-clean card must not become a deny.
  const clean = dlp("y".repeat(300 * KiB));
  assert.ok(clean.some((f) => f.category === "dlp.truncated"), "the cut is still recorded for observability");
  assert.deepEqual(clean.filter((f) => f.action === "block"), [], "a clean text keeps no block finding");

  // Over the cap with the secret in the last characters: the block rules must still see it.
  const dirty = dlp("y".repeat(300 * KiB) + SECRET);
  assert.ok(dirty.some((f) => f.category === "secret.api_key" && f.action === "block"), "a secret past the cap is still a block finding");
});
