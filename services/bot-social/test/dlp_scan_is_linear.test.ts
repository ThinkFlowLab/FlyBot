/*
 * #495 — the DLP scan must cost time linear in the text it reads, and shortening the text must never lose a finding.
 *
 * The two rules here were "an arbitrary run, then a cue that may be far away" (`/[\w.+-]+@[\w-]+\.[\w.-]+/` and the
 * `\d+\s*(元|块钱|美元)` half of the amount rule). On a long run with no cue, the engine re-walked the rest of the run
 * from every start position: 95 s for a 256 KiB run of `a` with no `@`, 423 s for a 256 KiB digit run whose unit sat
 * out of reach. One request body is capped at 256 KiB, so a single draft could hold a core for minutes.
 *
 * Ceilings are far above the fixed cost (a few milliseconds at 256 KiB) and far below the unfixed one (tens of
 * seconds), so this is a red-first guard, not a benchmark. The 32 KiB cases are the same shapes at a size where the
 * unfixed code takes 2-33 s rather than minutes, so the red run itself stays short.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as policy from "../src/policy.js";

const KiB = 1024;
const emailShape = (n: number) => "a".repeat(n); // a word run with no '@'
const amountShape = (n: number) => "1".repeat(n) + "x元"; // a digit run whose unit is out of reach

function ms<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

const cats = (t: string) => policy.dlpScan(t).map((h) => `${h.category}:${h.action}`);

test("a 256 KiB token with no '@' is scanned in milliseconds", () => {
  const { value, ms: took } = ms(() => policy.dlpScan(emailShape(256 * KiB)));
  assert.deepEqual(value, []);
  assert.ok(took < 500, `dlpScan took ${Math.round(took)} ms on a 256 KiB token; the ceiling is 500 ms`);
});

test("a 256 KiB digit run whose unit is out of reach is scanned in milliseconds", () => {
  const { ms: took } = ms(() => policy.dlpScan(amountShape(256 * KiB)));
  assert.ok(took < 500, `dlpScan took ${Math.round(took)} ms on a 256 KiB digit run; the ceiling is 500 ms`);
});

test("a 32 KiB token with no '@' is scanned in milliseconds", () => {
  const { value, ms: took } = ms(() => policy.dlpScan(emailShape(32 * KiB)));
  assert.deepEqual(value, []);
  assert.ok(took < 100, `dlpScan took ${Math.round(took)} ms on a 32 KiB token; the ceiling is 100 ms`);
});

test("a 32 KiB digit run whose unit is out of reach is scanned in milliseconds", () => {
  const { ms: took } = ms(() => policy.dlpScan(amountShape(32 * KiB)));
  assert.ok(took < 100, `dlpScan took ${Math.round(took)} ms on a 32 KiB digit run; the ceiling is 100 ms`);
});

test("the rewrite still finds every email the old rule found", () => {
  for (const t of [
    "mail me a@b.com",
    "first.last+tag@sub.example.co.uk",
    "x@y.z",
    "a.b-c@d-e.f",
    "contact:me+list@example.com.",
    "A@B",
  ]) {
    const expected = t === "A@B" ? [] : ["pii.email:approve"]; // no dot after the domain character means no match
    assert.deepEqual(cats(t), expected, t);
  }
});

test("the rewrite still finds every money amount the old rule found", () => {
  for (const t of ["¥5", "￥ 5", "$500", "USD 100", "RMB20", "元 30", "100元", "12 块钱", "5美元", "1 2 3 元"]) {
    assert.deepEqual(cats(t), ["money:approve"], t);
  }
  for (const t of ["no amount here", "version 1.2.3", "元", "块钱", "USD", "$", "1x元"]) {
    assert.deepEqual(cats(t), [], t);
  }
});

test("a finding past a long adversarial run is still reported", () => {
  // The cap lives at the entry (Platform.dlp); dlpScan itself must still see a hit at the end of a long text.
  assert.deepEqual(cats(emailShape(200 * KiB) + " a@b.com"), ["pii.email:approve"]);
  assert.deepEqual(cats(amountShape(200 * KiB).replace("x元", " 元")), ["money:approve"]);
});

test("the scan cap cuts over-long text and says so", () => {
  const short = "a@b.com";
  assert.deepEqual(policy.dlpText(short), { text: short, truncated: false });
  const long = "a".repeat(policy.DLP_TEXT_MAX_CHARS + 10);
  const cut = policy.dlpText(long);
  assert.equal(cut.truncated, true);
  assert.equal(cut.text.length, policy.DLP_TEXT_MAX_CHARS);
  // The cap is the 256 KiB request-body limit itself (#506): no door can send more, so the cut is a backstop. It was
  // 64 KiB while two rules were quadratic; once they were linear scanners that bound only hid findings.
  assert.equal(policy.DLP_TEXT_MAX_CHARS, 256 * KiB);
});
