// Bot card, second half: a face-room member's one-line description reaches the room's member list, so an owner
// reading the room knows what each seated Bot is for without opening Friends. The room view carries the line
// (nullable), the console cuts a long line at one line's width, and the member set itself is unchanged.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { ownerWithBot, startServer } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const pub = (f: string) => readFileSync(join(here, "..", "public", f), "utf8");

async function req(base: string, method: string, path: string, token: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}

const card = (base: string, who: any, description: string | null) =>
  req(base, "PATCH", `/v1/bots/${who.bot.id}/profile`, who.owner.token, { description });
const joinRoom = (base: string, who: any, code: string) => req(base, "POST", "/v1/face-rooms/join", who.owner.token, { code, bots: [who.bot.id] });
const leave = (base: string, who: any, roomId: string) => req(base, "POST", `/v1/face-rooms/${roomId}/leave`, who.owner.token, {});
const view = (base: string, who: any, roomId: string) => req(base, "GET", `/v1/face-rooms/${roomId}`, who.owner.token);
const memberOf = (room: any, botId: string) => room.members.find((m: any) => m.bot_id === botId);

/** A code unique to this run: rooms outlive a process when a database is reused. */
const RUN_CODE = 310000 + (Date.now() % 680000);
const code = (i: number) => String(RUN_CODE + i);

/** Load the console without boot(), signed in as one owner, pointed at the test server. */
function loadConsole({ token, base, hash }: { token: string; base: string; hash: string }) {
  const src = pub("ui.js").replace(/\nboot\(\);\s*$/, "\n;globalThis.__ui = { PAGES, route, roomDetailModel, roomMemberCard, location };\n");
  const store = new Map<string, string>([["bs_owner_token", token]]);
  const ctx: any = {
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, String(v)), removeItem: (k: string) => store.delete(k) },
    window: { addEventListener() {} },
    document: { querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, createElement: () => ({ setAttribute() {}, appendChild() {}, style: {}, classList: { add() {}, remove() {} } }) },
    location: { hash, origin: "https://example.test", reload() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: (path: string, init?: any) => fetch(base + path, init),
    setInterval() {}, setTimeout, clearTimeout, URLSearchParams, Intl, Date, console, confirm: () => true, prompt: () => null,
  };
  vm.runInNewContext(src, ctx);
  return ctx.__ui;
}

test("a member's line is the same string its owner set, on the room view every member reads", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "linea");
  const B = await ownerWithBot(s.base, "lineb");
  const line = "Drafts release notes from the changelog.";
  assert.equal((await card(s.base, A, line)).status, 200);
  assert.equal((await joinRoom(s.base, A, code(1))).status, 200);
  assert.equal((await joinRoom(s.base, B, code(1))).status, 200);
  const roomId = (await req(s.base, "GET", "/v1/face-rooms", A.owner.token)).body.rooms[0].room_id as string;
  // The other owner's view names the same line: the card is how a member reads, not who wrote it.
  const fromB = await view(s.base, B, roomId);
  assert.equal(fromB.status, 200);
  assert.equal(memberOf(fromB.body, A.bot.id).description, line);
  assert.equal(memberOf(fromB.body, B.bot.id).description, null, "a Bot without a card reads null");
  const fromA = await view(s.base, A, roomId);
  assert.equal(memberOf(fromA.body, A.bot.id).description, line);
});

test("an unset line is null and the console adds no row for it", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "rowea");
  const B = await ownerWithBot(s.base, "roweb");
  assert.equal((await card(s.base, A, "Reads the pair inbox.")).status, 200);
  assert.equal((await joinRoom(s.base, A, code(2))).status, 200);
  assert.equal((await joinRoom(s.base, B, code(2))).status, 200);
  const roomId = (await req(s.base, "GET", "/v1/face-rooms", A.owner.token)).body.rooms[0].room_id as string;
  const c = loadConsole({ token: A.owner.token, base: s.base, hash: `#/rooms/${roomId}` });
  const detail = { innerHTML: "" };
  await c.PAGES.rooms(detail);
  assert.ok(detail.innerHTML.includes("Reads the pair inbox."), "the set line is on the page");
  assert.ok(detail.innerHTML.includes(`data-card="${A.bot.id}"`), "the line belongs to that member's row");
  assert.ok(!detail.innerHTML.includes(`data-card="${B.bot.id}"`), "no row is drawn for a member without a card");
  const model = c.roomDetailModel((await view(s.base, A, roomId)).body);
  assert.equal(model.members.find((m: any) => m.bot_id === B.bot.id).description, null);
});

