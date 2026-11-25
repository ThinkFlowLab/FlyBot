// `sendAsMember` opens the pair's conversation before it drafts the line, so a first line the policy layer then
// refuses (a DLP-blocked text, a broken attachment ref) used to leave the empty conversation behind and to tell the
// peer a conversation had started; that empty thread also counted against the relationship's new-conversation
// quota for the day. The rules the platform states for its other refusals ("no row, no event") apply here too:
// a refused first line writes nothing, and only a stored, sendable conversation is ever announced.
import assert from "node:assert/strict";
import { test } from "node:test";
import { expectApiError, friends, startServer } from "./helpers.js";

/** The platform holds this Bot's key, so its owner may write through the console's owner-typed route. */
const holdKey = (s: any, o: any) => s.platform.enableCustody({ kind: "owner" as const, ownerId: o.owner_id }, o.bot.id, { private_key_pem: o.kp.privateKeyPem });

/** The owner's own credential, sent the way the console sends it (the owner's home route, body only). */
async function ownerSend(A: any, body: Record<string, unknown>) {
  const me = await A.owner.req("GET", "/v1/me");
  return A.owner.req("POST", `/v1/homes/${encodeURIComponent(me.home || A.bot.id)}/send`, body);
}

/** The conversations a principal can read, as ids. An owner sees their home's; a Bot sees its own. */
async function conversationIds(p: any) {
  const r = await p.req("GET", "/v1/conversations");
  return (r.conversations as any[]).map((c) => c.conversation_id);
}

/** How many times the peer was told a conversation started. */
async function startedCount(bot: any) {
  const r = await bot.events();
  return (r.events as any[]).filter((e) => e.event_type === "conversation.started").length;
}

test("a first line the outbound filter blocks opens no conversation and tells the peer nothing", async () => {
  const s = await startServer();
  try {
    const { A, B } = await friends(s.base);
    holdKey(s, A);
    const err = await expectApiError(
      ownerSend(A, { from_bot_id: A.bot.id, to: B.bot.id, text: "my key is sk-abcdefghijklmnop1234", typed_by_owner: true }),
      422,
      "dlp_blocked",
    );
    assert.match(err.message, /DLP/, "the refusal still says the outbound filter blocked it");
    assert.deepEqual(await conversationIds(A.owner), [], "a refused line leaves no conversation behind");
    assert.deepEqual(await conversationIds(B.bot), [], "and opens none on the peer's side either");
    assert.equal(await startedCount(B.bot), 0, "the peer is never told a conversation started");
    // What the owner reads in the audit trail still says why nothing was sent — and nothing in it claims a
    // conversation was created, since the row went away with the draft.
    const audit = (await A.owner.req("GET", "/v1/audit-events?limit=1000")).events as any[];
    const denies = audit.filter((e) => e.action === "policy.decision" && e.data?.action === "message.draft" && e.data?.decision === "deny");
    assert.equal(denies.length, 1, "the refusal is recorded in the audit trail");
    assert.deepEqual(denies[0].data.reasons, ["dlp.blocked"], "and says the outbound filter blocked the draft");
    assert.equal(audit.filter((e) => e.action === "conversation.created").length, 0, "nothing claims a conversation was created");
  } finally { await s.stop(); }
});

test("a first line naming an attachment that does not exist opens no conversation and tells the peer nothing", async () => {
  const s = await startServer();
  try {
    const { A, B } = await friends(s.base);
    holdKey(s, A);
    await expectApiError(
      ownerSend(A, { from_bot_id: A.bot.id, to: B.bot.id, text: "here is the file", typed_by_owner: true, attachments: [{ id: "att_missing" }] }),
      404,
      "attachment_not_found",
    );
    assert.deepEqual(await conversationIds(A.owner), [], "a refused line leaves no conversation behind");
    assert.deepEqual(await conversationIds(B.bot), [], "and opens none on the peer's side either");
    assert.equal(await startedCount(B.bot), 0, "the peer is never told a conversation started");
  } finally { await s.stop(); }
});

test("a first line that is sent opens exactly one conversation and announces it exactly once", async () => {
  const s = await startServer();
  try {
    const { A, B } = await friends(s.base);
    holdKey(s, A);
    const r = await ownerSend(A, { from_bot_id: A.bot.id, to: B.bot.id, text: "the first thing said here", typed_by_owner: true });
    assert.deepEqual(await conversationIds(A.owner), [r.conversation_id], "the send opened the one conversation it answered with");
    assert.deepEqual(await conversationIds(B.bot), [r.conversation_id], "the peer can read that same conversation");
    assert.equal(await startedCount(B.bot), 1, "the peer was told once that it started");
  } finally { await s.stop(); }
});

test("a later line reuses the pair's conversation and announces nothing again", async () => {
  const s = await startServer();
  try {
    const { A, B } = await friends(s.base);
    holdKey(s, A);
    const first = await ownerSend(A, { from_bot_id: A.bot.id, to: B.bot.id, text: "the first thing said here", typed_by_owner: true });
    const second = await ownerSend(A, { from_bot_id: A.bot.id, to: B.bot.id, text: "and a second line", typed_by_owner: true });
    assert.equal(second.conversation_id, first.conversation_id, "the pair's open conversation is reused");
    assert.deepEqual(await conversationIds(A.owner), [first.conversation_id], "no second conversation was opened");
    assert.equal(await startedCount(B.bot), 1, "nothing was announced twice");
  } finally { await s.stop(); }
});

test("a line that names its conversation neither opens one nor announces one", async () => {
  const s = await startServer();
  try {
    const { A, B } = await friends(s.base);
    holdKey(s, A);
    // The peer opens the thread, so the announcement the peer received is the only one.
    const opened = await B.bot.startConversation(A.bot.id, { type: "general_chat", summary: "a thread the peer opened" });
    assert.equal(await startedCount(A.bot), 1, "the thread's own opening is announced");
    const before = await conversationIds(A.owner);
    const r = await ownerSend(A, { from_bot_id: A.bot.id, to: B.bot.id, text: "an answer in that thread", typed_by_owner: true, conversation_id: opened.conversation_id });
    assert.equal(r.conversation_id, opened.conversation_id, "the answer lands in the named thread");
    assert.deepEqual(await conversationIds(A.owner), before, "no conversation was opened for the answer");
    assert.equal(await startedCount(A.bot), 1, "and nothing was announced again");
  } finally { await s.stop(); }
});
