import { test } from "node:test";
import assert from "node:assert/strict";
import { LIMITS, limitFromEnv, DEFAULT_NEW_CONVERSATIONS_PER_PAIR_PER_DAY } from "../src/policy.js";

test("new conversations per relationship per day: 50 by default, overridable by env", () => {
  assert.equal(DEFAULT_NEW_CONVERSATIONS_PER_PAIR_PER_DAY, 50);
  if (process.env.BOTSOCIAL_NEW_CONVERSATIONS_PER_PAIR_PER_DAY === undefined) assert.equal(LIMITS.newConversationsPerPairPerDay, 50);
  assert.equal(limitFromEnv("120", 50), 120);
  for (const bad of [undefined, "", " ", "0", "-3", "2.5", "abc"]) assert.equal(limitFromEnv(bad, 50), 50);
});
