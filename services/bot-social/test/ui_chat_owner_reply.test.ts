// P4: the owner console could read a chat (GET /v1/conversations/:id) and approve what a Bot drafted, but the owner
// could never write a line themselves from the console. `POST /v1/homes/:id/send` already accepts an owner's token
// and stamps `typed_by_owner` when the caller is the owner's own credential (`src/platform.ts` `typedByOwner`), and
// the chat page already renders `✍ typed by owner` on such a message. What was missing is the composer, and the two
// facts a console needs to know whether it may show one:
//
//   - `listBots` has no `custodial` flag, so the page cannot tell whether *this* Bot's signing key is held by the
//     platform (`bot_custody`); sending through the configured key is a 409 `not_custodial` (`custodialBot`).
//   - `getConversation` has no `room_id`, so a conversation bound to a room is indistinguishable from a 1:1 one. A
//     send from a room chat goes to `/v1/homes/:id/send` without a `room_id`, which `sendAsMember` resolves through
//     `activeRelationship` — the 1:1 thread — so the line would silently land in another conversation.
//
// These tests are behavioural and run against a real server: the console (`public/ui.js`) runs in a vm sandbox whose
// `fetch` is the real API, so the 202 → re-read chain is exercised end to end. Each test reads the page the owner
// sees and, where the page offers a control, fires the same handler an owner's click fires.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { friends, ownerWithBot, startServer } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "public", "ui.js"), "utf8")
  .replace(/\nboot\(\);\s*$/, "\n;globalThis.__ui = { PAGES, setMe: (x) => { me = x; } };\n");

type Call = { method: string; path: string; body?: any };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The owner-side token as the console stores it, so `api()` sends the same Bearer a signed-in browser sends. */
const ownerToken = (o: any) => o.owner.token;
/** Opt a Bot into key custody the way Bot details does, so its signing key is held by the platform. */
const custody = (s: any, o: any) => s.platform.enableCustody({ kind: "owner" as const, ownerId: o.owner_id }, o.bot.id, { private_key_pem: o.kp.privateKeyPem });

const el = (over: any = {}) => ({
  innerHTML: "", textContent: "", value: "", disabled: false, onclick: null, dataset: {}, style: {},
  classList: { add() {}, remove() {} }, setAttribute() {}, removeAttribute() {}, appendChild() {},
  querySelector: () => null, querySelectorAll: () => [], ...over,
});

/**
 * The console in a vm sandbox with the real API behind `fetch`. Elements are handed out only when the rendered HTML
 * really contains them, exactly as a browser would: a page with no composer gives the test no box to type in.
 */
function openConsole(base: string, token: string, me: any, convId: string, opts: { slowSend?: Promise<void>; refuseSend?: string } = {}) {
  const calls: Call[] = [];
  const reg: Record<string, any> = {};
  const toastEl = el();
  const rootEl = el();
  const view: any = el();
  const state = { html: "" };
  Object.defineProperty(view, "innerHTML", {
    get: () => state.html,
    // A re-render really replaces the subtree: the elements the previous page handed out are gone, exactly as in a
    // browser, so a control the test kept a reference to is no longer the control the owner can press.
    set: (x: string) => { state.html = String(x); for (const k of Object.keys(reg)) delete reg[k]; },
  });

  const inDom = (id: string) => state.html.includes(`id="${id}"`) || String(rootEl.innerHTML).includes(`id="${id}"`);
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
      const method = init?.method || "GET";
      const body = init?.body ? JSON.parse(init.body) : undefined;
      calls.push({ method, path, body });
      if (method === "POST" && /\/send$/.test(path)) {
        if (opts.slowSend) await opts.slowSend;
        if (opts.refuseSend) return { ok: false, status: 409, json: async () => ({ error: { code: opts.refuseSend, message: "this bot's signing key is not held by the platform; enable custody first (enable_custody)" } }) };
      }
      const r = await fetch(base + path, { method, headers: init?.headers, body: init?.body });
      const json = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, json: async () => json };
    },
    setInterval() {}, setTimeout, clearTimeout, URLSearchParams, Intl, Date, console, confirm: () => true, prompt: () => null,
  };
  vm.runInNewContext(src, ctx);
  ctx.__ui.setMe(me);

  const page = {
    calls: () => calls.slice(),
    html: () => state.html,
    toast: () => toastEl.textContent,
    hasComposer: () => /id="composer-text"/.test(state.html),
    note: () => (state.html.match(/id="composer-note"[^>]*>([^<]*)</) || [])[1] ?? null,
    /** Render the chat page the way `render()` does, against the live API. */
    render: async () => { await ctx.__ui.PAGES.chat(view); return state.html; },
    /** Type into the composer and press Send; returns what the page and the request log look like afterwards. */
    send: async (text: string) => {
      const box = byId("composer-text"), btn = byId("send-line");
      assert.ok(box && btn, `no composer to type in: there is no text box (${!!box}) and no Send (${!!btn})`);
      box.value = text;
      const running = btn.onclick();
      let disabledWhileSending = null;
      if (opts.slowSend) { await sleep(10); disabledWhileSending = btn.disabled; }
      await running;
      await sleep(80); // a successful send re-renders the shell without awaiting it
      const after = byId("send-line") || btn; // a successful send re-renders, so the live Send is the new one
      return { calls: calls.slice(), html: state.html, value: box.value, disabled: after.disabled, disabledWhileSending };
    },
    /** Every control the page bound a handler to — the whole surface an owner can click on this page. */
    clickEveryControl: async () => {
      const clicked: string[] = [];
      for (const [id, x] of Object.entries(reg)) {
        if (typeof x.onclick !== "function") continue;
        clicked.push(id);
        try { await x.onclick({ preventDefault() {} }); } catch {}
      }
      await sleep(80);
      return { clicked, calls: calls.slice() };
    },
  };
  return page;
}

