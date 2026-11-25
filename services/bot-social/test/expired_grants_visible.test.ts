// P5: the Friends card learned to say "expired" and to offer a Renew (#218), but nothing on a cold page ever shows
// that state. `grantsFor` (`src/platform.ts:1324`) writes a lapsed row back to `status='expired'` and then skips it,
// so `/v1/friends-overview` never lists it: the expired + Renew the card already renders only appeared in the window
// between that response and the render, or on a browser clock ahead of the server. A grant that ended months ago is
// simply gone, and there is nothing left to renew.
//
// The display read must not become an access read. `findGrant`, `listBotGrants`, `sendAsMember` and room reach keep
// dropping a lapsed row exactly as before: the overview is the only place an ended grant is listed, so the owner can
// see it ended and renew it, and it still cannot do anything.
//
// These tests are behavioural: they drive the real routes, and the console tests render the console's own
// `PAGES.friends` against the real server and fire the handler its Renew button binds.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { friends, startServer } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "public", "ui.js"), "utf8")
  .replace(/\nboot\(\);\s*$/, "\n;globalThis.__ui = { PAGES, setMe: (x) => { me = x; } };\n");

const FREE_BUSY = { window_days: 14, hours: "09:00-18:00" };
const past = () => new Date(Date.now() - 3600e3).toISOString();

/** The owners' clients throw on a non-2xx answer; this keeps the status and the refusal code so a test can read them. */
async function attempt(p: Promise<any>) {
  try { return { ok: true as const, value: await p }; }
  catch (e: any) { return { ok: false as const, status: e.status as number, code: e.code as string, message: String(e.message) }; }
}

/** One row of the owner's own Friends page, read the way the page reads it. */
async function card(o: any, botId: string, relId: string) {
  const d = await o.owner.req("GET", `/v1/friends-overview?bot_id=${botId}`);
  return [...d.friends, ...d.pending_incoming, ...d.pending_outgoing, ...d.others].find((x: any) => x.relationship_id === relId) ?? null;
}

