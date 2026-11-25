// The console's non-custodial note says whose signing key is in the owner's hands. The condition is about the
// owner's OWN Bot (`myBot.custodial !== true`: the platform does not hold its key, so the console cannot sign
// a line as it), but the sentence printed the peer's handle. The owner was told the other side's key was in
// their hands and sent to the other Bot's details page to turn on custody, while the switch that unblocks the
// composer is on their own Bot's page. These cases run the real console against a real server and read the
// note the owner sees.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { friends, startServer } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "public", "ui.js"), "utf8")
  .replace(/\nboot\(\);\s*$/, "\n;globalThis.__ui = { PAGES, setMe: (x) => { me = x; } };\n");

const custody = (s: any, o: any) => s.platform.enableCustody({ kind: "owner" as const, ownerId: o.owner_id }, o.bot.id, { private_key_pem: o.kp.privateKeyPem });
const matcher = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

const el = (over: any = {}) => ({
  innerHTML: "", textContent: "", value: "", disabled: false, onclick: null, dataset: {}, style: {},
  classList: { add() {}, remove() {} }, setAttribute() {}, removeAttribute() {}, appendChild() {},
  querySelector: () => null, querySelectorAll: () => [], ...over,
});

/** The console in a vm sandbox whose `fetch` is the real API; returns the note element the chat page rendered. */
async function openChat(base: string, token: string, me: any, convId: string) {
  const toastEl = el();
  const rootEl = el();
  const view: any = el();
  const state = { html: "" };
  const reg: Record<string, any> = {};
  Object.defineProperty(view, "innerHTML", {
    get: () => state.html,
    set: (x: string) => { state.html = String(x); for (const k of Object.keys(reg)) delete reg[k]; },
  });
  const inDom = (id: string) => state.html.includes(`id="${id}"`);
  const byId = (id: string) => { if (!reg[id]) reg[id] = el({ id }); return inDom(id) ? reg[id] : null; };
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
      querySelectorAll: () => [], getElementById: () => null, createElement: () => el(),
    },
    location: { hash: `#/chat/${convId}`, origin: "https://example.test", reload() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: async (path: string, init?: any) => {
      const r = await fetch(base + path, { method: init?.method || "GET", headers: init?.headers, body: init?.body });
      const json = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, json: async () => json };
    },
    setInterval() {}, setTimeout, clearTimeout, URLSearchParams, Intl, Date, console, confirm: () => true, prompt: () => null,
  };
  vm.runInNewContext(src, ctx);
  ctx.__ui.setMe(me);
  await ctx.__ui.PAGES.chat(view);
  // The page escapes the note for HTML; read what the owner actually sees, not the entity form.
  const decoded = (text: string) => text.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const noteMatch = state.html.match(/id="composer-note"[^>]*>([^<]*)</);
  return {
    html: state.html,
    note: noteMatch ? decoded(noteMatch[1]) : null,
    hasComposer: /id="composer-text"/.test(state.html),
  };
}

test("the note about a non-custodial key names the owner's own Bot, not the other side's", async (t) => {
  const s = await startServer(); t.after(s.stop);
  const { A, B } = await friends(s.base);
  // B's Bot opens the chat, so A's owner is the peer side and `self` is A's Bot — the one whose key the console lacks.
  const c = await B.bot.startConversation(A.bot.id, { type: "general_chat", summary: "Lunch" });
  const me = await A.owner.req("GET", "/v1/me");
  const page = await openChat(s.base, A.owner.token, me, c.conversation_id);
  assert.equal(page.hasComposer, false, "a Bot whose key the platform does not hold cannot be written as from the console");
  assert.ok(page.note !== null, "the page must say why there is no composer");
  assert.match(page.note!, matcher(A.handle), "the sentence names the Bot whose signing key is in the owner's hands — the owner's own");
  assert.doesNotMatch(page.note!, matcher(B.handle), "it must not name the other side's Bot");
  assert.match(page.note!,
    /signing key is in your hands, so the console cannot send as it — reply from your Bot's runtime, or run the enable_custody tool in your owner MCP session \(read it back with custody_status\) to let Bot Social hold the key, then refresh\.$/,
    "and the rest of the sentence is unchanged");
});

test("a custodial Bot that can be typed as keeps its composer and needs no note", async (t) => {
  const s = await startServer(); t.after(s.stop);
  const { A, B } = await friends(s.base);
  custody(s, A);
  const c = await B.bot.startConversation(A.bot.id, { type: "general_chat", summary: "Lunch" });
  const me = await A.owner.req("GET", "/v1/me");
  const page = await openChat(s.base, A.owner.token, me, c.conversation_id);
  assert.equal(page.hasComposer, true, "the owner can write as this Bot");
  assert.equal(page.note, null, "nothing to explain, so no note");
});

test("a room chat keeps its own sentence, unchanged", async (t) => {
  const s = await startServer(); t.after(s.stop);
  const { A, B } = await friends(s.base);
  custody(s, A);
  const join = await A.owner.req("POST", "/v1/face-rooms/join", { code: "484848", bots: [A.bot.id] });
  const inv = await A.owner.req("POST", `/v1/face-rooms/${join.room_id}/invites`, {});
  await B.owner.req("POST", "/v1/face-rooms/join-invite", { ticket: inv.ticket, bots: [B.bot.id] });
  const sent = await A.owner.req("POST", `/v1/homes/${A.bot.id}/send`, { from_bot_id: A.bot.id, to: B.bot.id, text: "welcome to the room", room_id: join.room_id });
  const me = await A.owner.req("GET", "/v1/me");
  const page = await openChat(s.base, A.owner.token, me, sent.conversation_id);
  assert.equal(page.hasComposer, false, "a room chat is answered from the room page");
  assert.equal(page.note, "This chat belongs to a room; answer from the room page.", "the room sentence is byte-for-byte what it was");
});

test("a chat that can no longer be answered needs no note about keys", async (t) => {
  const s = await startServer(); t.after(s.stop);
  const { A, B } = await friends(s.base);
  const c = await B.bot.startConversation(A.bot.id, { type: "general_chat", summary: "Lunch" });
  await B.bot.close(c.conversation_id, "abandoned");
  const me = await A.owner.req("GET", "/v1/me");
  const page = await openChat(s.base, A.owner.token, me, c.conversation_id);
  assert.equal(page.hasComposer, false, "a closed chat cannot be answered");
  assert.equal(page.note, null, "the page already says it is closed, so key custody is not the story");
});
