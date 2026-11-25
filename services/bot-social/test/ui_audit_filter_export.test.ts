/**
 * The audit page could only be read. It fetched the latest 1000 records, showed 300 of them and offered no filter and
 * no way out: an owner asking "what did my Bot do on these two days" had to open each `<details>` and copy by hand,
 * and the hash chain that makes the log evidence could not be handed to anyone. This pins the two pieces the page
 * gains: a pure filter over the rows it already fetched (action family + day range, an unknown action is never
 * dropped) and a JSONL export of exactly the rows on screen, `seq`, `hash` and `prev_hash` included.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const pub = (f: string) => readFileSync(join(here, "..", "public", f), "utf8");

const ev = (seq: number, action: string, ts: string) => ({ seq, action, actor: "bot:bot_x", ts, hash: `h${seq}`, prev_hash: `h${seq - 1}`, data: { n: seq } });
// Midday UTC so a day label is the same date in every timezone the console may run in.
const DAY1 = [
  ev(1, "message.received", "2026-11-02T10:00:00.000Z"),
  ev(2, "grant.changed", "2026-11-02T12:00:00.000Z"),
];
const DAY2 = [
  ev(3, "message.received", "2026-11-03T12:00:00.000Z"),
  ev(4, "approval.decided", "2026-11-03T12:30:00.000Z"),
  ev(5, "some_future.action", "2026-11-03T13:00:00.000Z"),
];
const FIXTURE = [...DAY1, ...DAY2];

/** public/ui.js in a sandbox without boot(), with one canned answer per URL and a captured download. */
function loadConsole(me: unknown, answer: () => unknown) {
  const src = pub("ui.js").replace(/\nboot\(\);\s*$/, "\n;globalThis.__ui = { PAGES, auditRows, auditJsonl, localDate, setMe: (m) => (me = m) };\n");
  const downloads: { name?: string; text?: string }[] = [];
  let lastBlob = "";
  const elements: Record<string, any> = {};
  const el = (sel: string) => (elements[sel] ??= { onclick: null, onchange: null, value: "", innerHTML: "", disabled: false, classList: { add() {}, remove() {} } });
  const ctx: any = {
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    window: { addEventListener() {} },
    document: {
      querySelector: (sel: string) => el(sel), querySelectorAll: () => [], getElementById: (id: string) => el("#" + id),
      createElement: () => {
        const a: any = { setAttribute() {}, style: {}, classList: { add() {}, remove() {} }, click() { downloads.push({ name: a.download, text: lastBlob }); } };
        return a;
      },
    },
    location: { hash: "#/audit", origin: "https://example.test" },
    navigator: { clipboard: { writeText: async () => {} } },
    Blob: class { constructor(parts: string[]) { lastBlob = parts.join(""); } },
    URL: { createObjectURL: () => "blob:1", revokeObjectURL() {} },
    fetch: async () => ({ status: 200, ok: true, json: async () => answer() }),
    setInterval() {}, setTimeout, clearTimeout, URLSearchParams, Intl, Date, console,
  };
  vm.runInNewContext(src, ctx);
  ctx.__ui.setMe(me);
  return { ...ctx.__ui, elements, downloads, el };
}

const NAME = { owner_id: "own_1", bots: [{ id: "bot_x", handle: "x" }] };

test("an action family keeps only its own records and never drops an unknown action", () => {
  const ui = loadConsole(NAME, () => ({}));
  assert.deepEqual(ui.auditRows(FIXTURE, { action: "message" }).map((e: any) => e.seq), [1, 3], "message keeps both message records");
  assert.deepEqual(ui.auditRows(FIXTURE, { action: "grant" }).map((e: any) => e.seq), [2], "grant keeps the grant record");
  assert.deepEqual(ui.auditRows(FIXTURE, { action: "approval" }).map((e: any) => e.seq), [4], "approval keeps the approval record");
  assert.deepEqual(ui.auditRows(FIXTURE, {}).map((e: any) => e.seq), [1, 2, 3, 4, 5], "no filter shows everything, an action this build does not know included");
});

test("a day range keeps the records of those days and nothing outside them", () => {
  const ui = loadConsole(NAME, () => ({}));
  const day2 = ui.localDate("2026-11-03T12:00:00.000Z");
  const day1 = ui.localDate("2026-11-02T12:00:00.000Z");
  assert.deepEqual(ui.auditRows(FIXTURE, { from: day2, to: day2 }).map((e: any) => e.seq), [3, 4, 5], "one day keeps exactly that day");
  assert.deepEqual(ui.auditRows(FIXTURE, { from: day1, to: day1 }).map((e: any) => e.seq), [1, 2], "the other day separately");
  assert.deepEqual(ui.auditRows(FIXTURE, { from: day2 }).map((e: any) => e.seq), [3, 4, 5], "from alone drops the earlier day");
  assert.deepEqual(ui.auditRows(FIXTURE, { action: "message", from: day2, to: day2 }).map((e: any) => e.seq), [3], "family and day together");
});

test("the export is one JSON object per line, chain fields included", () => {
  const ui = loadConsole(NAME, () => ({}));
  const rows = ui.auditRows(FIXTURE, { action: "message" });
  const lines = ui.auditJsonl(rows).split("\n").filter(Boolean);
  assert.equal(lines.length, 2, "one line per row");
  for (const [i, line] of lines.entries()) {
    const back = JSON.parse(line);
    assert.deepEqual(back, rows[i], "a line is the record itself, field for field");
    assert.ok(back.hash && back.prev_hash, "the chain fields are in the export");
    assert.equal(typeof back.seq, "number");
  }
  assert.equal(ui.auditJsonl([]), "", "an empty log exports an empty file, not a blank line");
});

test("the page renders the filter and the download, and the download holds the rows on screen", async () => {
  const ui = loadConsole(NAME, () => ({ events: FIXTURE, chain: { ok: true, count: 5 } }));
  const v: any = { innerHTML: "" };
  await ui.PAGES.audit(v);
  assert.match(v.innerHTML, /id="audit-action"/, "a family filter is on the page");
  assert.match(v.innerHTML, /id="audit-jsonl"/, "a download control is on the page");

  const filtered: any = { innerHTML: "" };
  await ui.PAGES.audit(filtered, { action: "message" });
  assert.deepEqual((filtered.innerHTML.match(/data-seq="(\d+)"/g) || []).map((x: string) => x.replace(/\D/g, "")), ["3", "1"], "the family filter shows exactly the two message rows, newest first");

  ui.el("#audit-jsonl").onclick();
  assert.equal(ui.downloads.length, 1, "one click, one file");
  assert.match(String(ui.downloads[0].name), /^audit-.*\.jsonl$/, "the file says what it is");
  const exported = String(ui.downloads[0].text).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(exported.map((e: any) => e.seq), [3, 1], "the file holds exactly the rows the page is showing, in the page's order");
});

test("a broken chain is still named on the page, and the rows are still exportable", async () => {
  const ui = loadConsole(NAME, () => ({ events: FIXTURE, chain: { ok: false, count: 5, broken_at: 3 } }));
  const v: any = { innerHTML: "" };
  await ui.PAGES.audit(v);
  assert.match(v.innerHTML, /Verification failed/, "the page still says the chain does not verify");
  assert.match(v.innerHTML, /#3/, "and where it broke");
  ui.el("#audit-jsonl").onclick();
  assert.equal(ui.downloads.length, 1, "a broken chain does not remove the download");
});
