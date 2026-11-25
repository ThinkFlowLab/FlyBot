/*
 * #512 — the peer reads a conversation's intent the moment the chat opens.
 *
 * `openConversation` stores the caller's `intent` as `String(pl.intent.summary ?? "")`, `params` and
 * `success_criteria` and writes it into the `conversation.started` event's `untrusted_content.intent`
 * (`src/platform.ts:3465`), so the peer holds the summary before either side has drafted a line. The
 * outbound DLP only ran in `draftMessage` (`src/platform.ts:3556`), so a value that door refuses with
 * `422 dlp_blocked` opened a conversation here and landed in the peer's queue verbatim.
 *
 * Expected on base `77601270da`: three red (summary / success_criteria / params), two green controls
 * (the draft door still refuses the same value; a clean intent still opens and the peer reads it).
 * Green after the fix.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { expectApiError, friends, startServer } from "./helpers.js";

const SECRET = "sk-" + "a".repeat(40); // `secret.api_key`, action `block`

const cleanIntent = () => ({
  type: "general_chat",
  summary: "plan the launch",
  success_criteria: "both sides agree on a date",
  params: { topic: "launch" },
});

/** The same clean intent with the value the draft door blocks, in one of the three caller-written places. */
const intentWith = (where: "summary" | "success_criteria" | "params") => {
  const intent: any = cleanIntent();
  if (where === "summary") intent.summary = `deploy with ${SECRET}`;
  if (where === "success_criteria") intent.success_criteria = `both sides confirm ${SECRET}`;
  if (where === "params") intent.params = { note: `use ${SECRET}` };
  return intent;
};

const conversationRows = (s: any) => (s.platform.db.prepare("SELECT COUNT(*) n FROM conversations").get() as any).n as number;
const started = async (bot: any) =>
  ((await bot.events()).events as any[]).filter((e) => e.event_type === "conversation.started");

test("#512 control: the draft door still refuses the same value", async (t) => {
  const s = await startServer(); t.after(s.stop);
  const { A, B } = await friends(s.base);
  const cid = (await A.bot.startConversation(B.bot.id, cleanIntent())).conversation_id as string;
  const err = await expectApiError(A.bot.draftMessage(cid, { text: `my key is ${SECRET}` }), 422, "dlp_blocked");
  assert.deepEqual((err as any).body.error.categories, ["secret.api_key"]);
});

test("#512 red: a blocked value in intent.summary opens no conversation", async (t) => {
  const s = await startServer(); t.after(s.stop);
  const { A, B } = await friends(s.base);
  const err = await expectApiError(A.bot.startConversation(B.bot.id, intentWith("summary")), 422, "dlp_blocked");
  assert.deepEqual((err as any).body.error.categories, ["secret.api_key"], "the refusal names the category, never the value");
  assert.equal(conversationRows(s), 0, "a refused intent writes no conversation row");
  assert.deepEqual(await started(B.bot), [], "and the peer is never told a conversation started");
});

test("#512 red: a blocked value in intent.success_criteria opens no conversation", async (t) => {
  const s = await startServer(); t.after(s.stop);
  const { A, B } = await friends(s.base);
  const err = await expectApiError(A.bot.startConversation(B.bot.id, intentWith("success_criteria")), 422, "dlp_blocked");
  assert.deepEqual((err as any).body.error.categories, ["secret.api_key"]);
  assert.equal(conversationRows(s), 0, "a refused intent writes no conversation row");
  assert.deepEqual(await started(B.bot), [], "and the peer is never told a conversation started");
});

test("#512 red: a blocked value inside intent.params opens no conversation", async (t) => {
  const s = await startServer(); t.after(s.stop);
  const { A, B } = await friends(s.base);
  const err = await expectApiError(A.bot.startConversation(B.bot.id, intentWith("params")), 422, "dlp_blocked");
  assert.deepEqual((err as any).body.error.categories, ["secret.api_key"]);
  assert.equal(conversationRows(s), 0, "a refused intent writes no conversation row");
  assert.deepEqual(await started(B.bot), [], "and the peer is never told a conversation started");
});

test("#512 control: a clean intent still opens and the peer reads its summary", async (t) => {
  const s = await startServer(); t.after(s.stop);
  const { A, B } = await friends(s.base);
  const r = await A.bot.startConversation(B.bot.id, cleanIntent());
  assert.equal(r.status, "open", "a clean intent still opens a conversation");
  const events = await started(B.bot);
  assert.equal(events.length, 1, "the peer is told once");
  assert.equal(events[0].untrusted_content.intent.summary, "plan the launch", "the peer reads the summary");
});
