import assert from "node:assert/strict";
import { test } from "node:test";
import { expectApiError, startServer } from "./helpers.js";
import { loadConsole } from "./ui_helpers.js";

test("revoking a home member cancels its pending drafts and nothing is delivered", async (t) => {
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
  const approval = sent.message.approval_id as string;

  p.removeHomeMember(A, a.home.bot_id, writer.bot_id);

  assert.equal(p.listApprovals(A, "pending").some((x: any) => x.approval_id === approval), false, "the card is no longer pending");
  await expectApiError(Promise.resolve().then(() => p.decideApproval(A, approval, { decision: "approved" })), 409, "invalid_state");
  const conv = p.getConversation(B, sent.conversation_id);
  assert.equal(conv.messages.filter((m: any) => m.direction === "inbound").length, 0, "nothing reached the peer");
  assert.equal(conv.status, "open", "a cancelled-only conversation is not left awaiting approval");
});

const REVOKED = "the sending Bot was revoked; this draft can no longer be approved";

/** Alice's home with two writers sending to Bob's coder; both pairs are friends. */
async function twoWriters(t: any) {
  const s = await startServer();
  t.after(s.stop);
  const p = s.platform;
  const a = p.onboardFlybot({ display_name: "Alice" });
  const b = p.onboardFlybot({ display_name: "Bob" });
  const A = { kind: "owner" as const, ownerId: a.owner_id };
  const B = { kind: "owner" as const, ownerId: b.owner_id };
  const writer = p.addHomeMember(A, a.home.bot_id, { name: "writer", display_name: "Writer" });
  const writer2 = p.addHomeMember(A, a.home.bot_id, { name: "writer2", display_name: "Writer Two" });
  const coder = p.addHomeMember(B, b.home.bot_id, { name: "coder", display_name: "Coder" });
  for (const w of [writer, writer2]) {
    const rel = p.requestRelationship(A, { from_bot_id: w.bot_id, target_bot_id: coder.bot_id, message: "hi" });
    p.consent(B, rel.relationship_id, { decision: "accept", grant_capabilities: [] });
  }
  return { s, p, A, B, home: a.home.bot_id as string, writer, writer2, coder };
}

test("a revoked sender's cancelled card names the sender that was revoked", async (t) => {
  const { p, A, home, writer, coder } = await twoWriters(t);
  const sent = p.sendAsMember(A, { from_bot_id: writer.bot_id, to: coder.handle, text: "hello" });
  const approval = sent.message.approval_id as string;
  p.removeHomeMember(A, home, writer.bot_id);
  const card = p.listApprovals(A, "cancelled").find((x: any) => x.approval_id === approval);
  assert.ok(card, "the cancelled card is still listed");
  assert.equal(card.decision, "member_revoked");
  assert.equal(card.sender.handle, writer.handle, "the card names the revoked sender");
});

test("a revoked sender's cancelled card records when it was decided", async (t) => {
  const { p, A, home, writer, coder } = await twoWriters(t);
  const sent = p.sendAsMember(A, { from_bot_id: writer.bot_id, to: coder.handle, text: "hello" });
  const approval = sent.message.approval_id as string;
  p.removeHomeMember(A, home, writer.bot_id);
  const card = p.listApprovals(A, "cancelled").find((x: any) => x.approval_id === approval);
  assert.ok(card, "the cancelled card is still listed");
  assert.ok(card.decided_at, "decided_at is set on the card");
});

test("a revoked sender's cancelled card keeps the destination and the draft text", async (t) => {
  const { p, A, home, writer, coder } = await twoWriters(t);
  const sent = p.sendAsMember(A, { from_bot_id: writer.bot_id, to: coder.handle, text: "hello" });
  const approval = sent.message.approval_id as string;
  p.removeHomeMember(A, home, writer.bot_id);
  const card = p.listApprovals(A, "cancelled").find((x: any) => x.approval_id === approval);
  assert.ok(card, "the cancelled card is still listed");
  assert.equal(card.message.to.handle, coder.handle, "the card keeps the intended destination");
  assert.equal(card.message.payload.text, "hello");
  assert.equal(card.message.status, "cancelled");
});

