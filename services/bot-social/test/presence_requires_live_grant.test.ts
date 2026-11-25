// A "thinking" entry is told only to a Bot the writer could still send to. The README promises it for reading
// ("a revoked grant ... drops the entry at once") and `setPresence` promises the same for writing ("allowed only
// where the Bot could already send"). A friendship outlives a revoked or declined per-Bot share, so the gate has
// to be the share itself, not the friendship.
import assert from "node:assert/strict";
import { test } from "node:test";
import { generateEd25519 } from "../src/crypto.js";
import { expectApiError, friends, startServer } from "./helpers.js";

const targets = (presence: any[]) => presence.map((e: any) => e.to).sort();

test("revoking the share drops its thinking entry and leaves the other share's entry alone", async () => {
  const S = await startServer();
  try {
    const { A, B } = await friends(S.base);
    // A second Bot of A's, shared to the same friend Bot: what the revoked share must not take with it.
    const kp = generateEd25519();
    const second = await A.owner.req("POST", "/v1/bots", {
      handle: "alice-second.bot",
      public_key: { alg: "Ed25519", kid: "k1", value: kp.publicKey },
    });
    await A.owner.req("POST", `/v1/bots/${second.bot_id}/grants`, { friend_owner_id: B.owner_id, friend_bot_id: B.bot.id });

    await B.bot.req("PUT", "/v1/presence", { to: A.bot.id, state: "thinking" });
    await B.bot.req("PUT", "/v1/presence", { to: second.bot_id, state: "thinking" });
    const live = await A.owner.req("GET", "/v1/presence");
    assert.deepEqual(targets(live.presence), ["@alice-second.bot", A.handle], "both entries are visible while both shares are live");

    // A revokes the whole per-Bot bundle B's Bot holds on A's Bot.
    const listed = await A.owner.req("GET", `/v1/bots/${A.bot.id}/grants`);
    const share = listed.grants.find((g: any) => g.grantee.bot_id === B.bot.id);
    assert.ok(share, "the friend Bot holds a share on that Bot");
    await A.owner.req("DELETE", `/v1/bots/${A.bot.id}/grants/${share.grant_id}`);

    const after = await A.owner.req("GET", "/v1/presence");
    assert.deepEqual(targets(after.presence), ["@alice-second.bot"], "the revoked share's entry is gone and the live share's entry stays");

    // The share is really gone: no new line and no new signal may name it.
    await expectApiError(B.bot.startConversation(A.bot.id, { type: "general_chat", summary: "hi" }), 403, "capability_not_granted");
    await expectApiError(B.bot.req("PUT", "/v1/presence", { to: A.bot.id, state: "thinking" }), 403, "capability_not_granted");
  } finally {
    await S.stop();
  }
});

test("the same holds when the grantee declines the share", async () => {
  const S = await startServer();
  try {
    const { A, B } = await friends(S.base);
    await B.bot.req("PUT", "/v1/presence", { to: A.bot.id, state: "thinking" });
    const live = await A.owner.req("GET", "/v1/presence");
    assert.deepEqual(targets(live.presence), [A.handle], "the entry is visible while the share is live");

    // B's owner removes A's Bot from what is shared with B (the recipient side of the same bundle).
    const remote = await B.owner.req("GET", "/v1/remote-bots");
    const shared = remote.bots.find((b: any) => b.bot_id === A.bot.id);
    assert.ok(shared, "A's Bot is in B's remote list");
    await B.owner.req("DELETE", `/v1/remote-bots/${shared.grant_id}`);

    await expectApiError(B.bot.startConversation(A.bot.id, { type: "general_chat", summary: "hi" }), 403, "capability_not_granted");
    const after = await A.owner.req("GET", "/v1/presence");
    assert.deepEqual(after.presence, [], "a declined share drops the entry at once");
  } finally {
    await S.stop();
  }
});
