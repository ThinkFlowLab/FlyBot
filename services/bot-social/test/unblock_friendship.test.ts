// P3 (#219): a Block is the one end state the owner can take back, but nothing on master writes it back. `block()`
// (`src/platform.ts:1848`) ends every row the pair holds (`endRelationship` `:1824`, the pair loop `:1875`), and
// `removeRelationship` (`:1838`) refuses a blocked row outright, so a friendship blocked by mistake is permanent;
// the console even says so on its Block button (`public/ui.js:447`, "You cannot undo a block from the console.") and
// its blocked card is an empty string (`:425`).
//
// The undo has to take back every row the same owner blocked, not only the id it is given: `requestRelationship`
// refuses the pair while any row is blocked (`src/platform.ts:1152`), so a fix on the friendship row alone would
// leave the pair unable to ask again. The id locates the pair and decides who may undo it; it is not the boundary.
//
// These tests are behavioural: they block through the real route, render the real Friends page (the console's own
// `PAGES.friends`, against the real server), click the control the page binds, and read back the row, the grants,
// the chats and the audit the owner would see.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { friends, ownerWithBot, startServer } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "public", "ui.js"), "utf8")
  .replace(/\nboot\(\);\s*$/, "\n;globalThis.__ui = { PAGES, setMe: (x) => { me = x; } };\n");

/** The owners' clients throw on a non-2xx answer; this keeps the status and the refusal text so a test can read them. */
async function attempt(p: Promise<any>) {
  try { return { ok: true as const, value: await p }; }
  catch (e: any) { return { ok: false as const, status: e.status as number, code: e.code as string, message: String(e.message) }; }
}

const undo = (o: any, relId: string) => o.owner.req("POST", `/v1/blocks/${relId}/undo`);

/** Every relationship row between two Bots, so a test can see that `block`/undo touched more than the named row. */
const pairRows = (s: any, a: string, b: string) =>
  s.platform.db.prepare("SELECT status, blocked_by FROM relationships WHERE (requester_bot = ? AND target_bot = ?) OR (requester_bot = ? AND target_bot = ?)").all(a, b, b, a) as any[];

const relRow = async (o: any, relId: string) =>
  (await o.owner.req("GET", "/v1/relationships")).relationships.find((r: any) => r.relationship_id === relId);

const el = (extra: any = {}) => ({ innerHTML: "", textContent: "", onclick: null, classList: { add() {}, remove() {} }, querySelector: () => null, querySelectorAll: () => [], ...extra });

/**
 * The console's Friends page in a sandbox, driven against the real server: `PAGES.friends` renders the page and
 * binds the controls, and the test fires the same handler an owner's click fires. The `[data-rel]` card is handed
 * one stub element per row, and `[data-unblk]` inside it is only returned when the rendered page really has one.
 */
function openConsole(base: string, token: string, relId: string) {
  const toastEl = el();
  const loEl = el();
  const state = { html: "", confirm: "" };
  const root = el();
  const view = el();
  Object.defineProperty(view, "innerHTML", { get: () => state.html, set: (x: string) => { state.html = x; } });
  const unblk = el();
  const card = el({ dataset: { rel: relId } });
  card.querySelector = (s: string) => (s === "[data-unblk]" && /data-unblk/.test(state.html) ? unblk : null);
  card.querySelectorAll = () => [];
  view.querySelectorAll = (s: string) => (s === "[data-rel]" ? [card] : []);
  const ctx: any = {
    localStorage: { getItem: (k: string) => (k === "bs_owner_token" ? token : null), setItem() {}, removeItem() {} },
    window: { addEventListener() {} },
    document: { querySelector: (s: string) => (s === "#toast" ? toastEl : s === "#lo" || s === "#lo2" ? loEl : s === "#root" ? root : s === "#view" ? view : null), querySelectorAll: () => [], createElement: () => el(), activeElement: null },
    location: { hash: "#/friends", origin: "https://example.test", reload() {} },
    fetch: (path: string, init?: any) => fetch(base + path, init),
    setInterval() {}, setTimeout, clearTimeout, URLSearchParams, Intl, Date, console,
    confirm: (m: string) => { state.confirm = m; return true; }, prompt: () => null,
  };
  vm.runInNewContext(src, ctx);
  ctx.__ui.setMe({ owner_id: "own_test", display_name: "Test Owner", username: "owner", timezone: "UTC", bots: [] });
  const settle = () => new Promise((r) => setTimeout(r, 80)); // the click re-renders the shell without awaiting it
  return {
    render: async () => { await ctx.__ui.PAGES.friends(view); return state.html; },
    overview: async () => {
      const r = await fetch(`${base}/v1/friends-overview`, { headers: { authorization: `Bearer ${token}` } });
      const d: any = await r.json();
      return [...(d.others || []), ...(d.friends || [])].find((x: any) => x.relationship_id === relId) ?? null;
    },
    html: () => state.html,
    confirmText: () => state.confirm,
    hasUnblock: () => /data-unblk/.test(state.html),
    clickUnblock: async () => {
      assert.equal(typeof unblk.onclick, "function", "the Blocked card offers a control bound to a handler");
      await unblk.onclick();
      await settle();
      return { toast: toastEl.textContent, confirm: state.confirm };
    },
  };
}

