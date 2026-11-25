// Removing a home member revokes its Bot. A line already held for the sender's owner was addressed to that Bot,
// so it can never be delivered — yet the card stayed pending for its whole 24-hour clock and `approve` answered
// `bot_revoked`, so the only way out was to reject a line nobody refused. The revoke now settles those cards
// under their own reason, the way it already settles the cards the revoked Bot owned.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

async function req(base: string, method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}

type S = Awaited<ReturnType<typeof startServer>>;

/** A FlyBot home of its own, with the members this test needs and the token that manages them. */
async function homeWithMembers(base: string, name: string, handles: string[]) {
  const home = await req(base, "POST", "/v1/onboard/flybot", undefined, { display_name: name, username: `${name}own`, password: "secret-pw" });
  assert.equal(home.status, 201, JSON.stringify(home.body));
  const login = await req(base, "POST", "/v1/auth/login", undefined, { username: `${name}own`, password: "secret-pw" });
  const token = login.body.owner_token as string;
  const members: { bot_id: string; handle: string }[] = [];
  for (const handle of handles) {
    const m = await req(base, "POST", `/v1/homes/${home.body.home.bot_id}/members`, token, { name: handle, display_name: handle });
    assert.equal(m.status, 201, JSON.stringify(m.body));
    members.push({ bot_id: m.body.bot_id as string, handle: m.body.handle as string });
  }
  return { token, homeId: home.body.home.bot_id as string, members };
}

/** A consented chat.public share so the sender's Bot may write to `target`. */
async function befriend(base: string, senderToken: string, fromBotId: string, targetHandle: string, targetToken: string) {
  const rel = await req(base, "POST", "/v1/relationships", senderToken, { from_bot_id: fromBotId, target_handle: targetHandle, message: "hi", requested_capabilities: ["chat.public"] });
  assert.equal(rel.status, 201, JSON.stringify(rel.body));
  const consent = await req(base, "POST", `/v1/relationships/${rel.body.relationship_id}/consent`, targetToken, {
    decision: "accept", grant_capabilities: [{ capability: "chat.public" }],
  });
  assert.equal(consent.status, 200, JSON.stringify(consent.body));
}

/** One line the sender's Bot writes; it waits at the sender's owner as `pending_approval`. */
async function heldLine(A: any, peerBotId: string, text: string) {
  const conv: any = await A.bot.startConversation(peerBotId, { type: "general_chat", summary: "a card that outlives its receiver" });
  const draft: any = await A.bot.signed(`/v1/conversations/${conv.conversation_id}/messages`, "message.draft", { text }, { conversation_id: conv.conversation_id });
  assert.equal(draft.status, "pending_approval", JSON.stringify(draft));
  return { conversationId: conv.conversation_id as string, approvalId: draft.approval_id as string, messageId: draft.message_id as string };
}

const pendingIds = async (base: string, token: string) =>
  ((await req(base, "GET", "/v1/approvals?status=pending", token)).body.approvals as any[]).map((a) => a.approval_id as string);
const row = (s: S, sql: string, ...args: unknown[]) => (s.platform as any).get(sql, ...args);
const all = (s: S, sql: string, ...args: unknown[]) => (s.platform as any).all(sql, ...args);

test("revoking the receiving Bot settles the sender's card under its own reason", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const R = await homeWithMembers(s.base, "ben", ["reader"]);
  await befriend(s.base, A.owner.token, A.bot.id, R.members[0].handle, R.token);
  const card = await heldLine(A, R.members[0].bot_id, "hello reader");
  assert.deepEqual(await pendingIds(s.base, A.owner.token), [card.approvalId], "the line waits at the sender's owner");

  const removed = await req(s.base, "DELETE", `/v1/homes/${R.homeId}/members/${R.members[0].bot_id}`, R.token);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));

  assert.deepEqual(await pendingIds(s.base, A.owner.token), [], "a card that can never be delivered is not left waiting");
  const settled = row(s, "SELECT status, decision FROM approvals WHERE id = ?", card.approvalId);
  assert.equal(settled.status, "cancelled");
  assert.equal(settled.decision, "recipient_revoked", "the record names the reason, not the sender's own revocation");
  assert.equal(row(s, "SELECT status FROM messages WHERE id = ?", card.messageId).status, "cancelled", "the line dies with its card");

  // The sending Bot is told, not left to notice a card that vanished: the reason names the peer, not its own seat.
  const told = all(s, "SELECT data FROM events WHERE bot_id = ? AND type = 'approval.decided'", A.bot.id)
    .map((e: any) => JSON.parse(e.data))
    .filter((e: any) => e.message_id === card.messageId);
  assert.equal(told.length, 1, "the sender hears once");
  assert.equal(told[0].decision, "cancelled");
  assert.equal(told[0].reason, "recipient_revoked");

  // Asking to approve it now answers what happened, instead of `403 bot_revoked` from the delivery door.
  let refusal: any;
  try { await A.owner.req("POST", `/v1/approvals/${card.approvalId}/decision`, { decision: "approved" }); } catch (e: any) { refusal = e; }
  assert.ok(refusal, "a settled card is not approved");
  assert.equal(refusal.status, 409);
  assert.equal(refusal.code, "invalid_state");
  assert.ok(refusal.message.endsWith("the receiving Bot was revoked; this draft can no longer be approved"), refusal.message);
});

test("the settle is bounded by the recipient: another member's card and another peer's card still decide", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const R = await homeWithMembers(s.base, "ben", ["reader", "writer"]);
  const [reader, writer] = R.members;
  await befriend(s.base, A.owner.token, A.bot.id, reader.handle, R.token);
  await befriend(s.base, A.owner.token, A.bot.id, writer.handle, R.token);
  const P = await ownerWithBot(s.base, "cy");
  await befriend(s.base, A.owner.token, A.bot.id, P.handle, P.owner.token);

  const toReader = await heldLine(A, reader.bot_id, "for the reader");
  const toWriter = await heldLine(A, writer.bot_id, "for the writer");
  const toPeer = await heldLine(A, P.bot.id, "for the other home");
  assert.equal((await pendingIds(s.base, A.owner.token)).length, 3);

  await req(s.base, "DELETE", `/v1/homes/${R.homeId}/members/${reader.bot_id}`, R.token);

  const left = await pendingIds(s.base, A.owner.token);
  assert.ok(!left.includes(toReader.approvalId), "the revoked receiver's card is settled");
  assert.ok(left.includes(toWriter.approvalId), "another member of the same home still receives its card");
  assert.ok(left.includes(toPeer.approvalId), "another peer's card is none of this revoke's business");

  // The surviving cards decide normally: the same home's other member first.
  const okWriter: any = await A.owner.req("POST", `/v1/approvals/${toWriter.approvalId}/decision`, { decision: "approved" });
  assert.ok(okWriter, "the writer's card is approved");
  assert.equal(row(s, "SELECT status FROM messages WHERE id = ?", toWriter.messageId).status, "delivered");
  const okPeer: any = await A.owner.req("POST", `/v1/approvals/${toPeer.approvalId}/decision`, { decision: "approved" });
  assert.ok(okPeer, "the other peer's card is approved");
  assert.equal(row(s, "SELECT status FROM messages WHERE id = ?", toPeer.messageId).status, "delivered");
  assert.deepEqual(await pendingIds(s.base, A.owner.token), [], "nothing is left behind");
});
