/**
 * A chat says `awaiting_approval` exactly while one of its cards is pending (`refreshConversationStatus` keeps that
 * invariant: pending ? "awaiting_approval" : "open").
 *
 * A card's own clock is 24h (`LIMITS.approvalTtlMs`) and the sweep that settles a lapsed card (`expireStale`) runs on
 * the doors that read cards: the approval queue and the event feed. The conversation read does not run it, so a card
 * whose clock ran out a moment ago keeps the chat page saying "Pending approval" and its line `pending_approval`, while
 * the queue at the same moment reads "(none)" — and the decision the page still offers answers 409 `invalid_state`
 * "approval is expired". The page is the last place that calls the card alive.
 *
 * The conversation read now settles the lapsed cards of the chats it is about to answer, through the same
 * `expireApproval` the sweep uses, so the chat reports what the queue already reports and the Bot that drafted the
 * line hears its expiry once. Only a member's read settles: a read refused with 403 settles nothing, because a
 * refused request must not leave a write in someone else's chat.
 *
 * Red first on 93f57b9b: the view reports `awaiting_approval` / `pending_approval` for a card whose row is long past
 * its deadline, and the read leaves it pending.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { expectApiError, friends, ownerWithBot, startServer } from "./helpers.js";

const past = () => new Date(Date.now() - 60e3).toISOString();

/** A pair, one live chat and one draft held in it; the card's own clock then runs out under both. */
async function chatWithLapsedCard(s: any) {
  const { A, B } = await friends(s.base);
  const cid = (await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "hi" })).conversation_id as string;
  const draft: any = await A.bot.draftMessage(cid, { text: "a line whose card ran out of time" });
  assert.equal(draft.status, "pending_approval");
  s.platform.db.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?").run(past(), draft.approval_id);
  return { A, B, cid, draft };
}

const cardRow = (s: any, id: string) => s.platform.db.prepare("SELECT status, decided_at FROM approvals WHERE id = ?").get(id) as any;
const convRow = (s: any, cid: string) => s.platform.db.prepare("SELECT status, outcome FROM conversations WHERE id = ?").get(cid) as any;
const msgRow = (s: any, id: string) => s.platform.db.prepare("SELECT status FROM messages WHERE id = ?").get(id) as any;

test("the chat view settles a card whose clock ran out, like the queue already does", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B, cid, draft } = await chatWithLapsedCard(s);
  assert.equal(convRow(s, cid).status, "awaiting_approval", "the row still waits: only a sweep moves it");
  assert.equal(cardRow(s, draft.approval_id).status, "pending", "and nothing has settled the card yet");

  const view: any = await A.owner.req("GET", `/v1/conversations/${cid}`);
  assert.equal(view.status, "open", "a chat is not waiting for a card that can never be decided");
  assert.equal(view.outcome ?? null, null, "an open chat has no ending to report");
  const line = (view.messages as any[]).find((m) => m.message_id === draft.message_id);
  assert.ok(line, "the line is still on the page");
  assert.equal(line.status, "expired", "the line reports what the card's clock says");
  assert.equal(line.approval_id, undefined, "and it offers no decision the decision door would refuse");

  const card = cardRow(s, draft.approval_id);
  assert.equal(card.status, "expired", "the card is settled, not left pending behind the page");
  assert.ok(card.decided_at, "with the moment it ended");
  assert.equal(convRow(s, cid).status, "open", "and the chat row stops waiting");
  assert.equal(msgRow(s, draft.message_id).status, "expired");

  const peerView: any = await B.bot.getConversation(cid);
  assert.equal(peerView.status, "open", "the peer reads the same chat, and hears no line that never went out");
});

test("the conversation list settles it too", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, cid, draft } = await chatWithLapsedCard(s);

  const list: any = await A.owner.req("GET", "/v1/conversations");
  const listed = (list.conversations as any[]).find((c) => c.conversation_id === cid);
  assert.ok(listed, "the chat is on the list");
  assert.equal(listed.status, "open", "the list and the view cannot disagree about a lapsed card");
  assert.equal(cardRow(s, draft.approval_id).status, "expired");
});

