import assert from "node:assert/strict";
import { test } from "node:test";
import { friends, inDays, startServer } from "./helpers.js";

// An action draft is a card the owner decides. `draftAction` writes the approval card and the `actions` row, and the
// card reader (`approvalCard`) dereferences the action row unconditionally. Nothing type-checks the free-form fields
// the Bot sends (`justification`, and the `params` values execution later reads, such as `title` or `booking_id`), so a
// value that SQLite cannot bind makes the write throw after the card exists: a 500, an approval row whose subject row
// was never written, and a pending list that 500s for every card the owner owns until the orphan leaves it. The same
// unchecked values arrive through the owner's edit door, which merges them into the params execution writes.

const meetingIntent = () => ({ type: "schedule_meeting", summary: "sync", params: { duration_minutes: 30, window: { start: inDays(1, 0), end: inDays(5, 23) } } });
const bookings = (s: any, cid: string) => (s.platform.db.prepare("SELECT COUNT(*) n FROM actions WHERE conversation_id = ?").get(cid) as any).n as number;
const cards = (s: any, ownerId: string) => (s.platform.db.prepare("SELECT COUNT(*) n FROM approvals WHERE owner_id = ?").get(ownerId) as any).n as number;

test("a draft whose justification is not a string is refused with 400 and writes no row", async (t) => {
  const s = await startServer(); t.after(s.stop);
  const { A, B } = await friends(s.base);
  const cid = (await A.bot.startConversation(B.bot.id, meetingIntent())).conversation_id as string;

  await assert.rejects(
    A.bot.draftAction(cid, "calendar.book", { title: "Sync", start: inDays(1, 10), end: inDays(1, 11), attendees: [B.bot.id] }, { why: "because" } as any),
    (e: any) => {
      assert.equal(e.status, 400, `a malformed justification must be a 400, not a ${e.status} (${e.message})`);
      assert.equal(e.code, "invalid_request");
      return true;
    },
  );
  assert.equal(bookings(s, cid), 0, "no action row was written");
  assert.equal(cards(s, A.owner_id), 0, "no approval card was written");
});

test("one malformed draft does not break the owner's approval list", async (t) => {
  const s = await startServer(); t.after(s.stop);
  const { A, B } = await friends(s.base);
  const cid = (await A.bot.startConversation(B.bot.id, meetingIntent())).conversation_id as string;
  // A real card, so the queue has something to lose.
  await A.bot.draftMessage(cid, { text: "shall we sync this week?" });
  const before: any = await A.owner.req("GET", "/v1/approvals");
  assert.equal(before.approvals.length, 1, "the owner's queue starts with the one real card");

  // A peer Bot's malformed draft. What it answers is the other test's business; this one is about the queue after it.
  await A.bot.draftAction(cid, "calendar.book", { title: "Sync", start: inDays(1, 10), end: inDays(1, 11), attendees: [B.bot.id] }, { why: "because" } as any).catch(() => {});

  const after: any = await A.owner.req("GET", "/v1/approvals");
  assert.equal(after.approvals.length, 1, "the queue still lists the real card");
  assert.equal(after.approvals[0].kind, "outbound_message");
});

test("a well-formed action draft still makes exactly one decidable card", async (t) => {
  const s = await startServer(); t.after(s.stop);
  const { A, B } = await friends(s.base);
  const cid = (await A.bot.startConversation(B.bot.id, meetingIntent())).conversation_id as string;

  const d: any = await A.bot.draftAction(cid, "calendar.book", { title: "Sync", start: inDays(1, 10), end: inDays(1, 11), attendees: [B.bot.id] }, "plan the week");
  assert.equal(d.status, "pending_approval");
  const q: any = await A.owner.req("GET", "/v1/approvals");
  assert.equal(q.approvals.length, 1);
  assert.equal(q.approvals[0].kind, "action");
  assert.equal(q.approvals[0].action.action_id, d.action_id);
  const r: any = await A.owner.req("POST", `/v1/approvals/${d.approval_id}/decision`, { decision: "approved" });
  assert.equal(r.status, "executed");
});