/** The capability chips in a rendered Friends page: one entry per `title="<capability>"` pill. */
const chips = (html: string, cap: string) => html.split(/<span class="pill" title="/).slice(1)
  .map((s) => ({ title: s.slice(0, s.indexOf('"')), text: s }))
  .filter((p) => p.title === cap);
const expiryOf = (segment: string) => (segment.match(/data-expiry>([^<]*)</) || [])[1] ?? null;

const el = (extra: any = {}) => ({ innerHTML: "", textContent: "", onclick: null, classList: { add() {}, remove() {} }, querySelector: () => null, querySelectorAll: () => [], ...extra });

/**
 * The console's Friends page in a sandbox, driven against the real server: `PAGES.friends` renders the page and binds
 * the controls, and the test fires the same handler an owner's click fires. The `[data-rel]` card is handed one stub
 * per row, and `[data-renew]` inside it is only returned when the rendered page really offers one.
 */
function openConsole(base: string, token: string, relId: string) {
  const toastEl = el();
  const loEl = el();
  const state = { html: "" };
  const root = el();
  const view = el();
  Object.defineProperty(view, "innerHTML", { get: () => state.html, set: (x: string) => { state.html = x; } });
  const renewEl = el();
  const cardEl = el({ dataset: { rel: relId } });
  cardEl.querySelector = () => null;
  cardEl.querySelectorAll = (s: string) => {
    if (s !== "[data-renew]") return [];
    const m = state.html.match(/data-renew="([^"]+)"/);
    if (!m) return [];
    renewEl.dataset = { renew: m[1] };
    return [renewEl];
  };
  view.querySelectorAll = (s: string) => (s === "[data-rel]" ? [cardEl] : []);
  const posts: { path: string; body: any }[] = [];
  const ctx: any = {
    localStorage: { getItem: (k: string) => (k === "bs_owner_token" ? token : null), setItem() {}, removeItem() {} },
    window: { addEventListener() {} },
    document: { querySelector: (s: string) => (s === "#toast" ? toastEl : s === "#lo" || s === "#lo2" ? loEl : s === "#root" ? root : s === "#view" ? view : null), querySelectorAll: () => [], createElement: () => el(), activeElement: null },
    location: { hash: "#/friends", origin: "https://example.test", reload() {} },
    fetch: async (path: string, init?: any) => {
      if ((init?.method || "GET") !== "GET") posts.push({ path, body: init?.body ? JSON.parse(init.body) : undefined });
      return fetch(base + path, init);
    },
    setInterval() {}, setTimeout, clearTimeout, URLSearchParams, Intl, Date, console,
    confirm: () => true, prompt: () => null,
  };
  vm.runInNewContext(src, ctx);
  ctx.__ui.setMe({ owner_id: "own_test", display_name: "Test Owner", username: "owner", timezone: "UTC", bots: [] });
  const settle = () => new Promise((r) => setTimeout(r, 150)); // the click re-renders the shell without awaiting it
  return {
    render: async () => { await ctx.__ui.PAGES.friends(view); return state.html; },
    html: () => state.html,
    renew: () => (/data-renew="/.test(state.html) ? renewEl : null),
    clickRenew: async () => {
      assert.equal(typeof renewEl.onclick, "function", "the Renew the page offers is bound to a handler");
      await renewEl.onclick();
      await settle();
      return { toast: toastEl.textContent, posted: posts.slice(), html: state.html };
    },
  };
}

test("A: a grant that has lapsed is still on the overview, named expired, next to the one that is live", async () => {
  const s = await startServer();
  try {
    const p = await friends(s.base);
    const created = await p.B.owner.req("POST", `/v1/relationships/${p.relId}/grants`, { capability: "calendar.book", expires_in_days: 30 });
    s.platform.db.prepare("UPDATE grants SET expires_at = ? WHERE id = ?").run(past(), created.grant_id);

    const row = await card(p.B, p.B.bot.id, p.relId);
    const granted = row.capabilities.granted_to_peer;
    const live = granted.find((g: any) => g.capability === "chat.public");
    const lapsed = granted.find((g: any) => g.capability === "calendar.book");
    assert.ok(lapsed,
      `the grant whose expiry passed an hour ago is missing from /v1/friends-overview, so a cold page can never show it ended or offer a Renew: ${JSON.stringify(granted)}`);
    assert.equal(lapsed.status, "expired", "a grant that has lapsed is listed with the state it is in");
    assert.ok(live && live.status === "active", `the grant that has not lapsed is no longer listed as active: ${JSON.stringify(granted)}`);
    assert.ok(Date.parse(lapsed.expires_at) < Date.now(), `the listed grant carries its real expiry, not a refreshed one: ${lapsed.expires_at}`);
  } finally { await s.stop(); }
});

test("B: re-granting a lapsed capability leaves one chip on the card, the live one", async () => {
  const s = await startServer();
  try {
    const p = await friends(s.base);
    const created = await p.B.owner.req("POST", `/v1/relationships/${p.relId}/grants`, { capability: "calendar.book", expires_in_days: 30 });
    s.platform.db.prepare("UPDATE grants SET expires_at = ? WHERE id = ?").run(past(), created.grant_id);

    const before = (await card(p.B, p.B.bot.id, p.relId)).capabilities.granted_to_peer
      .filter((g: any) => g.capability === "calendar.book");
    assert.deepEqual(before.map((g: any) => g.status), ["expired"],
      `the lapsed grant is not shown, so "granting it again" would look like the first grant instead of a renewal: ${JSON.stringify(before)}`);

    await p.B.owner.req("POST", `/v1/relationships/${p.relId}/grants`, { capability: "calendar.book", expires_in_days: 30 });
    const after = (await card(p.B, p.B.bot.id, p.relId)).capabilities.granted_to_peer
      .filter((g: any) => g.capability === "calendar.book");
    assert.equal(after.length, 1, `the card would show two chips for one capability, one expired and one live: ${JSON.stringify(after)}`);
    assert.equal(after[0].status, "active", "the one chip left is the grant that is live now");
    assert.ok(Date.parse(after[0].expires_at) > Date.now(), "and it carries the new expiry");
  } finally { await s.stop(); }
});

test("C: a lapsed grant is visible on the page and still grants nothing", async () => {
  const s = await startServer();
  try {
    const p = await friends(s.base);
    const row = s.platform.db.prepare(
      "SELECT id FROM grants WHERE relationship_id = ? AND grantee_bot = ? AND capability = 'chat.public' AND status = 'active'",
    ).get(p.relId, p.A.bot.id) as any;
    assert.ok(row, "control: accepting the friendship wrote a chat.public grant for A's Bot");
    s.platform.db.prepare("UPDATE grants SET expires_at = ? WHERE id = ?").run(past(), row.id);

    const refused = await attempt(p.A.bot.startConversation(p.B.bot.id, { type: "general_chat", summary: "hello?" }));
    assert.equal(refused.ok, false, `a chat.public grant whose expiry has passed still opened a conversation: ${JSON.stringify(refused)}`);
    assert.equal(refused.status, 403);
    assert.equal(refused.code, "capability_not_granted", "a lapsed grant is refused with the same shape as a grant that was never given");

    const listed = (await card(p.B, p.B.bot.id, p.relId)).capabilities.granted_to_peer
      .filter((g: any) => g.capability === "chat.public");
    assert.deepEqual(listed.map((g: any) => g.status), ["expired"], `the owner cannot see that the grant ended: ${JSON.stringify(listed)}`);
  } finally { await s.stop(); }
});

test("D: the console shows the lapsed grant as expired and renews it from the card", async () => {
  const s = await startServer();
  try {
    const p = await friends(s.base);
    const created = await p.B.owner.req("POST", `/v1/relationships/${p.relId}/grants`, { capability: "calendar.freebusy.read", scope: FREE_BUSY, expires_in_days: 30 });
    s.platform.db.prepare("UPDATE grants SET expires_at = ? WHERE id = ?").run(past(), created.grant_id);

    const page = openConsole(s.base, p.B.owner.token, p.relId);
    const before = await page.render();
    const shown = chips(before, "calendar.freebusy.read");
    assert.equal(shown.length, 1, `the Friends card does not list the grant that lapsed: ${JSON.stringify(shown.map((c) => c.text))}`);
    assert.equal(expiryOf(shown[0].text), "expired", "the card names the lapsed grant as expired instead of dropping it");
    assert.ok(page.renew() !== null, "a grant that has lapsed says expired but offers no Renew, so the owner cannot bring it back");
    // The × revokes through `data-revoke`, whose handler finds the grant in `/v1/relationships` — the read that drops a
    // lapsed row. A × on this chip would be a button that does nothing at all, so the ended chip must not carry one.
    assert.doesNotMatch(shown[0].text, /data-revoke/, "an expired chip offers a Revoke that can only do nothing: the grant is already void and the route cannot find it");

    const clicked = await page.clickRenew();
    assert.equal(clicked.posted.length, 1, `the Renew click wrote ${clicked.posted.length} grants instead of one: ${JSON.stringify(clicked.posted)}`);
    assert.equal(clicked.posted[0].path, `/v1/relationships/${p.relId}/grants`, "the renewal is written on the relationship the card is for");
    assert.equal(clicked.posted[0].body.capability, "calendar.freebusy.read", "the renewal keeps the same capability");
    assert.deepEqual(clicked.posted[0].body.scope, FREE_BUSY, "and the scope it was granted with, not the console's default");
    assert.equal(clicked.posted[0].body.expires_in_days, 30, "a renewal writes a fresh expiry instead of leaving the old one");
    assert.equal(clicked.toast, "Renewed for 30 days");

    const after = chips(clicked.html, "calendar.freebusy.read");
    assert.equal(after.length, 1, `after renewing, the card shows ${after.length} chips for one capability (the lapsed row and the new one): ${JSON.stringify(after.map((c) => c.text))}`);
    assert.equal(expiryOf(after[0].text), "30 days left", "the card the owner is left looking at shows the renewed expiry");
    assert.match(after[0].text, /data-revoke="calendar\.freebusy\.read"/, "the renewed chip is live again, so it carries the Revoke the ended one had to lose");
  } finally { await s.stop(); }
});
