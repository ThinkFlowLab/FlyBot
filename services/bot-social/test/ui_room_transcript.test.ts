import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { ownerWithBot, startServer } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const pub = (f: string) => readFileSync(join(here, "..", "public", f), "utf8");
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(); });
after(async () => { await S.stop(); });

const req = async (method: string, path: string, token: string, body?: unknown) => {
  const r = await fetch(S.base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
};

/** A code reused by an earlier run joins the room that run left behind, so every run makes its own. */
const RUN_CODE = 310000 + (Date.now() % 680000);

/** Two owners, one Bot each, in the same room: A opened it, B walked in after. */
async function roomWithTwoOwners(code: string) {
  const A = await ownerWithBot(S.base, "txa");
  const B = await ownerWithBot(S.base, "txb");
  const a = await req("POST", "/v1/face-rooms/join", A.owner.token, { code, bots: [A.bot.id] });
  const b = await req("POST", "/v1/face-rooms/join", B.owner.token, { code, bots: [B.bot.id] });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.body.room_id, b.body.room_id);
  return { A, B, roomId: a.body.room_id as string };
}

/** Load public/ui.js without boot(), signed in as one owner, with fetch pointed at the test server. */
function loadConsole({ token, hash }: { token: string; hash: string }) {
  const src = pub("ui.js").replace(/\nboot\(\);\s*$/, "\n;globalThis.__ui = { PAGES, route, roomsModel, roomDetailModel, roomTranscript: typeof roomTranscript === \"undefined\" ? undefined : roomTranscript, location };\n");
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

test("the page shows what was said, in event order, each line naming who said it", async () => {
  const { A, B, roomId } = await roomWithTwoOwners(String(RUN_CODE));
  await req("PATCH", "/v1/me", B.owner.token, { auto_approve_face_rooms: true });
  const said = [
    { text: "hello room", bot_id: B.bot.id },
    { text: "<img src=x onerror=alert(1)>", bot_id: B.bot.id },
  ];
  for (const body of said) {
    const sent = await req("POST", `/v1/face-rooms/${roomId}/messages`, B.owner.token, body);
    assert.equal(sent.status, 202);
    assert.equal(sent.body.status, "delivered");
  }

  // Exactly two messages and one platform line are in reach for B: its own join, then the two lines it sent.
  const raw = await req("GET", `/v1/face-rooms/${roomId}`, B.owner.token);
  assert.deepEqual(raw.body.events.map((e: any) => e.type), ["member.joined", "room.message", "room.message"]);

  const c = loadConsole({ token: B.owner.token, hash: `#/rooms/${roomId}` });
  const d = c.roomDetailModel(raw.body);
  assert.deepEqual(d.lines.map((l: any) => l.cursor), raw.body.events.map((e: any) => e.event_cursor), "lines keep the server's event_cursor order");

  const detail = { innerHTML: "" };
  await c.PAGES.rooms(detail);
  const html = detail.innerHTML;

  // Each line reads in event_cursor order: platform join sentence, then the two messages.
  const at = (s: string) => { const i = html.indexOf(s); assert.ok(i >= 0, `${s} is on the page`); return i; };
  const joined = raw.body.events[0].text;
  const firstAt = at(esc(joined));
  const secondAt = at(esc(said[0]!.text));
  const thirdAt = at(esc(said[1]!.text));
  assert.ok(firstAt < secondAt && secondAt < thirdAt, "the page prints the room's lines in event order");

  // Every message names its speaker and keeps the peer text verbatim, escaped.
  const speaker = raw.body.events.find((e: any) => e.type === "room.message").from.handle;
  assert.ok(html.includes(esc(speaker)), "the message names the Bot that said it");
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"), "peer text renders escaped, not as markup");
  assert.ok(!/<img/i.test(html), "no img element is built from peer text");
});

test("platform lines (member joined, room started, lead changed) read as system lines", async () => {
  const { A, B, roomId } = await roomWithTwoOwners(String(RUN_CODE + 1));
  const raw = await req("GET", `/v1/face-rooms/${roomId}`, B.owner.token);
  const join = raw.body.events.find((e: any) => e.type === "member.joined");
  assert.ok(join, "the join is in the room's events");
  assert.equal(join.trust, "platform");

  const c = loadConsole({ token: B.owner.token, hash: `#/rooms/${roomId}` });
  const detail = { innerHTML: "" };
  await c.PAGES.rooms(detail);
  const html = detail.innerHTML;

  assert.ok(html.includes(`<div class="sys">${esc(join.text)}</div>`), "the platform sentence sits in the console's system line");
  assert.equal((html.match(/class="bub"/g) || []).length, 0, "a platform sentence is not drawn as a Bot's speech bubble");
  assert.equal((html.match(/class="sys"/g) || []).length, 1, "one platform event, one system line");
});

test("a room with nothing in reach says so instead of showing an empty list", () => {
  const c = loadConsole({ token: "", hash: "#/rooms" });
  const d = c.roomDetailModel({ room_id: "rm_none", status: "open", members: [], events: [] });
  assert.deepEqual(d.lines, []);
  const html = c.roomTranscript(d.lines, new Set());
  assert.match(html, /Nothing said yet/);
  assert.doesNotMatch(html, /class="bub"/);
});