/** Two friends whose Bots chat; `A` is the owner looking at the console. B's Bot writes first, so a chat exists. */
async function pairWithChat(s: any, opts: { custody?: boolean } = {}) {
  const { A, B } = await friends(s.base);
  if (opts.custody) custody(s, A);
  const c = await B.bot.startConversation(A.bot.id, { type: "general_chat", summary: "Lunch" });
  await B.bot.draftMessage(c.conversation_id, { text: "are you free at noon?" });
  return { A, B, convId: c.conversation_id as string };
}

const matcher = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

test("a non-custodial Bot gets no composer, one sentence saying why, and no write at all", async (t) => {
  const s = await startServer(); t.after(s.stop);
  const { A, B, convId } = await pairWithChat(s);
  const me = await A.owner.req("GET", "/v1/me");
  const page = openConsole(s.base, ownerToken(A), me, convId);
  await page.render();
  const note = page.note();
  assert.ok(!page.hasComposer() && note !== null,
    `a chat with a non-custodial Bot renders no composer (${page.hasComposer()}) and must say why the console cannot send as it (note: ${note === null ? "none" : `"${note}"`})`);
  assert.match(note!, matcher(A.handle), "the sentence names the Bot whose key the owner holds — their own");
  assert.match(note!, /signing key is in your hands/, "and says the signing key is the owner's, not the platform's");
  assert.deepEqual(page.calls().filter((c) => c.method !== "GET"), [], "opening the page writes nothing");
  assert.equal(me.bots.find((b: any) => b.id === A.bot.id)?.custodial, false, "the API must say this Bot's key is not held by the platform");
});

test("a custodial Bot: the owner types a line, it is one POST with five fields, then the bubble comes from the re-read", async (t) => {
  const s = await startServer(); t.after(s.stop);
  const { A, B, convId } = await pairWithChat(s, { custody: true });
  const me = await A.owner.req("GET", "/v1/me");
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const page = openConsole(s.base, ownerToken(A), me, convId, { slowSend: gate });
  await page.render();
  assert.ok(page.hasComposer(), "a custodial Bot in an open 1:1 chat gets a composer");

  const sending = page.send("Lunch at noon?");
  await sleep(10);
  const before = page.calls().filter((c) => c.path.endsWith("/send"));
  release();
  const r = await sending;
  assert.equal(r.disabledWhileSending, true, "the Send button is disabled while the request is in flight");
  assert.equal(r.disabled, false, "and is usable again once it settles");

  const posts = r.calls.filter((c) => c.method === "POST");
  assert.deepEqual(posts.map((c) => c.path), [`/v1/homes/${encodeURIComponent(me.home || A.bot.id)}/send`],
    "pressing Send writes exactly once, through the owner home route");
  assert.deepEqual(Object.keys(posts[0].body).sort(), ["conversation_id", "from_bot_id", "text", "to", "typed_by_owner"],
    "the body carries the five fields the route reads");
  assert.equal(posts[0].body.conversation_id, convId, "and names the conversation the owner is reading");
  assert.equal(posts[0].body.from_bot_id, A.bot.id, "from the Bot this chat belongs to");
  assert.equal(posts[0].body.to, B.bot.id, "to the Bot on the other side of this chat");
  assert.equal(posts[0].body.typed_by_owner, true, "attested as typed by the owner");
  assert.equal(before.length, 1, "the request is already in flight while the button is disabled");

  const reads = r.calls.filter((c) => c.method === "GET" && c.path === `/v1/conversations/${convId}`);
  assert.equal(reads.length, 2, `the page is re-read once from /v1/conversations/:id after the 202 (reads: ${reads.length})`);
  assert.match(r.html, /Lunch at noon\?/, "the line the owner wrote is on the page");
  assert.match(r.html, /✍ typed by owner/, "and marked as the owner's own words, not the Bot's");
  assert.match(r.html, /Delivered/, "with the status the re-read reported");
  assert.equal(me.bots.find((b: any) => b.id === A.bot.id)?.custodial, true, "the API must say the platform holds this Bot's key");
});

