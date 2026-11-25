// P1 (#210): the chat header rendered `Extend 4 turns` on every open, awaiting-approval and paused conversation,
// and the click always toasted "Extended". Conversations have had no turn limit since the owner decision on
// 2026-10-19 (`src/platform.ts:2454`), and `extendConversation` discards the body (`src/platform.ts:2714`, `void body;`):
// on an `open` or `awaiting_approval` chat the request changes no state at all, because `resumeConversation` only
// writes a status when the chat is not already one of those two (`src/platform.ts:2721`). Only a paused chat is
// really resumed, so its control has to say "Resume chat" and the other two must not offer one.
//
// These tests are behavioural, not layout: each one renders the page, clicks the control the page actually offers
// (found through the same `$("#ext")` hook the console binds), and then reads the toast the owner would see and
// the conversation the page re-reads.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "public", "ui.js"), "utf8")
  .replace(/\nboot\(\);\s*$/, "\n;globalThis.__ui = { PAGES, setMe: (x) => { me = x; } };\n");

const conversation = (status: string) => ({
  conversation_id: "cv_1", status, outcome: null, summary: null,
  intent: { type: "chat", summary: "Planning the week" }, turn: { count: 0, max: null },
  initiator: { bot_id: "bot_me", handle: "@me.bot", display_name: "Me", owner_display_name: "Me Owner" },
  peer: { bot_id: "bot_peer", handle: "@bob.bot", display_name: "Bob", owner_display_name: "Bob Owner" },
  messages: [], actions: [], effective_capabilities: { me_on_peer: [] },
});

const el = (extra: any = {}) => ({ innerHTML: "", textContent: "", onclick: null, classList: { add() {}, remove() {} }, querySelector: () => null, querySelectorAll: () => [], ...extra });

/**
 * The console in a sandbox with the conversation endpoints stubbed, so `PAGES.chat` can be rendered and clicked
 * without a server. `#toast`, `#ext` and `#cls` are registered so the page can bind and so the test can fire the
 * same handler an owner's click fires; `#ext` is only handed out when the rendered page really contains it.
 */
function renderChat(status: string) {
  const posts: { path: string; body: any }[] = [];
  const reads: { status: string; turns: number }[] = [];
  let lastExtendResponse: any = null;
  const conv = conversation(status);
  const toastEl = el();
  const extEl = el();
  const clsEl = el();
  const state = { html: "" };
  const view = el();
  Object.defineProperty(view, "innerHTML", {
    get: () => state.html,
    set: (x: string) => { state.html = x; },
  });

  const ctx: any = {
    localStorage: { getItem: () => "tkn", setItem() {}, removeItem() {} },
    window: { addEventListener() {}, open() {} },
    document: {
      querySelector: (s: string) => {
        if (s === "#toast") return toastEl;
        if (s === "#view") return view;
        if (s === "#root") return el();
        if (s === "#lo" || s === "#lo2") return el();
        if (s === "#ext") return /id="ext"/.test(state.html) ? extEl : null;
        if (s === "#cls") return /id="cls"/.test(state.html) ? clsEl : null;
        return null;
      },
      querySelectorAll: () => [], getElementById: () => null,
      createElement: () => el(),
    },
    location: { hash: "#/chat/cv_1", origin: "https://example.test", reload() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: async (path: string, init?: any) => {
      const method = init?.method || "GET";
      if (method === "POST") {
        posts.push({ path, body: init?.body ? JSON.parse(init.body) : undefined });
        // The shape the real endpoint returns for an open / awaiting_approval chat: nothing added, no turn limit.
        // `src/platform.ts:2708-2717` — `void body`, `return { …, max_turns: null }`.
        lastExtendResponse = { conversation_id: "cv_1", status, max_turns: null };
        return { ok: true, status: 200, json: async () => lastExtendResponse };
      }
      if (path === "/v1/conversations/cv_1") {
        reads.push({ status: conv.status, turns: conv.turn.count });
        return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(conv)) };
      }
      throw new Error(`unexpected request ${method} ${path}`);
    },
    setInterval() {}, setTimeout, clearTimeout, URLSearchParams, Intl, Date, console, confirm: () => true, prompt: () => null,
  };
  vm.runInNewContext(src, ctx);
  ctx.__ui.setMe({ owner_id: "own_1", display_name: "Test Owner", timezone: "UTC", bots: [{ id: "bot_me", handle: "@me.bot" }] });

  const settle = () => new Promise((r) => setTimeout(r, 30)); // the click re-renders the shell without awaiting it
  return async () => {
    await ctx.__ui.PAGES.chat(view);
    return {
      html: () => state.html,
      hasExt: () => /id="ext"/.test(state.html),
      label: () => (state.html.match(/id="ext">([^<]*)</) || [])[1],
      clickExt: async () => {
        assert.equal(typeof extEl.onclick, "function", "the control the page offers is bound to a handler");
        await extEl.onclick();
        await settle();
        return { toast: toastEl.textContent, posted: posts.slice(), response: lastExtendResponse, reads: reads.slice() };
      },
    };
  };
}

test("a paused chat offers a resume, and says so", async () => {
  const page = await renderChat("paused_loop")();
  assert.match(page.html(), /id="ext"/, "the one state that really resumes keeps a control");
  assert.equal(page.label(), "Resume chat", "and it is labelled for what the request does, not for four turns");
  const r = await page.clickExt();
  assert.equal(r.toast, "Resumed", `the toast reports the resume; it said "${r.toast}"`);
  assert.doesNotMatch(r.toast, /Extend|turns/, "no turn count anywhere: the conversation has no turn limit");
  assert.deepEqual(r.posted.map((p) => p.path), ["/v1/conversations/cv_1/extend"], "still the endpoint the server exposes");
  assert.equal(r.response.max_turns, null, "the server adds nothing, and the console no longer pretends otherwise");
});

test("a paused chat stopped by its owner is offered the same resume", async () => {
  const page = await renderChat("paused_stop")();
  assert.equal(page.label(), "Resume chat", "every paused_* state resumes the same way");
});

test("an open chat: clicking the offered control changes nothing, so it must not claim an extension", async () => {
  const page = await renderChat("open")();
  if (page.hasExt()) {
    const r = await page.clickExt();
    assert.doesNotMatch(r.toast, /Extended|turns/, `the click changed no state, yet the console said "${r.toast}"`);
    assert.equal(r.response.max_turns, null, "the server returned no turns");
    assert.deepEqual(r.reads[0], r.reads[r.reads.length - 1], "status and turn count are identical before and after the click");
    assert.deepEqual(r.reads[0], { status: "open", turns: 0 }, "an open chat is already running at zero turns");
  }
  assert.equal(page.hasExt(), false, "an open chat has nothing to extend and nothing to resume: no control at all");
});

test("an awaiting-approval chat: the click moves no state either, so the control goes", async () => {
  const page = await renderChat("awaiting_approval")();
  if (page.hasExt()) {
    const r = await page.clickExt();
    assert.doesNotMatch(r.toast, /Extended|turns/, `the click changed no state, yet the console said "${r.toast}"`);
    assert.equal(r.response.max_turns, null, "the server returned no turns");
    assert.deepEqual(r.reads[0], r.reads[r.reads.length - 1], "status and turn count are identical before and after the click");
  }
  assert.equal(page.hasExt(), false, "approving the pending message is the only action that moves this chat");
});
