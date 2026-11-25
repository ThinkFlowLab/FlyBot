import assert from "node:assert/strict";
import { test } from "node:test";
import { expectApiError, friends, startServer } from "./helpers.js";

/** The kill switch takes a Bot offline for everyone: an active friend must not reach it either. */
test("a frozen Bot cannot be reached by a friend's new conversation", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  await A.owner.req("POST", "/v1/emergency-stop", { bot_id: A.bot.id });

  // B is still active and the friendship is still active: only A is frozen.
  await expectApiError(B.bot.startConversation(A.bot.id, { type: "general_chat", summary: "are you there?" }), 403, "bot_frozen");

  // The refusal is the freeze, not a permanent break: resuming A restores reach.
  const r = await A.owner.req("POST", `/v1/bots/${A.bot.id}/resume`);
  A.bot.cred.token = r.bot_token;
  const conv = await B.bot.startConversation(A.bot.id, { type: "general_chat", summary: "back?" });
  assert.equal(conv.status, "open");
});

/** A card that was already waiting when the recipient froze must not carry the text in afterwards. */
test("a pending draft cannot be approved into a Bot that froze after the draft", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const cid = (await B.bot.startConversation(A.bot.id, { type: "general_chat", summary: "before the freeze" })).conversation_id;
  const draft = await B.bot.draftMessage(cid, { text: "written before you froze" });
  assert.equal(draft.status, "pending_approval");

  await A.owner.req("POST", "/v1/emergency-stop", { bot_id: A.bot.id });

  // B's owner approving after the freeze is refused, not answered with a delivery.
  await expectApiError(
    B.owner.req("POST", `/v1/approvals/${draft.approval_id}/decision`, { decision: "approved" }),
    403,
    "bot_frozen",
  );

  // The card is held, not cancelled: its owner can still decide it once the Bot is back.
  const pending = await B.owner.req("GET", "/v1/approvals?status=pending");
  assert.ok(pending.approvals.some((a: any) => a.approval_id === draft.approval_id), "the card must stay pending");
  // Nothing arrived at the frozen Bot, and the sender's view does not claim delivery.
  const seenByA = await A.owner.req("GET", `/v1/conversations/${cid}`);
  assert.equal(seenByA.messages.filter((m: any) => m.direction === "inbound").length, 0);
  const seenByB = await B.bot.getConversation(cid);
  assert.equal(seenByB.messages.find((m: any) => m.message_id === draft.message_id).status, "pending_approval");

  // Control: the freeze does not rewrite a conversation that already exists into bot_frozen -- nothing new starts
  // toward the Bot, but this chat is paused_stop, so a fresh draft into it is still refused for the pause. This
  // holds on the base as well: it pins that the freeze refusal above did not spread to the existing chat.
  await expectApiError(B.bot.draftMessage(cid, { text: "still there?" }), 409, "conversation_paused");

  // After the owner resumes A the same card goes through: the freeze held it, it did not kill it.
  await A.owner.req("POST", `/v1/bots/${A.bot.id}/resume`);
  await B.owner.req("POST", `/v1/approvals/${draft.approval_id}/decision`, { decision: "approved" });
  const after = await A.owner.req("GET", `/v1/conversations/${cid}`);
  const inbound = after.messages.filter((m: any) => m.direction === "inbound");
  assert.equal(inbound.length, 1);
  assert.equal(inbound[0].untrusted_content.text, "written before you froze");

  // The pause the kill switch left on the chat outlives the resume: drafting into it is refused for the pause.
  await expectApiError(B.bot.draftMessage(cid, { text: "still paused?" }), 409, "conversation_paused");
});

/** The kill switch blocks reach, never the owner: resume, rotate, audit, revoke a grant and block stay usable. */
test("a freeze does not lock the owner out of their own Bot", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B, relId } = await friends(s.base);
  await A.owner.req("POST", "/v1/emergency-stop", { bot_id: A.bot.id });

  // The audit trail of the Bot stays readable.
  const audit = await A.owner.req("GET", "/v1/audit-events");
  assert.ok(audit.events.length > 0);

  // Rotating the token of their own frozen Bot.
  const rotated = await A.owner.req("POST", `/v1/bots/${A.bot.id}/token`);
  assert.ok(rotated.bot_token);

  // Revoking a grant this owner made to the friend.
  const { grants } = await A.owner.req("GET", `/v1/bots/${A.bot.id}/grants`);
  const grant = grants.find((g: any) => g.relationship_id === relId);
  assert.ok(grant, "the friendship grant is listed");
  const revoked = await A.owner.req("DELETE", `/v1/grants/${grant.grant_id}`);
  assert.equal(revoked.status, "revoked");

  // Blocking the peer.
  const blocked = await A.owner.req("POST", "/v1/blocks", { bot_id: B.bot.id });
  assert.equal(blocked.status, "blocked");

  // And resuming brings the Bot back.
  const resumed = await A.owner.req("POST", `/v1/bots/${A.bot.id}/resume`);
  assert.equal(resumed.status, "active");
});