test("a card whose action row is missing is still listed, and the queue around it still reads", async (t) => {
  const s = await startServer(); t.after(s.stop);
  const { A, B } = await friends(s.base);
  const cid = (await A.bot.startConversation(B.bot.id, meetingIntent())).conversation_id as string;
  await A.bot.draftMessage(cid, { text: "shall we sync this week?" });
  // A row an older build can leave behind: a card whose subject action was never written.
  s.platform.db.prepare("INSERT INTO approvals (id, owner_id, kind, subject_id, bot_id, conversation_id, summary, reasons, risk_flags, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run("apr_orphan", A.owner_id, "action", "act_never_written", A.bot.id, cid, "Book a meeting", "[]", "[]", new Date().toISOString(), new Date(Date.now() + 3600e3).toISOString());

  const q: any = await A.owner.req("GET", "/v1/approvals");
  assert.equal(q.approvals.length, 2, "both cards are in the queue");
  const orphan = q.approvals.find((x: any) => x.approval_id === "apr_orphan");
  assert.ok(orphan, "the card without its action row is still listed");
  assert.equal(orphan.action, undefined, "a missing subject is left out, not dereferenced");
  const real = q.approvals.find((x: any) => x.kind === "outbound_message");
  assert.equal(real.message.status, "pending_approval", "the card next to it still reads");
  // The card is not settled by looking at it, and the owner can still decide it by id.
  const still: any = await A.owner.req("GET", "/v1/approvals");
  assert.equal(still.approvals.find((x: any) => x.approval_id === "apr_orphan").status, "pending", "reading the list settles nothing");
  const decided: any = await A.owner.req("POST", "/v1/approvals/apr_orphan/decision", { decision: "rejected" });
  assert.equal(decided.status, "rejected");
});

test("an owner edit that gives the booking a non-string title is refused with 400 and leaves the card pending", async (t) => {
  const s = await startServer(); t.after(s.stop);
  const { A, B } = await friends(s.base);
  const cid = (await A.bot.startConversation(B.bot.id, meetingIntent())).conversation_id as string;
  const d: any = await A.bot.draftAction(cid, "calendar.book", { title: "Sync", start: inDays(1, 10), end: inDays(1, 11), attendees: [B.bot.id] }, "plan the week");

  await assert.rejects(
    A.owner.req("POST", `/v1/approvals/${d.approval_id}/decision`, { decision: "approved_with_edits", edited_params: { title: { text: "Sync" } } }),
    (e: any) => {
      assert.equal(e.status, 400, `an impossible title must be a 400, not a ${e.status} (${e.message})`);
      assert.equal(e.code, "invalid_request");
      return true;
    },
  );
  const a = s.platform.db.prepare("SELECT status FROM approvals WHERE id = ?").get(d.approval_id) as any;
  assert.equal(a.status, "pending", "the card is still decidable");
  const x = s.platform.db.prepare("SELECT status FROM actions WHERE id = ?").get(d.action_id) as any;
  assert.equal(x.status, "pending_approval", "the action row is unchanged");
  const cal = s.platform.db.prepare("SELECT COUNT(*) n FROM calendar_entries WHERE owner_id = ? OR owner_id = ?").get(A.owner_id, B.owner_id) as any;
  assert.equal(cal.n, 0, "nothing was written to either calendar");
});

test("an accept draft whose booking_id is not a string is refused with 400 and writes no card", async (t) => {
  const s = await startServer(); t.after(s.stop);
  const { A, B } = await friends(s.base);
  const cid = (await A.bot.startConversation(B.bot.id, meetingIntent())).conversation_id as string;
  // A real invitation, so the refusal is about the value's type, not about a missing invite.
  const d: any = await A.bot.draftAction(cid, "calendar.book", { title: "Sync", start: inDays(1, 10), end: inDays(1, 11), attendees: [B.bot.id] }, "plan the week");
  const done: any = await A.owner.req("POST", `/v1/approvals/${d.approval_id}/decision`, { decision: "approved" });
  const bookingId = done.result.booking_id as string;

  await assert.rejects(
    B.bot.draftAction(cid, "calendar.accept_invite", { booking_id: { id: bookingId } } as any, "yes please"),
    (e: any) => {
      assert.equal(e.status, 400, `an impossible booking_id must be a 400, not a ${e.status} (${e.message})`);
      assert.equal(e.code, "invalid_request");
      return true;
    },
  );
  const inv = s.platform.db.prepare("SELECT status FROM calendar_entries WHERE booking_id = ? AND owner_id = ?").get(bookingId, B.owner_id) as any;
  assert.equal(inv.status, "invited", "the invitation is untouched");
  assert.equal(bookings(s, cid), 1, "only the booking's action row exists");
  assert.equal(cards(s, B.owner_id), 0, "no card was written for the malformed draft");

  // The same call with the value the door expects still drafts, so the gate refuses the type and nothing else.
  const ok: any = await B.bot.draftAction(cid, "calendar.accept_invite", { booking_id: bookingId }, "yes please");
  assert.equal(ok.status, "pending_approval");
});

test("an owner edit that gives the accept a non-string booking_id is refused with 400 and leaves the card pending", async (t) => {
  const s = await startServer(); t.after(s.stop);
  const { A, B } = await friends(s.base);
  const cid = (await A.bot.startConversation(B.bot.id, meetingIntent())).conversation_id as string;
  const d: any = await A.bot.draftAction(cid, "calendar.book", { title: "Sync", start: inDays(1, 10), end: inDays(1, 11), attendees: [B.bot.id] }, "plan the week");
  const done: any = await A.owner.req("POST", `/v1/approvals/${d.approval_id}/decision`, { decision: "approved" });
  const bookingId = done.result.booking_id as string;
  const accept: any = await B.bot.draftAction(cid, "calendar.accept_invite", { booking_id: bookingId }, "yes please");
  const calendarRows = () => (s.platform.db.prepare("SELECT COUNT(*) n FROM calendar_entries WHERE owner_id = ? OR owner_id = ?").get(A.owner_id, B.owner_id) as any).n as number;
  const before = calendarRows();

  // The owner approves the accept with an edit the card can hold but SQLite cannot bind into the invite lookup.
  await assert.rejects(
    B.owner.req("POST", `/v1/approvals/${accept.approval_id}/decision`, { decision: "approved_with_edits", edited_params: { booking_id: { id: bookingId } } }),
    (e: any) => {
      assert.equal(e.status, 400, `an impossible booking_id must be a 400, not a ${e.status} (${e.message})`);
      assert.equal(e.code, "invalid_request");
      return true;
    },
  );
  const a = s.platform.db.prepare("SELECT status FROM approvals WHERE id = ?").get(accept.approval_id) as any;
  assert.equal(a.status, "pending", "the card is still decidable");
  const x = s.platform.db.prepare("SELECT status FROM actions WHERE id = ?").get(accept.action_id) as any;
  assert.equal(x.status, "pending_approval", "the action row is unchanged");
  assert.equal(calendarRows(), before, "neither calendar was written");
  const inv = s.platform.db.prepare("SELECT status FROM calendar_entries WHERE booking_id = ? AND owner_id = ?").get(bookingId, B.owner_id) as any;
  assert.equal(inv.status, "invited", "the invitation is still open");
});
