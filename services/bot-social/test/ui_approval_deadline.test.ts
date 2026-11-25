import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConsole } from "./ui_helpers.js";

// A pending card carries `expires_at` (src/platform.ts `approvalCard`), and every other time-bound row in the
// console prints it ("until ..." on invites, rooms, friend requests). The pending approval card did not, so an
// owner could not see how long a draft had before it lapses and is never sent.

const card = (extra: Record<string, unknown> = {}) => ({
  approval_id: "apr_1",
  kind: "outbound_message",
  status: "pending",
  summary: "Say hi to B",
  reasons: [],
  risk_flags: [],
  created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
  expires_at: new Date(Date.now() + 42 * 60_000).toISOString(),
  message: { message_id: "msg_1", to: { display_name: "B", handle: "@b" }, payload: { text: "hi" }, status: "pending_approval" },
  ...extra,
});

test("a pending approval card shows the deadline it was given", () => {
  const { approvalCard } = loadConsole(["approvalCard"]);
  const html = approvalCard(card());
  assert.match(html, /Expires \d/, "the card names the deadline the API sent");
  assert.match(html, /not sent if it lapses/, "and says what a lapse means for a draft");
});

test("a card without a deadline renders no deadline line", () => {
  const { approvalCard } = loadConsole(["approvalCard"]);
  const html = approvalCard(card({ expires_at: null }));
  assert.doesNotMatch(html, /Expires /);
});
