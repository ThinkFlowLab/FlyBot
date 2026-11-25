/**
 * DLP: a card number, a national ID or a phone number is the same number however its digits are grouped.
 *
 * Root cause (`src/policy.ts` `dlpScan`): the digit runs are matched against the raw text, so
 * `\b(?:\d[ -]?){13,19}\b` accepts exactly one space or one hyphen between digits, and
 * `\b\d{17}[\dXx]\b` / `1[3-9]\d{9}` accept no separator at all. A non-breaking space (U+00A0), a
 * zero-width space (U+200B), full-width digits, a dot, two spaces or a line break between the digits
 * leaves every one of those patterns without a match, so `pii.bank_card` / `pii.national_id` never
 * reach the draft: the line is delivered as `dlp.clean` when `auto_approve_chat` is on, or held with
 * `risk_flags: []` when it is off. README.md:485 promises a Luhn-valid card is refused (422, without
 * echoing the value), and README.md:364 promises auto-delivery only for "chat messages with no DLP hits".
 *
 * Fail-first on the base commit: the six card variants (non-breaking space, dots, double space, line
 * break, zero-width space, full-width digits), the two national-ID variants and the non-breaking-space
 * phone variant fail; the single-space control and the false-positive guards pass.
 *
 * Fix shape (Lead-frozen): normalize at the entry of `dlpScan` — NFKC (folds full-width digits and
 * U+00A0 to a plain space), drop format characters (U+200B), then drop whitespace/dot/slash/dash runs
 * that sit between two digits — before the existing regexes and the luhn / check-digit validators run.
 * The validators themselves are not touched. The only regression surface of joining digit groups is
 * that unrelated numbers could concatenate into a Luhn-valid run, so dates, dotted versions, IP
 * addresses, ratings and clock times must stay clean.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { expectApiError, friends, startServer } from "./helpers.js";

const CARD = "4111111111111111";
/** The same card in four groups of four, joined by `sep`. */
const cardGrouped = (sep: string) => `card ${CARD.slice(0, 4)}${sep}${CARD.slice(4, 8)}${sep}${CARD.slice(8, 12)}${sep}${CARD.slice(12)} please`;

type Party = Awaited<ReturnType<typeof friends>>;

/**
 * Each draft gets a conversation of its own: loop detection compares consecutive lines, and these are
 * one number in different clothes, so the same thread would pause before DLP ever ran.
 */
async function draft(p: Party, text: string) {
  const cid = (await p.A.bot.startConversation(p.B.bot.id, { type: "general_chat", summary: "dlp" })).conversation_id;
  return p.A.bot.signed(`/v1/conversations/${cid}/messages`, "message.draft", { text }, { conversation_id: cid });
}

test("a bank card grouped with non-breaking spaces is blocked", async () => {
  const S = await startServer();
  try {
    const p = await friends(S.base);
    const err = await expectApiError(draft(p, cardGrouped("\u00A0")), 422, "dlp_blocked");
    assert.deepEqual(err.body.error.categories, ["pii.bank_card"], "the card category is named");
    const refusal = JSON.stringify(err.body);
    assert.equal(refusal.includes("4111"), false, "the refusal does not echo the value");
    assert.equal(refusal.includes("\u00A0"), false, "nor the grouped form it received");
  } finally { await S.stop(); }
});

test("a bank card grouped with dots is blocked", async () => {
  const S = await startServer();
  try {
    const p = await friends(S.base);
    const err = await expectApiError(draft(p, cardGrouped(".")), 422, "dlp_blocked");
    assert.deepEqual(err.body.error.categories, ["pii.bank_card"]);
  } finally { await S.stop(); }
});

test("a bank card grouped with double spaces is blocked", async () => {
  const S = await startServer();
  try {
    const p = await friends(S.base);
    const err = await expectApiError(draft(p, cardGrouped("  ")), 422, "dlp_blocked");
    assert.deepEqual(err.body.error.categories, ["pii.bank_card"]);
  } finally { await S.stop(); }
});

