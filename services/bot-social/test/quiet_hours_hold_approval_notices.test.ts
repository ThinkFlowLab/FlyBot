/**
 * Quiet hours: the owner names a local window (`HH:MM` in their own zone) in which the platform must not wake the
 * designated notification Bot. Cards still wait; they are recorded in the announcement ledger and leave together as
 * one summary at the first delivery moment after the window ends, so a night of cards is one event and never a
 * second one for the same batch. Outside the window nothing changes: one card, one announcement.
 *
 * The clock the tests move is the platform's (`nowMs`), never the host clock: the window is read in the owner's
 * zone, which is set to UTC here so a fixed instant is a fixed wall time.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { expectApiError, friends, startServer } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));

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

/** One pending card for the owner's own Bot, written into a chat with a friend. */
async function heldCard(s: any, A: any, B: any, convId: string, text: string) {
  const d = await A.bot.draftMessage(convId, { text });
  assert.equal(d.status, "pending_approval", JSON.stringify(d));
  return d as { approval_id: string };
}

async function chat(s: any, A: any, B: any) {
  const c = await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "quiet hours" });
  return c.conversation_id as string;
}

test("a card written inside the quiet window is recorded, not announced", async (t) => {
  const box: Box = { t: at(23, 30) };
  const s = await startServer({ now: () => box.t });
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const conv = await chat(s, A, B);
  await settings(A.owner, { timezone: "UTC", notify_bot_id: A.bot.id });
  const me = await quiet(A.owner, "22:00", "07:00");
  assert.equal(me.quiet_start, "22:00");
  assert.equal(me.quiet_end, "07:00");

  const card = await heldCard(s, A, B, conv, "a line at 23:30");

  assert.deepEqual(ofType(s, A.bot.id, "approval.created"), [], "nothing wakes the Bot during its quiet hours");
  assert.deepEqual(ofType(s, A.bot.id, "approval.digest"), [], "the summary waits for the window to end");
  const row = noteRow(s, card.approval_id);
  assert.ok(row, "the card is still recorded, so it cannot be announced twice");
  assert.equal(row.delivered_at, null, "recorded is not delivered");
});

test("the held cards leave as one summary at the first delivery after the window", async (t) => {
  const box: Box = { t: at(23, 30) };
  const s = await startServer({ now: () => box.t });
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const conv = await chat(s, A, B);
  await settings(A.owner, { timezone: "UTC", notify_bot_id: A.bot.id });
  await quiet(A.owner, "22:00", "07:00");

  const night = await heldCard(s, A, B, conv, "a line at 23:30");
  box.t = at(8, 0);
  const morning = await heldCard(s, A, B, conv, "a line at 08:00");

  const digests = ofType(s, A.bot.id, "approval.digest");
  assert.equal(digests.length, 1, "the night's cards are one summary");
  assert.equal(digests[0].count, 1);
  assert.deepEqual(digests[0].approval_ids, [night.approval_id], "the summary names the card that waited");
  assert.deepEqual(ofType(s, A.bot.id, "approval.created").map((e) => e.approval_id), [morning.approval_id], "the card written after the window is announced at once");

  // The next delivery moment does not repeat the batch: only its own card is announced.
  const noon = await heldCard(s, A, B, conv, "a line at noon");
  assert.equal(ofType(s, A.bot.id, "approval.digest").length, 1, "the same batch is never summarised twice");
  assert.deepEqual(ofType(s, A.bot.id, "approval.created").map((e) => e.approval_id), [morning.approval_id, noon.approval_id]);
});

