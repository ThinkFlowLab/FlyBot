// A pending card an older build left behind in a chat that is already closed is not a decision: the owner's next
// attempt settles it (409) instead of delivering. `cancelPendingFor` promises that "a cancelled card is never
// silent", and every other call site asks for it -- the live close, the clock, a revoked share, an ended
// relationship. The stale-row branch in `decideApprovalOnce` cancelled without telling anyone, so the Bot that
// wrote the line never heard it was cancelled: its draft vanished from its world with no `approval.decided` to read.
import assert from "node:assert/strict";
import { test } from "node:test";
import { friends, inDays, startServer } from "./helpers.js";

const meetingIntent = () => ({ type: "schedule_meeting", summary: "sync", params: { duration_minutes: 30, window: { start: inDays(1, 0), end: inDays(8, 23) } } });

async function req(base: string, method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}

const approve = (base: string, o: any, id: string) =>
  req(base, "POST", `/v1/approvals/${id}/decision`, o.owner.token, { decision: "approved" });

const cardIn = async (base: string, o: any, status: string, id: string) =>
  (((await req(base, "GET", `/v1/approvals?status=${status}`, o.owner.token)).body.approvals as any[]) ?? []).find((a) => a.approval_id === id) ?? null;

const told = async (bot: any, approvalId: string) =>
  ((await bot.events()).events as any[]).filter((e) => e.event_type === "approval.decided" && e.approval_id === approvalId);

/** Close the conversation behind the card, the row an older build left pending. */
const closeBehind = (s: any, cid: string, outcome: "abandoned" | "expired") =>
  s.platform.db.prepare("UPDATE conversations SET status = 'closed', outcome = ? WHERE id = ?").run(outcome, cid);

/** A line A's Bot holds for B, left pending by an older build after its chat closed. */
async function staleLine(s: any, A: any, B: any, outcome: "abandoned" | "expired") {
  const c = await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "hi" });
  const d: any = await A.bot.draftMessage(c.conversation_id, { text: "the line the older build left behind" });
  assert.equal(d.status, "pending_approval");
  closeBehind(s, c.conversation_id, outcome);
  assert.ok(await cardIn(s.base, A, "pending", d.approval_id), "the stale card is still pending");
  return { cid: c.conversation_id as string, approvalId: d.approval_id as string, messageId: d.message_id as string };
}

test("settling a stale line in a closed chat tells the Bot that owned it", async () => {
  const s = await startServer();
  try {
    const { A, B } = await friends(s.base);
    const held = await staleLine(s, A, B, "abandoned");

    const refused: any = await approve(s.base, A, held.approvalId);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.error.code, "invalid_state");
    const settled: any = await cardIn(s.base, A, "cancelled", held.approvalId);
    assert.ok(settled, "the stale card is settled instead of delivered");
    assert.equal(settled.decision, "conversation_closed");

    const events = await told(A.bot, held.approvalId);
    assert.equal(events.length, 1, "the Bot that wrote the line hears it was cancelled, once");
    assert.equal(events[0].decision, "cancelled");
    assert.equal(events[0].reason, "conversation_closed");
    assert.equal(events[0].message_id, held.messageId);
  } finally { await s.stop(); }
});

test("a chat closed the normal way announces its card once, and stays at one", async () => {
  const s = await startServer();
  try {
    const { A, B } = await friends(s.base);
    const c = await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "hi" });
    const held: any = await A.bot.draftMessage(c.conversation_id, { text: "the line the close cancels" });
    const closed: any = await req(s.base, "POST", `/v1/conversations/${c.conversation_id}/close`, A.owner.token, { outcome: "abandoned" });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));

    const events = await told(A.bot, held.approval_id);
    assert.equal(events.length, 1, "the live close already tells the Bot, and must keep doing so once");
    assert.equal(events[0].reason, "conversation_closed");
  } finally { await s.stop(); }
});

test("a stale line in a chat whose clock ran out says so with its own reason", async () => {
  const s = await startServer();
  try {
    const { A, B } = await friends(s.base);
    const held = await staleLine(s, A, B, "expired");

    const refused: any = await approve(s.base, A, held.approvalId);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.match(refused.body.error.message, /expired/);
    const settled: any = await cardIn(s.base, A, "cancelled", held.approvalId);
    assert.equal(settled.decision, "conversation_expired");

    const events = await told(A.bot, held.approvalId);
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, "conversation_expired");
  } finally { await s.stop(); }
});

test("a stale action card in a closed chat is announced with its action", async () => {
  const s = await startServer();
  try {
    const { A, B } = await friends(s.base);
    const c = await A.bot.startConversation(B.bot.id, meetingIntent());
    const d: any = await A.bot.draftAction(c.conversation_id, "calendar.book", { title: "Sync", start: inDays(3, 15), end: inDays(3, 15.5), attendees: [B.bot.id] });
    assert.equal(d.status, "pending_approval");
    closeBehind(s, c.conversation_id, "abandoned");
    assert.ok(await cardIn(s.base, A, "pending", d.approval_id), "the stale action card is still pending");

    const refused: any = await approve(s.base, A, d.approval_id);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    const settled: any = await cardIn(s.base, A, "cancelled", d.approval_id);
    assert.equal(settled.decision, "conversation_closed");

    const events = await told(A.bot, d.approval_id);
    assert.equal(events.length, 1, "the Bot that drafted the action hears it was cancelled, once");
    assert.equal(events[0].decision, "cancelled");
    assert.equal(events[0].reason, "conversation_closed");
    assert.equal(events[0].action_id, d.action_id);
  } finally { await s.stop(); }
});