test("a blocked friendship offers an undo, and the route exists", async () => {
  const s = await startServer();
  try {
    const p = await friends(s.base);
    await p.A.owner.req("POST", "/v1/blocks", { relationship_id: p.relId });
    const page = openConsole(s.base, p.A.owner.token, p.relId);
    await page.render();
    const hasUnblock = page.hasUnblock();
    const r = await attempt(undo(p.A, p.relId));
    assert.ok(hasUnblock && r.ok,
      `the Blocked card has ${hasUnblock ? "an Unblock" : "no Unblock"}, and POST /v1/blocks/${p.relId}/undo answered ${r.ok ? "200" : r.status}`);
    assert.equal(r.value.status, "revoked", "the undo lands on the state an Unfriend leaves");
    assert.equal((await relRow(p.A, p.relId)).status, "revoked");
  } finally { await s.stop(); }
});

test("clicking Unblock says the friendship is not restored, and lands the row on Removed", async () => {
  const s = await startServer();
  try {
    const p = await friends(s.base);
    await p.A.owner.req("POST", "/v1/blocks", { relationship_id: p.relId });
    const page = openConsole(s.base, p.A.owner.token, p.relId);
    await page.render();
    const blockedAt = (await page.overview()).connected_at;
    const blockedLabel = (page.html().match(/<span>Blocked<\/span><span>([^<]*)<\/span>/) || [])[1];
    assert.ok(blockedAt && blockedLabel, "the blocked card names the moment the friendship ended");
    assert.equal(page.hasUnblock(), true, "the owner who blocked is offered the undo");
    const clicked = await page.clickUnblock();
    assert.match(clicked.confirm, /does not restore the friendship/i, `the confirm must not promise the friendship back; it said "${clicked.confirm}"`);
    assert.equal(clicked.toast, "Unblocked");
    assert.equal((await relRow(p.A, p.relId)).status, "revoked", "the click wrote the undo to the server");
    assert.match(page.html(), /Removed/, "the re-rendered row falls to Removed");
    assert.doesNotMatch(page.html(), /data-unblk/, "a revoked row has nothing left to undo");
    assert.equal((await page.overview()).connected_at, blockedAt, "the Removed time is when the block ended the friendship, not when the undo was clicked");
    assert.equal((page.html().match(/<span>Removed<\/span><span>([^<]*)<\/span>/) || [])[1], blockedLabel, "the card shows the same moment it showed as Blocked");
  } finally { await s.stop(); }
});

test("A: the side that was blocked cannot undo, and is offered no control", async () => {
  const s = await startServer();
  try {
    const p = await friends(s.base);
    await p.A.owner.req("POST", "/v1/blocks", { relationship_id: p.relId });
    const page = openConsole(s.base, p.B.owner.token, p.relId);
    await page.render();
    assert.equal(page.hasUnblock(), false, "only the owner who wrote the block may take it back");
    const r = await attempt(undo(p.B, p.relId));
    assert.equal(r.ok, false, `the blocked side undid the block: ${JSON.stringify(r)}`);
    assert.equal(r.status, 403);
    assert.equal(r.code, "forbidden");
    assert.equal((await relRow(p.A, p.relId)).status, "blocked", "a refused undo changes nothing");
  } finally { await s.stop(); }
});

