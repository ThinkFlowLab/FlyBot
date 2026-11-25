// P2 (#217): `GET /v1/friends-overview` has shipped every grant's `expires_at` since the grant table got the column
// (`src/platform.ts` `friendsOverview` -> `capabilities.granted_to_peer` / `granted_to_me`, each item
// `{ capability, scope, expires_at }`), and `insertGrant` supersedes the old row before it writes a new one, so
// "renewing" a grant is writing the same `capability` again with `expires_in_days`.
// The Friends card only rendered `capPill(g.capability) + grantScope(g)`: an owner could not see that a grant they
// gave ends in three days, and had no way to renew it from the card.
//
// These tests are behavioural: each one renders `PAGES.friends` with the real response shape, then reads the page the
// owner sees and, where a control is offered, fires the same handler an owner's click fires.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "public", "ui.js"), "utf8")
  .replace(/\nboot\(\);\s*$/, "\n;globalThis.__ui = { PAGES, setMe: (x) => { me = x; } };\n");

const FREE_BUSY = { window_days: 14, hours: "09:00-18:00" };
/** An ISO instant `days` from now, so the fixtures keep meaning regardless of when the suite runs. */
const at = (days: number) => new Date(Date.now() + days * 86400e3).toISOString();
const grant = (capability: string, expires_at: string | null, scope: any = {}) => ({ capability, scope, expires_at });

/** One active friend of `bot_me`, carrying exactly the fields `friendsOverview` returns for it. */
const overview = (grantedToPeer: any[], grantedToMe: any[] = []) => ({
  bots: [{ bot_id: "bot_me", handle: "@me.bot", display_name: "Me", status: "active" }],
  bot: { bot_id: "bot_me", handle: "@me.bot", display_name: "Me", status: "active", owner_display_name: "Test Owner" },
  friends: [{
    relationship_id: "rel_1", status: "active", direction: "outgoing", side: "joiner",
    peer: { bot_id: "bot_peer", handle: "@bob.bot", display_name: "Bob", owner_display_name: "Bob Owner" },
    connected_at: at(-20), requested_at: at(-21), expires_at: null, message: null,
    requested_capabilities: [], offered_capabilities: [], settings: { auto_approve_chat: false }, blocked_by_me: false,
    capabilities: { granted_to_peer: grantedToPeer, granted_to_me: grantedToMe },
    conversation_count: 0, last_conversation: null, last_activity_at: at(-2),
  }],
  pending_incoming: [], pending_outgoing: [], others: [],
});

const el = (extra: any = {}) => ({ innerHTML: "", textContent: "", onclick: null, classList: { add() {}, remove() {} }, querySelector: () => null, querySelectorAll: () => [], ...extra });

/**
 * The console in a sandbox with `/v1/friends-overview` stubbed, so `PAGES.friends` can be rendered and clicked without
 * a server. The tags inside the rendered page are handed out only when the HTML really contains them, so a build that
 * offers no Renew gives the test nothing to click — exactly what the owner sees.
 */
function renderFriends(first: any) {
  const reads: string[] = [];
  const posts: { path: string; body: any }[] = [];
  const toastEl = el();
  const state = { html: "" };
  const renewEl = el();
  let payload = first;

  const view = el();
  Object.defineProperty(view, "innerHTML", { get: () => state.html, set: (x: string) => { state.html = x; } });
  const card = {
    dataset: { rel: "rel_1" },
    querySelector: () => null,
    querySelectorAll: (s: string) => {
      if (s !== "[data-renew]") return [];
      const m = state.html.match(/data-renew="([^"]+)"/);
      if (!m) return [];
      renewEl.dataset = { renew: m[1] };
      return [renewEl];
    },
  };
  (view as any).querySelectorAll = (s: string) => (s === "[data-rel]" ? [card] : []);

  const ctx: any = {
    localStorage: { getItem: () => "tkn", setItem() {}, removeItem() {} },
    window: { addEventListener() {}, open() {} },
    document: {
      querySelector: (s: string) => {
        if (s === "#toast") return toastEl;
        if (s === "#view") return view;
        if (s === "#root") return el();
        if (s === "#lo" || s === "#lo2") return el();
        return null;
      },
      querySelectorAll: () => [], getElementById: () => null, createElement: () => el(),
    },
    location: { hash: "#/friends", origin: "https://example.test", reload() {} },
    fetch: async (path: string, init?: any) => {
      const method = init?.method || "GET";
      if (method === "GET" && path.startsWith("/v1/friends-overview")) {
        reads.push(path);
        return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(payload)) };
      }
      if (method === "POST" && path.startsWith("/v1/relationships/")) {
        posts.push({ path, body: init?.body ? JSON.parse(init.body) : undefined });
        // `addGrant` supersedes the old grant and writes a fresh one; the re-read shows the new expiry.
        payload = overview([grant("calendar.freebusy.read", at(30), FREE_BUSY)]);
        return { ok: true, status: 201, json: async () => ({ grant_id: "grt_2", capability: "calendar.freebusy.read", grantee_bot: "bot_peer", status: "active" }) };
      }
      throw new Error(`unexpected request ${method} ${path}`);
    },
    setInterval() {}, setTimeout, clearTimeout, URLSearchParams, Intl, Date, console, confirm: () => true,
  };
  vm.runInNewContext(src, ctx);
  ctx.__ui.setMe({ owner_id: "own_1", display_name: "Test Owner", username: "test-owner", timezone: "UTC", bots: [{ id: "bot_me", handle: "@me.bot" }] });

  const settle = () => new Promise((r) => setTimeout(r, 30)); // the click re-renders the shell without awaiting it
  return async () => {
    await ctx.__ui.PAGES.friends(view);
    return {
      html: () => state.html,
      expiry: () => {
        const m = state.html.match(/data-expiry>([^<]*)</);
        return m ? m[1] : null;
      },
      renew: () => (/data-renew="/.test(state.html) ? renewEl : null),
      clickRenew: async () => {
        assert.equal(typeof renewEl.onclick, "function", "the Renew the page offers is bound to a handler");
        await renewEl.onclick();
        await settle();
        return { toast: toastEl.textContent, posted: posts.slice(), reads: reads.slice(), html: state.html };
      },
    };
  };
}