test("approving a revoked sender's cancelled card refuses with the exact reason", async (t) => {
  const { p, A, home, writer, coder } = await twoWriters(t);
  const sent = p.sendAsMember(A, { from_bot_id: writer.bot_id, to: coder.handle, text: "hello" });
  const approval = sent.message.approval_id as string;
  p.removeHomeMember(A, home, writer.bot_id);
  const err = await expectApiError(Promise.resolve().then(() => p.decideApproval(A, approval, { decision: "approved" })), 409, "invalid_state");
  assert.equal(err.message, REVOKED, "the refusal says why, not just 'approval is cancelled'");
});

test("another member's pending draft still approves and is delivered after the revoke", async (t) => {
  const { p, A, B, home, writer, writer2, coder } = await twoWriters(t);
  const one = p.sendAsMember(A, { from_bot_id: writer.bot_id, to: coder.handle, text: "one" });
  const two = p.sendAsMember(A, { from_bot_id: writer2.bot_id, to: coder.handle, text: "two" });
  p.removeHomeMember(A, home, writer.bot_id);

  await expectApiError(Promise.resolve().then(() => p.decideApproval(A, one.message.approval_id as string, { decision: "approved" })), 409, "invalid_state");
  const delivered = await p.decideApproval(A, two.message.approval_id as string, { decision: "approved" });
  assert.equal(delivered.status, "delivered", "the untouched member's draft is still approvable");
  const peer = p.getConversation(B, two.conversation_id);
  assert.deepEqual(peer.messages.filter((m: any) => m.direction === "inbound").map((m: any) => m.untrusted_content.text), ["two"], "it reached the peer");
});

test("a message delivered before the revoke stays delivered and the peer's conversation is unchanged", async (t) => {
  const { p, A, B, home, writer, coder } = await twoWriters(t);
  const first = p.sendAsMember(A, { from_bot_id: writer.bot_id, to: coder.handle, text: "already sent" });
  await p.decideApproval(A, first.message.approval_id as string, { decision: "approved" });
  const before = p.getConversation(B, first.conversation_id);
  const draft = p.sendAsMember(A, { from_bot_id: writer.bot_id, to: coder.handle, text: "never sent" });
  p.removeHomeMember(A, home, writer.bot_id);
  const after = p.getConversation(B, first.conversation_id);
  assert.deepEqual(after.messages, before.messages, "the cancelled draft added nothing to the peer's conversation");
  assert.equal((after.messages.find((m: any) => m.message_id === first.message.message_id) as any).status, "delivered");
  assert.ok(!after.messages.some((m: any) => m.message_id === draft.message.message_id));
});

test("a stale pending row whose sender is already revoked is cancelled on decision (last line of defence)", async (t) => {
  const { p, A, home, writer, coder } = await twoWriters(t);
  const sent = p.sendAsMember(A, { from_bot_id: writer.bot_id, to: coder.handle, text: "stale" });
  const approval = sent.message.approval_id as string;
  // Simulate an older build's revoke: the Bot is gone but the approval was left pending.
  p.db.prepare("UPDATE bots SET status = 'revoked' WHERE id = ?").run(writer.bot_id);
  assert.equal((p.db.prepare("SELECT status FROM approvals WHERE id = ?").get(approval) as any).status, "pending");

  const err = await expectApiError(Promise.resolve().then(() => p.decideApproval(A, approval, { decision: "approved" })), 409, "invalid_state");
  assert.equal(err.message, REVOKED);
  const row: any = p.db.prepare("SELECT status, decision, decided_at FROM approvals WHERE id = ?").get(approval);
  assert.deepEqual([row.status, row.decision], ["cancelled", "member_revoked"]);
  assert.ok(row.decided_at);
  assert.equal((p.db.prepare("SELECT status FROM messages WHERE id = ?").get(sent.message.message_id) as any).status, "cancelled");
});

