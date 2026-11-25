/**
 * On master 3091fa66.
 *
 * A join that never became a friendship must give its invite slot back, and the four ends this family already has do
 * both halves: a declined consent, a rejected approval, the expiry sweep and Remove/Block all call `releaseInviteUse`
 * and write `relationship.expired` (the invariant comment over `releaseInviteUse` says exactly this). The fifth end —
 * `cancelPendingFor`, which settles a waiting card when something larger takes the request away — flipped the
 * `relationship_request` row to `expired` and did neither. So a link whose join was cancelled read `used` for a
 * relationship that never existed: permanently for a 1-use link (`410 invite_unavailable`), and one spent use for a
 * wider one.
 *
 * Two owner doors reach it: `POST /v1/emergency-stop` freezes the Bot that asked, and `remove_home_member` (the path
 * FlyBot itself takes when a member is removed) revokes it. Both cancel the card the waiting join wrote, so both
 * burned the link silently.
 *
 * The fix is the row's own write plus what the other ends already do: `releaseInviteUse` and a `relationship.expired`
 * line, both under the row's still-pending check. That check is not decoration: `endRelationship` (Remove/Block)
 * writes its row to `revoked` *before* it cancels the cards hanging off it and then gives the use back itself, so a
 * second refund here would pay twice — a `max_uses = 2` link would hand one extra join to whoever came next. Reading
 * the UPDATE's `.changes` is what keeps that door's own refund the only one, and keeps an `expired` line off a row
 * that ended another way.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

const owner = (o: any) => ({ kind: "owner" as const, ownerId: o.owner_id });
const inviteState = async (base: string, code: string) => (await (await fetch(`${base}/v1/invites/${code}`)).json() as any).status;

const auditCount = (s: any, action: string) =>
  (s.platform.audit.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action = ?").get(action) as any).n as number;

async function auditOf(o: any, subject: string, action: string) {
  const r: any = await o.owner.req("GET", `/v1/audit-events?subject=${subject}`);
  return (r.events as any[]).filter((e) => e.action === action);
}

/** A Bot-signed join that waits on its own owner: one pending request, one card, one spent use. */
async function waitingJoin(s: any, A: any, B: any, maxUses = 1) {
  const p = s.platform as any;
  const inv = p.createInvite(owner(A), { bot_id: A.bot.id, auto_accept: false, max_uses: maxUses });
  const uses = () => (s.platform.db.prepare("SELECT uses FROM invites WHERE code = ?").get(inv.code) as any).uses;
  const join: any = await B.bot.signed(`/v1/invites/${inv.code}/join`, "invite.join", { code: inv.code });
  assert.equal(join.status, "pending_requester_owner", JSON.stringify(join));
  assert.ok(join.approval_id, "the join waits on its own owner's card");
  assert.equal(uses(), 1, "the join spent a use");
  return { inv, uses, join, relId: join.relationship_id as string, approvalId: join.approval_id as string };
}

test("the stop gives a waiting join's invite use back and names its end", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "cancel-a");
  const B = await ownerWithBot(s.base, "cancel-b");
  const f = await waitingJoin(s, A, B);

  // The kill switch on the Bot that asked: its card is cancelled, and the request it was holding goes with it.
  await B.owner.req("POST", "/v1/emergency-stop", { bot_id: B.bot.id });

  assert.equal(f.uses(), 0, "a cancelled request gives its invite slot back");
  assert.equal(await inviteState(s.base, f.inv.code), "active", "so a 1-use link reads active again instead of burnt");
  const rel = s.platform.db.prepare("SELECT status FROM relationships WHERE id = ?").get(f.relId) as any;
  assert.equal(rel.status, "expired", "the request is settled as expired");
  const card = s.platform.db.prepare("SELECT status, decision FROM approvals WHERE id = ?").get(f.approvalId) as any;
  assert.equal(card.status, "cancelled", "and its card is settled");
  assert.equal(card.decision, "emergency_stop", "with the door's own word");

  const lines = await auditOf(A, f.relId, "relationship.expired");
  assert.equal(lines.length, 1, "one line names the end, as the four other ends of this family write one");
  assert.equal(lines[0].actor, `owner:${B.owner_id}`, "the line credits the owner whose door settled it");
  assert.deepEqual(lines[0].owners, [B.owner_id, A.owner_id].sort(), "both homes the request belonged to");

  // The refund is a real slot: the same link still takes a join.
  const C = await ownerWithBot(s.base, "cancel-c");
  const again = (s.platform as any).joinInvite(owner(C), f.inv.code, { from_bot_id: C.bot.id });
  assert.equal(again.status, "pending_target", "the next owner can still use the link");
  assert.equal(f.uses(), 1);
});

