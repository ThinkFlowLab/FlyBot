import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

// The kill switch cancels every pending card of the Bot it stops. For a Bot-created invite that card is the only
// thing standing between `pending_owner` and a link people can use, and `cancelPendingFor` knew only the draft,
// action and room-line subjects: the card read `cancelled`, the invite row stayed `pending_owner` (its own 72h
// clock the only way out), the owner's invite page kept offering it, the decision door answered 409, the join door
// answered 410 `pending_owner`, and the Bot that created it was never told. The expiry sweep had already settled
// both rows for the same approval kind (`invite_approval_expiry`); the stop path never did, so resuming the Bot
// only brought the same dead link back.
//
// The assertion is not the terminal row alone: at no step of the run may a `cancelled` card sit over a link that
// still reads `pending_owner`. Every door below reads that pair after the stop and again after a resume, and the
// one outcome the stop owes the creator — a single `approval.decided` — is counted, not just detected.

async function req(base: string, method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  const json = text ? JSON.parse(text) : {};
  return { status: r.status, body: json.error ? json.error : json };
}
const tok = (o: { owner: { token: string } }) => o.owner.token;
const stopBot = (s: { base: string }, o: any) => req(s.base, "POST", "/v1/emergency-stop", tok(o), { bot_id: o.bot.id });

/** The two rows that must never disagree: the decision card, and the link the joining side reads. */
function pair(s: any, inviteId: string, approvalId: string) {
  const a = s.platform.db.prepare("SELECT status, decision FROM approvals WHERE id = ?").get(approvalId) as any;
  const i = s.platform.db.prepare("SELECT status FROM invites WHERE id = ?").get(inviteId) as any;
  return { card: a?.status, decision: a?.decision, link: i?.status };
}
function noDeadLink(where: string, p: { card?: string; link?: string }) {
  assert.ok(!(p.card === "cancelled" && p.link === "pending_owner"),
    `${where}: a cancelled card sits over a pending_owner link (${JSON.stringify(p)})`);
}
const inviteInList = async (o: any, inviteId: string) =>
  ((await o.owner.req("GET", "/v1/invites")).invites as any[]).find((i: any) => i.invite_id === inviteId);
const preview = (s: { base: string }, code: string) => req(s.base, "GET", `/v1/invites/${code}`);
const share = async (s: { base: string }, holder: any, code: string) => {
  try { return { status: 201, code: null as string | null, body: await holder.bot.signed(`/v1/invites/${code}/join`, "invite.join", { code }) }; }
  catch (e: any) { return { status: e.status, code: e.code ?? null, body: e.body?.error ?? e.body ?? e }; }
};
async function hostInvite(A: any, caps: string[] = ["chat.public"]) {
  const inv: any = await A.bot.signed("/v1/invites", "invite.create", { offered_capabilities: caps });
  assert.equal(inv.status, "pending_owner", "a Bot-created invite waits for its owner's approval");
  assert.ok(inv.approval_id);
  return inv;
}
const invitationEvents = (s: any, botId: string) =>
  s.platform.db.prepare("SELECT * FROM events WHERE bot_id = ? AND type = 'approval.decided'").all(botId) as any[];

test("an emergency stop expires the invite its cancelled card was waiting on", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "stopinv");
  const inv = await hostInvite(A);

  const stopped = await stopBot(s, A);
  assert.equal(stopped.status, 200, JSON.stringify(stopped.body));

  const p = pair(s, inv.invite_id, inv.approval_id);
  assert.equal(p.card, "cancelled", "the stop still cancels the card");
  assert.equal(p.link, "expired", "the link is settled with the card instead of waiting out its own 72h clock");
});

test("the owner's invite list, and the public preview both while stopped and after a resume, read expired", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "stopview");
  const inv = await hostInvite(A);

  assert.equal((await preview(s, inv.code)).body.status, "pending_owner", "the link waits for its owner while the Bot is active");

  await stopBot(s, A);
  assert.equal((await inviteInList(A, inv.invite_id)).status, "expired", "owner invite list");
  const stopped = await preview(s, inv.code);
  assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
  assert.equal(stopped.body.status, "expired", "public invite preview while the Bot is stopped");

  const resumed = await req(s.base, "POST", `/v1/bots/${A.bot.id}/resume`, tok(A));
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  const afterResume = await preview(s, inv.code);
  assert.equal(afterResume.status, 200, "resuming the Bot reopens the link's own answer, not a bot_frozen refusal");
  assert.equal(afterResume.body.status, "expired", "public invite preview after the resume");
});

test("the Bot that created the invite hears the stop exactly once, as approval.decided", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "stophear");
  const inv = await hostInvite(A);
  await stopBot(s, A);

  const evs = invitationEvents(s, A.bot.id);
  assert.equal(evs.length, 1, "one approval.decided carries the cancelled invite card, not two");
  const data = JSON.parse(evs[0].data);
  assert.equal(data.kind, "invite");
  assert.equal(data.decision, "cancelled");
  assert.equal(data.reason, "emergency_stop");
  assert.equal(data.invite_id, inv.invite_id);
  assert.equal(data.approval_id, inv.approval_id);

  // Resume is not a second settlement: the same single event is what the Bot reads from its own queue, once.
  const resumed = await req(s.base, "POST", `/v1/bots/${A.bot.id}/resume`, tok(A));
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  const seen = await req(s.base, "GET", "/v1/events", resumed.body.bot_token);
  assert.equal(seen.status, 200, JSON.stringify(seen.body));
  const heard = (seen.body.events as any[]).filter((e) => e.event_type === "approval.decided");
  assert.equal(heard.length, 1, "exactly one card outcome on the queue");
  assert.equal(heard[0].invite_id, inv.invite_id);
  assert.equal(invitationEvents(s, A.bot.id).length, 1, "no duplicate after the resume either");
});