test("the Recently cancelled list is ordered by when it was cancelled, newest first, capped at 20", () => {
  const { recentCancelled } = loadConsole(["recentCancelled"]);
  const rows = Array.from({ length: 25 }, (_, i) => ({
    approval_id: `a${i}`, created_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), decided_at: new Date(Date.UTC(2026, 5, 1, 0, i)).toISOString(),
  }));
  const out = recentCancelled(rows);
  assert.equal(out.length, 20, "at most 20 records");
  assert.deepEqual(out.map((r: any) => r.approval_id), Array.from({ length: 20 }, (_, i) => `a${24 - i}`), "the newest decision is first");
  // A draft written months ago and revoked now is the newest record: order by decided_at, not created_at.
  const oldDraft = { approval_id: "old-draft", created_at: "2026-01-01T00:00:00.000Z", decided_at: "2026-06-02T00:00:00.000Z" };
  const freshDraft = { approval_id: "fresh-draft", created_at: "2026-05-31T00:00:00.000Z", decided_at: "2026-05-31T00:00:00.000Z" };
  assert.deepEqual(recentCancelled([oldDraft, freshDraft]).map((r: any) => r.approval_id), ["old-draft", "fresh-draft"]);
});

test("the console renders a cancelled card read-only: draft text, destination and the reason", () => {
  const { cancelledCard } = loadConsole(["cancelledCard"]);
  const html = cancelledCard({
    approval_id: "apr_1", kind: "outbound_message", status: "cancelled", decision: "member_revoked",
    summary: "Writer wants to message Coder", created_at: new Date(Date.now() - 3600e3).toISOString(), decided_at: new Date().toISOString(),
    sender: { handle: "@writer.alice", display_name: "Writer" },
    message: { message_id: "msg_1", to: { handle: "@coder.bob", display_name: "Coder" }, payload: { text: "hello there" }, status: "cancelled" },
  });
  assert.match(html, /hello there/, "the draft text is shown");
  assert.match(html, /@coder\.bob/, "the destination is shown");
  assert.match(html, /sending Bot @writer\.alice was revoked — this draft can no longer be approved/);
  assert.doesNotMatch(html, /Awaiting your approval/, "a cancelled card is not presented as pending");
  assert.doesNotMatch(html, /data-dec|Approve<\/button>|Reject<\/button>/, "no decision buttons on a cancelled card");
});

// A cancelled card is read-only, so its sentence is the only thing telling the owner what happened: without it a
// draft that can no longer be approved looks like one that may still go out. `decision` is already on every card
// (`src/platform.ts` approvalCard -> `decision`), and every way the platform cancels a draft needs its own sentence;
// a reason this build does not know, or a card with none at all, still gets a safe one instead of a blank line.
test("every way a draft can be cancelled says why on the card, and an unknown reason still says something safe", () => {
  const { cancelledCard } = loadConsole(["cancelledCard"]);
  const card = (decision?: string) => cancelledCard({
    approval_id: "apr_1", kind: "outbound_message", status: "cancelled", ...(decision === undefined ? {} : { decision }),
    summary: "Writer wants to message Coder", created_at: new Date(Date.now() - 3600e3).toISOString(), decided_at: new Date().toISOString(),
    sender: { handle: "@writer.alice", display_name: "Writer" },
    message: { message_id: "msg_1", to: { handle: "@coder.bob", display_name: "Coder" }, payload: { text: "hello there" }, status: "cancelled" },
  });

  const reasons: [string, RegExp][] = [
    ["conversation_closed", /the chat was closed before anyone decided, so the draft was not sent/],
    ["emergency_stop", /the Bot was emergency-stopped, so this draft was cancelled and not sent/],
    ["blocked", /the friendship was blocked, so this draft was cancelled and not sent/],
    ["revoked", /the friendship was removed, so this draft was cancelled and not sent/],
    ["room_closed", /the room closed before anyone decided, so the draft was not sent/],
  ];
  for (const [decision, sentence] of reasons) {
    const html = card(decision);
    assert.match(html, sentence, `${decision} says why the draft can no longer be approved`);
    assert.doesNotMatch(html, /undefined|\[object Object\]/, `${decision} never leaks a raw value into the card`);
  }

  for (const decision of ["a_reason_from_a_newer_server", undefined]) {
    const html = card(decision);
    assert.match(html, /it was cancelled before it was sent, so nothing was delivered/,
      "an unknown or missing reason still says the draft was not sent, instead of leaving the card blank");
    assert.doesNotMatch(html, /undefined|\[object Object\]/, "the fallback never prints the raw decision");
  }
});
