// An action the owner approves from the console can still fail on the server: the slot is already busy, the
// meeting invite it accepts is gone, or the platform does not support the action. The decision endpoint answers
// 200 with `{status: "failed", reason}` (`decideApproval` → `executeAction`), and the conversation's action row
// keeps that code as `result: {error: reason}` (`getConversation`), so both facts reach the console. The console
// read neither: the toast always said "Approved" and the action line ended at the bare word "failed", leaving the
// owner unable to tell a booking that happened from one that did not, or why.
//
// These tests run the console (`public/ui.js`) in a vm sandbox whose `fetch` is the real API, render the approvals
// page, press the same Approve button an owner presses, and then read the chat page the owner opens afterwards.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { friends, inDays, startServer } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "public", "ui.js"), "utf8")
  .replace(/\nboot\(\);\s*$/, "\n;globalThis.__ui = { PAGES, setMe: (x) => { me = x; } };\n");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const el = (over: any = {}) => ({
  innerHTML: "", textContent: "", value: "", disabled: false, onclick: null, dataset: {} as Record<string, string>,
  style: {}, classList: { add() {}, remove() {} }, setAttribute() {}, removeAttribute() {}, appendChild() {},
  querySelector: () => null, querySelectorAll: () => [], ...over,
});

/**
 * The console in a vm sandbox with the real API behind `fetch`. The console binds a card's buttons by walking the
 * markup it just wrote (`$$("[data-apr]", root)` then `$$("[data-dec]", card)`), so the sandbox tree is built from
 * that markup: one card per `data-apr`, one button per `data-dec`, exactly the controls the owner can press.
 */
