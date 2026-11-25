import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { ownerWithBot, startServer } from "./helpers.js";

// The console could read rooms and leave one, but an owner whose Bot does not run a runtime had no way into a room:
// every entry meant calling the API by hand. The rooms list now joins with a 6-digit code and the detail page starts
// a room that is still waiting, so the product's main ability works from the console alone.

const here = dirname(fileURLToPath(import.meta.url));
const pub = (f: string) => readFileSync(join(here, "..", "public", f), "utf8");

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(); });
after(async () => { await S.stop(); });

const req = async (method: string, path: string, token: string, body?: unknown) => {
  const r = await fetch(S.base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
};

/** A code reused by an earlier run joins the room that run left behind, so every run makes its own. */
const RUN_CODE = 300000 + (Date.now() % 690000);

type Node = {
  innerHTML: string; textContent: string; value: string; disabled: boolean; onclick: null | (() => Promise<void> | void); attrs: Record<string, string>;
  classList: { add(): void; remove(): void; contains(): boolean };
  closest(): { appendChild(): void; querySelectorAll(): never[]; querySelector(): null };
  parentElement: { appendChild(): void; querySelectorAll(): never[]; querySelector(): null };
  setAttribute(k: string, v: string): void; removeAttribute(k: string): void; appendChild(): void; addEventListener(): void;
};

const el = (): Node => ({
  innerHTML: "", textContent: "", value: "", disabled: false, onclick: null, attrs: {},
  classList: { add() {}, remove() {}, contains: () => false },
  closest: () => ({ appendChild() {}, querySelectorAll: () => [], querySelector: () => null }), parentElement: { appendChild() {}, querySelectorAll: () => [], querySelector: () => null },
  setAttribute(k: string, v: string) { this.attrs[k] = v; }, removeAttribute(k: string) { delete this.attrs[k]; }, appendChild() {}, addEventListener() {},
});

/** The console signed in as one owner, with the nodes the rooms page and a re-render touch, and every request recorded. */
function loadConsole({ token, hash, bots }: { token: string; hash: string; bots: unknown[] }) {
  const src = pub("ui.js").replace(/\nboot\(\);\s*$/, "\n;globalThis.__ui = { PAGES, location, me: () => me, setMe: (x) => { me = x; } };\n");
  const nodes: Record<string, Node> = {
    "#root": el(), "#view": el(), "#toast": el(), "#lo": el(), "#lo2": el(),
    "#join-code": el(), "#join-bot": el(), "#join-go": el(), "#join-err": el(), "#room-start": el(),
  };
  const calls: { method: string; path: string; body?: string }[] = [];
  const created: Node[] = [];
  const ctx: any = {
    localStorage: { getItem: (k: string) => (k === "bs_owner_token" ? token : null), setItem() {}, removeItem() {} },
    window: { addEventListener() {} },
    document: {
      querySelector: (s: string) => nodes[s] ?? null,
      querySelectorAll: () => [],
      getElementById: () => null,
      createElement: () => { const e = el(); created.push(e); return e; },
    },
    location: { hash, origin: "https://example.test", reload() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: (path: string, init?: any) => {
      calls.push({ method: init?.method ?? "GET", path, body: init?.body });
      return fetch(S.base + path, init);
    },
    setInterval() {}, setTimeout, clearTimeout, URLSearchParams, Intl, Date, console, confirm: () => true, prompt: () => null,
  };
  vm.runInNewContext(src, ctx);
  ctx.__ui.setMe({ owner_id: "own_console", display_name: "Console owner", username: "console", timezone: "UTC", bots });
  return { ui: ctx.__ui, nodes, calls, created };
}

test("joining from the list sends one join request with the typed code and the chosen Bot", async () => {
  const A = await ownerWithBot(S.base, "joinui");
  const { ui, nodes, calls } = loadConsole({ token: A.owner.token, hash: "#/rooms", bots: [{ id: A.bot.id, handle: A.handle }] });

  await ui.PAGES.rooms(nodes["#view"]);
  assert.match(nodes["#view"].innerHTML, /Join a room/, "the list offers the way in");
  assert.match(nodes["#view"].innerHTML, /id="join-code"/, "the code field has the id the console fills");
  assert.ok(nodes["#view"].innerHTML.includes(`<option value="${A.bot.id}">`), "the Bot select offers the owner's Bot");

  nodes["#join-code"].value = String(RUN_CODE);
  nodes["#join-bot"].value = A.bot.id;
  assert.equal(typeof nodes["#join-go"].onclick, "function", "the Join button is wired");
  await nodes["#join-go"].onclick!();

  const joins = calls.filter((c) => c.path === "/v1/face-rooms/join");
  assert.equal(joins.length, 1, "one click sends exactly one join request");
  assert.equal(joins[0].method, "POST");
  assert.deepEqual(JSON.parse(joins[0].body!), { code: String(RUN_CODE), bots: [A.bot.id] });

  const listed = await req("GET", "/v1/face-rooms", A.owner.token);
  assert.equal(listed.body.rooms.length, 1, "the server has the room the console joined");
});

test("a room waiting to start offers Start room, which starts it once; a started room offers no such button", async () => {
  const A = await ownerWithBot(S.base, "starta");
  const B = await ownerWithBot(S.base, "startb");
  const code = String(RUN_CODE + 1);
  const a = await req("POST", "/v1/face-rooms/join", A.owner.token, { code, bots: [A.bot.id] });
  const b = await req("POST", "/v1/face-rooms/join", B.owner.token, { code, bots: [B.bot.id] });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const roomId = a.body.room_id as string;
  assert.equal(a.body.room_id, b.body.room_id);

  const waiting = await req("GET", `/v1/face-rooms/${roomId}`, A.owner.token);
  assert.equal(waiting.body.status, "candidate", "the room waits for someone to start it");

  const { ui, nodes, calls } = loadConsole({ token: A.owner.token, hash: `#/rooms/${roomId}`, bots: [{ id: A.bot.id, handle: A.handle }] });
  await ui.PAGES.rooms(nodes["#view"]);
  assert.match(nodes["#view"].innerHTML, /id="room-start"/, "a waiting room offers Start room");
  assert.equal(typeof nodes["#room-start"].onclick, "function", "the Start button is wired");
  await nodes["#room-start"].onclick!();

  const starts = calls.filter((c) => c.path === `/v1/face-rooms/${roomId}/start`);
  assert.equal(starts.length, 1, "one click starts the room exactly once");
  assert.equal(starts[0].method, "POST");
  const started = await req("GET", `/v1/face-rooms/${roomId}`, A.owner.token);
  assert.equal(started.body.status, "open", "the room is in progress after the click");

  nodes["#room-start"].onclick = null;
  await ui.PAGES.rooms(nodes["#view"]);
  assert.doesNotMatch(nodes["#view"].innerHTML, /id="room-start"/, "a room already in progress has no Start room button");
});

test("a code that is not six digits sends nothing and marks the field", async () => {
  const A = await ownerWithBot(S.base, "badui");
  const { ui, nodes, calls, created } = loadConsole({ token: A.owner.token, hash: "#/rooms", bots: [{ id: A.bot.id, handle: A.handle }] });
  await ui.PAGES.rooms(nodes["#view"]);

  nodes["#join-code"].value = "12345";
  nodes["#join-bot"].value = A.bot.id;
  await nodes["#join-go"].onclick!();

  assert.equal(calls.filter((c) => c.path === "/v1/face-rooms/join").length, 0, "a short code never reaches the server");
  assert.equal(nodes["#join-code"].attrs["aria-invalid"], "true", "the field is marked invalid");
  assert.ok(created.some((n) => /6-digit/.test(n.textContent)), "the owner is told what a room code looks like");
});