test("a grant that expires in three days says when it ends, and offers a renewal", async () => {
  const page = await renderFriends(overview([grant("calendar.freebusy.read", at(3), FREE_BUSY)]))();
  const expiry = page.expiry();
  assert.ok(
    expiry !== null && page.renew() !== null,
    `the grant chip shows "calendar.freebusy.read" with no expiry (${expiry === null ? "nothing" : `"${expiry}"`}) and there is no Renew (${page.renew() !== null}), so the owner cannot see it ends in 3 days`,
  );
  assert.equal(expiry, "3 days left", "the owner is told how long the grant has left");
});

test("Renew sends the same capability with the scope it had and a fresh 30 days, then reloads the card", async () => {
  const page = await renderFriends(overview([grant("calendar.freebusy.read", at(3), FREE_BUSY)]))();
  assert.ok(page.renew() !== null, "there is no Renew button, so an owner whose 3-day grant is about to lapse cannot renew it");
  const r = await page.clickRenew();
  assert.deepEqual(r.posted.map((p) => p.path), ["/v1/relationships/rel_1/grants"], "the click writes a grant on the relationship the card is for");
  assert.equal(r.posted[0].body.capability, "calendar.freebusy.read", "the renewed grant keeps the same capability");
  assert.deepEqual(r.posted[0].body.scope, FREE_BUSY, "and the scope it was granted with, not the console's default");
  assert.equal(r.posted[0].body.expires_in_days, 30, "a renewal writes a fresh expiry instead of leaving the old one");
  assert.ok(r.reads.length >= 2, `after renewing, the card is reloaded from /v1/friends-overview; it was read ${r.reads.length} time(s)`);
  assert.equal((r.html.match(/data-expiry>([^<]*)</) || [])[1], "30 days left", "the card the owner is left looking at shows the renewed expiry");
});

test("a grant that has already expired is shown as expired, and can still be renewed", async () => {
  const page = await renderFriends(overview([grant("calendar.book", at(-1))]))();
  assert.equal(page.expiry(), "expired", "a lapsed grant is named as lapsed instead of silently disappearing into the pill");
  assert.ok(page.renew() !== null, "a lapsed grant can be renewed from the same card");
});

test("renewing a capability that carries no scope sends an empty scope", async () => {
  const page = await renderFriends(overview([grant("calendar.book", at(-1))]))();
  const r = await page.clickRenew();
  assert.equal(r.posted[0].body.capability, "calendar.book", "the renewed grant keeps the same capability");
  assert.deepEqual(r.posted[0].body.scope, {}, "only calendar.freebusy.read has a scope to carry over");
  assert.equal(r.posted[0].body.expires_in_days, 30, "a renewal writes a fresh 30 days");
});

test("a grant that runs for another month says when it ends and offers no Renew", async () => {
  const page = await renderFriends(overview([grant("calendar.freebusy.read", at(30), FREE_BUSY)]))();
  assert.equal(page.expiry(), "30 days left", "the owner can still see when it ends");
  assert.equal(page.renew(), null, "nothing so close to lapsing needs a renewal button");
});

test("a grant they gave me says when it ends, but only its grantor can renew it", async () => {
  const page = await renderFriends(overview([], [grant("profile.read", at(5))]))();
  assert.equal(page.expiry(), "5 days left", "a grant the peer gave me is shown with its expiry too");
  assert.equal(page.renew(), null, "the renewal belongs to the owner who granted it, so it is not offered on my side");
});

test("a free/busy grant made for a single day reads as one day", async () => {
  const oneDay = { window_days: 1, hours: "09:00-18:00" };
  const single = (await renderFriends(overview([grant("calendar.freebusy.read", at(30), oneDay)]))()).html();
  assert.match(single, /1 day ·/, `a one-day window must read "1 day"; the card renders "${(single.match(/\d+ days?(?= ·)/) || ["nothing"])[0]}"`);
  assert.doesNotMatch(single, /1 days/, "a count of one takes the singular, the way grantExpiry and the audit page already write it");
  const many = (await renderFriends(overview([grant("calendar.freebusy.read", at(30), FREE_BUSY)]))()).html();
  assert.match(many, /14 days ·/, "a count above one still reads as a plural");
  const none = (await renderFriends(overview([grant("calendar.freebusy.read", at(30), {})]))()).html();
  assert.match(none, /no day limit/, "a grant that carries no window keeps its own wording instead of a count");
});