test("B: the owner who blocked takes it back: revoked, no old audit lost, one new entry", async () => {
  const s = await startServer();
  try {
    const p = await friends(s.base);
    await p.A.owner.req("POST", "/v1/blocks", { relationship_id: p.relId });
    const r = await attempt(undo(p.A, p.relId));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.value.status, "revoked");
    const row: any = await relRow(p.A, p.relId);
    assert.equal(row.status, "revoked");
    assert.equal(row.blocked_by_me, false, "the row is no longer marked as blocked by this owner");
    assert.deepEqual(row.capabilities.me_on_peer, [], "the block voided every grant; the undo does not bring them back");
    assert.deepEqual(row.capabilities.peer_on_me, []);
    const audited = (await p.A.owner.req("GET", `/v1/audit-events?subject=${p.relId}`)).events.map((e: any) => e.action);
    assert.equal(audited.filter((a: string) => a === "relationship.blocked").length, 1, "the old block entry is kept");
    assert.equal(audited.filter((a: string) => a === "relationship.unblocked").length, 1, "the undo is appended");
    const again = await attempt(undo(p.A, p.relId));
    assert.equal(again.ok, false);
    assert.equal(again.status, 409, "there is no second undo");
  } finally { await s.stop(); }
});

test("C: after the undo the pair can ask again, and the old friendship stays revoked", async () => {
  const s = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  try {
    const p = await friends(s.base);
    const conv: any = await p.A.bot.signed("/v1/conversations", "conversation.create", { type: "direct", peer_bot_id: p.B.bot.id, intent: { type: "general_chat", summary: "plan the week" } });
    // A room row between the same pair: `block` ends it as well, so the undo has to take back more than one row.
    await p.A.owner.req("POST", "/v1/face-rooms/join", { code: "737373", bots: [p.A.bot.id] });
    await p.B.owner.req("POST", "/v1/face-rooms/join", { code: "737373", bots: [p.B.bot.id] });
    await p.A.owner.req("POST", "/v1/blocks", { relationship_id: p.relId });
    assert.ok(pairRows(s, p.A.bot.id, p.B.bot.id).length > 1, "the block ended every row the pair holds");
    assert.deepEqual(pairRows(s, p.A.bot.id, p.B.bot.id).filter((x) => x.status !== "blocked"), [], "all of them are blocked");

    const r = await attempt(undo(p.A, p.relId));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(pairRows(s, p.A.bot.id, p.B.bot.id).filter((x) => x.status === "blocked"), [], "the undo takes back every row this owner blocked");
    assert.deepEqual(pairRows(s, p.A.bot.id, p.B.bot.id).map((x) => x.status).sort(), ["revoked", "revoked"], "they land on revoked, not active");

    const old: any = await relRow(p.A, p.relId);
    assert.equal(old.status, "revoked", "the old friendship is not restored");
    assert.deepEqual(old.capabilities.me_on_peer, []);
    assert.deepEqual(old.capabilities.peer_on_me, []);
    const chats = (await p.A.owner.req("GET", "/v1/conversations")).conversations.filter((c: any) => c.conversation_id === conv.conversation_id);
    assert.equal(chats.length, 1);
    assert.equal(chats[0].status, "closed", "the chat the block closed stays closed");

    const again: any = await p.A.owner.req("POST", "/v1/relationships", { from_bot_id: p.A.bot.id, target_handle: p.B.handle, requested_capabilities: ["chat.public"] });
    assert.notEqual(again.relationship_id, p.relId, "the new request is a new row");
    assert.equal(again.status, "pending_target");
    assert.equal((await relRow(p.A, p.relId)).status, "revoked", "asking again does not resurrect the old row");
  } finally { await s.stop(); }
});

test("an unrelated owner reads the same 404 as a missing id", async () => {
  const s = await startServer();
  try {
    const p = await friends(s.base);
    const C = await ownerWithBot(s.base, "carol");
    await p.A.owner.req("POST", "/v1/blocks", { relationship_id: p.relId });
    const unrelated = await attempt(undo(C, p.relId));
    const missing = await attempt(undo(C, "rel_does_not_exist"));
    assert.equal(unrelated.ok, false);
    assert.equal(unrelated.status, 404, "a stranger must not learn that this pair is blocked");
    assert.equal(unrelated.code, "relationship_not_found");
    assert.deepEqual({ status: unrelated.status, code: unrelated.code, message: unrelated.message }, { status: missing.status, code: missing.code, message: missing.message },
      "an unrelated id answers exactly like one that does not exist");
    assert.equal((await relRow(p.A, p.relId)).status, "blocked");
  } finally { await s.stop(); }
});
