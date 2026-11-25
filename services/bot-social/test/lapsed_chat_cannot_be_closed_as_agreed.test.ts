/**
 * A chat whose own clock ran out must not be closed as agreed, declined or abandoned.
 *
 * `closeConversation` asserts only that the row is not already `closed`, so a conversation that lapsed hours ago but
 * was never written since still carries `status = 'open'`: an owner closing it stores the requested outcome as if the
 * chat had ended that way, audits that outcome, and cancels the cards hanging off it as `conversation_closed`. Every
 * other door into a lapsed chat (`extend`, `message.draft`, approving a stalled card) settles the expiry first and
 * refuses; the manual close was the one way in that never looked at `expires_at`.
 *
 * Red first on 80822fc:
 *   (a) closing a lapsed chat as agreed answers 200 `{status:"closed",outcome:"agreed"}` instead of 409
 *       `invalid_state`, and the row, the audit and the events all carry the requested outcome;
 *   (b) the card the lapsed chat was holding is cancelled as `conversation_closed` instead of `conversation_expired`.
 * Green on 80822fc and kept green: (c) live chats still close with each outcome and each state, (d) a chat already
 * closed by agreement or by revocation is still refused.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { bulkAuth, friends, inDays, startServer } from "./helpers.js";

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(bulkAuth); });
after(async () => { await S.stop(); });

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const meeting = (extra: Record<string, unknown> = {}) => ({
  type: "schedule_meeting", summary: "sync",
  params: { duration_minutes: 30, window: { start: inDays(1, 0), end: inDays(8, 23) } },
  ...extra,
});
const row = (sql: string, ...args: unknown[]) => S.platform.db.prepare(sql).get(...args) as any;
const closeAudits = async (owner: any, cid: string) =>
  ((await owner.req("GET", `/v1/audit-events?subject=${cid}`)).events as any[]).filter((e) => e.action === "conversation.closed");
const closedEvents = async (bot: any, cid: string) =>
  ((await bot.events()).events as any[]).filter((e) => e.event_type === "conversation.closed" && e.conversation_id === cid);

/** A pair and a conversation that has lapsed: `expires_at` in the past, the row itself never written since. */
async function lapsed() {
  const { A, B } = await friends(S.base);
  const cid = (await A.bot.startConversation(B.bot.id, meeting())).conversation_id as string;
  S.platform.db.prepare("UPDATE conversations SET expires_at = ? WHERE id = ?").run(ago(1000), cid);
  return { A, B, cid };
}

/** The same, with a card the chat was holding when its clock ran out. */
async function lapsedWithDraft() {
  const { A, B } = await friends(S.base);
  const cid = (await A.bot.startConversation(B.bot.id, meeting())).conversation_id as string;
  const draft = await B.bot.draftMessage(cid, { text: "a draft that outlives the chat" });
  assert.equal(draft.status, "pending_approval");
  S.platform.db.prepare("UPDATE conversations SET expires_at = ? WHERE id = ?").run(ago(1000), cid);
  return { A, B, cid, draft };
}