test("a bank card split across lines is blocked", async () => {
  const S = await startServer();
  try {
    const p = await friends(S.base);
    const err = await expectApiError(draft(p, cardGrouped("\n")), 422, "dlp_blocked");
    assert.deepEqual(err.body.error.categories, ["pii.bank_card"]);
  } finally { await S.stop(); }
});

test("a bank card with zero-width spaces between digits is blocked", async () => {
  const S = await startServer();
  try {
    const p = await friends(S.base);
    const err = await expectApiError(draft(p, cardGrouped("\u200B")), 422, "dlp_blocked");
    assert.deepEqual(err.body.error.categories, ["pii.bank_card"]);
  } finally { await S.stop(); }
});

test("a bank card written in full-width digits is blocked", async () => {
  const S = await startServer();
  try {
    const p = await friends(S.base);
    const text = "card \uFF14\uFF11\uFF11\uFF11\u00A0\uFF11\uFF11\uFF11\uFF11\u00A0\uFF11\uFF11\uFF11\uFF11\u00A0\uFF11\uFF11\uFF11\uFF11 please";
    const err = await expectApiError(draft(p, text), 422, "dlp_blocked");
    assert.deepEqual(err.body.error.categories, ["pii.bank_card"]);
  } finally { await S.stop(); }
});

test("a national ID grouped with spaces is blocked", async () => {
  const S = await startServer();
  try {
    const p = await friends(S.base);
    const err = await expectApiError(draft(p, "id 110105 19491231 002X please"), 422, "dlp_blocked");
    assert.deepEqual(err.body.error.categories, ["pii.national_id"]);
  } finally { await S.stop(); }
});

test("a national ID grouped with non-breaking spaces is blocked", async () => {
  const S = await startServer();
  try {
    const p = await friends(S.base);
    const err = await expectApiError(draft(p, "id 110105\u00A019491231\u00A0002X please"), 422, "dlp_blocked");
    assert.deepEqual(err.body.error.categories, ["pii.national_id"]);
  } finally { await S.stop(); }
});

test("a phone number grouped with non-breaking spaces keeps the owner's card", async () => {
  const S = await startServer();
  try {
    const p = await friends(S.base);
    // A phone number is approve-class, not block-class: the number must reach the card the owner decides.
    const held: any = await draft(p, "call 138\u00A00013\u00A08000 now");
    assert.equal(held.status, "pending_approval", "the line is not delivered on its own");
    assert.deepEqual(held.policy.risk_flags.map((f: any) => f.category), ["pii.phone"], "the card names the phone number");
    assert.ok(held.policy.reasons.includes("dlp.pii.phone"), "the policy reasons name the finding too");
  } finally { await S.stop(); }
});

test("control: a bank card grouped with a single space is already blocked", async () => {
  const S = await startServer();
  try {
    const p = await friends(S.base);
    const err = await expectApiError(draft(p, cardGrouped(" ")), 422, "dlp_blocked");
    assert.deepEqual(err.body.error.categories, ["pii.bank_card"]);
  } finally { await S.stop(); }
});

test("the digit normalization does not join unrelated numbers into a finding", async () => {
  const S = await startServer();
  try {
    const p = await friends(S.base);
    for (const text of ["2026.11.01", "1.2.3.4", "版本 3.1.4.1.5.9", "评分 4.5", "会议 10:30"]) {
      const held: any = await draft(p, text);
      assert.equal(held.status, "pending_approval", `${text}: still the owner's card, not a refusal`);
      assert.deepEqual(held.policy.risk_flags, [], `${text}: nothing is flagged on the card`);
      assert.equal(held.policy.reasons.some((r: string) => r.startsWith("dlp.") && r !== "dlp.clean"), false, `${text}: no DLP finding`);
    }
  } finally { await S.stop(); }
});
