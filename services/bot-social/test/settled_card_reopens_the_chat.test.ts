// A chat says `awaiting_approval` exactly while one of its cards is pending (refreshConversationStatus keeps that
// invariant: pending ? "awaiting_approval" : "open"). The three paths that settle a card when a share ends cancel the
// card but never refresh the chat, so the owner is left looking at "Pending approval" with an empty approval list.
import assert from "node:assert/strict";
import { test } from "node:test";
import { friends, startServer } from "./helpers.js";

async function req(base: string, method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}

const grantFor = (s: any, grantorOwner: string, granteeBot: string, capability = "chat.public") =>
  s.platform.db.prepare("SELECT id FROM grants WHERE grantor_owner = ? AND grantee_bot = ? AND capability = ? AND IFNULL(room_id, '') = '' AND status = 'active' ORDER BY created_at DESC LIMIT 1").get(grantorOwner, granteeBot, capability) as any;

const cardIn = async (base: string, owner: any, status: string, id: string) =>
  (((await req(base, "GET", `/v1/approvals?status=${status}`, owner.token)).body.approvals as any[]) ?? []).find((a) => a.approval_id === id) ?? null;

const approve = (base: string, owner: any, id: string) =>
  req(base, "POST", `/v1/approvals/${id}/decision`, owner.token, { decision: "approved" });

async function heldLine(A: any, B: any, text = "the line that must not land") {
  const c = await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "hi" });
  const d: any = await A.bot.draftMessage(c.conversation_id, { text });
  assert.equal(d.status, "pending_approval");
  return { cid: c.conversation_id as string, approvalId: d.approval_id as string, messageId: d.message_id as string };
}

const convStatus = async (A: any, cid: string) => ((await A.bot.getConversation(cid)) as any).status;

test("revoking the share settles the card AND reopens the chat", async () => {
  const s = await startServer();
  try {
    const { A, B } = await friends(s.base);
    const held = await heldLine(A, B);
    assert.equal(await convStatus(A, held.cid), "awaiting_approval", "a pending card is what holds the chat");

    const g = grantFor(s, B.owner_id, A.bot.id);
    assert.ok(g, "B's owner gave A's Bot chat.public when they became friends");
    assert.equal((await req(s.base, "DELETE", `/v1/grants/${g.id}`, B.owner.token)).status, 200);

    const settled: any = await cardIn(s.base, A.owner, "cancelled", held.approvalId);
    assert.ok(settled, "the held line is settled with the share it was waiting on");
    assert.equal(settled.decision, "grant_revoked");
    assert.equal(await cardIn(s.base, A.owner, "pending", held.approvalId), null, "and it is no longer pending");
    assert.equal(await convStatus(A, held.cid), "open", "a chat with no pending card does not say it waits for one");
    assert.equal(await convStatus(B, held.cid), "open", "the peer reads the same status");
  } finally { await s.stop(); }
});

test("the stale-card 409 reopens the chat too", async () => {
  const s = await startServer();
  try {
    const { A, B } = await friends(s.base);
    const held = await heldLine(A, B);
    const g = grantFor(s, B.owner_id, A.bot.id);
    // The row an older build left behind: the share is gone, the card was never settled.
    s.platform.db.prepare("UPDATE grants SET status = 'revoked', revoked_at = ? WHERE id = ?").run(new Date().toISOString(), g.id);
    assert.ok(await cardIn(s.base, A.owner, "pending", held.approvalId), "the stale card is still pending");

    const refused: any = await approve(s.base, A.owner, held.approvalId);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.error.code, "invalid_state");
    assert.ok(await cardIn(s.base, A.owner, "cancelled", held.approvalId), "the stale card is settled instead of delivered");
    assert.equal(await convStatus(A, held.cid), "open", "the 409 cancelled the card, so the chat stops waiting");
  } finally { await s.stop(); }
});

test("a chat whose cards are still pending keeps saying so", async () => {
  const s = await startServer();
  try {
    const { A, B } = await friends(s.base);
    const held = await heldLine(A, B);
    assert.equal(await convStatus(A, held.cid), "awaiting_approval");
    const ok: any = await approve(s.base, A.owner, held.approvalId);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(await convStatus(A, held.cid), "open", "a normal approval still clears it");
  } finally { await s.stop(); }
});

test("two cards in one chat reopen it once, not card by card", async () => {
  const s = await startServer();
  try {
    const { A, B } = await friends(s.base);
    const held = await heldLine(A, B, "first line");
    const second: any = await A.bot.draftMessage(held.cid, { text: "second line" });
    assert.equal(second.status, "pending_approval");
    assert.equal(await convStatus(A, held.cid), "awaiting_approval");

    const g = grantFor(s, B.owner_id, A.bot.id);
    assert.equal((await req(s.base, "DELETE", `/v1/grants/${g.id}`, B.owner.token)).status, 200);
    assert.ok(await cardIn(s.base, A.owner, "cancelled", held.approvalId));
    assert.ok(await cardIn(s.base, A.owner, "cancelled", second.approval_id), "both held lines are settled");
    assert.equal(await convStatus(A, held.cid), "open", "the chat reopens exactly once its last card is gone");
  } finally { await s.stop(); }
});

test("a closed chat stays closed when its cards are cancelled", async () => {
  const s = await startServer();
  try {
    const { A, B } = await friends(s.base);
    const held = await heldLine(A, B);
    const closed: any = await req(s.base, "POST", `/v1/conversations/${held.cid}/close`, A.owner.token, { outcome: "abandoned" });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.equal(await convStatus(A, held.cid), "closed");
    const g = grantFor(s, B.owner_id, A.bot.id);
    assert.equal((await req(s.base, "DELETE", `/v1/grants/${g.id}`, B.owner.token)).status, 200);
    assert.equal(await convStatus(A, held.cid), "closed", "settling cards must not reopen a chat someone closed");
  } finally { await s.stop(); }
});
