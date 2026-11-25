/**
 * A Bot's hourly draft budget is spent without the owner being able to see it.
 *
 * Both write doors refuse over the limit with `global bot rate limit (60/h)` and `retry_after: 3600`, and the union
 * of the two tables is already what `draftsInLastHour` counts. The owner's Bot list did not carry that count, so the
 * only way to learn how much of the hour a Bot has spent was to try a draft and be refused. The list now answers it
 * read-only: `draft_budget: { used, limit, resets_in }`, and `#/bots` prints it on the Bot's card.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { expectApiError, friends, startServer } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const pub = (f: string) => readFileSync(join(here, "..", "public", f), "utf8");
const PER_MINUTE = 6;
/** Many rooms are needed only to spread room drafts; the room creation budget has nothing to do with this feature. */
const ROOMS = { faceRooms: { createsPerAccount: 20, createsPerIp: 20, attemptsPerAccount: 40, attemptsPerIp: 40 } };

async function req(base: string, method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}
const chatIntent = () => ({ type: "general_chat", summary: "chat" });
const openConversation = async (from: any, to: any) => (await from.bot.startConversation(to.bot.id, chatIntent())).conversation_id as string;
async function conversations(from: any, to: any, count: number) {
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(await openConversation(from, to));
  return out;
}
async function chatDrafts(from: any, cid: string, count: number) {
  for (let i = 0; i < count; i++) await from.bot.draftMessage(cid, { text: `Update ${i}: the plan for today is ready.` });
}
async function openRoom(base: string, home: any, code: string) {
  const r = await req(base, "POST", "/v1/face-rooms/join", home.owner.token, { code, bots: [home.bot.id] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.room_id as string;
}
async function roomDrafts(base: string, home: any, roomId: string, count: number) {
  for (let i = 0; i < count; i++) {
    const r = await req(base, "POST", `/v1/face-rooms/${roomId}/messages`, home.owner.token, { text: `Room update ${i}: the plan for today is ready.` });
    assert.equal(r.status, 202, JSON.stringify(r.body));
  }
}
const botOf = (me: any, id: string) => me.bots.find((b: any) => b.id === id);

const el = () => ({
  innerHTML: "", innerText: "", textContent: "", value: "", style: {}, dataset: {}, disabled: false, onclick: null as any,
  classList: { add() {}, remove() {}, contains: () => false }, appendChild() {}, setAttribute() {}, removeAttribute() {}, addEventListener() {},
  querySelectorAll: () => [], querySelector: () => null, closest: () => ({ appendChild() {}, querySelector: () => null, querySelectorAll: () => [] }),
});
/** The console signed in as one owner, with the nodes the Bot page writes to and then binds. */
function loadConsole(base: string, { token, hash }: { token: string; hash: string }) {
  const src = pub("ui.js").replace(/\nboot\(\);\s*$/, "\n;globalThis.__ui = { PAGES };\n");
  const nodes: Record<string, any> = { "#view": el(), "#root": el(), "#toast": el(), "#cponb": el(), "#regbot": el() };
  const ctx: any = {
    localStorage: { getItem: (k: string) => (k === "bs_owner_token" ? token : null), setItem() {}, removeItem() {} },
    window: { addEventListener() {} },
    document: { querySelector: (s: string) => nodes[s] ?? null, querySelectorAll: () => [], getElementById: () => null, createElement: () => el() },
    location: { hash, origin: "https://example.test", reload() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: (path: string, init?: any) => fetch(base + path, init),
    setInterval() {}, setTimeout, clearTimeout, URLSearchParams, Intl, Date, console, confirm: () => true, prompt: () => null,
  };
  vm.runInNewContext(src, ctx);
  return { ui: ctx.__ui, nodes };
}

test("three chat drafts read as 3 of 60 on the Bot's card", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  await chatDrafts(A, await openConversation(A, B), 3);

  const me = await req(s.base, "GET", "/v1/me", A.owner.token);
  const bot = botOf(me.body, A.bot.id);
  assert.equal(bot.draft_budget?.used, 3, "the owner's Bot list carries the hour's draft count");
  assert.equal(bot.draft_budget?.limit, 60);
  assert.ok(bot.draft_budget?.resets_in > 3000 && bot.draft_budget?.resets_in <= 3600, "the window refills within the hour");

  const { ui, nodes } = loadConsole(s.base, { token: A.owner.token, hash: "#/bots" });
  await ui.PAGES.bots(nodes["#view"]);
  assert.match(nodes["#view"].innerHTML, /3 of 60 drafts this hour/, "the Bot's card prints the count");
  assert.match(nodes["#view"].innerHTML, /resets in \d+ min/, "and when the hour refills");
});

test("chat and room drafts spend the same visible hour", async (t) => {
  const s = await startServer(ROOMS);
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  await chatDrafts(A, await openConversation(A, B), 3);
  await roomDrafts(s.base, A, await openRoom(s.base, A, "750001"), 3);

  const me = await req(s.base, "GET", "/v1/me", A.owner.token);
  assert.equal(botOf(me.body, A.bot.id).draft_budget?.used, 6, "three chat and three room drafts are one budget");
});

test("a spent hour reads 60 of 60 and still refuses the sixty-first draft", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  for (const cid of await conversations(A, B, 10)) await chatDrafts(A, cid, PER_MINUTE);

  const err = await expectApiError(A.bot.draftMessage(await openConversation(A, B), { text: "One too many." }), 429, "rate_limited");
  assert.equal(err.body.error.message, "global bot rate limit (60/h)");

  const me = await req(s.base, "GET", "/v1/me", A.owner.token);
  const budget = botOf(me.body, A.bot.id).draft_budget;
  assert.equal(budget.used, 60);
  assert.equal(budget.limit, 60);
  assert.ok(Number.isInteger(budget.resets_in) && budget.resets_in > 0 && budget.resets_in <= 3600, "the refusal and the reading agree on one window");
});

test("another owner's Bot is not listed and keeps its own budget", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  await chatDrafts(A, await openConversation(A, B), 3);

  const bMe = await req(s.base, "GET", "/v1/me", B.owner.token);
  assert.deepEqual(bMe.body.bots.map((b: any) => b.id), [B.bot.id], "B's list holds only B's Bots");
  assert.equal(botOf(bMe.body, B.bot.id).draft_budget?.used, 0);
  assert.equal(botOf(bMe.body, B.bot.id).draft_budget?.resets_in, null, "an unused budget has nothing to wait for");
  const aMe = await req(s.base, "GET", "/v1/me", A.owner.token);
  assert.equal(botOf(aMe.body, A.bot.id).draft_budget?.used, 3, "B reading its own list did not touch A's count");
});
