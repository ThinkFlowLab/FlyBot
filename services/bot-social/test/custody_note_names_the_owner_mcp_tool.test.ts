// The console has no Bot details page and no custody switch: `POST /v1/bots/{id}/custody` answers 404, and nothing in
// public/ renders a per-Bot settings screen. The only way an owner can let the platform hold a Bot's signing key is the
// owner MCP tool `enable_custody` (with `custody_status` to read it back), registered in src/owner-mcp.ts. The note that
// explains why the composer is missing still sent the owner to "its details page", which does not exist, so the page
// named a road that is not there. These cases run the real console against a real server and read the note the owner
// actually sees, then check the tools the sentence names are the ones the server really registers.
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
const ownerMcp = readFileSync(join(here, "..", "src", "owner-mcp.ts"), "utf8");
const matcher = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

const custody = (s: any, o: any) => s.platform.enableCustody({ kind: "owner" as const, ownerId: o.owner_id }, o.bot.id, { private_key_pem: o.kp.privateKeyPem });

const el = (over: any = {}) => ({
  innerHTML: "", textContent: "", value: "", disabled: false, onclick: null, dataset: {}, style: {},
  classList: { add() {}, remove() {} }, setAttribute() {}, removeAttribute() {}, appendChild() {},
  querySelector: () => null, querySelectorAll: () => [], ...over,
});

/** The chat page in a vm sandbox whose `fetch` is the real API; returns the note element it rendered. */
async function openChat(base: string, token: string, me: any, convId: string) {
  const toastEl = el();
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
      querySelector: (s: string) => (s === "#toast" ? toastEl : s === "#view" ? view : s.startsWith("#") ? byId(s.slice(1)) : null),
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
  const decoded = (text: string) => text.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const noteMatch = state.html.match(/id="composer-note"[^>]*>([^<]*)</);
  return { note: noteMatch ? decoded(noteMatch[1]) : null, hasComposer: /id="composer-text"/.test(state.html) };
}

test("the note sends the owner to the owner MCP tool that can actually hold the key", async (t) => {
  const s = await startServer(); t.after(s.stop);
  const { A, B } = await friends(s.base);
  const c = await B.bot.startConversation(A.bot.id, { type: "general_chat", summary: "Lunch" });
  const me = await A.owner.req("GET", "/v1/me");
  const page = await openChat(s.base, A.owner.token, me, c.conversation_id);
  assert.equal(page.hasComposer, false, "a Bot whose key the platform does not hold cannot be written as from the console");
  assert.ok(page.note !== null, "the page must say why there is no composer");
  assert.match(page.note!, matcher(A.handle), "it still names the Bot whose signing key is in the owner's hands");
  assert.match(page.note!, matcher("enable_custody"), "the way out it names is the owner MCP tool `enable_custody`");
  assert.doesNotMatch(page.note!, /details page/i, "there is no Bot details page, so the note cannot send the owner there");
  // The sentence may only name surfaces that exist: both tools it points at are registered on the owner MCP server.
  for (const tool of ["enable_custody", "custody_status"]) {
    assert.ok(page.note!.includes(tool), `the note names \`${tool}\``);
    assert.match(ownerMcp, new RegExp(`registerTool\\("${tool}"`), `src/owner-mcp.ts registers \`${tool}\``);
  }
});

test("a custodial Bot keeps its composer and needs no note at all", async (t) => {
  const s = await startServer(); t.after(s.stop);
  const { A, B } = await friends(s.base);
  custody(s, A);
  const c = await B.bot.startConversation(A.bot.id, { type: "general_chat", summary: "Lunch" });
  const me = await A.owner.req("GET", "/v1/me");
  const page = await openChat(s.base, A.owner.token, me, c.conversation_id);
  assert.equal(page.hasComposer, true, "the owner can write as this Bot");
  assert.equal(page.note, null, "nothing to explain, so no note");
});
