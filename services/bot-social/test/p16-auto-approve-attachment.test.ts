/**
 * P16 fail-first — `auto_approve_chat` must not auto-deliver a message that carries attachments.
 *
 * Root cause (base 7a07e1b `src/platform.ts:2110`, fork 71e8abf `:2129`): the auto-delivery branch is
 * `if ((autoChat || byRoom) && flags.length === 0 && !injectionSuspected)`. `byRoom` already requires
 * `refs.length === 0`, `autoChat` does not, so a clean text with a file skips the owner's card even though
 * `holdReasonOf` itself ranks the attachment as a finding (`:40-45`) and the card it decides carries
 * `hold_reason: "attachment"`. README.md:113 promises the opposite: "Everything the platform found on its own
 * keeps the card and stays the owner's decision: a DLP flag …, an attachment, suspected injection".
 *
 * Fix shape (Lead-frozen): the gate reads the reason already computed for the card —
 *   `if ((autoChat || byRoom) && holdReason === "blanket_outbound")`
 * `holdReasonOf` ranks risk > attachment > policy > blanket_outbound, so "blanket" is exactly "nothing found
 * besides the owner's default hold". Re-listing the findings here lets the next finding it learns drift out.
 *
 *   (a) auto-approve on + clean text + attachment → still `pending_approval`, `policy.decision`
 *       "require_approval", `policy.hold_reason` "attachment", `risk_flags: []` (a file is not a risk flag),
 *       the approval row still `pending`, audit has `message.drafted` and no `message.delivered`,
 *       the file is not downloadable by the peer, and after the owner approves it the peer gets the exact bytes;
 *   (b) guard: auto-approve on + clean text, no file → delivered by itself (unchanged);
 *   (c) guard: auto-approve off + attachment → held with `attachment` (unchanged);
 *   (d) guard (room half of the same union): a clean room-context line still auto-delivers, reason
 *       `room.context` (unchanged — the new gate must not close the `byRoom` door).
 *
 * Expected on base 7a07e1b and fork 71e8abf: (a) fails, (b)(c)(d) pass → 4 tests / 3 pass / 1 fail.
 * PASS 4/4 after the fix. Drop-in as `test/p16-auto-approve-attachment.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { friends, startServer } from "./helpers.js";

const b64 = (s: string) => Buffer.from(s).toString("base64");

test("P16a: a clean attachment is not auto-delivered by auto_approve_chat", async () => {
  const S = await startServer();
  try {
    const p = await friends(S.base);
    const set: any = await p.A.owner.req("PUT", `/v1/relationships/${p.relId}/settings`, { auto_approve_chat: true });
    assert.equal(set.settings.auto_approve_chat, true);
    const cid = (await p.A.bot.startConversation(p.B.bot.id, { type: "schedule_meeting", summary: "sync" })).conversation_id;

    const up: any = await p.A.bot.req("POST", "/v1/attachments", { name: "plan.md", content_base64: b64("# Plan\nship it") });
    const sent: any = await p.A.bot.signed(`/v1/conversations/${cid}/messages`, "message.draft", { text: "see attached", attachments: [up.attachment] }, { conversation_id: cid });
    assert.equal(sent.status, "pending_approval", "a file is a finding: it keeps the card");
    assert.equal(sent.policy?.decision, "require_approval");
    assert.equal(sent.policy?.hold_reason, "attachment", "the hold names the file");
    assert.deepEqual(sent.policy?.risk_flags, [], "an attachment is not a risk flag: do not invent one");

    const pending: any = await p.A.owner.req("GET", "/v1/approvals?status=pending");
    const card = pending.approvals.find((a: any) => a.approval_id === sent.approval_id);
    assert.ok(card, "the card is pending for the owner");
    assert.equal(card.status, "pending");
    assert.equal(card.hold_reason, "attachment");

    // The decision was not taken: the audit trail stops at the draft.
    const audit: any = await p.A.owner.req("GET", `/v1/audit-events?subject=${sent.message_id}`);
    const actions = audit.events.map((e: any) => e.action);
    assert.ok(actions.includes("message.drafted"), "the draft is in the audit trail");
    assert.equal(actions.includes("message.delivered"), false, "nothing was delivered before the owner decided");

    // Nothing is delivered before the owner decides, so the recipient cannot read the file yet.
    await assert.rejects(() => p.B.bot.req("GET", `/v1/attachments/${up.attachment.id}?bot_id=${p.B.bot.id}`), { status: 404 });

    const decided: any = await p.A.owner.req("POST", `/v1/approvals/${sent.approval_id}/decision`, { decision: "approved" });
    assert.equal(decided.status, "delivered", "the approved line is delivered");
    const got: any = await p.B.bot.req("GET", `/v1/attachments/${up.attachment.id}?bot_id=${p.B.bot.id}`);
    assert.equal(Buffer.from(got.content_base64, "base64").toString(), "# Plan\nship it", "after approval the peer gets the signed bytes");
  } finally { await S.stop(); }
});

test("P16b: guard — clean text without a file is still auto-delivered", async () => {
  const S = await startServer();
  try {
    const p = await friends(S.base);
    await p.A.owner.req("PUT", `/v1/relationships/${p.relId}/settings`, { auto_approve_chat: true });
    const cid = (await p.A.bot.startConversation(p.B.bot.id, { type: "schedule_meeting", summary: "sync" })).conversation_id;
    const sent: any = await p.A.bot.signed(`/v1/conversations/${cid}/messages`, "message.draft", { text: "shall we meet at noon tomorrow?" }, { conversation_id: cid });
    assert.equal(sent.status, "delivered");
    assert.equal(sent.auto_approved, true);
  } finally { await S.stop(); }
});

test("P16c: guard — with auto-approve off the same attachment is held (unchanged)", async () => {
  const S = await startServer();
  try {
    const p = await friends(S.base);
    const cid = (await p.A.bot.startConversation(p.B.bot.id, { type: "schedule_meeting", summary: "sync" })).conversation_id;
    const up: any = await p.A.bot.req("POST", "/v1/attachments", { name: "spec.md", content_base64: b64("# Spec") });
    const held: any = await p.A.bot.signed(`/v1/conversations/${cid}/messages`, "message.draft", { text: "second file for the spec review", attachments: [up.attachment] }, { conversation_id: cid });
    assert.equal(held.status, "pending_approval");
    assert.equal(held.policy?.hold_reason ?? held.hold_reason, "attachment");
  } finally { await S.stop(); }
});

test("P16d: guard — a clean room-context line still auto-delivers as room.context", async () => {
  const S = await startServer();
  try {
    const p = await friends(S.base);
    // Both owners put their Bot in one face room; that join is the room reach (#45).
    const ja: any = await p.A.owner.req("POST", "/v1/face-rooms/join", { code: "616161", bots: [p.A.bot.id] });
    const jb: any = await p.B.owner.req("POST", "/v1/face-rooms/join", { code: "616161", bots: [p.B.bot.id] });
    assert.equal(jb.room_id, ja.room_id);
    S.platform.enableCustody({ kind: "owner", ownerId: p.A.owner_id }, p.A.bot.id, { private_key_pem: p.A.kp.privateKeyPem });

    // auto_approve_chat stays off: this line leaves on the room half of the union, not the setting.
    const sent: any = S.platform.sendAsMember({ kind: "owner", ownerId: p.A.owner_id }, { from_bot_id: p.A.bot.id, to: p.B.handle, text: "the room we share", room_id: ja.room_id });
    assert.equal(sent.message.status, "delivered");
    assert.equal(sent.message.auto_approved, true);
    assert.equal(sent.message.room_id, ja.room_id);
    assert.deepEqual(sent.message.policy.reasons, ["room.context", "dlp.clean"]);
    assert.equal(sent.message.policy.hold_reason, undefined, "no hold reason on a delivered line");
    const peer: any = await p.B.bot.events(0);
    assert.ok(peer.events.some((e: any) => e.event_type === "message.received"), "the line arrived at the other home");
  } finally { await S.stop(); }
});
