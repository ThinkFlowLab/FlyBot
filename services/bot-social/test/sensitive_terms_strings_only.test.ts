// `updateSettings` declares `sensitive_terms?: string[]`, but the write coerced every element with `String()`: a number,
// `null` or an object became the literal word ("42", "null", "[object Object]") and an object whose `toString` is not
// callable threw a TypeError, which the error handler turned into a 500 `internal_error` for what is a bad request. A
// value that is not an array at all was silently ignored, yet still wrote an audit row naming `sensitive_terms` as
// changed. A settings write takes an array of strings; anything else is refused before anything is written.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

/** Shapes that used to be coerced, ignored or thrown on, and the code each one must now get. */
const NOT_STRINGS: Array<[string, unknown]> = [
  ['[{"toString":"x"}]', [{ toString: "x" }]],
  ["[42]", [42]],
  ["[null]", [null]],
  ["[{}]", [{}]],
  ['["ok",42]', ["ok", 42]],
  ['"a string instead of an array"', "notarray"],
  ["42", 42],
];

async function patch(A: any, value: unknown) {
  try {
    await A.owner.req("PATCH", "/v1/me", { sensitive_terms: value });
    return { status: 200, code: null as string | null };
  } catch (e: any) {
    return { status: e.status as number, code: e.code as string };
  }
}

test("sensitive_terms takes an array of strings and refuses every other shape", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "termshape");

  const seen: Array<[string, number, string | null]> = [];
  for (const [label, value] of NOT_STRINGS) {
    const r = await patch(A, value);
    seen.push([label, r.status, r.code]);
  }
  assert.deepEqual(seen, NOT_STRINGS.map(([label]) => [label, 400, "invalid_request"]), "each bad shape is a 400 invalid_request");
});

test("a refused sensitive_terms patch changes nothing and writes no audit row", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "termsrefused");

  const refused = await patch(A, [42]);
  assert.equal(refused.status, 400, JSON.stringify(refused));

  const me = await A.owner.req("GET", "/v1/me");
  assert.deepEqual(me.sensitive_terms, [], "the stored list is untouched");
  const audit = await A.owner.req("GET", "/v1/audit-events");
  const settings = (audit.events as any[]).filter((e) => e.action === "owner.settings_updated");
  assert.deepEqual(settings, [], "a refused patch is not recorded as a settings change");
});

test("an array of strings is still stored and reported word for word", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "termsok");

  const words = ["swordfish", "bluebird"];
  const patched = await A.owner.req("PATCH", "/v1/me", { sensitive_terms: words });
  assert.deepEqual(patched.sensitive_terms, words, "the patch is applied");
  const me = await A.owner.req("GET", "/v1/me");
  assert.deepEqual(me.sensitive_terms, words, "the list is returned as it was set");
  const audit = await A.owner.req("GET", "/v1/audit-events");
  const settings = (audit.events as any[]).filter((e) => e.action === "owner.settings_updated");
  assert.deepEqual(settings.map((e) => e.data.sensitive_terms), [2], "the audit still records how many words were set, never the words");
});