test("removing a home member gives its waiting join's invite use back", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const p = s.platform as any;
  // The joiner is a member of a FlyBot home — the shape FlyBot itself has — and asks through the console-as-Bot door.
  const inviter = await ownerWithBot(s.base, "member-inviter");
  const home = p.onboardFlybot({ display_name: "Member Home" });
  const A = { kind: "owner" as const, ownerId: home.owner_id };
  const member = p.addHomeMember(A, home.bot.bot_id, { name: "joiner" });
  const inv = p.createInvite(owner(inviter), { bot_id: inviter.bot.id, auto_accept: false, max_uses: 1 });
  const uses = () => (s.platform.db.prepare("SELECT uses FROM invites WHERE code = ?").get(inv.code) as any).uses;
  const cb = p.custodialBot(A, member.bot_id);
  const join = p.joinInvite(cb.bp, inv.code, cb.sign("invite.join", { code: inv.code }));
  assert.equal(join.status, "pending_requester_owner", JSON.stringify(join));
  assert.equal(uses(), 1, "the join spent the only slot");
  assert.equal(await inviteState(s.base, inv.code), "used");

  p.removeHomeMember(A, home.bot.bot_id, member.bot_id);

  assert.equal(uses(), 0, "a removed member's waiting request gives the slot back");
  assert.equal(await inviteState(s.base, inv.code), "active", "so the link is not burnt by a revocation");
  const rel = s.platform.db.prepare("SELECT status FROM relationships WHERE id = ?").get(join.relationship_id) as any;
  assert.equal(rel.status, "expired");
  const card = s.platform.db.prepare("SELECT status, decision FROM approvals WHERE id = ?").get(join.approval_id) as any;
  assert.equal(card.status, "cancelled");
  assert.equal(card.decision, "member_revoked");

  const lines = await auditOf(inviter, join.relationship_id, "relationship.expired");
  assert.equal(lines.length, 1, "one line names the end");
  assert.equal(lines[0].actor, `owner:${home.owner_id}`, "the home owner's door settled it");
  assert.deepEqual(lines[0].owners, [home.owner_id, inviter.owner_id].sort());
});

test("a request another door already ended is refunded once, not twice", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const p = s.platform as any;
  const A = await ownerWithBot(s.base, "once-a");
  const B = await ownerWithBot(s.base, "once-b");
  const C = await ownerWithBot(s.base, "once-c");
  const f = await waitingJoin(s, A, B, 2);

  // The second use is a real friendship: it never comes back, and it makes a double refund visible as a free join.
  const cjoin = p.joinInvite(owner(C), f.inv.code, { from_bot_id: C.bot.id });
  assert.equal(cjoin.status, "pending_target");
  p.consent(owner(A), cjoin.relationship_id, { decision: "accept", grant_capabilities: [] });
  assert.equal(f.uses(), 2, "both uses are spent");

  // Remove writes the row to `revoked` before it cancels the cards off it, and gives this pending request's use back
  // itself. The cancellation therefore meets a row that is no longer pending: reading `.changes` is what makes its own
  // refund the only one.
  await B.owner.req("DELETE", `/v1/relationships/${f.relId}`);
  assert.equal(f.uses(), 1, "exactly one use comes back: the request's, not one more");
  assert.equal(auditCount(s, "relationship.expired"), 0, "and no expired line names a row Remove settled as revoked");

  // A refund too many would be a free join for whoever came next: the link has one use left, not two.
  const D = await ownerWithBot(s.base, "once-d");
  assert.equal(p.joinInvite(owner(D), f.inv.code, { from_bot_id: D.bot.id }).status, "pending_target");
  assert.equal(f.uses(), 2, "the last use is the one the refund restored");
  assert.equal(await inviteState(s.base, f.inv.code), "used");
});

test("a refund the store refuses takes the whole settlement back", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "refuse-a");
  const B = await ownerWithBot(s.base, "refuse-b");
  const f = await waitingJoin(s, A, B);

  // The refund is one write of the settlement: if the invite row refuses it, the card, the request and the stop
  // itself come back untaken. Nothing half-settles, so a retry after the store recovers still finds the request
  // waiting, and the use is neither spent twice nor lost.
  s.platform.db.exec("CREATE TEMP TRIGGER refuse_refund BEFORE UPDATE ON invites WHEN NEW.uses < OLD.uses BEGIN SELECT RAISE(ABORT, 'refused'); END;");
  await assert.rejects(() => B.owner.req("POST", "/v1/emergency-stop", { bot_id: B.bot.id }));

  assert.equal(f.uses(), 1, "a refused refund gives nothing back");
  const rel = s.platform.db.prepare("SELECT status FROM relationships WHERE id = ?").get(f.relId) as any;
  assert.equal(rel.status, "pending_requester_owner", "and the request still waits instead of ending without its slot");
  const card = s.platform.db.prepare("SELECT status FROM approvals WHERE id = ?").get(f.approvalId) as any;
  assert.equal(card.status, "pending", "the card was not settled either");
  const bot = s.platform.db.prepare("SELECT status FROM bots WHERE id = ?").get(B.bot.id) as any;
  assert.equal(bot.status, "active", "and the stop did not take half the Bot with it");
  assert.equal(auditCount(s, "relationship.expired"), 0);

  // The store recovers: the same stop settles it whole, once.
  s.platform.db.exec("DROP TRIGGER refuse_refund");
  await B.owner.req("POST", "/v1/emergency-stop", { bot_id: B.bot.id });
  assert.equal(f.uses(), 0);
  assert.equal((s.platform.db.prepare("SELECT status FROM relationships WHERE id = ?").get(f.relId) as any).status, "expired");
  assert.equal(auditCount(s, "relationship.expired"), 1);
});
