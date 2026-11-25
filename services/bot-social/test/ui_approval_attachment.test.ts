import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConsole } from "./ui_helpers.js";

// A draft that carries a file is held for approval, and `GET /v1/approvals` returns the attachment list on the
// card (`src/platform.ts` approvalCard -> message.payload.attachments with size_label). The console rendered only
// `payload.text`, so the owner was asked to approve a file whose name and size never appeared on the page.

const card = () => ({
  approval_id: "apr_9",
  kind: "outbound_message",
  status: "pending",
  summary: "Send report.pdf to B",
  reasons: [],
  risk_flags: [{ category: "attachment", label: "attachment" }],
  created_at: new Date(Date.now() - 60_000).toISOString(),
  expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
  message: {
    message_id: "msg_9",
    to: { display_name: "B", handle: "@b" },
    payload: { text: "please review", attachments: [{ id: "att_1", name: "report.pdf", size_label: "1.0 KB" }] },
    status: "pending_approval",
  },
});

test("an approval card names the file it is asking the owner to send", () => {
  const { approvalCard } = loadConsole(["approvalCard"]);
  const html = approvalCard(card());
  assert.match(html, /report\.pdf/, "the file name is on the card");
  assert.match(html, /1\.0 KB/, "and its size");
  assert.match(html, /data-att="att_1"/, "with a control that opens it through the authenticated endpoint");
});

test("a card without attachments grows no attachment row", () => {
  const { approvalCard } = loadConsole(["approvalCard"]);
  const c = card();
  delete (c.message.payload as any).attachments;
  assert.doesNotMatch(approvalCard(c), /data-att=/);
});