test("the owner's line goes into the conversation on screen, not the pair's newest one", async (t) => {
  const s = await startServer(); t.after(s.stop);
  const { A, B } = await friends(s.base);
  custody(s, A);
  // B's Bot opens two open 1:1 conversations. The console is reading the first one while the second is newer,
  // which is exactly the shape in which the old route wrote into the wrong thread and the page read back empty.
  const first = await B.bot.startConversation(A.bot.id, { type: "general_chat", summary: "First thread" });
  const firstDraft = await B.bot.draftMessage(first.conversation_id, { text: "the first thread has a message" });
  await B.owner.req("POST", `/v1/approvals/${firstDraft.approval_id}/decision`, { decision: "approved" });
  const second = await B.bot.startConversation(A.bot.id, { type: "general_chat", summary: "Second thread" });
  const secondDraft = await B.bot.draftMessage(second.conversation_id, { text: "the second thread is newer" });
  await B.owner.req("POST", `/v1/approvals/${secondDraft.approval_id}/decision`, { decision: "approved" });
  const onScreenId = first.conversation_id as string, newerId = second.conversation_id as string;

  const me = await A.owner.req("GET", "/v1/me");
  const page = openConsole(s.base, ownerToken(A), me, onScreenId);
  await page.render();
  assert.ok(page.hasComposer(), "a custodial Bot in an open 1:1 chat gets a composer");

  const r = await page.send("this belongs to the thread on screen");
  const post = r.calls.find((c) => c.method === "POST" && c.path.endsWith("/send"));
  assert.ok(post, "pressing Send writes once");
  assert.equal(post!.body.conversation_id, onScreenId, "the body names the conversation the owner is reading");

  const read = async (id: string) => (await A.owner.req("GET", `/v1/conversations/${id}`)).messages as any[];
  const onScreen = await read(onScreenId), newer = await read(newerId);
  const line = onScreen.find((m: any) => m.direction === "outbound" && m.content?.text === "this belongs to the thread on screen");
  assert.ok(line !== undefined, "the line is in the conversation the owner was reading");
  assert.equal(line.status, "delivered", "and it was delivered, not merely accepted");
  assert.equal(newer.some((m: any) => m.direction === "outbound" && m.content?.text === "this belongs to the thread on screen"), false,
    "the newer conversation received nothing");
  assert.match(r.html, /this belongs to the thread on screen/, "the re-read of the page shows the bubble the owner just wrote");
  assert.match(r.html, /Delivered/, "with the status the re-read reported");
});

test("a line that comes back awaiting approval is shown as awaiting, never as delivered", async (t) => {
  const s = await startServer(); t.after(s.stop);
  const { A, convId } = await pairWithChat(s, { custody: true });
  const me = await A.owner.req("GET", "/v1/me");
  const page = openConsole(s.base, ownerToken(A), me, convId);
  await page.render();
  assert.ok(page.hasComposer(), "the composer is missing, so a 202 that comes back pending cannot be exercised");
  // An email address is an `approve` DLP finding, so the owner-typed fast path (`typedByOwner` + clean scan) does
  // not apply and the line waits on a card: a real 202 whose message is `pending_approval`, not `delivered`.
  const r = await page.send("Email me at bob@example.com");
  const bubble = r.html.split('<div class="b ').find((x) => x.includes("bob@example.com"));
  assert.ok(bubble !== undefined, "the pending line is on the page after the re-read");
  assert.match(bubble!, /Awaiting your approval/, "the page shows the status the re-read reported");
  assert.doesNotMatch(bubble!, /Delivered/, "a 202 is not a delivery: the line must not be shown as sent");
});

test("a refused send (409 not_custodial) keeps the text and the composer, and says why", async (t) => {
  const s = await startServer(); t.after(s.stop);
  const { A, convId } = await pairWithChat(s, { custody: true });
  const me = await A.owner.req("GET", "/v1/me");
  const page = openConsole(s.base, ownerToken(A), me, convId, { refuseSend: "not_custodial" });
  await page.render();
  assert.ok(page.hasComposer(), "the composer is missing, so a refused send cannot be exercised");
  const r = await page.send("this will be refused");
  assert.equal(r.value, "this will be refused", "the owner's words are still in the box");
  assert.ok(page.hasComposer(), "the composer is still there");
  assert.doesNotMatch(r.html, /this will be refused/, "nothing was added to the conversation");
  assert.match(page.toast(), /signing key|custody/i, "and the page says why in a sentence, not a bare code");
  assert.equal(r.calls.filter((c) => c.method === "POST").length, 1, "the attempt is made exactly once");
  assert.equal(r.calls.filter((c) => c.method === "GET" && c.path === `/v1/conversations/${convId}`).length, 1, "a failed send does not re-render the page");
});