test("opening the queue after the window also delivers the summary, once", async (t) => {
  const box: Box = { t: at(23, 30) };
  const s = await startServer({ now: () => box.t });
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const conv = await chat(s, A, B);
  await settings(A.owner, { timezone: "UTC", notify_bot_id: A.bot.id });
  await quiet(A.owner, "22:00", "07:00");
  const held = await heldCard(s, A, B, conv, "a line at 23:30");

  box.t = at(9, 0);
  await A.owner.req("GET", "/v1/approvals?status=pending");
  await A.owner.req("GET", "/v1/approvals?status=pending");

  const digests = ofType(s, A.bot.id, "approval.digest");
  assert.equal(digests.length, 1, "the queue read is a delivery moment, and only one");
  assert.deepEqual(digests[0].approval_ids, [held.approval_id]);
});

test("outside the window a card is announced at once", async (t) => {
  const box: Box = { t: at(12, 0) };
  const s = await startServer({ now: () => box.t });
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const conv = await chat(s, A, B);
  await settings(A.owner, { timezone: "UTC", notify_bot_id: A.bot.id });
  await quiet(A.owner, "22:00", "07:00");

  const card = await heldCard(s, A, B, conv, "a line at noon");
  assert.deepEqual(ofType(s, A.bot.id, "approval.created").map((e) => e.approval_id), [card.approval_id], "the card is announced as before");
  assert.deepEqual(ofType(s, A.bot.id, "approval.digest"), []);
});

test("a window that crosses midnight covers the night and ends at its end", async (t) => {
  const box: Box = { t: at(21, 59) };
  const s = await startServer({ now: () => box.t });
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const conv = await chat(s, A, B);
  await settings(A.owner, { timezone: "UTC", notify_bot_id: A.bot.id });
  await quiet(A.owner, "22:00", "07:00");

  const before = await heldCard(s, A, B, conv, "a line at 21:59");
  box.t = at(23, 30);
  const evening = await heldCard(s, A, B, conv, "a line at 23:30");
  box.t = at(6, 59);
  const night = await heldCard(s, A, B, conv, "a line at 06:59");
  box.t = at(7, 0);
  const morning = await heldCard(s, A, B, conv, "a line at 07:00");

  assert.deepEqual(ofType(s, A.bot.id, "approval.created").map((e) => e.approval_id), [before.approval_id, morning.approval_id], "21:59 and 07:00 are outside the window, 23:30 and 06:59 are inside");
  const digests = ofType(s, A.bot.id, "approval.digest");
  assert.equal(digests.length, 1);
  assert.equal(digests[0].count, 2);
  assert.deepEqual(digests[0].approval_ids, [evening.approval_id, night.approval_id]);
});

test("a window that does not cross midnight leaves the night outside", async (t) => {
  const box: Box = { t: at(23, 30) };
  const s = await startServer({ now: () => box.t });
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const conv = await chat(s, A, B);
  await settings(A.owner, { timezone: "UTC", notify_bot_id: A.bot.id });
  await quiet(A.owner, "09:00", "17:00");

  const card = await heldCard(s, A, B, conv, "a line at 23:30");
  assert.deepEqual(ofType(s, A.bot.id, "approval.created").map((e) => e.approval_id), [card.approval_id], "a daytime window does not cover the night");
  assert.deepEqual(ofType(s, A.bot.id, "approval.digest"), []);
});

test("clearing the window restores immediate announcements and delivers what waited", async (t) => {
  const box: Box = { t: at(23, 30) };
  const s = await startServer({ now: () => box.t });
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const conv = await chat(s, A, B);
  await settings(A.owner, { timezone: "UTC", notify_bot_id: A.bot.id });
  await quiet(A.owner, "22:00", "07:00");
  const held = await heldCard(s, A, B, conv, "a line while quiet");

  const off = await quiet(A.owner, null, null);
  assert.equal(off.quiet_start, null);
  assert.equal(off.quiet_end, null);
  const now = await heldCard(s, A, B, conv, "a line with no quiet hours");
  assert.deepEqual(ofType(s, A.bot.id, "approval.created").map((e) => e.approval_id), [now.approval_id], "the card is announced at once again");
  const digests = ofType(s, A.bot.id, "approval.digest");
  assert.equal(digests.length, 1, "the card held before the switch was cleared still leaves as its summary");
  assert.deepEqual(digests[0].approval_ids, [held.approval_id]);
});

