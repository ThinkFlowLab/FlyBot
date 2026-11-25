import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConsole } from "./ui_helpers.js";

// A held room message waits on the owner's approval, so the owner has to read the line before deciding. The
// server already ships it (`approvalCard` in src/platform.ts: `face_room = { room_id, message_id, payload,
// mentions, status }`), and the console renders a cancelled or expired room draft in full. Only the pending card
// dropped it: `approvalCard` in public/ui.js had branches for message / action / relationship / grant_request /
// invite and none for `face_room`, so the owner saw the truncated `summary` ("To face room: …" first 80 chars)
// and the raw kind `face_room_message` where every other kind has a human label.
// These tests render the card the way the console builds it, and assert what the owner actually reads.

const ROOM = "session-8c1f4a2b-7d3e-4b6a-9f10-2c5d8e7a1b3c";
const BODY = "notes from @alice on the migration: the owner must read the closing paragraph before approving this line.";
const MENTIONS = ["@alice.home", "@bob.home"];

const card = (extra: Record<string, unknown> = {}) => ({
  approval_id: "apr_room_1",
  kind: "face_room_message",
  status: "pending",
  summary: `To face room: ${BODY.slice(0, 80)}`,
  reasons: ["mvp.all_outbound_requires_approval"],
  risk_flags: [],
  bot_id: "bot_a",
  conversation_id: null,
  created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
  expires_at: new Date(Date.now() + 42 * 60_000).toISOString(),
  face_room: { room_id: ROOM, message_id: "fmd_1", payload: { text: BODY }, status: "pending_approval" },
  ...extra,
});

test("a held room message shows its whole text on the pending card, not just the summary's first 80 chars", () => {
  const { approvalCard } = loadConsole(["approvalCard"]);
  const html = approvalCard(card());
  assert.ok(html.includes(BODY), "the owner reads the line they are approving, in full");
  assert.ok(BODY.length > 80, "the fixture is longer than the summary the server truncates");
  assert.ok(html.includes(`In room ${ROOM}`), "and where it would be said");
});

test("the kind is named in words, mentions are listed, and a room line offers no edit", () => {
  const { approvalCard } = loadConsole(["approvalCard"]);
  const html = approvalCard(card({ face_room: { ...card().face_room, mentions: MENTIONS } }));
  assert.doesNotMatch(html, /face_room_message/, "no raw kind reaches the owner");
  assert.match(html, /Room message/, "the kind has a human label");
  for (const h of MENTIONS) assert.ok(html.includes(h), `the addressed Bot ${h} is named`);
  assert.doesNotMatch(html, /Approve with edits/, "a room line is read-only here: the edit path rebuilds {text} and drops mentions");
  assert.match(html, /data-dec="approved"/, "the plain decision is still offered");
  assert.match(html, /data-dec="rejected"/);
});
