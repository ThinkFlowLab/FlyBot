/**
 * A card the platform settles on its own is not a decision its owner can still make, and the decision gate is the
 * door that tells a client why. Two reasons already answer with a sentence of their own: a revoked member's card and
 * a card left behind by a revoked share. A card settled by its sender walking out of a room (`room_left`) and one
 * dropped when the room closed (`room_closed`) answered only "approval is cancelled", which names a status the
 * caller never chose and says nothing about the room.
 *
 * So the two room reasons name what happened, next to the sentences that already do. The reasons that have their own
 * sentence keep it word for word, and a reason this build does not map keeps the plain "approval is cancelled" line
 * instead of borrowing a cause it does not know.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { expectApiError, friends, startServer } from "./helpers.js";

const ROOM_LEFT = "the Bot is no longer in the room this draft was for; this draft can no longer be approved";
const ROOM_CLOSED = "the room closed before this draft was decided; this draft can no longer be approved";
const MEMBER_REVOKED = "the sending Bot was revoked; this draft can no longer be approved";
const SHARE_GONE = "the share this draft was waiting on was revoked; this draft can no longer be approved";

async function req(base: string, method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}

/** Two owners whose own Bots are friends: the seat a room is joined with. */
async function pair(t: any) {
  const s = await startServer();
  t.after(s.stop);
  const p = s.platform;
  const a = p.onboardFlybot({ display_name: "Alice" });
  const b = p.onboardFlybot({ display_name: "Bob" });
  const A = { kind: "owner" as const, ownerId: a.owner_id };
  const B = { kind: "owner" as const, ownerId: b.owner_id };
  const rel = p.requestRelationship(A, { from_bot_id: a.home.bot_id, target_bot_id: b.home.bot_id, message: "hi" });
  p.consent(B, rel.relationship_id, { decision: "accept", grant_capabilities: [] });
  return { s, p, A, B, aBot: a.home.bot_id as string, bBot: b.home.bot_id as string };
}

/** One open room holding both owners' Bots. */
function openRoom(p: any, A: any, B: any, aBot: string, bBot: string, code: string) {
  const first = p.joinFaceRoom(A, { code, bots: [aBot] });
  const second = p.joinFaceRoom(B, { code, bots: [bBot] });
  assert.equal(second.room_id, first.room_id, "both owners are in the same room");
  p.startFaceRoom(A, first.room_id);
  return first.room_id as string;
}

const decide = (p: any, A: any, approvalId: string) =>
  expectApiError(Promise.resolve().then(() => p.decideApproval(A, approvalId, { decision: "approved" })), 409, "invalid_state");

test("a card settled by the sender walking out of the room names the seat at the decision gate", async (t) => {
  const { p, A, B, aBot, bBot } = await pair(t);
  const roomId = openRoom(p, A, B, aBot, bBot, "830101");
  const line = p.draftFaceRoomMessage(A, roomId, { text: "a line waiting on a seat" });
  assert.equal(line.status, "pending_approval");

  p.leaveFaceRoom(A, roomId);
  const row = p.db.prepare("SELECT status, decision FROM approvals WHERE id = ?").get(line.approval_id) as any;
  assert.equal(row.decision, "room_left", "the leave settled the card it was holding");

  const err = await decide(p, A, line.approval_id);
  assert.equal(err.message, ROOM_LEFT, "the refusal names the seat, not just the cancelled state");
  assert.doesNotMatch(err.message, /approval is cancelled/);
});

test("a card dropped when the room closed names the closure at the decision gate", async (t) => {
  const { p, A, B, aBot, bBot } = await pair(t);
  const roomId = openRoom(p, A, B, aBot, bBot, "830102");
  const line = p.draftFaceRoomMessage(B, roomId, { text: "the line the room drops" });

  p.leaveFaceRoom(A, roomId);
  p.leaveFaceRoom(B, roomId);
  const row = p.db.prepare("SELECT status, decision FROM approvals WHERE id = ?").get(line.approval_id) as any;
  assert.equal(row.status, "cancelled");
  assert.equal(row.decision, "room_closed", "the closure settled the line still waiting in the room");

  const err = await decide(p, B, line.approval_id);
  assert.equal(err.message, ROOM_CLOSED, "the refusal names the closed room, not just the cancelled state");
  assert.doesNotMatch(err.message, /approval is cancelled/);
});

