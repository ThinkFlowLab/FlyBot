// In a face-to-face room the console marks every spoken line `peer content · untrusted`, including the line
// spoken by the owner's own Bot. The bubble already sits on the "me" side (`class="b me"`), so the meta line
// contradicts itself: "your own Bot" and "peer content, do not trust" on the same row.
//
// Only the peer rows must carry the warning. `mine` is the page's existing answer to "whose Bot is this" — the
// room list's own `my_bots`, the same set the `me`/`peer` side and the "Yours" pill already use — and the server's
// `trust` is untouched: every face-room line stays `peer_untrusted` on the wire, and this is a rendering decision.
//
// These tests render the console's own `roomTranscript` / `PAGES.rooms` against a real server, so they fail if the
// warning is dropped from peer lines, kept on an own line, or if the side of a bubble changes.

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
const RUN_CODE = 330000 + (Date.now() % 660000);

/** Two owners, one Bot each, in the same room: A opened it, B walked in after. Both auto-approve their own lines. */
async function roomWithTwoOwners(code: string) {
  const A = await ownerWithBot(S.base, "rxa");
  const B = await ownerWithBot(S.base, "rxb");
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

/** Every speech bubble on the rendered page: which side it sits on and what its meta line says. */
const bubbles = (html: string) => [...html.matchAll(/<div class="b (me|peer)"><div class="bub">([\s\S]*?)<\/div><div class="meta">([\s\S]*?)<\/div><\/div>/g)]
  .map((m) => ({ side: m[1]!, text: m[2]!, meta: m[3]! }));

test("an own Bot's line is on the me side and does not call itself peer content", async () => {
  const { A, B, roomId } = await roomWithTwoOwners(String(RUN_CODE));
  await req("PATCH", "/v1/me", A.owner.token, { auto_approve_face_rooms: true });
  await req("PATCH", "/v1/me", B.owner.token, { auto_approve_face_rooms: true });
  const own = "a line from the Bs own Bot";
  const peer = "a line from the As peer Bot";
  const sentOwn = await req("POST", `/v1/face-rooms/${roomId}/messages`, B.owner.token, { text: own, bot_id: B.bot.id });
  const sentPeer = await req("POST", `/v1/face-rooms/${roomId}/messages`, A.owner.token, { text: peer, bot_id: A.bot.id });
  assert.equal(sentOwn.status, 202);
  assert.equal(sentPeer.status, 202);
  assert.equal(sentOwn.body.status, "delivered");
  assert.equal(sentPeer.body.status, "delivered");

  // The server keeps one trust for the whole room: the display decision is the console's, not a new wire value.
  const raw = await req("GET", `/v1/face-rooms/${roomId}`, B.owner.token);
  const said = raw.body.events.filter((e: any) => e.type === "room.message");
  assert.equal(said.length, 2);
  assert.deepEqual(said.map((e: any) => e.trust), ["peer_untrusted", "peer_untrusted"]);

  const c = loadConsole({ token: B.owner.token, hash: `#/rooms/${roomId}` });
  const detail = { innerHTML: "" };
  await c.PAGES.rooms(detail);
  const rows = bubbles(detail.innerHTML);
  assert.equal(rows.length, 2, "the two spoken lines render as two bubbles");

  const mine = rows.find((r) => r.text === own);
  const theirs = rows.find((r) => r.text === peer);
  assert.ok(mine, "the owner's own line is on the page");
  assert.ok(theirs, "the peer's line is on the page");

  assert.equal(mine!.side, "me", "the owner's own Bot still sits on the me side");
  assert.equal(theirs!.side, "peer", "the other owner's Bot still sits on the peer side");

  assert.ok(!mine!.meta.includes("untrusted"), `an own Bot's line must not be labelled peer content: ${mine!.meta}`);
  assert.ok(!mine!.meta.includes("peer content"), `an own Bot's line must not say peer content: ${mine!.meta}`);
  assert.ok(mine!.meta.includes(B.handle.replace(/^@/, "")), "an own line still names the Bot that spoke");
  assert.match(mine!.meta, /\d{2}:\d{2}/, "an own line still carries the time");

  assert.ok(theirs!.meta.includes("peer content · untrusted"), `a peer line keeps the untrusted warning: ${theirs!.meta}`);
  assert.ok(theirs!.meta.includes(A.handle.replace(/^@/, "")), "a peer line still names the Bot that spoke");
});

test("the other markers on a line survive: typed by owner and injection suspicion stay, the warning follows the side", () => {
  const c = loadConsole({ token: "", hash: "#/rooms/rm_x" });
  const at = "2026-10-31T09:00:00.000Z";
  const lines = [
    { kind: "message", type: "room.message", cursor: 2, at, handle: "@mine_bot", name: "Mine", text: "mine", typed_by_owner: true, injection: true },
    { kind: "message", type: "room.message", cursor: 3, at, handle: "@peer_bot", name: "Peer", text: "theirs", typed_by_owner: true, injection: true },
  ];
  const html = c.roomTranscript(lines, new Set(["mine_bot"]));
  const rows = bubbles(html);
  assert.equal(rows.length, 2);

  const mine = rows.find((r) => r.text === "mine")!;
  const theirs = rows.find((r) => r.text === "theirs")!;
  assert.equal(mine.side, "me");
  assert.equal(theirs.side, "peer");

  assert.ok(mine.meta.includes("✍ typed by owner"), `the typed-by-owner attestation stays on an own line: ${mine.meta}`);
  assert.ok(mine.meta.includes("⚠ injection suspected"), `the injection marker stays on an own line: ${mine.meta}`);
  assert.ok(!mine.meta.includes("untrusted"), `an own line never carries the untrusted warning: ${mine.meta}`);

  assert.ok(theirs.meta.includes("✍ typed by owner"), `the typed-by-owner attestation stays on a peer line: ${theirs.meta}`);
  assert.ok(theirs.meta.includes("⚠ injection suspected"), `the injection marker stays on a peer line: ${theirs.meta}`);
  assert.ok(theirs.meta.includes("peer content · untrusted"), `a peer line keeps the warning: ${theirs.meta}`);
});