function consoleAt(base: string, token: string, me: any) {
  const toastEl = el();
  const rootEl = el();
  const view: any = el();
  const state = { html: "" };
  const calls: { method: string; path: string }[] = [];
  const generic = new Map<string, any>();

  let currentCards: any[] = [];
  const buildCards = () => {
    const found = [...state.html.matchAll(/<div class="card" data-apr="([^"]+)"/g)];
    currentCards = found.map((m, i) => {
      const chunk = state.html.slice(m.index!, i + 1 < found.length ? found[i + 1].index! : state.html.length);
      const buttons = [...chunk.matchAll(/<button class="[^"]*" data-dec="([^"]+)"/g)]
        .map((b) => el({ dataset: { dec: b[1] } }));
      return el({
        dataset: { apr: m[1] },
        querySelectorAll: (s: string) => (s === "[data-dec]" || s === "button" ? buttons : []),
      });
    });
  };
  view.querySelectorAll = (s: string) => (s === "[data-apr]" ? currentCards : []);
  Object.defineProperty(view, "innerHTML", {
    get: () => state.html,
    // A re-render replaces the subtree: the cards the previous page handed out are gone, as they are in a browser.
    set: (x: string) => { state.html = String(x); generic.clear(); buildCards(); },
  });

  const inDom = (id: string) => state.html.includes(`id="${id}"`) || String(rootEl.innerHTML).includes(`id="${id}"`);
  const byId = (id: string) => { if (!generic.has(id)) generic.set(id, el({ id })); return inDom(id) ? generic.get(id) : null; };

  const ctx: any = {
    localStorage: { getItem: () => token, setItem() {}, removeItem() {} },
    window: { addEventListener() {}, open() {} },
    document: {
      querySelector: (s: string) => {
        if (s === "#toast") return toastEl;
        if (s === "#view") return view;
        if (s === "#root") return rootEl;
        if (s.startsWith("#")) return byId(s.slice(1));
        return null;
      },
      querySelectorAll: () => [], getElementById: () => null, createElement: () => el(), activeElement: null,
    },
    location: { hash: "", origin: "https://example.test", reload() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: async (path: string, init?: any) => {
      const method = init?.method || "GET";
      calls.push({ method, path });
      const r = await fetch(base + path, { method, headers: init?.headers, body: init?.body });
      const json = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, json: async () => json };
    },
    setInterval() {}, setTimeout, clearTimeout, URLSearchParams, Intl, Date, console, confirm: () => true, prompt: () => null,
  };
  vm.runInNewContext(src, ctx);
  ctx.__ui.setMe(me);

  return {
    calls: () => calls.slice(),
    html: () => state.html,
    toast: () => toastEl.textContent,
    clearToast: () => { toastEl.textContent = ""; },
    /** Render the approvals page, where an action draft waits on its card. */
    renderApprovals: async () => { ctx.location.hash = "#/"; await ctx.__ui.PAGES[""](view); return state.html; },
    /** Render the chat page, where the action line lives. */
    renderChat: async (convId: string) => { ctx.location.hash = `#/chat/${convId}`; await ctx.__ui.PAGES.chat(view); return state.html; },
    /** Press the decision button an owner presses on the approval card. */
    press: async (aprId: string, dec = "approved") => {
      const card = view.querySelectorAll("[data-apr]").find((c: any) => c.dataset.apr === aprId);
      assert.ok(card, `the approvals page offers no card for ${aprId}`);
      const btn = card.querySelectorAll("[data-dec]").find((b: any) => b.dataset.dec === dec);
      assert.ok(btn, `the card offers no ${dec} button`);
      await btn.onclick();
      await sleep(20);
    },
  };
}

const meetingIntent = () => ({ type: "schedule_meeting", summary: "sync", params: { duration_minutes: 60, window: { start: inDays(1, 0), end: inDays(8, 23) } } });

/** A drafts a booking for a slot A's own calendar already holds, so approving it cannot succeed. */
async function conflictingBooking(s: any) {
  const { A, B } = await friends(s.base);
  const cid = (await A.bot.startConversation(B.bot.id, meetingIntent())).conversation_id as string;
  await A.owner.req("POST", "/v1/calendar/entries", { start: inDays(2, 10), end: inDays(2, 11), title: "Standup" });
  const act: any = await A.bot.draftAction(cid, "calendar.book", { title: "Sync", start: inDays(2, 10), end: inDays(2, 11), attendees: [B.bot.id] }, "plan");
  return { A, B, cid, approvalId: act.approval_id as string };
}

/** A drafts a booking for a slot that is free, so approving it succeeds. */
async function bookableMeeting(s: any) {
  const { A, B } = await friends(s.base);
  const cid = (await A.bot.startConversation(B.bot.id, meetingIntent())).conversation_id as string;
  const act: any = await A.bot.draftAction(cid, "calendar.book", { title: "Sync", start: inDays(3, 10), end: inDays(3, 11), attendees: [B.bot.id] }, "plan");
  return { A, B, cid, approvalId: act.approval_id as string };
}

/** The action row the chat page prints: a `<div class="sys">` that starts with the gear. */
const actsLine = (html: string) => (html.match(/<div class="sys">⚙ [^<]*<\/div>/) || [""])[0];

test("an approved booking that hits a conflict says why, on the action line and in the toast", async (t) => {
  const s = await startServer(); t.after(s.stop);
  const { A, cid, approvalId } = await conflictingBooking(s);
  const me = await A.owner.req("GET", "/v1/me");
  const page = consoleAt(s.base, A.owner.token, me);

  await page.renderApprovals();
  await page.press(approvalId);

  // What the server recorded: the decision was accepted, the action failed, and the reason is a code the console
  // has to turn into words. Nothing here may be invented by the console.
  const view: any = await A.bot.getConversation(cid);
  const failed = view.actions.find((x: any) => x.status === "failed");
  assert.ok(failed, "approving a booking for a busy slot leaves the action failed on the server");
  assert.equal(failed.result?.error, "calendar_conflict", "and the server says the time was busy");

  const toast = page.toast();
  assert.match(toast, /failed/, `the toast tells the owner the booking did not happen: "${toast}"`);
  assert.match(toast, /already busy/, `and says why, in words rather than a code: "${toast}"`);

  const html = await page.renderChat(cid);
  const line = actsLine(html);
  assert.match(line, /already busy/, `the action line says why it failed: ${line}`);
  assert.doesNotMatch(line, /· failed<\/div>/, `the line no longer ends at the bare word "failed": ${line}`);
});

test("the reason is on the page the owner reads later, not only in the one-shot toast", async (t) => {
  const s = await startServer(); t.after(s.stop);
  const { A, cid, approvalId } = await conflictingBooking(s);
  const me = await A.owner.req("GET", "/v1/me");
  const page = consoleAt(s.base, A.owner.token, me);

  await page.renderApprovals();
  await page.press(approvalId);
  await sleep(300); // the console re-renders the page 250 ms after a decision
  page.clearToast();

  const html = await page.renderChat(cid);
  const line = actsLine(html);
  assert.match(line, /already busy/, `a fresh read of the chat still names the reason: ${line}`);
  assert.doesNotMatch(line, /· failed<\/div>/, `and does not fall back to the bare word: ${line}`);
  assert.equal(page.toast(), "", "this read needed no toast at all");
});

test("a failure code the console does not know is shown verbatim, never swallowed", async (t) => {
  const s = await startServer(); t.after(s.stop);
  const { A, cid, approvalId } = await conflictingBooking(s);
  const me = await A.owner.req("GET", "/v1/me");
  const page = consoleAt(s.base, A.owner.token, me);

  await page.renderApprovals();
  await page.press(approvalId);
  const row = s.platform.db.prepare("SELECT id, status FROM actions WHERE conversation_id = ?").get(cid) as any;
  assert.equal(row.status, "failed", "the action row is the failed one the console will read");
  // A code this build has never seen: the owner still gets the code itself rather than an empty sentence.
  s.platform.db.prepare("UPDATE actions SET result = ? WHERE id = ?").run(JSON.stringify({ error: "mystery_code" }), row.id);

  const html = await page.renderChat(cid);
  const line = actsLine(html);
  assert.match(line, /mystery_code/, `an unknown code is printed as it arrived: ${line}`);
  assert.doesNotMatch(line, /· failed<\/div>/, `and even then the line does not end at the bare word: ${line}`);
});

test("a booking that succeeds still reads as before: the date on the line, a plain Approved toast", async (t) => {
  const s = await startServer(); t.after(s.stop);
  const { A, cid, approvalId } = await bookableMeeting(s);
  const me = await A.owner.req("GET", "/v1/me");
  const page = consoleAt(s.base, A.owner.token, me);

  await page.renderApprovals();
  await page.press(approvalId);
  assert.equal(page.toast(), "Approved", "a decision that went through says exactly what it said before");

  const html = await page.renderChat(cid);
  const line = actsLine(html);
  assert.match(line, /Book meetings · executed · \d{1,2}\/\d{1,2}, \d{2}:\d{2}/, `the successful booking still names its date: ${line}`);
  assert.doesNotMatch(line, /failed|busy|mystery/, `and says nothing about a failure: ${line}`);
});

const HOUR = 3600e3;
const iso = (ms: number) => new Date(ms).toISOString();

/** A server whose clock the test moves, so a card can outlive the meeting it names. */
async function clocked(t: any) {
  const clock = { now: Date.now() };
  const s = await startServer({ now: () => clock.now });
  t.after(s.stop);
  return { s, clock };
}

test("a card whose meeting already started says so, on the action line and in the toast", async (t) => {
  const { s, clock } = await clocked(t);
  const { A, B } = await friends(s.base);
  const cid = (await A.bot.startConversation(B.bot.id, meetingIntent())).conversation_id as string;
  // The draft is legal while the window is ahead; the owner then leaves it on the desk past the meeting.
  const act: any = await A.bot.draftAction(cid, "calendar.book", { title: "Late sync", start: iso(clock.now + 2 * HOUR), end: iso(clock.now + 3 * HOUR), attendees: [B.bot.id] }, "plan");
  clock.now += 4 * HOUR;

  const me = await A.owner.req("GET", "/v1/me");
  const page = consoleAt(s.base, A.owner.token, me);
  await page.renderApprovals();
  await page.press(act.approval_id);

  const row = s.platform.db.prepare("SELECT status, result FROM actions WHERE conversation_id = ?").get(cid) as any;
  assert.equal(row.status, "failed", "the server records the refusal");
  assert.equal(JSON.parse(row.result).error, "meeting_in_past", "and names the reason");

  const toast = page.toast();
  assert.match(toast, /failed/, `the toast tells the owner nothing was booked: "${toast}"`);
  assert.match(toast, /already started/, `and says why, in words rather than a code: "${toast}"`);

  const line = actsLine(await page.renderChat(cid));
  assert.match(line, /already started/, `the action line says why it failed: ${line}`);
  assert.doesNotMatch(line, /\(meeting_in_past\)/, `never the bare code: ${line}`);
});

test("an invitation that expired with its meeting says so, not a bare failed code", async (t) => {
  const { s, clock } = await clocked(t);
  const { A, B } = await friends(s.base);
  const cid = (await A.bot.startConversation(B.bot.id, meetingIntent())).conversation_id as string;
  const d: any = await A.bot.draftAction(cid, "calendar.book", { title: "Stale sync", start: iso(clock.now + 2 * HOUR), end: iso(clock.now + 3 * HOUR), attendees: [B.bot.id] }, "plan");
  const booked: any = await A.owner.req("POST", `/v1/approvals/${d.approval_id}/decision`, { decision: "approved" });
  assert.equal(booked.status, "executed");
  // The invitee drafts the answer while the meeting is still ahead, then the meeting passes.
  const acc: any = await B.bot.draftAction(cid, "calendar.accept_invite", { booking_id: booked.result.booking_id }, "ok");
  clock.now += 4 * HOUR;

  const me = await B.owner.req("GET", "/v1/me");
  const page = consoleAt(s.base, B.owner.token, me);
  await page.renderApprovals();
  await page.press(acc.approval_id);

  const toast = page.toast();
  assert.match(toast, /failed/, `the toast tells the owner nothing was accepted: "${toast}"`);
  assert.match(toast, /expired with its meeting/, `and says why, in words rather than a code: "${toast}"`);

  const html = await page.renderChat(cid);
  const line = (html.match(/<div class="sys">⚙ Accept meeting invite[^<]*<\/div>/) || [""])[0];
  assert.match(line, /expired with its meeting/, `the action line says why it failed: ${line}`);
  assert.doesNotMatch(line, /\(invite_expired\)/, `never the bare code: ${line}`);
});
