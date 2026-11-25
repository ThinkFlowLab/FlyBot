import assert from "node:assert/strict";
import { test } from "node:test";
import { approveAll, bulkAuth, expectApiError, friends, ownerWithBot, startServer } from "./helpers.js";

// `calendar.accept_invite` names its invite by `booking_id` and the caller's owner only: neither door compares the
// booking's other side with the peer of the conversation the card was drafted in. `calendar.book` refuses the
// mirror mismatch in so many words ("attendees must be exactly the peer bot"); accept does not, so a Bot that reads
// the wrong booking id answers someone else's invitation inside a chat with a third home -- and then the platform
// tells that third home the meeting is on (`event.invite_accepted`), whose conversation read shows the executed
// action with the other owners' meeting window.

async function threeHomes(t: any) {
  const s = await startServer({ ...bulkAuth });
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const C = await ownerWithBot(s.base, "carol");
  const rel = await B.owner.req("POST", "/v1/relationships", { from_bot_id: B.bot.id, target_handle: C.handle, message: "hi", requested_capabilities: ["chat.public"] });
  await C.owner.req("POST", `/v1/relationships/${rel.relationship_id}/consent`, { decision: "accept", grant_capabilities: [] });
  return { s, A, B, C };
}

/** A books a meeting with B; returns the invitation on B's calendar. */
async function booked(A: any, B: any) {
  const cid = (await A.bot.startConversation(B.bot.id, { type: "schedule_meeting", summary: "plan the offsite" })).conversation_id as string;
  const start = new Date(Date.now() + 2 * 86400e3).toISOString();
  const end = new Date(Date.now() + 2 * 86400e3 + 1800e3).toISOString();
  const d = await A.bot.draftAction(cid, "calendar.book", { title: "Offsite planning", start, end, attendees: [B.bot.id] });
  assert.equal(d.status, "pending_approval");
  await approveAll(A.owner);
  const inv = (await B.owner.req("GET", "/v1/calendar/entries")).entries.find((e: any) => e.status === "invited");
  assert.ok(inv, "B holds the invitation");
  return { cid, booking_id: inv.booking_id as string, start, end };
}

test("a: a booking cannot be accepted from a conversation with another home, and that home hears nothing", async (t) => {
  const { A, B, C } = await threeHomes(t);
  const b = await booked(A, B);
  const cidBC = (await B.bot.startConversation(C.bot.id, { type: "general_chat", summary: "unrelated chat" })).conversation_id as string;

  // The invitee drafts the answer in a chat with a third home. The invitation is not that chat's to answer.
  await expectApiError(B.bot.draftAction(cidBC, "calendar.accept_invite", { booking_id: b.booking_id }), 404, "invite_not_found");

  // Nothing moved: B still holds an unanswered invite, C's chat shows no action, and C's queue was never told.
  const entries = (await B.owner.req("GET", "/v1/calendar/entries")).entries;
  assert.equal(entries.find((e: any) => e.booking_id === b.booking_id).status, "invited", "the invite is still waiting");
  const seenByC = await C.owner.req("GET", `/v1/conversations/${cidBC}`);
  assert.equal(seenByC.actions.length, 0, "C's chat shows no action of B's");
  const events = await C.bot.events(0);
  assert.equal(events.events.filter((e: any) => e.event_type === "event.invite_accepted").length, 0, "C is not told a meeting is on");
});

test("b: the organizer's own chat still accepts, and only the organizer hears it", async (t) => {
  const { A, B, C } = await threeHomes(t);
  const b = await booked(A, B);
  const d = await B.bot.draftAction(b.cid, "calendar.accept_invite", { booking_id: b.booking_id });
  assert.equal(d.status, "pending_approval");
  await approveAll(B.owner);
  const entries = (await B.owner.req("GET", "/v1/calendar/entries")).entries;
  assert.equal(entries.find((e: any) => e.booking_id === b.booking_id).status, "confirmed");
  const aEvents = await A.bot.events(0);
  const accepted = aEvents.events.find((e: any) => e.event_type === "event.invite_accepted" && e.booking_id === b.booking_id);
  assert.ok(accepted, "the organizer is told the invite was accepted");
  assert.equal(accepted.by, B.bot.id);
  // C is a stranger to this booking and stays one.
  assert.equal((await C.bot.events(0)).events.filter((e: any) => e.event_type === "event.invite_accepted").length, 0);
});

