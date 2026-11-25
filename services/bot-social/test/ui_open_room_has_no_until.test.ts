/**
 * The console must not put a matching-window deadline on a room that already started.
 *
 * A six-digit code opens a candidate room with a short `expires_at`; starting the room turns it into a normal open
 * group and voids the number, and from then on the room has no deadline at all. The API row keeps the old
 * `expires_at` (only `status` and `started_at` change), and the rooms page rendered `until <expires_at>` for every
 * state, so a started room showed a time that had already passed minutes after it started.
 *
 * The list and the detail both read `status` from the API; only a `candidate` still waits for its window to end, so
 * only a `candidate` may show `until`.
 *
 * Red first on 80822fc: (a) the list of a started room still shows `until`, with the old window time; (b) the room
 * detail does too. Green on 80822fc and kept green: (c) a candidate room still shows its `until`.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { ownerWithBot, startServer } from "./helpers.js";

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

let nextCode = 300000 + (Date.now() % 600000);
const freshCode = () => String(++nextCode);

/** Load public/ui.js without boot(), signed in as one owner, with fetch pointed at the test server. */
function loadConsole(token: string, hash = "#/rooms") {
  const src = pub("ui.js").replace(/\nboot\(\);\s*$/, "\n;globalThis.__ui = { PAGES, route, roomHref, roomsModel, roomDetailModel, location };\n");
  const store = new Map<string, string>([["bs_owner_token", token]]);
  const ctx: any = {
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, String(v)), removeItem: (k: string) => store.delete(k) },
    window: { addEventListener() {} },
    document: { querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, createElement: () => ({ setAttribute() {}, appendChild() {}, style: {}, classList: { add() {}, remove() {} } }) },
    location: { hash, origin: "https://example.test", reload() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: (path: string, init?: any) => fetch(S.base + path, init),
    setInterval() {}, setTimeout, clearTimeout, URLSearchParams, Intl, Date, console, confirm: () => true, prompt: () => null,
  };
  vm.runInNewContext(src, ctx);
  return ctx.__ui;
}

/** Two owners, one bot each, in the same candidate room; the initiator's console is returned signed in. */
async function candidateRoom() {
  const A = await ownerWithBot(S.base, "roomza");
  const B = await ownerWithBot(S.base, "roomzb");
  const code = freshCode();
  const a = await req("POST", "/v1/face-rooms/join", A.owner.token, { code, bots: [A.bot.id] });
  const b = await req("POST", "/v1/face-rooms/join", B.owner.token, { code, bots: [B.bot.id] });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.body.room_id, b.body.room_id);
  const c = loadConsole(A.owner.token);
  return { A, B, roomId: a.body.room_id as string, c };
}

/** Start the room and move its leftover window time safely into the past, as waiting past it would. */
async function startedRoom() {
  const room = await candidateRoom();
  const started: any = await req("POST", `/v1/face-rooms/${room.roomId}/start`, room.A.owner.token);
  assert.equal(started.body.status, "open");
  S.platform.db.prepare("UPDATE face_rooms SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 3600e3).toISOString(), room.roomId);
  return room;
}

test("(a) the list of a started room shows no matching-window deadline", async () => {
  const { roomId, c } = await startedRoom();
  const list = { innerHTML: "" };
  await c.PAGES.rooms(list);
  assert.ok(list.innerHTML.includes(roomId), "the started room is still listed");
  assert.ok(list.innerHTML.includes("In progress"), "and it reads as open, not as waiting");
  assert.equal(list.innerHTML.includes("until"), false, "a started room has no matching window left to show");
});

test("(b) the room page of a started room shows no matching-window deadline", async () => {
  const { A, roomId, c } = await startedRoom();
  c.location.hash = `#/rooms/${roomId}`;
  const detail = { innerHTML: "" };
  await c.PAGES.rooms(detail);
  assert.ok(detail.innerHTML.includes("In progress"), "the detail still names the open state");
  assert.ok(detail.innerHTML.includes(A.handle.replace(/^@/, "")), "and still lists who is in the room");
  assert.equal(detail.innerHTML.includes("until"), false, "the detail does not put a deadline on an open room");
});

test("(c) a candidate room still shows when its matching window closes", async () => {
  const { c } = await candidateRoom();
  const list = { innerHTML: "" };
  await c.PAGES.rooms(list);
  assert.ok(list.innerHTML.includes("until"), "a candidate still tells its owner when the window closes");
  assert.ok(list.innerHTML.includes("Waiting to start"));
});
