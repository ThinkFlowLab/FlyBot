/**
 * A guest seat is not the viewer's own Bot.
 *
 * When an owner brings another owner's Bot into a face room on a share, that seat is `added_by_owner_id = viewer`
 * but `owner_id` is the other home. Every write door treats "my Bot" as `owner_id === viewer` (`draftFaceRoomMessage`,
 * `setFaceRoomRoles`, `leaveFaceRoom`), and the room view says so: the line carries `trust: "peer_untrusted"` and
 * `from.owner_name` of the other home. The console's room page reads the room list instead, and `my_bots` there held
 * both the viewer's own seats and the guests it brought in, so a guest's line rendered on the "me" side with
 * "your Bot" and lost the peer-content warning; the seat also carried the "Yours" pill.
 *
 * The list now tells the two apart the way the write doors already do: `my_bots` is the seats this home owns, and
 * `brought_bots` is the guests it brought in on a share — seats it can still see and manage, never speak as. The page
 * takes its transcript side, its warning and its pill from `my_bots` only, and the wire's `trust` is untouched.
 * A Bot token reads the same field narrowed to that one Bot, not every seat its owner holds.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { friends, ownerWithBot, startServer } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const pub = (f: string) => readFileSync(join(here, "..", "public", f), "utf8");

/** Load public/ui.js without boot(), signed in as one owner, with fetch pointed at the test server. */
function loadConsole(base: string, token: string, hash: string) {
  const src = pub("ui.js").replace(/\nboot\(\);\s*$/, "\n;globalThis.__ui = { PAGES, route, location };\n");
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

async function req(base: string, method: string, path: string, token: string, body?: unknown) {
  const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}

/** Every speech bubble on the rendered page: which side it sits on and what its meta line says. */
const bubbles = (html: string) => [...html.matchAll(/<div class="b (me|peer)"><div class="bub">([\s\S]*?)<\/div><div class="meta">([\s\S]*?)<\/div><\/div>/g)]
  .map((m) => ({ side: m[1]!, text: m[2]!, meta: m[3]! }));
const bubbleOf = (html: string, text: string) => {
  const b = bubbles(html).find((x) => x.text === text);
  assert.ok(b, `a bubble for "${text}"`);
  return b;
};
/** The "In the room" row that names this handle. */
const memberRow = (html: string, handle: string) => {
  const section = html.slice(html.indexOf("In the room"));
  const row = section.split('<div class="it">').slice(1).find((r) => r.includes(handle));
  assert.ok(row, `a member row for ${handle}`);
  return row;
};
const renderRooms = async (c: any) => { const v: any = { innerHTML: "" }; await c.PAGES.rooms(v); return v.innerHTML as string; };
const bare = (handle: string) => String(handle).replace(/^@/, "");
const handlesOf = (seats: any[]) => (seats || []).map((b: any) => bare(b.handle)).sort();

/** A room with A's own Bot, A's brought guest B.bot (on a share), and an ordinary member C who joined by code. */
async function roomWithAGuest(code: string) {
  const s = await startServer();
  const { A, B } = await friends(s.base);
  const C = await ownerWithBot(s.base, "guesty");
  const share = await req(s.base, "POST", `/v1/bots/${B.bot.id}/grants`, B.owner.token, { friend_owner_id: A.owner_id, friend_bot_id: A.bot.id });
  assert.equal(share.status, 201, JSON.stringify(share.body));
  const opened = await req(s.base, "POST", "/v1/face-rooms/join", A.owner.token, { code, bots: [A.bot.id, B.bot.id] });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  const roomId = opened.body.room_id as string;
  const joined = await req(s.base, "POST", "/v1/face-rooms/join", C.owner.token, { code, bots: [C.bot.id] });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  assert.equal(joined.body.room_id, roomId);
  const started = await req(s.base, "POST", `/v1/face-rooms/${roomId}/start`, A.owner.token);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  for (const o of [A, B, C]) assert.equal((await req(s.base, "PATCH", "/v1/me", o.owner.token, { auto_approve_face_rooms: true })).status, 200);
  return { s, A, B, C, roomId, code };
}

const ownLine = "A line from the home that opened the room.";
const guestLine = "A line from the guest Bot.";
const memberLine = "A line from the third home.";

test("a guest seat's line is peer content, the viewer's own line stays its own", async () => {
  const { s, A, B, C, roomId } = await roomWithAGuest("810001");
  try {
    for (const [o, text] of [[A, ownLine], [B, guestLine], [C, memberLine]] as const) {
      const r = await req(s.base, "POST", `/v1/face-rooms/${roomId}/messages`, o.owner.token, { text, bot_id: o.bot.id });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      assert.equal(r.body.status, "delivered");
    }
    const html = await renderRooms(loadConsole(s.base, A.owner.token, `#/rooms/${roomId}`));
    const guest = bubbleOf(html, guestLine);
    assert.equal(guest.side, "peer", "a guest's line is not the viewer's own side");
    assert.match(guest.meta, /peer content · untrusted/);
    assert.ok(!guest.meta.includes("your Bot"), "a guest's line is not the viewer's Bot");
    const own = bubbleOf(html, ownLine);
    assert.equal(own.side, "me");
    assert.match(own.meta, /your Bot/);
    assert.ok(!own.meta.includes("untrusted"));
  } finally { await s.stop(); }
});

test("the viewer's own seat keeps the Yours pill, a brought guest does not", async () => {
  const { s, A, B, C, roomId } = await roomWithAGuest("810002");
  try {
    const html = await renderRooms(loadConsole(s.base, A.owner.token, `#/rooms/${roomId}`));
    assert.match(memberRow(html, bare(A.handle)), /Yours/, "the viewer's own seat is Yours");
    assert.ok(!memberRow(html, bare(B.handle)).includes("Yours"), "a guest seat is not Yours");
    assert.ok(!memberRow(html, bare(C.handle)).includes("Yours"), "another home's seat is not Yours");
  } finally { await s.stop(); }
});

test("the bringer still sees and manages a guest seat but never speaks as it", async () => {
  const { s, A, B, roomId } = await roomWithAGuest("810003");
  try {
    const sent = await req(s.base, "POST", `/v1/face-rooms/${roomId}/messages`, B.owner.token, { text: guestLine, bot_id: B.bot.id });
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    assert.equal(sent.body.status, "delivered");

    // The wire is right already: the guest's words are the other home's, and they say so.
    const view = await req(s.base, "GET", `/v1/face-rooms/${roomId}`, A.owner.token);
    assert.equal(view.status, 200, JSON.stringify(view.body));
    const wire = (view.body.events || []).find((e: any) => e.type === "room.message" && e.untrusted_content?.text === guestLine);
    assert.ok(wire, "the guest's line is in the room view");
    assert.equal(wire.trust, "peer_untrusted", "the wire keeps marking a guest line untrusted");
    assert.equal(wire.from?.bot_id, B.bot.id);

    // The write door keeps its own test: the bringer may manage the seat, not speak as it.
    const asGuest = await req(s.base, "POST", `/v1/face-rooms/${roomId}/messages`, A.owner.token, { text: "Not mine to say.", bot_id: B.bot.id });
    assert.equal(asGuest.status, 403, JSON.stringify(asGuest.body));
    assert.equal(asGuest.body.error?.code, "forbidden");

    // The list keeps the guest visible to the home that brought it, apart from the seats it owns.
    const list = await req(s.base, "GET", "/v1/face-rooms", A.owner.token);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const row = (list.body.rooms || []).find((r: any) => r.room_id === roomId);
    assert.ok(row, "the room is in the list");
    assert.deepEqual(handlesOf(row.my_bots), [bare(A.handle)], "my_bots is the seats this home owns");
    assert.deepEqual(handlesOf(row.brought_bots), [bare(B.handle)], "brought_bots is the guest this home brought in");
  } finally { await s.stop(); }
});

test("a Bot token reads only its own seat", async () => {
  const s = await startServer();
  try {
    const A = await ownerWithBot(s.base, "twoseats");
    const second = await req(s.base, "POST", "/v1/bots", A.owner.token, { handle: "twoseats.second" });
    assert.equal(second.status, 201, JSON.stringify(second.body));
    const opened = await req(s.base, "POST", "/v1/face-rooms/join", A.owner.token, { code: "810005", bots: [A.bot.id, second.body.bot_id] });
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    const roomId = opened.body.room_id as string;
    const started = await req(s.base, "POST", `/v1/face-rooms/${roomId}/start`, A.owner.token);
    assert.equal(started.status, 200, JSON.stringify(started.body));

    const asOwner = await req(s.base, "GET", "/v1/face-rooms", A.owner.token);
    const ownerRow = (asOwner.body.rooms || []).find((r: any) => r.room_id === roomId);
    assert.equal((ownerRow?.my_bots || []).length, 2, "the owner holds both seats");

    const asBot = await req(s.base, "GET", "/v1/face-rooms", A.reg.bot_token);
    assert.equal(asBot.status, 200, JSON.stringify(asBot.body));
    const botRow = (asBot.body.rooms || []).find((r: any) => r.room_id === roomId);
    assert.ok(botRow, "the room is in the Bot's list");
    assert.deepEqual(handlesOf(botRow.my_bots), [bare(A.handle)], "a Bot token sees only the seat it holds");
  } finally { await s.stop(); }
});

test("an ordinary member's line and a candidate room keep their rendering", async () => {
  const { s, A, C, roomId } = await roomWithAGuest("810006");
  try {
    const sent = await req(s.base, "POST", `/v1/face-rooms/${roomId}/messages`, C.owner.token, { text: memberLine, bot_id: C.bot.id });
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    const html = await renderRooms(loadConsole(s.base, A.owner.token, `#/rooms/${roomId}`));
    const peer = bubbleOf(html, memberLine);
    assert.equal(peer.side, "peer");
    assert.match(peer.meta, /peer content · untrusted/);

    // A room that has not started renders the same lines the same way.
    const candidate = await req(s.base, "POST", "/v1/face-rooms/join", A.owner.token, { code: "810007", bots: [A.bot.id] });
    assert.equal(candidate.status, 200, JSON.stringify(candidate.body));
    const ownInCandidate = "A line in a room that has not started.";
    const draft = await req(s.base, "POST", `/v1/face-rooms/${candidate.body.room_id}/messages`, A.owner.token, { text: ownInCandidate, bot_id: A.bot.id });
    assert.equal(draft.status, 202, JSON.stringify(draft.body));
    const candidateHtml = await renderRooms(loadConsole(s.base, A.owner.token, `#/rooms/${candidate.body.room_id}`));
    const own = bubbleOf(candidateHtml, ownInCandidate);
    assert.equal(own.side, "me");
    assert.match(own.meta, /your Bot/);
  } finally { await s.stop(); }
});
