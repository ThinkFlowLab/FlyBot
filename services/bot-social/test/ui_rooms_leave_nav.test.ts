import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { ownerWithBot, startServer } from "./helpers.js";

// Leaving a room from its own page re-rendered the same `#/rooms/<id>` address, but the server no longer counts the
// owner as a member: `faceRequireMember` answers 404 `face_room_not_found`, so the console said "No such room."
// on top of "Left the room" and left the owner on an empty page. The page must move to the list instead.

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

/** Two owners, one bot each, in the same room (one 6-digit code). */
async function roomWithTwoOwners(code: string) {
  const A = await ownerWithBot(S.base, "leavea");
  const B = await ownerWithBot(S.base, "leaveb");
  const a = await req("POST", "/v1/face-rooms/join", A.owner.token, { code, bots: [A.bot.id] });
  const b = await req("POST", "/v1/face-rooms/join", B.owner.token, { code, bots: [B.bot.id] });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.body.room_id, b.body.room_id);
  return { A, B, roomId: a.body.room_id as string };
}

const el = () => ({
  innerHTML: "", textContent: "", style: {}, dataset: {}, disabled: false, onclick: null,
  classList: { add() {}, remove() {}, contains: () => false }, appendChild() {}, setAttribute() {}, removeAttribute() {}, addEventListener() {},
});

/** The console signed in as one owner, with the handful of nodes the page and a re-render touch. */
function loadConsole({ token, hash }: { token: string; hash: string }) {
  const src = pub("ui.js").replace(/\nboot\(\);\s*$/, "\n;globalThis.__ui = { PAGES, location, me: () => me, setMe: (x) => { me = x; } };\n");
  const nodes: Record<string, any> = { "#root": el(), "#view": el(), "#toast": el(), "#lo": el(), "#lo2": el(), "#room-leave": el() };
  const ctx: any = {
    localStorage: { getItem: (k: string) => (k === "bs_owner_token" ? token : null), setItem() {}, removeItem() {} },
    window: { addEventListener() {} },
    document: { querySelector: (s: string) => nodes[s] ?? null, querySelectorAll: () => [], getElementById: () => null, createElement: () => el() },
    location: { hash, origin: "https://example.test", reload() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: (path: string, init?: any) => fetch(S.base + path, init),
    setInterval() {}, setTimeout, clearTimeout, URLSearchParams, Intl, Date, console, confirm: () => true, prompt: () => null,
  };
  vm.runInNewContext(src, ctx);
  return { ui: ctx.__ui, nodes };
}

test("leaving a room lands on the rooms list and keeps the confirmation", async () => {
  const { A, roomId } = await roomWithTwoOwners(String(RUN_CODE));
  const { ui, nodes } = loadConsole({ token: A.owner.token, hash: `#/rooms/${roomId}` });
  ui.setMe({ owner_id: "own_leave", display_name: "Owner A", username: "leavea", timezone: "UTC", bots: [] });

  await ui.PAGES.rooms(nodes["#view"]);
  assert.match(nodes["#view"].innerHTML, /Leave room/, "the detail page offers the door");

  const leave = nodes["#room-leave"];
  assert.equal(typeof leave.onclick, "function", "the handler is bound to the button");
  await leave.onclick();
  // The handler starts the re-render without awaiting it, so let that request land before reading the console:
  // on the page that re-opens the room it is the 404 that overwrites the confirmation.
  await new Promise((r) => setTimeout(r, 400));

  assert.equal(nodes["#toast"].textContent, "Left the room", "the confirmation is not overwritten by a reload of the room");
  assert.doesNotMatch(nodes["#view"].innerHTML, /No such room/i, "the console does not re-open the room the owner just left");
  assert.equal(ui.location.hash, "#/rooms", "the console moves to the list the owner can still read");
});