test("a chat bound to a room offers no composer, says where to answer, and has no control that can write a line", async (t) => {
  const s = await startServer(); t.after(s.stop);
  const A = await ownerWithBot(s.base, "alice");
  const B = await ownerWithBot(s.base, "bob");
  // The pair are also friends with a live 1:1 chat, so a send from the room chat through `/v1/homes/:id/send` would
  // not fail: `sendAsMember` resolves `activeRelationship` and reuses (or opens) the friendship's thread. That thread
  // is the "another thread" this test says must not receive a line typed here.
  const rel = await A.owner.req("POST", "/v1/relationships", { from_bot_id: A.bot.id, target_handle: B.handle, message: "hi" });
  await B.owner.req("POST", `/v1/relationships/${rel.relationship_id}/consent`, { decision: "accept", grant_capabilities: [] });
  custody(s, A);
  const oneToOne = await A.owner.req("POST", `/v1/homes/${A.bot.id}/send`, { from_bot_id: A.bot.id, to: B.bot.id, text: "hello in our own chat" });
  const join = await A.owner.req("POST", "/v1/face-rooms/join", { code: "474747", bots: [A.bot.id] });
  const inv = await A.owner.req("POST", `/v1/face-rooms/${join.room_id}/invites`, {});
  await B.owner.req("POST", "/v1/face-rooms/join-invite", { ticket: inv.ticket, bots: [B.bot.id] });
  custody(s, B);
  const sent = await A.owner.req("POST", `/v1/homes/${A.bot.id}/send`, { from_bot_id: A.bot.id, to: B.bot.id, text: "welcome to the room", room_id: join.room_id });
  const convId = sent.conversation_id as string;
  assert.notEqual(convId, oneToOne.conversation_id, "the room chat is its own conversation, not the pair's 1:1 thread");

  const me = await A.owner.req("GET", "/v1/me");
  const page = openConsole(s.base, ownerToken(A), me, convId);
  const html = await page.render();
  assert.match(html, /welcome to the room/, "the room line is on the page");
  const note = page.note();
  assert.ok(!page.hasComposer() && note !== null,
    `a chat bound to a room renders no composer (${page.hasComposer()}) and must say to answer from the room page (note: ${note === null ? "none" : `"${note}"`}); a line typed here would take the 1:1 send route and land in another thread`);
  assert.match(note!, /room page/i, "the sentence says where the owner can answer");
  assert.equal((await A.owner.req("GET", `/v1/conversations/${convId}`)).room_id, join.room_id, "the conversation says which room it belongs to");
  assert.deepEqual(page.calls().filter((c) => c.method !== "GET"), [], "opening the page writes nothing");

  const oneBefore = await A.owner.req("GET", `/v1/conversations/${oneToOne.conversation_id}`);
  const all = await page.clickEveryControl();
  const oneAfter = await A.owner.req("GET", `/v1/conversations/${oneToOne.conversation_id}`);
  assert.equal(oneAfter.messages.length, oneBefore.messages.length, "nothing the page offers writes a line into the pair's 1:1 thread");
  const writes = all.calls.filter((c) => c.method !== "GET");
  assert.deepEqual(writes.filter((c) => /\/conversations\/[^/]+\/messages$/.test(c.path)).map((c) => c.path), [],
    "no control on this page can write a line into a conversation");
  assert.deepEqual(writes.filter((c) => /\/send$/.test(c.path)).map((c) => c.path), [],
    "and none can take the 1:1 send route, where the line would land in another thread");
});

test("a closed chat offers no composer and no explanation line", async (t) => {
  const s = await startServer(); t.after(s.stop);
  const { A, convId } = await pairWithChat(s, { custody: true });
  await A.owner.req("POST", `/v1/conversations/${convId}/close`, { outcome: "abandoned" });
  const me = await A.owner.req("GET", "/v1/me");
  const page = openConsole(s.base, ownerToken(A), me, convId);
  await page.render();
  assert.ok(!page.hasComposer(), "a closed chat cannot be answered");
  assert.equal(page.note(), null, "the page already says the chat is closed, so it needs no second explanation");
  assert.deepEqual(page.calls().filter((c) => c.method !== "GET"), [], "opening the page writes nothing");
});