test("no door, including after a resume, ever pairs a cancelled card with a pending_owner link", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "stopwalk");
  const B = await ownerWithBot(s.base, "stopjoin");
  const inv = await hostInvite(A);

  // Before the stop the two live together: a pending card over a pending_owner link is the normal state.
  const before = pair(s, inv.invite_id, inv.approval_id);
  assert.equal(before.card, "pending");
  assert.equal(before.link, "pending_owner");

  await stopBot(s, A);

  // Door 1: the rows themselves.
  noDeadLink("after the stop (rows)", pair(s, inv.invite_id, inv.approval_id));

  // Door 2: the owner's invite list renders the link.
  const listed = await inviteInList(A, inv.invite_id);
  assert.equal(listed.status, "expired", "owner invite list after the stop");
  noDeadLink("owner invite list", { card: pair(s, inv.invite_id, inv.approval_id).card, link: listed.status });

  // Door 3: the public preview anyone holding the link reads while the Bot is stopped.
  const stoppedPreview = await preview(s, inv.code);
  assert.equal(stoppedPreview.status, 200, JSON.stringify(stoppedPreview.body));
  assert.equal(stoppedPreview.body.status, "expired", "public preview after the stop");
  noDeadLink("public invite preview (stopped)", { card: pair(s, inv.invite_id, inv.approval_id).card, link: stoppedPreview.body.status });

  // Door 4: the joining side.
  const joined = await share(s, B, inv.code);
  assert.equal(joined.status, 410, JSON.stringify(joined.body));
  assert.equal(joined.code, "invite_unavailable");
  assert.equal(joined.body.invite_status, "expired", "join after the stop");
  noDeadLink("after the join door", pair(s, inv.invite_id, inv.approval_id));

  // Door 5: resume, then the same two doors again — the stop is settled, not paused.
  const resumed = await req(s.base, "POST", `/v1/bots/${A.bot.id}/resume`, tok(A));
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  const resumedPreview = await preview(s, inv.code);
  assert.equal(resumedPreview.status, 200, JSON.stringify(resumedPreview.body));
  assert.equal(resumedPreview.body.status, "expired", "public preview after the resume");
  noDeadLink("public invite preview (resumed)", { card: pair(s, inv.invite_id, inv.approval_id).card, link: resumedPreview.body.status });

  // Door 6: the decision door after the resume. The card is settled, so it is a 409 invalid_state in so many words.
  const decided = await req(s.base, "POST", `/v1/approvals/${inv.approval_id}/decision`, tok(A), { decision: "approved" });
  assert.equal(decided.status, 409, JSON.stringify(decided.body));
  assert.equal(decided.body.code, "invalid_state");
  assert.equal(decided.body.message, "approval is cancelled");
  noDeadLink("after the decision door", pair(s, inv.invite_id, inv.approval_id));

  // Terminal rows, and the creator is told once for the whole walk.
  assert.equal(pair(s, inv.invite_id, inv.approval_id).link, "expired");
  assert.equal(invitationEvents(s, A.bot.id).length, 1);
});

test("the joining side is told the link expired, not that it is still waiting for an approval", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "stopdead");
  const B = await ownerWithBot(s.base, "stoplive");
  const inv = await hostInvite(A);
  await stopBot(s, A);

  const refused = await req(s.base, "POST", `/v1/invites/${inv.code}/join`, tok(B), { from_bot_id: B.bot.id });
  assert.equal(refused.status, 410, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "invite_unavailable");
  assert.equal(refused.body.invite_status, "expired", "the link is not a pending_owner dead end any more");
});

test("control: an invite approved before the stop and an owner's own invite are untouched, and revoke still wins", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "stopctl");

  // Every invite is created while the Bot is still active: after the stop the Bot's own doors are closed, which
  // is the point of the kill switch and not what this control is about.
  // (a) The owner approves the card first: the invite is active and a later stop must not sweep it to expired.
  const approved = await hostInvite(A);
  await A.owner.req("POST", `/v1/approvals/${approved.approval_id}/decision`, { decision: "approved" });
  assert.equal((await inviteInList(A, approved.invite_id)).status, "active");

  // (b) An invite the owner minted directly has no card at all and is not the Bot's outbound side.
  const own: any = await A.owner.req("POST", "/v1/invites", { bot_id: A.bot.id });
  assert.equal(own.status, "active");

  // (c) The revoke door keeps its own outcome for the same row shape, and names itself.
  const revoked = await hostInvite(A);
  await A.owner.req("DELETE", `/v1/invites/${revoked.code}`);
  const afterRevoke = pair(s, revoked.invite_id, revoked.approval_id);
  assert.equal(afterRevoke.link, "revoked");
  assert.equal(afterRevoke.card, "cancelled");
  assert.equal(afterRevoke.decision, "invite_revoked", "the revoke names itself, not the stop");

  await stopBot(s, A);

  const afterStop = pair(s, approved.invite_id, approved.approval_id);
  assert.equal(afterStop.card, "approved", "an approved card is not cancelled by a later stop");
  assert.equal(afterStop.link, "active", "an approved invite is not swept by a later stop");
  assert.equal((await inviteInList(A, own.invite_id)).status, "active", "owner-minted invite unchanged by the stop");
  assert.equal(pair(s, revoked.invite_id, revoked.approval_id).link, "revoked", "a revoked invite keeps its own outcome");
});
