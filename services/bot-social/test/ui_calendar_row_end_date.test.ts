import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { ownerWithBot, startServer } from "./helpers.js";

// My Bots renders each calendar entry as `${fmt(e.start, { zone: false })} – ${fmt(e.end, { time: true })}`: the start
// side carries the date and the end side only a time. For an entry that ends after local midnight the row reads
// "01/11, 23:00 – 01:00 GMT+8", i.e. a negative span, because the end instant is on 02/11 in the owner's zone.
// Both sides are formatted in the owner's zone, so the "do the two ends share a date?" question has to be answered in
// that same zone: for some entries UTC would say "same day" (23:00 → 01:00 the next local day), and for others it would
// say "different day" (00:30 → 10:00 on one local day that straddles UTC midnight). The machine here runs in UTC, so
// these two fixtures fail if the date comparison uses anything but the owner's zone.

const here = dirname(fileURLToPath(import.meta.url));

const req = async (method: string, path: string, token: string, body?: unknown) => {
  const r = await fetch(S.base + path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
};

/** The console (public/ui.js) with fetch pointed at the test server, without boot(); returns the rendered Bots page. */
function loadBotsPage(base: string, token: string) {
  const src = readFileSync(join(here, "..", "public", "ui.js"), "utf8")
    .replace(/\nboot\(\);\s*$/, "\n;globalThis.__ui = { PAGES };\n");
  const el = () => ({ onclick: null, value: "", innerText: "", closest: () => ({}) });
  const ctx: any = {
    localStorage: { getItem: (k: string) => (k === "bs_owner_token" ? token : null), setItem() {}, removeItem() {} },
    window: { addEventListener() {} },
    document: { querySelector: el, querySelectorAll: () => [], getElementById: () => null, createElement: () => ({ setAttribute() {}, appendChild() {}, style: {}, classList: { add() {}, remove() {} } }) },
    location: { hash: "#/bots", origin: "https://example.test", reload() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: (path: string, init?: any) => fetch(base + path, init),
    setInterval() {}, setTimeout, clearTimeout, URLSearchParams, Intl, Date, console, confirm: () => true, prompt: () => null,
  };
  vm.runInNewContext(src, ctx);
  return async () => {
    const v: any = { innerHTML: "", querySelector: () => null, querySelectorAll: () => [] };
    await ctx.__ui.PAGES.bots(v);
    return v.innerHTML as string;
  };
}

/** Intl may separate the time from the zone with a narrow no-break space; compare the text a reader sees. */
const plain = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");

/** The first cell (the time span) of the calendar row whose title cell is `title`, as the page rendered it. */
const rowFor = (html: string, title: string) => {
  const m = html.match(new RegExp(`<tr><td>([^<]*)</td><td>${title}</td>`));
  return m ? plain(m[1]) : null;
};

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(); });
after(async () => { await S.stop(); });

/** A fresh owner whose time zone is set explicitly, so the test never depends on the machine's zone. */
async function ownerInShanghai(name: string) {
  const A = await ownerWithBot(S.base, name);
  const me = await req("PATCH", "/v1/me", A.owner.token, { timezone: "Asia/Shanghai" });
  assert.equal(me.status, 200, JSON.stringify(me.body));
  assert.equal(me.body.timezone, "Asia/Shanghai", "the page must format in the owner's zone, not the machine's");
  return A;
}

test("an entry that ends after local midnight shows the end's date instead of reading as a negative span", async () => {
  const A = await ownerInShanghai("calnight");
  // 2026-11-01 23:00 → 2026-11-02 01:00 in Asia/Shanghai, both on the same UTC date (01/11).
  const add = await req("POST", "/v1/calendar/entries", A.owner.token, {
    start: "2026-11-01T15:00:00.000Z", end: "2026-11-01T17:00:00.000Z", title: "Night shift",
  });
  assert.equal(add.status, 201, JSON.stringify(add.body));

  const html = await loadBotsPage(S.base, A.owner.token)();
  const row = rowFor(html, "Night shift");
  assert.ok(row !== null, "the Bots page renders the calendar entry");
  assert.equal(row, "01/11, 23:00 – 02/11, 01:00 GMT+8",
    "the end side carries its own date when the two ends are on different local dates");
  assert.doesNotMatch(row!, /– \d{2}:\d{2}/,
    "no end side that shows only a time, which is what made this row look like it went backwards");
});

test("an entry that stays on one local date keeps the current shape, even when its ends are on different UTC dates", async () => {
  const A = await ownerInShanghai("calday");
  // 2026-11-02 00:30 → 10:00 in Asia/Shanghai: one local date (02/11) that straddles UTC midnight (01/11 → 02/11).
  const add = await req("POST", "/v1/calendar/entries", A.owner.token, {
    start: "2026-11-01T16:30:00.000Z", end: "2026-11-02T02:00:00.000Z", title: "Morning handover",
  });
  assert.equal(add.status, 201, JSON.stringify(add.body));

  const html = await loadBotsPage(S.base, A.owner.token)();
  const row = rowFor(html, "Morning handover");
  assert.ok(row !== null, "the Bots page renders the calendar entry");
  assert.equal(row, "02/11, 00:30 – 10:00 GMT+8",
    "a same-local-date row is unchanged, so the common case does not grow a second date");
  assert.doesNotMatch(row!, /– \d{2}\/\d{2},/,
    "no second date when both ends share the owner's local date (a UTC comparison would wrongly add one here)");
});