test("a card that still has time keeps holding the chat", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const cid = (await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "hi" })).conversation_id as string;
  const draft: any = await A.bot.draftMessage(cid, { text: "a line with time on its clock" });

  const view: any = await A.owner.req("GET", `/v1/conversations/${cid}`);
  assert.equal(view.status, "awaiting_approval", "a live card is what the chat waits for");
  assert.equal(cardRow(s, draft.approval_id).status, "pending", "and the read does not settle it");
  const line = (view.messages as any[]).find((m) => m.message_id === draft.message_id);
  assert.equal(line?.approval_id, draft.approval_id, "the page still offers the live card's decision");
});

test("a second read writes no second settlement", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, cid, draft } = await chatWithLapsedCard(s);

  await A.owner.req("GET", `/v1/conversations/${cid}`);
  const settled = () => ({
    expired: (s.platform.audit.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action = 'approval.expired' AND subject = ?").get(draft.approval_id) as any).n,
    told: (s.platform.db.prepare("SELECT COUNT(*) n FROM events WHERE type = 'approval.decided' AND data LIKE ?").get(`%${draft.approval_id}%`) as any).n,
  });
  const first = settled();
  assert.equal(first.expired, 1, "the sweep settles the card once");
  assert.equal(first.told, 1, "and the Bot that drafted the line is told once");

  const again: any = await A.owner.req("GET", `/v1/conversations/${cid}`);
  assert.equal(again.status, "open");
  assert.deepEqual(settled(), first, "the second read settles nothing twice");
});

test("a read that is refused settles nothing in someone else's chat", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, cid, draft } = await chatWithLapsedCard(s);
  const outsider = await ownerWithBot(s.base, "carol");

  const settled = () => ({
    expired: (s.platform.audit.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action = 'approval.expired' AND subject = ?").get(draft.approval_id) as any).n,
    told: (s.platform.db.prepare("SELECT COUNT(*) n FROM events WHERE type = 'approval.decided' AND data LIKE ?").get(`%${draft.approval_id}%`) as any).n,
  });

  await expectApiError(outsider.owner.req("GET", `/v1/conversations/${cid}`), 403, "forbidden");
  await expectApiError(outsider.bot.getConversation(cid), 403, "not_a_member");
  assert.deepEqual(settled(), { expired: 0, told: 0 }, "a refused read is not a settlement, and writes nothing");
  assert.equal(cardRow(s, draft.approval_id).status, "pending", "the card is still where the member left it");
  assert.equal(convRow(s, cid).status, "awaiting_approval", "and the chat still waits for the member's own read");

  const view: any = await A.owner.req("GET", `/v1/conversations/${cid}`);
  assert.equal(view.status, "open", "the member's read still settles the card in their own chat");
  assert.equal(cardRow(s, draft.approval_id).status, "expired");
  assert.deepEqual(settled(), { expired: 1, told: 1 }, "and the settlement lands exactly once");

  await A.owner.req("GET", `/v1/conversations/${cid}`);
  assert.deepEqual(settled(), { expired: 1, told: 1 }, "a second read of a settled chat writes nothing again");
});

test("a refused read leaves a live card pending", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const cid = (await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "hi" })).conversation_id as string;
  const draft: any = await A.bot.draftMessage(cid, { text: "a line with time on its clock" });
  const outsider = await ownerWithBot(s.base, "dave");

  const settled = () => ({
    expired: (s.platform.audit.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action = 'approval.expired' AND subject = ?").get(draft.approval_id) as any).n,
    told: (s.platform.db.prepare("SELECT COUNT(*) n FROM events WHERE type = 'approval.decided' AND data LIKE ?").get(`%${draft.approval_id}%`) as any).n,
  });
  const untouched = { expired: 0, told: 0 };
  assert.deepEqual(settled(), untouched, "the fixture starts unsettled");

  await expectApiError(outsider.owner.req("GET", `/v1/conversations/${cid}`), 403, "forbidden");
  assert.deepEqual(settled(), untouched, "only a card past its own clock is a card a read settles");
  assert.equal(cardRow(s, draft.approval_id).status, "pending", "this one still has time, so it is still pending");

  const view: any = await A.owner.req("GET", `/v1/conversations/${cid}`);
  assert.equal(view.status, "awaiting_approval", "a live card is what the chat still waits for");
  assert.equal(cardRow(s, draft.approval_id).status, "pending", "and no read settles a card that can still be decided");
  assert.deepEqual(settled(), untouched, "so no read writes anything about it either");
});
