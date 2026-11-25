import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// An approved message that carried a file lost the file in the conversation view: the bubble rendered `text` and
// `structured` only, while the stored payload keeps `attachments` (id/name/size_label, `src/platform.ts`). The
// approval card already names the file; the chat the owner reads afterwards did not. Only the outbound side can
// carry one: an inbound message exposes `text`/`structured` alone, so nothing may be invented there.

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "public", "ui.js"), "utf8")
  .replace(/\nboot\(\);\s*$/, "\n;globalThis.__ui = { PAGES, me: () => me, setMe: (x) => { me = x; } };\n");

const ATT = { id: "att_1", name: "plan.md", size_label: "2.1 KB" };

const msg = (over: any = {}) => ({
  message_id: "m_1", direction: "outbound", status: "delivered", risk_flags: [],
  content: { text: "here is the plan", structured: null, attachments: [ATT] },
  created_at: "2026-10-30T09:00:00.000Z", delivered_at: "2026-10-30T09:00:01.000Z", ...over,
});

function conversation(messages: any[]) {
  return {
    conversation_id: "cv_1", status: "open", outcome: null, summary: null,
    intent: { type: "chat", summary: "Planning the week" }, turn: { count: 2, max: null },
    initiator: { bot_id: "bot_me", handle: "@me.bot", display_name: "Me", owner_display_name: "Me Owner" },
    peer: { bot_id: "bot_peer", handle: "@bob.bot", display_name: "Bob", owner_display_name: "Bob Owner" },
    messages, actions: [], effective_capabilities: { me_on_peer: [] },
  };
}

/** The console with the conversation endpoint stubbed, so `PAGES.chat` can be rendered without a server. */
function renderChat(conv: unknown) {
  const ctx: any = {
    localStorage: { getItem: () => "tkn", setItem() {}, removeItem() {} },
    window: { addEventListener() {} },
    document: { querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, createElement: () => ({ setAttribute() {}, appendChild() {}, style: {}, classList: { add() {}, remove() {} } }) },
    location: { hash: "#/chat/cv_1", origin: "https://example.test", reload() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: async (path: string) => {
      if (path !== "/v1/conversations/cv_1") throw new Error(`unexpected request ${path}`);
      return { ok: true, status: 200, json: async () => conv };
    },
    setInterval() {}, setTimeout, clearTimeout, URLSearchParams, Intl, Date, console, confirm: () => true, prompt: () => null,
  };
  vm.runInNewContext(src, ctx);
  ctx.__ui.setMe({ owner_id: "own_1", display_name: "Test Owner", timezone: "UTC", bots: [{ id: "bot_me", handle: "@me.bot" }] });
  return async () => {
    const v = { innerHTML: "", querySelector: () => null, querySelectorAll: () => [] } as any;
    await ctx.__ui.PAGES.chat(v);
    return v.innerHTML as string;
  };
}

test("an approved message keeps its file in the conversation: the bubble names it", async () => {
  const html = await renderChat(conversation([msg()]))();
  assert.match(html, /plan\.md/, "the file name is in the bubble, not only on the approval card");
  assert.match(html, /2\.1 KB/, "and its size");
  assert.match(html, /data-att="att_1"/, "with the same control the card uses to open it");
  assert.match(html, /here is the plan/, "the text is untouched");
});

test("a message without a file grows no attachment row", async () => {
  const html = await renderChat(conversation([msg({ content: { text: "no files here", structured: null } })]))();
  assert.match(html, /no files here/);
  assert.doesNotMatch(html, /data-att=/, "nothing to open, so no control");
  assert.doesNotMatch(html, /Attached:/, "and no empty label");
});

test("an inbound message never grows one: peer attachments are not in the API", async () => {
  const inbound = {
    message_id: "m_2", direction: "inbound", status: "delivered", risk_flags: [],
    untrusted_content: { text: "see this file", structured: null, attachments: [ATT] },
    security: { injection_suspected: false }, delivered_at: "2026-10-30T09:00:02.000Z",
  };
  const html = await renderChat(conversation([msg({ content: { text: "out loud", structured: null } }), inbound]))();
  assert.match(html, /see this file/, "the peer text is shown as data");
  assert.doesNotMatch(html, /data-att=/, "a peer cannot plant a file link the owner would open on its word");
});