describe("a lapsed chat cannot be closed as agreed, declined or abandoned", () => {
  test("(a) the close is refused as a closed chat, and the requested outcome never lands", async () => {
    const { A, B, cid } = await lapsed();

    await assert.rejects(A.owner.req("POST", `/v1/conversations/${cid}/close`, { outcome: "agreed", summary: "we agreed" }),
      (e: any) => e.status === 409 && e.code === "invalid_state" && /conversation is closed \(expired\)/.test(e.message),
      "the clock closed this chat; the owner's close must be refused, not recorded as agreement");

    const r = row("SELECT status, outcome, summary FROM conversations WHERE id = ?", cid);
    assert.equal(r.status, "closed");
    assert.equal(r.outcome, "expired", "the only outcome a lapsed chat can carry");
    assert.equal(r.summary, null, "the summary the refused close carried must not land either");

    const audits = await closeAudits(A.owner, cid);
    assert.equal(audits.length, 1, "the expiry is recorded like a close, exactly once");
    assert.equal(audits[0].data.outcome, "expired");
    for (const bot of [A.bot, B.bot]) {
      const evs = await closedEvents(bot, cid);
      assert.equal(evs.length, 1, "each side hears the chat closed, exactly once");
      assert.equal(evs[0].outcome, "expired");
      assert.equal(evs[0].trust, "platform", "the platform's clock closed it; nothing here is peer text");
    }
    assert.equal((await A.bot.getConversation(cid)).status, "closed");
    assert.equal((await B.bot.getConversation(cid)).outcome, "expired");

    // The Bot half of the same door is refused the same way.
    const second = await lapsed();
    await assert.rejects(second.A.bot.close(second.cid, "abandoned"),
      (e: any) => e.status === 409 && e.code === "invalid_state" && /conversation is closed \(expired\)/.test(e.message));
    assert.equal(row("SELECT outcome FROM conversations WHERE id = ?", second.cid).outcome, "expired");
  });

  test("(b) the cards the lapsed chat was holding settle on the clock's terms, not the close's", async () => {
    const { A, B, cid, draft } = await lapsedWithDraft();

    await assert.rejects(A.owner.req("POST", `/v1/conversations/${cid}/close`, { outcome: "declined" }),
      (e: any) => e.status === 409 && e.code === "invalid_state");

    const card = row("SELECT status, decision FROM approvals WHERE id = ?", draft.approval_id);
    assert.equal(card.status, "cancelled");
    assert.equal(card.decision, "conversation_expired", "the clock cancelled it, so the reason is the clock's");
    assert.equal(row("SELECT status FROM messages WHERE id = ?", draft.message_id).status, "cancelled", "the draft itself is settled too");

    const evs = ((await B.bot.events()).events as any[]).filter((e) => e.event_type === "approval.decided" && e.approval_id === draft.approval_id);
    assert.equal(evs.length, 1, "the Bot whose card died hears it exactly once");
    assert.equal(evs[0].decision, "cancelled");
    assert.equal(evs[0].reason, "conversation_expired");

    const r = row("SELECT status, outcome FROM conversations WHERE id = ?", cid);
    assert.equal(r.status, "closed");
    assert.equal(r.outcome, "expired");
  });

  test("(c) a live chat still closes with every outcome and in every declared state", async () => {
    for (const status of ["open", "awaiting_approval", "paused_limit", "paused_loop", "paused_stop"]) {
      for (const outcome of ["agreed", "declined", "abandoned"]) {
        const { A, B } = await friends(S.base);
        const cid = (await A.bot.startConversation(B.bot.id, meeting())).conversation_id as string;
        if (status !== "open") S.platform.db.prepare("UPDATE conversations SET status = ? WHERE id = ?").run(status, cid);
        const summary = `${outcome} from ${status}`;

        const closed: any = await A.bot.close(cid, outcome, summary);
        assert.equal(closed.status, "closed");
        assert.equal(closed.outcome, outcome, `closing a live ${status} chat as ${outcome} must still work`);

        const r = row("SELECT status, outcome, summary FROM conversations WHERE id = ?", cid);
        assert.equal(r.status, "closed");
        assert.equal(r.outcome, outcome);
        assert.equal(r.summary, summary);

        const audits = await closeAudits(A.owner, cid);
        assert.equal(audits.length, 1, "one close, one audit line");
        assert.equal(audits[0].data.outcome, outcome);
        for (const bot of [A.bot, B.bot]) {
          const evs = await closedEvents(bot, cid);
          assert.equal(evs.length, 1, "one close, one event per side");
          assert.equal(evs[0].outcome, outcome);
        }
      }
    }
  });

  test("(d) a chat already closed by agreement or by revocation is still refused", async () => {
    const { A, B } = await friends(S.base);
    const agreed = (await A.bot.startConversation(B.bot.id, meeting())).conversation_id as string;
    await A.bot.close(agreed, "agreed", "done");
    await assert.rejects(A.owner.req("POST", `/v1/conversations/${agreed}/close`, { outcome: "declined" }),
      (e: any) => e.status === 409 && e.code === "conversation_closed");

    const revoked = (await A.bot.startConversation(B.bot.id, meeting())).conversation_id as string;
    S.platform.db.prepare("UPDATE conversations SET status = 'closed', outcome = 'revoked' WHERE id = ?").run(revoked);
    await assert.rejects(A.owner.req("POST", `/v1/conversations/${revoked}/close`, { outcome: "abandoned" }),
      (e: any) => e.status === 409 && e.code === "conversation_closed");
    assert.equal(row("SELECT outcome FROM conversations WHERE id = ?", revoked).outcome, "revoked");
  });

  test("(e) closing the same lapsed chat twice stays refused, and its expiry is announced once", async () => {
    const { A, B, cid } = await lapsed();
    for (const outcome of ["agreed", "declined"]) {
      await assert.rejects(A.owner.req("POST", `/v1/conversations/${cid}/close`, { outcome }),
        (e: any) => e.status === 409 && e.code === "invalid_state" && /conversation is closed \(expired\)/.test(e.message),
        "the second close sees the same closed, expired chat the first one left behind");
    }
    assert.equal((await closeAudits(A.owner, cid)).length, 1, "the expiry is recorded once, not once per refused close");
    for (const bot of [A.bot, B.bot]) assert.equal((await closedEvents(bot, cid)).length, 1);
    const r = row("SELECT status, outcome, summary FROM conversations WHERE id = ?", cid);
    assert.equal(r.status, "closed");
    assert.equal(r.outcome, "expired");
    assert.equal(r.summary, null, "no refused close wrote a summary");
  });
});