test("the setting takes both ends, a real clock, and a window that is not empty", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A } = await friends(s.base);
  await settings(A.owner, { timezone: "UTC" });

  await expectApiError(quiet(A.owner, "22:00", null), 400, "invalid_request");
  await expectApiError(quiet(A.owner, null, "07:00"), 400, "invalid_request");
  await expectApiError(quiet(A.owner, "7:00", "07:00"), 400, "invalid_request");
  await expectApiError(quiet(A.owner, "22:00", "24:00"), 400, "invalid_request");
  await expectApiError(quiet(A.owner, "22:00", "22:00"), 400, "invalid_request");
  await expectApiError(quiet(A.owner, 2200 as any, null), 400, "invalid_request");
  const untouched = await A.owner.req("GET", "/v1/me");
  assert.equal(untouched.quiet_start, null, "a refused patch writes nothing");
  assert.equal(untouched.quiet_end, null);

  // A bad zone in the same patch is refused before the quiet window is written.
  await expectApiError(settings(A.owner, { timezone: "Not/AZone", quiet_start: "22:00", quiet_end: "07:00" }), 400, "invalid_timezone");
  const still = await A.owner.req("GET", "/v1/me");
  assert.equal(still.quiet_start, null, "the quiet window was not written behind the refused zone");
});

test("the console's account area offers the two clocks", async () => {
  const src = readFileSync(join(here, "..", "public", "ui.js"), "utf8")
    .replace(/\nboot\(\);\s*$/, "\n;globalThis.__ui = { shell, saveQuietHours, setMe: (m) => { me = m; } };\n");
  const nodes = new Map<string, any>();
  const node = (k: string) => {
    if (!nodes.has(k)) nodes.set(k, { innerHTML: "", textContent: "", value: "", onclick: null, onchange: null, style: {}, classList: { add() {}, remove() {} }, setAttribute() {}, appendChild() {}, focus() {} });
    return nodes.get(k);
  };
  const calls: any[] = [];
  const ctx: any = {
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    window: { addEventListener() {} },
    document: { querySelector: (sel: string) => node(sel), querySelectorAll: () => [], getElementById: (sel: string) => node(sel), createElement: () => node("created") },
    location: { hash: "#/", origin: "https://example.test" },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: (path: string, init?: any) => {
      calls.push({ method: init?.method || "GET", path, body: init?.body ? JSON.parse(init.body) : undefined });
      const me = { kind: "owner", quiet_start: "22:00", quiet_end: "07:00", timezone: "UTC", bots: [] };
      return Promise.resolve(new Response(JSON.stringify(me), { status: 200, headers: { "content-type": "application/json" } }));
    },
    setInterval() {}, setTimeout, clearTimeout, URLSearchParams, Intl, Date, console, confirm: () => true, prompt: () => null,
  };
  vm.runInNewContext(src, ctx);
  ctx.__ui.setMe({ display_name: "Ada", username: "ada", timezone: "UTC", quiet_start: "22:00", quiet_end: "07:00", bots: [] });
  ctx.__ui.shell();
  const html = String(node("#root").innerHTML);
  assert.match(html, /id="qstart"[^>]*value="22:00"/, "the account area shows the window that is stored");
  assert.match(html, /id="qend"[^>]*value="07:00"/);

  node("#qstart").value = "23:00";
  node("#qend").value = "06:30";
  await ctx.__ui.saveQuietHours("23:00", "06:30");
  const patch = calls.find((c) => c.method === "PATCH" && c.path === "/v1/me");
  assert.ok(patch, "the clocks are saved through the account settings door");
  assert.equal(patch.body.quiet_start, "23:00");
  assert.equal(patch.body.quiet_end, "06:30");
});
