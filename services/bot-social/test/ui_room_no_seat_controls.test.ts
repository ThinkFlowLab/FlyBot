// A home that only brought another owner's guest into a room can read that room, but it holds no seat of its own
// there: `start` answers 404 face_room_not_found, and `leave` removes nothing (it answers with an empty `left`).
// The page and the doors must agree on that one fact, so neither button is drawn for a home without a seat. A home
// with a seat of its own keeps both buttons, and the start door accepts it: the buttons are gated on the seat, not
// switched off for everyone.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { friends, startServer } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "public", "ui.js"), "utf8");
const el = () => ({ innerHTML: "", innerText: "", textContent: "", value: "", style: {}, dataset: {}, disabled: false, onclick: null as any, classList: { add() {}, remove() {}, contains: () => false }, appendChild() {}, setAttribute() {}, removeAttribute() {}, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, closest: () => ({ appendChild() {}, querySelector: () => null, querySelectorAll: () => [] }) });
function loadConsole(base: string, { token, hash }: { token: string; hash: string }) {
  const code = src.replace(/\nboot\(\);\s*$/, "\n;globalThis.__ui = { PAGES };\n");
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
  vm.runInNewContext(code, ctx);
  return { ui: ctx.__ui, nodes };
}
async function req(base: string, method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}

/** A code reused by an earlier run joins the room that run left behind, so every run makes its own two. */
const RUN_CODE = 400000 + (Date.now() % 590000);

test("a room page only offers the buttons a home with a seat can use", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);

  // B lends its Bot to A; A opens a candidate room bringing ONLY that guest, so A holds no seat of its own.
  const grant = await req(s.base, "POST", `/v1/bots/${B.bot.id}/grants`, B.owner.token, { friend_owner_id: A.owner_id, friend_bot_id: A.bot.id });
  assert.equal(grant.status, 201, JSON.stringify(grant.body));
  const joined = await req(s.base, "POST", "/v1/face-rooms/join", A.owner.token, { code: String(RUN_CODE), bots: [B.bot.id] });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  const guestRoom = joined.body.room_id as string;
  const detail = await req(s.base, "GET", `/v1/face-rooms/${guestRoom}`, A.owner.token);
  assert.equal(detail.status, 200, "the bringer reads the room it opened");
  assert.equal(detail.body.status, "candidate");

  const start = await req(s.base, "POST", `/v1/face-rooms/${guestRoom}/start`, A.owner.token);
  const startAccepted = start.status === 200;
  assert.equal(start.status, 404, "the start door refuses a home with no seat of its own");
  assert.equal(start.body?.error?.code, "face_room_not_found");

  // Leave answers 200 but takes nobody out: the guest is the other owner's seat, so nothing leaves and the room
  // keeps both its seat and its status. A button saying "Left the room" would be wrong on both counts.
  const leave = await req(s.base, "POST", `/v1/face-rooms/${guestRoom}/leave`, A.owner.token, {});
  assert.equal(leave.status, 200, JSON.stringify(leave.body));
  assert.deepEqual(leave.body.left, [], "a home with no seat of its own leaves nobody");
  const after = await req(s.base, "GET", `/v1/face-rooms/${guestRoom}`, A.owner.token);
  assert.equal(after.status, 200, "the room is still readable and still there");
  assert.equal(after.body.status, "candidate");

  const { ui, nodes } = loadConsole(s.base, { token: A.owner.token, hash: `#/rooms/${guestRoom}` });
  await ui.PAGES.rooms(nodes["#view"]);
  const html = nodes["#view"].innerHTML as string;
  assert.match(html, new RegExp(guestRoom), "the page renders the room it can read");
  assert.ok(html.includes(String(B.handle).replace(/^@/, "")), "the guest seat is still named on the page");
  // The page agrees with the doors, whichever way the doors answer: a refused start or a leave that takes nobody out is
  // exactly the case where the button must not be there.
  assert.equal(/id="room-start"/.test(html), startAccepted, `the page must offer Start only when the start door accepts (door: ${start.status} ${start.body?.error?.code ?? ""})`);
  assert.doesNotMatch(html, /id="room-start"/, "a home with no seat of its own is not offered Start");
  assert.equal(/id="room-leave"/.test(html), (leave.body.left as string[]).length > 0, "the page must offer Leave only when leaving takes a Bot out");
  assert.doesNotMatch(html, /id="room-leave"/, "a home with no seat of its own is not offered Leave");
  assert.match(html, /href="#\/rooms"/, "the way back to the list stays");
  assert.match(html, /the other owner's Bot to take out/, "the line under the header says whose Bot the guest is");
  assert.doesNotMatch(html, /Leaving takes your Bots out/, "no seat, no leaving line");

  // The positive control: a home with a seat of its own keeps both buttons, and the start door accepts it.
  const ownJoined = await req(s.base, "POST", "/v1/face-rooms/join", A.owner.token, { code: String(RUN_CODE + 1), bots: [A.bot.id] });
  assert.equal(ownJoined.status, 200, JSON.stringify(ownJoined.body));
  const ownRoom = ownJoined.body.room_id as string;
  // Before the start, the candidate room page offers both buttons to the home that holds a seat.
  const own = loadConsole(s.base, { token: A.owner.token, hash: `#/rooms/${ownRoom}` });
  await own.ui.PAGES.rooms(own.nodes["#view"]);
  const ownHtml = own.nodes["#view"].innerHTML as string;
  const ownStart = await req(s.base, "POST", `/v1/face-rooms/${ownRoom}/start`, A.owner.token);
  const ownStartAccepted = ownStart.status === 200;
  assert.equal(ownStart.status, 200, "the start door accepts a home with a seat of its own");
  assert.equal(ownStart.body.status, "open");
  assert.equal(/id="room-start"/.test(ownHtml), ownStartAccepted, "the page offers Start when its door accepts");
  assert.match(ownHtml, /id="room-start"/, "a home with a seat is offered the start its door accepts");
  assert.match(ownHtml, /id="room-leave"/, "a home with a seat can still leave");
  assert.match(ownHtml, /Leaving takes your Bots out/, "a home with a seat keeps the leaving line");
});