test("a changed line reads new the next time the room is opened", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "chga");
  const B = await ownerWithBot(s.base, "chgb");
  assert.equal((await card(s.base, A, "First card.")).status, 200);
  assert.equal((await joinRoom(s.base, A, code(3))).status, 200);
  assert.equal((await joinRoom(s.base, B, code(3))).status, 200);
  const roomId = (await req(s.base, "GET", "/v1/face-rooms", A.owner.token)).body.rooms[0].room_id as string;
  assert.equal(memberOf((await view(s.base, B, roomId)).body, A.bot.id).description, "First card.");
  assert.equal((await card(s.base, A, "Second card.")).status, 200);
  assert.equal(memberOf((await view(s.base, B, roomId)).body, A.bot.id).description, "Second card.");
  // Clearing it takes the row away again, not an empty one.
  assert.equal((await card(s.base, A, null)).status, 200);
  const cleared = await view(s.base, B, roomId);
  assert.equal(memberOf(cleared.body, A.bot.id).description, null);
  const c = loadConsole({ token: B.owner.token, base: s.base, hash: `#/rooms/${roomId}` });
  const detail = { innerHTML: "" };
  await c.PAGES.rooms(detail);
  assert.ok(!detail.innerHTML.includes("Second card."), "a cleared line is gone from a reopened page");
  assert.ok(!detail.innerHTML.includes(`data-card="${A.bot.id}"`), "and leaves no empty row");
});

test("a 280-character line reaches the API whole and the console cuts it to one line", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "longa");
  const B = await ownerWithBot(s.base, "longb");
  const long = "Drafts the weekly changelog and keeps the notes in order while the owners review. ".repeat(6).slice(0, 280).trim();
  assert.equal((await card(s.base, A, long)).status, 200);
  assert.equal((await joinRoom(s.base, A, code(4))).status, 200);
  assert.equal((await joinRoom(s.base, B, code(4))).status, 200);
  const roomId = (await req(s.base, "GET", "/v1/face-rooms", A.owner.token)).body.rooms[0].room_id as string;
  const room = (await view(s.base, B, roomId)).body;
  assert.equal(memberOf(room, A.bot.id).description, long, "the API keeps the whole line");
  assert.equal(memberOf(room, A.bot.id).description.length, 280);
  const c = loadConsole({ token: B.owner.token, base: s.base, hash: `#/rooms/${roomId}` });
  const detail = { innerHTML: "" };
  await c.PAGES.rooms(detail);
  const shown = [...long].slice(0, 80).join("") + "…";
  assert.ok(detail.innerHTML.includes(shown), "the page shows the first 80 characters and an ellipsis");
  assert.ok(!detail.innerHTML.includes(long), "the whole line is not laid out in the member row");
});

test("the card adds no member and no room: the member set and a non-member's refusal are unchanged", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "visa");
  const B = await ownerWithBot(s.base, "visb");
  const C = await ownerWithBot(s.base, "visc");
  assert.equal((await card(s.base, A, "Visible to the room only.")).status, 200);
  assert.equal((await card(s.base, B, "Also only to the room.")).status, 200);
  assert.equal((await joinRoom(s.base, A, code(5))).status, 200);
  assert.equal((await joinRoom(s.base, B, code(5))).status, 200);
  const roomId = (await req(s.base, "GET", "/v1/face-rooms", A.owner.token)).body.rooms[0].room_id as string;
  const room = (await view(s.base, B, roomId)).body;
  assert.deepEqual(room.members.map((m: any) => m.bot_id).sort(), [A.bot.id, B.bot.id].sort(), "the card does not add a member");
  // Someone outside the room is refused exactly as before, and reads neither line.
  const outside = await view(s.base, C, roomId);
  assert.equal(outside.status, 404);
  assert.equal(outside.body.error.code, "face_room_not_found");
  assert.equal((await req(s.base, "GET", "/v1/face-rooms", C.owner.token)).body.rooms.length, 0);
  // A member who leaves no longer sees the room, so no card of the members still seated reaches them.
  assert.equal((await leave(s.base, A, roomId)).status, 200);
  assert.equal((await view(s.base, A, roomId)).status, 404);
  const remaining = await view(s.base, B, roomId);
  assert.deepEqual(remaining.body.members.map((m: any) => m.bot_id), [B.bot.id], "only the seated member remains");
  assert.equal(memberOf(remaining.body, B.bot.id).description, "Also only to the room.");
});

test("the console's one-line rule is a boundary, not a guess", () => {
  const c = loadConsole({ token: "t", base: "http://127.0.0.1:1", hash: "#/rooms" });
  assert.equal(c.roomMemberCard(""), "");
  assert.equal(c.roomMemberCard(null), "");
  const exact = "x".repeat(80);
  assert.equal(c.roomMemberCard(exact), exact, "exactly one line's width is shown whole");
  assert.equal(c.roomMemberCard("x".repeat(81)), exact + "…", "one character over is cut, with an ellipsis");
});
