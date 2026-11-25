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

/** A code reused by an earlier run joins the room that run left behind, so every run makes its own. */
const RUN_CODE = 300000 + (Date.now() % 690000);

/** Two owners, one bot each, in the same room (one 6-digit code). */
async function roomWithTwoOwners(code: string) {
  const A = await ownerWithBot(S.base, "roomsa");
  const B = await ownerWithBot(S.base, "roomsb");
  const a = await req("POST", "/v1/face-rooms/join", A.owner.token, { code, bots: [A.bot.id] });
  const b = await req("POST", "/v1/face-rooms/join", B.owner.token, { code, bots: [B.bot.id] });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.body.room_id, b.body.room_id);
  return { A, B, roomId: a.body.room_id as string };
}

/** Load public/ui.js without boot(), signed in as one owner, with fetch pointed at the test server. */
function loadConsole({ token, hash }: { token: string; hash: string }) {
  const src = pub("ui.js").replace(/\nboot\(\);\s*$/, "\n;globalThis.__ui = { PAGES, route, roomsModel, roomDetailModel, location };\n");
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

test("one click from the list opens the room and shows every member", async () => {
  const { A, roomId } = await roomWithTwoOwners(String(RUN_CODE));
  const c = loadConsole({ token: A.owner.token, hash: "#/rooms" });

  const rows = c.roomsModel(await c.PAGES.rooms.list());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].room_id, roomId);
  assert.equal(rows[0].href, `#/rooms/${roomId}`, "each row is a link to the room");

  const list = { innerHTML: "" };
  await c.PAGES.rooms(list);
  assert.ok(list.innerHTML.includes(roomId), "the list names the room");
  assert.match(list.innerHTML, /2 Bots/);

  // One click follows that link: the hash becomes #/rooms/<id> and the detail renders the members.
  c.location.hash = `#/rooms/${roomId}`;
  const r = c.route();
  assert.equal(r.page, "rooms");
  assert.equal(r.id, roomId);

  const raw = await req("GET", `/v1/face-rooms/${roomId}`, A.owner.token);
  const detail = { innerHTML: "" };
  await c.PAGES.rooms(detail);
  for (const m of raw.body.members) {
    assert.ok(detail.innerHTML.includes(m.handle.replace(/^@/, "")), `${m.handle} is visible after one click`);
    assert.ok(detail.innerHTML.includes(m.label), `${m.label} is visible after one click`);
  }
  assert.match(detail.innerHTML, /Leave room/);
});

test("the list shows exactly what GET /v1/face-rooms returns", async () => {
  const { A } = await roomWithTwoOwners(String(RUN_CODE + 1));
  const raw = await req("GET", "/v1/face-rooms", A.owner.token);
  const c = loadConsole({ token: A.owner.token, hash: "#/rooms" });
  const rows = c.roomsModel(await c.PAGES.rooms.list());
  assert.equal(rows.length, raw.body.rooms.length);
  for (const [i, room] of raw.body.rooms.entries()) {
    assert.deepEqual(
      { room_id: rows[i].room_id, member_count: rows[i].member_count, my_bots: rows[i].my_bots, expires_at: rows[i].expires_at },
      { room_id: room.room_id, member_count: room.member_count, my_bots: room.my_bots, expires_at: room.expires_at },
    );
  }
});

test("a started room reads In progress, not a bare open pill", async () => {
  const { A, roomId } = await roomWithTwoOwners(String(RUN_CODE + 3));
  const started = await req("POST", `/v1/face-rooms/${roomId}/start`, A.owner.token);
  assert.equal(started.status, 200);
  assert.equal(started.body.status, "open", "the server calls a started room open");

  const c = loadConsole({ token: A.owner.token, hash: "#/rooms" });
  const list = { innerHTML: "" };
  await c.PAGES.rooms(list);
  assert.match(list.innerHTML, /In progress/, "the list names a started room the way the rest of the console does");
  assert.doesNotMatch(list.innerHTML, />open</, "no bare open pill in the list");

  c.location.hash = `#/rooms/${roomId}`;
  const detail = { innerHTML: "" };
  await c.PAGES.rooms(detail);
  assert.match(detail.innerHTML, /In progress/, "the detail names a started room the way the rest of the console does");
  assert.doesNotMatch(detail.innerHTML, />open</, "no bare open pill in the detail");
});

test("Leave removes my Bots and the room's member count drops by one", async () => {
  const { A, B, roomId } = await roomWithTwoOwners(String(RUN_CODE + 2));
  const c = loadConsole({ token: A.owner.token, hash: `#/rooms/${roomId}` });
  const before = await req("GET", "/v1/face-rooms", B.owner.token);
  assert.equal(before.body.rooms.find((r: any) => r.room_id === roomId).member_count, 2);

  await c.PAGES.rooms.leave(roomId);

  const after = await req("GET", "/v1/face-rooms", B.owner.token);
  assert.equal(after.body.rooms.find((r: any) => r.room_id === roomId).member_count, 1, "one Bot fewer in the room");
  const mine = await req("GET", "/v1/face-rooms", A.owner.token);
  assert.equal(mine.body.rooms.some((r: any) => r.room_id === roomId), false, "a room I left is not in my list");
});
