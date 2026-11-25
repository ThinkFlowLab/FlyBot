import assert from "node:assert/strict";
import { test } from "node:test";
import { expectApiError, ownerWithBot, startServer } from "./helpers.js";

test("a revoked home member cannot be reached by a friend's Bot", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const p = s.platform;
  const a = p.onboardFlybot({ display_name: "Alice" });
  const A = { kind: "owner" as const, ownerId: a.owner_id };
  const writer = p.addHomeMember(A, a.home.bot_id, { name: "writer", display_name: "Writer" });
  const B = await ownerWithBot(s.base, "revoked-reach");
  const rel = p.requestRelationship(A, { from_bot_id: writer.bot_id, target_bot_id: B.bot.id });
  p.consent({ kind: "owner", ownerId: B.owner_id }, rel.relationship_id, { decision: "accept", grant_capabilities: [] });
  const live = await B.bot.startConversation(writer.bot_id, { type: "general_chat", summary: "before" });

  p.removeHomeMember(A, a.home.bot_id, writer.bot_id);

  await expectApiError(B.bot.startConversation(writer.bot_id, { type: "general_chat", summary: "after" }), 403, "bot_revoked");
  await expectApiError(B.bot.draftMessage(live.conversation_id, { text: "still there?" }), 403, "bot_revoked");
});
