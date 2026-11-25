// The audit page's collapsed sentence for `owner.settings_updated` comes from `AUDIT_LABEL` alone, so two rows for the
// same switch read word for word alike: "You updated account settings" when auto-approve was turned on and again when it
// was turned off. A reader scanning the log cannot tell which way it went without opening Details and reading JSON. The
// event already carries the value (auto_approve_face_rooms as a boolean, sensitive_terms as a count); the sentence should
// end with it, while the expanded block keeps its JSON exactly as it is.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { ownerWithBot, startServer } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));

/** public/ui.js in a sandbox without boot(): PAGES.audit with fetch and the login token pointed at the test server. */
function loadAuditPage(base: string, token: string) {
  const src = readFileSync(join(here, "..", "public", "ui.js"), "utf8")
    .replace(/\nboot\(\);\s*$/, "\n;globalThis.__ui = { PAGES, setMe: (m) => (me = m) };\n");
  const ctx: any = {
    localStorage: { getItem: (k: string) => (k === "bs_owner_token" ? token : null), setItem() {}, removeItem() {} },
    window: { addEventListener() {} },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    location: { hash: "#/audit", origin: "https://example.test" },
    fetch: (path: string, init?: any) => fetch(base + path, init),
    setInterval() {}, setTimeout, clearTimeout, URLSearchParams, Intl, Date, console,
  };
  vm.runInNewContext(src, ctx);
  return async (me: unknown) => {
    ctx.__ui.setMe(me);
    const v: any = { innerHTML: "" };
    await ctx.__ui.PAGES.audit(v);
    return v.innerHTML as string;
  };
}

/** The collapsed sentence of each row, in page order (newest first): the first `<div>` inside `div.grow`. */
const collapsedLines = (html: string) => [...html.matchAll(/<div class="grow"><div>(.*?)<\/div>/g)]
  .map((m) => m[1].replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&"));

async function settingsRows(base: string, token: string, ownerId: string) {
  const audit = await fetch(`${base}/v1/audit-events?limit=1000`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json());
  return (audit.events as any[]).filter((e) => e.action === "owner.settings_updated" && e.subject === ownerId);
}

test("a switch turned on and then off writes two audit rows that read differently", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "auditsummary");

  for (const value of [true, false]) {
    const r = await A.owner.req("PATCH", "/v1/me", { auto_approve_face_rooms: value });
    assert.equal(r.auto_approve_face_rooms, value, "the patch is applied before the audit row is read");
  }
  assert.equal((await settingsRows(s.base, A.owner.token, A.owner_id)).length, 2, "each PATCH writes one settings row");

  const lines = collapsedLines(await loadAuditPage(s.base, A.owner.token)(await A.owner.req("GET", "/v1/me")));
  assert.ok(lines.length >= 2, `the page renders both rows: ${JSON.stringify(lines)}`);
  assert.notEqual(lines[0], lines[1], `the two settings rows must not read alike: ${lines[0]}`);
  assert.match(lines[0], /auto-approve off/, "the newest row says the switch was turned off");
  assert.match(lines[1], /auto-approve on/, "the row before it says the switch was turned on");
});

test("a change to the sensitive words says how many, never the words", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "auditsummaryterms");

  for (const words of [["swordfish", "bluebird"], []]) {
    const r = await A.owner.req("PATCH", "/v1/me", { sensitive_terms: words });
    assert.deepEqual(r.sensitive_terms, words, "the patch is applied before the audit row is read");
  }
  assert.equal((await settingsRows(s.base, A.owner.token, A.owner_id)).length, 2, "each PATCH writes one settings row");

  const html = await loadAuditPage(s.base, A.owner.token)(await A.owner.req("GET", "/v1/me"));
  const lines = collapsedLines(html);
  assert.ok(lines.length >= 2, `the page renders both rows: ${JSON.stringify(lines)}`);
  assert.notEqual(lines[0], lines[1], `the two settings rows must not read alike: ${lines[0]}`);
  assert.match(lines[0], /0 sensitive words/, "the newest row says the list is now empty");
  assert.match(lines[1], /2 sensitive words/, "the row before it says two words were set");
  assert.ok(!html.includes("swordfish") && !html.includes("bluebird"), "neither the sentence nor the details carry the words themselves");
});

test("a single sensitive word reads singular on the audit summary line", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "auditsummaryone");

  const r = await A.owner.req("PATCH", "/v1/me", { sensitive_terms: ["onlyone"] });
  assert.deepEqual(r.sensitive_terms, ["onlyone"], "the patch is applied before the audit row is read");

  const lines = collapsedLines(await loadAuditPage(s.base, A.owner.token)(await A.owner.req("GET", "/v1/me")));
  assert.ok(lines.length >= 1, `the page renders the row: ${JSON.stringify(lines)}`);
  assert.match(lines[0], /1 sensitive word\b/, `one word must read singular: ${lines[0]}`);
  assert.doesNotMatch(lines[0], /1 sensitive words/, `one word must not read plural: ${lines[0]}`);
  assert.ok(!lines[0].includes("onlyone"), "the sentence carries the count, never the word itself");
});