test("a revoked member's sentence is unchanged at the decision gate", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const p = s.platform;
  const a = p.onboardFlybot({ display_name: "Alice" });
  const b = p.onboardFlybot({ display_name: "Bob" });
  const A = { kind: "owner" as const, ownerId: a.owner_id };
  const B = { kind: "owner" as const, ownerId: b.owner_id };
  const writer = p.addHomeMember(A, a.home.bot_id, { name: "writer", display_name: "Writer" });
  const coder = p.addHomeMember(B, b.home.bot_id, { name: "coder", display_name: "Coder" });
  const rel = p.requestRelationship(A, { from_bot_id: writer.bot_id, target_bot_id: coder.bot_id, message: "hi" });
  p.consent(B, rel.relationship_id, { decision: "accept", grant_capabilities: [] });
  const sent = p.sendAsMember(A, { from_bot_id: writer.bot_id, to: coder.handle, text: "hello" });
  assert.equal(sent.message.status, "pending_approval");

  p.removeHomeMember(A, a.home.bot_id, writer.bot_id);
  const err = await decide(p, A, sent.message.approval_id as string);
  assert.equal(err.message, MEMBER_REVOKED);
});

test("a revoked share's sentence is unchanged at the decision gate", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const c = await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "hi" });
  const held: any = await A.bot.draftMessage(c.conversation_id, { text: "a line waiting on the share" });
  assert.equal(held.status, "pending_approval");
  const g = s.platform.db.prepare("SELECT id FROM grants WHERE grantor_owner = ? AND grantee_bot = ? AND capability = 'chat.public' AND IFNULL(room_id, '') = '' AND status = 'active' ORDER BY created_at DESC LIMIT 1").get(B.owner_id, A.bot.id) as any;
  assert.ok(g, "the friendship's chat.public grant is the share the card waits on");
  assert.equal((await req(s.base, "DELETE", `/v1/grants/${g.id}`, B.owner.token)).status, 200);

  const refused: any = await req(s.base, "POST", `/v1/approvals/${held.approval_id}/decision`, A.owner.token, { decision: "approved" });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error.message, SHARE_GONE);
});

test("a reason this build does not map still answers with the plain cancelled state", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const c = await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "hi" });
  const held: any = await A.bot.draftMessage(c.conversation_id, { text: "a line the stop settles" });
  assert.equal(held.status, "pending_approval");
  assert.equal((await req(s.base, "POST", "/v1/emergency-stop", A.owner.token, { bot_id: A.bot.id })).status, 200);
  const row = s.platform.db.prepare("SELECT status, decision FROM approvals WHERE id = ?").get(held.approval_id) as any;
  assert.equal(row.decision, "emergency_stop", "the stop settled the card with its own reason");

  const refused: any = await req(s.base, "POST", `/v1/approvals/${held.approval_id}/decision`, A.owner.token, { decision: "approved" });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error.code, "invalid_state");
  assert.equal(refused.body.error.message, "approval is cancelled", "an unmapped reason keeps the plain line");
});

test("a card that was decided keeps naming the decision it already carries", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const c = await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "hi" });
  const held: any = await A.bot.draftMessage(c.conversation_id, { text: "a line that is rejected" });
  const rejected = await req(s.base, "POST", `/v1/approvals/${held.approval_id}/decision`, A.owner.token, { decision: "rejected" });
  assert.equal(rejected.status, 200, JSON.stringify(rejected.body));

  const again: any = await req(s.base, "POST", `/v1/approvals/${held.approval_id}/decision`, A.owner.token, { decision: "approved" });
  assert.equal(again.status, 409, JSON.stringify(again.body));
  assert.equal(again.body.error.message, "approval is rejected");
});