test("c: an invitation whose chat closed can still be accepted from that same chat (#105)", async (t) => {
  const { A, B } = await threeHomes(t);
  const b = await booked(A, B);
  await B.bot.close(b.cid, "agreed", "we will answer later");
  const d = await B.bot.draftAction(b.cid, "calendar.accept_invite", { booking_id: b.booking_id });
  assert.equal(d.status, "pending_approval", "the invite outlives the chat");
  await approveAll(B.owner);
  const entries = (await B.owner.req("GET", "/v1/calendar/entries")).entries;
  assert.equal(entries.find((e: any) => e.booking_id === b.booking_id).status, "confirmed");
});

test("d: an owner edit cannot point the card at an invitation from another chat", async (t) => {
  const { s, A, B, C } = await threeHomes(t);
  const b = await booked(A, B);
  // A second invitation on B's calendar, from a home this card's chat does not reach. Written as a row, because the
  // draft door already refuses to create a card for it.
  const start = new Date(Date.now() + 3 * 86400e3).toISOString();
  const end = new Date(Date.now() + 3 * 86400e3 + 1800e3).toISOString();
  s.platform.db.prepare("INSERT INTO calendar_entries (id, owner_id, start, end, title, attendees, source, status, organizer_owner, booking_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run("cal_other_home", B.owner_id, start, end, "Other home's meeting", JSON.stringify([B.owner_id]), "botsocial", "invited", C.owner_id, "bkg_other_home", new Date().toISOString());

  const d = await B.bot.draftAction(b.cid, "calendar.accept_invite", { booking_id: b.booking_id });
  assert.equal(d.status, "pending_approval");
  await expectApiError(B.owner.req("POST", `/v1/approvals/${d.approval_id}/decision`, { decision: "approved_with_edits", edited_params: { booking_id: "bkg_other_home" } }), 404, "invite_not_found");

  // The refusal is not a settle: the card and its action are where they were, and both invitations still wait.
  const card = s.platform.db.prepare("SELECT status FROM approvals WHERE id = ?").get(d.approval_id) as any;
  assert.equal(card.status, "pending", "the card is still decidable");
  const row = s.platform.db.prepare("SELECT status FROM actions WHERE id = ?").get(d.action_id) as any;
  assert.equal(row.status, "pending_approval", "the action row is unchanged");
  const entries = (await B.owner.req("GET", "/v1/calendar/entries")).entries;
  assert.equal(entries.find((e: any) => e.booking_id === b.booking_id).status, "invited");
  assert.equal(entries.find((e: any) => e.booking_id === "bkg_other_home").status, "invited");
  assert.equal((await C.bot.events(0)).events.filter((e: any) => e.event_type === "event.invite_accepted").length, 0, "the other home is not told");
});

test("e: a card an older build drafted in the wrong chat fails at execution and tells nobody", async (t) => {
  const { s, A, B, C } = await threeHomes(t);
  const b = await booked(A, B);
  const cidBC = (await B.bot.startConversation(C.bot.id, { type: "general_chat", summary: "unrelated chat" })).conversation_id as string;
  // The rows the draft door used to write: an accept card in the B-C chat, pointing at the A-B invitation.
  const now = new Date().toISOString();
  s.platform.db.prepare("INSERT INTO actions (id, conversation_id, actor_bot, action_type, params, justification, envelope, status, approval_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run("act_legacy_peer", cidBC, B.bot.id, "calendar.accept_invite", JSON.stringify({ booking_id: b.booking_id }), null, "{}", "pending_approval", "apr_legacy_peer", now);
  s.platform.db.prepare("INSERT INTO approvals (id, owner_id, kind, subject_id, bot_id, conversation_id, summary, reasons, risk_flags, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run("apr_legacy_peer", B.owner_id, "action", "act_legacy_peer", B.bot.id, cidBC, "Accept the invite", "[]", "[]", now, new Date(Date.now() + 3600e3).toISOString());

  const r: any = await B.owner.req("POST", "/v1/approvals/apr_legacy_peer/decision", { decision: "approved" });
  assert.equal(r.status, "failed");
  assert.equal(r.reason, "invite_not_found");
  const entries = (await B.owner.req("GET", "/v1/calendar/entries")).entries;
  assert.equal(entries.find((e: any) => e.booking_id === b.booking_id).status, "invited", "the invitation was not answered");
  assert.equal((await C.bot.events(0)).events.filter((e: any) => e.event_type === "event.invite_accepted").length, 0, "the third home is not told");
  assert.equal((await A.bot.events(0)).events.filter((e: any) => e.event_type === "event.invite_accepted").length, 0, "the organizer is not told either");
});
