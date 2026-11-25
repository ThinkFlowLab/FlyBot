import assert from "node:assert/strict";
import { test } from "node:test";
import { expectApiError, ownerWithBot, startServer } from "./helpers.js";

test("revoking a home member revokes its invite links and stops its webhook", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const p = s.platform;
  const a = p.onboardFlybot({ display_name: "Alice" });
  const A = { kind: "owner" as const, ownerId: a.owner_id };
  const writer = p.addHomeMember(A, a.home.bot_id, { name: "writer", display_name: "Writer" });
  const B = await ownerWithBot(s.base, "revoked-shares");
  const invite = p.createInvite(A, { bot_id: writer.bot_id }) as any;
  p.setWebhook(A, writer.bot_id, { url: "http://127.0.0.1:9/hook" });

  p.removeHomeMember(A, a.home.bot_id, writer.bot_id);

  assert.equal(p.inviteInfo(invite.code).status, "revoked");
  await expectApiError(Promise.resolve().then(() => p.joinInvite({ kind: "owner", ownerId: B.owner_id }, invite.code, { from_bot_id: B.bot.id })), 410, "invite_unavailable");
  assert.equal(p.getWebhook(A, writer.bot_id).configured, false);
});
