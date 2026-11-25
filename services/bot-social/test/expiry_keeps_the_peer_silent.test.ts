/**
 * An expired draft is settled the way a rejected one is: only its sender hears about it.
 *
 * `rejectMessage` states the rule -- "the peer never sees rejected drafts; only the sender bot is informed" -- and
 * every cancellation `cancelPendingFor` announces goes to the Bot that owned the card. The expiry sweep was the
 * exception: `expireApproval` emitted an undocumented `system.notice` into the recipient's queue. The peer never
 * received the draft, so it did not lose anything and has nothing to act on; the notice also woke its webhook with
 * an item whose summary renders as the bare type name, because `summarize()` has no case for it.
 *
 * (1) and (2) pin the silence toward the peer, event queue and webhook alike. (3)-(5) are the guards: the sender is
 * still told and the expiry still audited, a rejected draft stays equally silent, and a delivered line still
 * reaches the peer with a real wake-up.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

const pushes: { url: string; body: any }[] = [];
const fetchImpl = (async (url: string, init: any) => {
  pushes.push({ url, body: JSON.parse(init.body) });
  return new Response("ok", { status: 200 });
}) as unknown as typeof fetch;

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer({ fetchImpl, webhooks: { debounceMs: 0, retryBaseMs: 1 } }); });
after(async () => { await S.stop(); });

const past = () => new Date(Date.now() - 3600e3).toISOString();
const approvalRow = (id: string) => S.platform.db.prepare("SELECT status, decision FROM approvals WHERE id = ?").get(id) as any;

/** Two friends; B carries a webhook, so a wake-up is observable in `pushes`. */
async function pair() {
  const A = await ownerWithBot(S.base, "alice");
  const B = await ownerWithBot(S.base, "bob", "https://peer.test/hook");
  const rel = await A.owner.req("POST", "/v1/relationships", { from_bot_id: A.bot.id, target_handle: B.handle, message: "hi", requested_capabilities: ["chat.public"] });
  await B.owner.req("POST", `/v1/relationships/${rel.relationship_id}/consent`, { decision: "accept", grant_capabilities: [] });
  return { A, B };
}

/** A draft from A to B that waits for A's owner, with the conversation it was written in. */
async function holdDraft(A: any, B: any, text: string) {
  const conv: any = await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "expiry silence" });
  const draft: any = await A.bot.draftMessage(conv.conversation_id, { text });
  assert.equal(draft.status, "pending_approval", JSON.stringify(draft));
  return { convId: conv.conversation_id as string, aprId: draft.approval_id as string, messageId: draft.message_id as string };
}

/** Force the card past its TTL and let the lazy sweep run the way every read triggers it. */
async function expire(aprId: string, owner: any) {
  S.platform.db.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?").run(past(), aprId);
  await owner.req("GET", "/v1/approvals?status=pending");
  await S.platform.flushWebhooks();
}

const peerEventsAbout = async (bot: any, convId: string) =>
  (await bot.events()).events.filter((e: any) => e.conversation_id === convId).map((e: any) => e.event_type).filter((t: string) => t !== "conversation.started");

describe("an expired draft keeps the peer silent", () => {
  test("(1) the peer's queue learns nothing about the draft", async () => {
    const { A, B } = await pair();
    const { convId, aprId } = await holdDraft(A, B, "never approved");
    await S.platform.flushWebhooks();

    await expire(aprId, A.owner);

    assert.deepEqual(await peerEventsAbout(B.bot, convId), [], "the peer never received the draft, so it must not learn that the draft expired");
    assert.equal(approvalRow(aprId).status, "expired", "the card still settles");
  });

  test("(2) the peer's webhook is not woken by the expiry", async () => {
    const { A, B } = await pair();
    const { convId, aprId } = await holdDraft(A, B, "never approved");
    await S.platform.flushWebhooks();
    const before = pushes.length;

    await expire(aprId, A.owner);

    const fresh = pushes.slice(before);
    const items = fresh.flatMap((p) => (p.body.items ?? []).map((i: any) => `${i.type} :: ${i.summary}`));
    assert.deepEqual(items.filter((x: string) => x.startsWith("system.notice")), [], `an expiring draft is not a wake-up: ${JSON.stringify(items)}`);
    assert.ok(fresh.every((p) => !JSON.stringify(p.body).includes(convId)), "no push may name the draft's conversation");
  });

  test("(3) guard: the Bot that drafted it is told, and the expiry is audited", async () => {
    const { A, B } = await pair();
    const { aprId } = await holdDraft(A, B, "never approved");

    await expire(aprId, A.owner);

    const decided = (await A.bot.events()).events.filter((e: any) => e.event_type === "approval.decided" && e.approval_id === aprId);
    assert.equal(decided.length, 1, "the owner of the card hears the outcome once");
    assert.equal(decided[0].decision, "expired");
    assert.equal(decided[0].message_id, (await S.platform.db.prepare("SELECT id FROM messages WHERE approval_id = ?").get(aprId) as any).id, "the event names the draft");
    const audit = (await A.owner.req("GET", `/v1/audit-events?subject=${aprId}`)).events.filter((e: any) => e.action === "approval.expired");
    assert.equal(audit.length, 1, "the expiry leaves an audit record");
    assert.equal(audit[0].data.kind, "outbound_message");
  });

  test("(4) guard: a rejected draft stays silent toward the peer", async () => {
    const { A, B } = await pair();
    const { convId, aprId } = await holdDraft(A, B, "rejected line");
    await S.platform.flushWebhooks();

    await A.owner.req("POST", `/v1/approvals/${aprId}/decision`, { decision: "rejected" });
    await S.platform.flushWebhooks();

    assert.deepEqual(await peerEventsAbout(B.bot, convId), [], "reject is the rule the expiry path has to follow");
  });

  test("(5) guard: an approved line still reaches the peer and wakes its webhook", async () => {
    const { A, B } = await pair();
    const { convId, aprId } = await holdDraft(A, B, "approved line");
    await S.platform.flushWebhooks();
    const before = pushes.length;

    await A.owner.req("POST", `/v1/approvals/${aprId}/decision`, { decision: "approved" });
    await S.platform.flushWebhooks();

    const peer = (await B.bot.events()).events.filter((e: any) => e.event_type === "message.received" && e.conversation_id === convId);
    assert.equal(peer.length, 1, "the peer gets the delivered line");
    const items = pushes.slice(before).flatMap((p) => (p.body.items ?? []).map((i: any) => i.type));
    assert.ok(items.includes("message.received"), `and a real wake-up: ${JSON.stringify(items)}`);
  });
});
