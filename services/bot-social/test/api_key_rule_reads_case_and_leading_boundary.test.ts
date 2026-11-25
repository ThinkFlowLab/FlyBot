/*
 * The api_key rule reads one spelling of a token and misses two others.
 *
 * On master at d007e14, src/policy.ts:161 is
 *   /\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/
 * so `SK-…` and `Sk-…` are not the same secret as `sk-…` to this rule, and a value keyed `{"k_sk-…":1}` is cut off
 * by the leading `\b` because `_` is a word character. Every outbound scan reads this one rule (draft text and
 * structured, action title and justification, the conversation intent), so a miss here is a miss at every door:
 * a Bot draft that carries one is only held by the blanket outbound card (202 pending_approval) instead of being
 * refused, and the peer reads it as soon as the owner approves a card that the DLP layer called clean.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as policy from "../src/policy.js";
import { expectApiError, friends, startServer } from "./helpers.js";

const SEC = "sk-abcdefghijklmnopqrstuvwx"; // sk- + 24 body characters; the rule wants 16+
const cats = (t: string) => policy.dlpScan(t).map((h) => `${h.category}:${h.action}`);

async function pair(t: any) {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const cid = (await B.bot.startConversation(A.bot.id, { type: "general_chat", summary: "hi" })).conversation_id;
  return { s, A, B, cid };
}

// --- the rule itself: one secret, three spellings ---

test("the rule reads SK-… as the same api key", () => {
  assert.deepEqual(cats(`deploy SK-${SEC.slice(3)} now`), ["secret.api_key:block"]);
});

test("the rule reads Sk-… as the same api key", () => {
  assert.deepEqual(cats(`deploy Sk-${SEC.slice(3)} now`), ["secret.api_key:block"]);
});

// --- the draft door: refused, not carded ---

test("a draft carrying Sk-… is refused instead of held as a clean card", async (t) => {
  const { A, cid } = await pair(t);
  await expectApiError(A.bot.draftMessage(cid, { text: `deploy Sk-${SEC.slice(3)} now` }), 422, "dlp_blocked");
});

test("a draft whose structured value is keyed k_sk-… is refused", async (t) => {
  const { A, cid } = await pair(t);
  await expectApiError(
    A.bot.draftMessage(cid, { text: "config attached", structured: { [`k_${SEC}`]: 1 } }),
    422,
    "dlp_blocked",
  );
});

// --- the control group: what works today keeps working ---

test("a plain lowercase sk-… key is still refused", async (t) => {
  const { A, cid } = await pair(t);
  await expectApiError(A.bot.draftMessage(cid, { text: `my key is ${SEC}` }), 422, "dlp_blocked");
});

test("a clean line is still only carded, with no finding", async (t) => {
  const { A, cid } = await pair(t);
  const draft: any = await A.bot.draftMessage(cid, { text: "shall we walk through the plan this afternoon" });
  assert.equal(draft.status, "pending_approval");
  assert.ok(draft.approval_id);
  assert.deepEqual(draft.policy.risk_flags, []);
});
