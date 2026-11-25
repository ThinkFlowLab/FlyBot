/**
 * A lapsed request whose settlement is refused keeps its invite use forever.
 *
 * `settlePendingRelationships` walks the lapsed requests and, for each one, writes four things: the relationship row
 * to `expired` (a bare `UPDATE`, committed at once), each pending card through `expireApproval` (a transaction of its
 * own, and the one write here that can throw), the `relationship.expired` audit line, and the invite use
 * (`releaseInviteUse`). A refusal anywhere after the first write therefore leaves the relationship already terminal —
 * and the sweep only selects `pending_*` rows, so the last two writes never run: the invite's use is spent for good
 * and the audit line is never written. Unlike a torn card, this one cannot converge on a later read: the row it would
 * have to pick is no longer a candidate.
 *
 * The card an invite join writes is a `relationship_request`, which carries no `messages` row, so the refusal is
 * injected where that card's settlement actually writes: the `approval.decided` event for the requesting Bot, after
 * the card row itself has already been flipped inside the settlement transaction. The trigger names that one Bot, so
 * nothing else on the platform is affected.
 *
 * The fix is one transaction per request — the relationship row, its cards, the audit line and the invite use settle
 * together or not at all — not one transaction for the whole loop, so a refused row does not take the next one with
 * it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

const past = () => new Date(Date.now() - 3600e3).toISOString();

const count = (s: any, sql: string, ...args: unknown[]) => (s.platform.db.prepare(sql).get(...args) as any).n as number;
const auditCount = (s: any, action: string) =>
  (s.platform.audit.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action = ?").get(action) as any).n as number;
const inviteStatus = async (base: string, code: string) => (await (await fetch(`${base}/v1/invites/${code}`)).json() as any).status;

function snap(s: any) {
  return {
    approvals: count(s, "SELECT COUNT(*) n FROM approvals"),
    events: count(s, "SELECT COUNT(*) n FROM events"),
    webhook_deliveries: count(s, "SELECT COUNT(*) n FROM webhook_deliveries"),
    audit: (s.platform.audit.db.prepare("SELECT COUNT(*) n FROM audit_events").get() as any).n as number,
  };
}

const delta = (after: ReturnType<typeof snap>, before: ReturnType<typeof snap>) => ({
  approvals: after.approvals - before.approvals,
  events: after.events - before.events,
  webhook_deliveries: after.webhook_deliveries - before.webhook_deliveries,
  audit: after.audit - before.audit,
});

/** A Bot's invite join that waits on its own owner: one pending relationship, one card, one spent use. */
async function lapsedJoinRequest(s: any, botWebhook?: string) {
  const p = s.platform as any;
  const A = await ownerWithBot(s.base, "requse-a");
  const B = await ownerWithBot(s.base, "requse-b", botWebhook);
  const inv = p.createInvite({ kind: "owner" as const, ownerId: A.owner_id }, { bot_id: A.bot.id, auto_accept: false, max_uses: 1 });
  const join: any = await B.bot.signed(`/v1/invites/${inv.code}/join`, "invite.join", { code: inv.code });
  assert.equal(join.status, "pending_requester_owner", JSON.stringify(join));
  assert.ok(join.approval_id, "a Bot's join waits on its own owner's card");
  const uses = () => (s.platform.db.prepare("SELECT uses FROM invites WHERE code = ?").get(inv.code) as any).uses;
  assert.equal(uses(), 1, "the join spent the link's only use");
  assert.equal(await inviteStatus(s.base, inv.code), "used");
  return { A, B, inv, uses, relId: join.relationship_id as string, approvalId: join.approval_id as string, botId: B.bot.id as string };
}

function lapse(s: any, relId: string, approvalId: string) {
  s.platform.db.prepare("UPDATE relationships SET expires_at = ? WHERE id = ?").run(past(), relId);
  s.platform.db.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?").run(past(), approvalId);
}

test("a refused settlement leaves the lapsed request waiting and its invite use untouched", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const f = await lapsedJoinRequest(s);

  // The card's own row is written inside `expireApproval`'s transaction; the event that names the settlement is
  // refused, so that transaction rolls back. The relationship row was already written before it, with no transaction
  // around it.
  s.platform.db.exec(`CREATE TEMP TRIGGER refuse_settlement_event BEFORE INSERT ON events
    WHEN NEW.bot_id = '${f.botId}' AND NEW.type = 'approval.decided'
    BEGIN SELECT RAISE(ABORT, 'store refused the event write'); END`);
  lapse(s, f.relId, f.approvalId);
  const before = snap(s);

  await assert.rejects(
    f.A.owner.req("GET", "/v1/relationships"),
    (e: any) => e.status === 500 && e.code === "internal_error",
    "the refusal reaches the caller instead of being swallowed into a successful read",
  );

  const rel = s.platform.db.prepare("SELECT status FROM relationships WHERE id = ?").get(f.relId) as any;
  const card = s.platform.db.prepare("SELECT status, decided_at FROM approvals WHERE id = ?").get(f.approvalId) as any;
  assert.equal(rel.status, "pending_requester_owner", "the request is still waiting: a refused settlement wrote no half of it");
  assert.equal(card.status, "pending", "the card is where it waited");
  assert.equal(card.decided_at, null, "and carries no decision time it never reached");
  assert.equal(count(s, "SELECT COUNT(*) n FROM relationship_invites WHERE relationship_id = ?", f.relId), 1, "the link still holds this request");
  assert.equal(f.uses(), 1, "the invite's use is neither spent twice nor quietly refunded: it is exactly where the join left it");
  assert.equal(auditCount(s, "relationship.expired"), 0, "no audit line names a settlement that did not happen");
  assert.equal(auditCount(s, "approval.expired"), 0, "nor one for the card");
  assert.doesNotThrow(() => s.platform.audit.verify(), "the audit chain is intact");
  assert.deepEqual(delta(snap(s), before), { approvals: 0, events: 0, webhook_deliveries: 0, audit: 0 }, "no row, event, push or audit line outlives the rollback");
});

test("without the refusal the same read settles the request and returns the use", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const f = await lapsedJoinRequest(s);
  lapse(s, f.relId, f.approvalId);
  const before = snap(s);

  const listed: any = await f.A.owner.req("GET", "/v1/relationships");
  const row = (listed.relationships as any[]).find((r) => r.relationship_id === f.relId);
  assert.equal(row.status, "expired", "the lapsed request is settled by the read");

  const card = s.platform.db.prepare("SELECT status, decided_at FROM approvals WHERE id = ?").get(f.approvalId) as any;
  assert.equal(card.status, "expired", "together with the card it held");
  assert.ok(card.decided_at, "with a decision moment");
  assert.equal(auditCount(s, "relationship.expired"), 1, "one audit line names the expiry");
  assert.equal(f.uses(), 0, "the use comes back");
  assert.equal(await inviteStatus(s.base, f.inv.code), "active", "so the one-use link is live again");
  assert.deepEqual(delta(snap(s), before), { approvals: 0, events: 1, webhook_deliveries: 0, audit: 2 }, "one settlement: one event, and the two audit lines it writes");

  // The returned use is real: another home can join with the very same link.
  const C = await ownerWithBot(s.base, "requse-c");
  const again: any = await C.bot.signed(`/v1/invites/${f.inv.code}/join`, "invite.join", { code: f.inv.code });
  assert.equal(again.status, "pending_requester_owner", "the returned use lets the next join in");
  assert.equal(f.uses(), 1);
});

test("the refusal is not terminal: the next read settles the same request, use and all", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const f = await lapsedJoinRequest(s);
  s.platform.db.exec(`CREATE TEMP TRIGGER refuse_settlement_event BEFORE INSERT ON events
    WHEN NEW.bot_id = '${f.botId}' AND NEW.type = 'approval.decided'
    BEGIN SELECT RAISE(ABORT, 'store refused the event write'); END`);
  lapse(s, f.relId, f.approvalId);
  await assert.rejects(f.A.owner.req("GET", "/v1/relationships"), (e: any) => e.status === 500);

  // Drop the refusal: every later read runs the same sweep, and the request must still be there for it to find.
  s.platform.db.exec("DROP TRIGGER refuse_settlement_event");
  await f.A.owner.req("GET", "/v1/relationships");

  const rel = s.platform.db.prepare("SELECT status FROM relationships WHERE id = ?").get(f.relId) as any;
  assert.equal(rel.status, "expired", "the retry settles the request the refused run left waiting");
  assert.equal(auditCount(s, "relationship.expired"), 1, "and writes the audit line the refused run could not");
  assert.equal(f.uses(), 0, "and gives the invite its use back");
  assert.equal(await inviteStatus(s.base, f.inv.code), "active", "so the link is live again instead of spent forever");
});

test("a refused request does not take the other lapsed requests of the same sweep down with it", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const first = await lapsedJoinRequest(s);
  const second = await lapsedJoinRequest(s);
  s.platform.db.exec(`CREATE TEMP TRIGGER refuse_settlement_event BEFORE INSERT ON events
    WHEN NEW.bot_id = '${first.botId}' AND NEW.type = 'approval.decided'
    BEGIN SELECT RAISE(ABORT, 'store refused the event write'); END`);
  lapse(s, first.relId, first.approvalId);
  lapse(s, second.relId, second.approvalId);

  // The sweep walks the rows in id order; whichever row it reaches first, the refusal fails the read.
  await assert.rejects(first.A.owner.req("GET", "/v1/relationships"), (e: any) => e.status === 500);
  s.platform.db.exec("DROP TRIGGER refuse_settlement_event");
  await first.A.owner.req("GET", "/v1/relationships");

  const one = s.platform.db.prepare("SELECT status FROM relationships WHERE id = ?").get(first.relId) as any;
  const two = s.platform.db.prepare("SELECT status FROM relationships WHERE id = ?").get(second.relId) as any;
  assert.equal(one.status, "expired", "the row that was refused settles on the retry");
  assert.equal(two.status, "expired", "and so does the row behind it: the refusal rolled back one request, not the loop");
  assert.equal(first.uses(), 0, "both uses come back");
  assert.equal(second.uses(), 0);
  assert.equal(auditCount(s, "relationship.expired"), 2, "with one audit line each");
});

/** Every push the platform hands to its own sender, by the event type it names. */
const pushes = (calls: { body: string }[], type: string) => calls.filter((c) => c.body?.includes(`"${type}"`)).length;

test("a card settled inside a rolled-back request pushes nothing", async (t) => {
  const calls: { url: string; body: string }[] = [];
  const fetchImpl = (async (url: string, init: any) => {
    calls.push({ url, body: init.body });
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  const s = await startServer({ fetchImpl, webhooks: { debounceMs: 15, retryBaseMs: 5 } });
  t.after(s.stop);
  const f = await lapsedJoinRequest(s, "https://requse.test/hook");
  lapse(s, f.relId, f.approvalId);
  const usesBefore = f.uses();

  // The card settles first, in the transaction `expireApproval` opens for itself, and the request's own transaction
  // then meets a store that will not take the invite-use write. The push naming the card decision is queued by that
  // inner settlement, but the outer rollback takes the card, its event and the decision back with it: a push that
  // left here would page the Bot about a settlement that is in no table.
  s.platform.db.exec(`CREATE TEMP TRIGGER refuse_release_use BEFORE UPDATE ON invites
    WHEN NEW.uses < OLD.uses BEGIN SELECT RAISE(ABORT, 'store refused the invite use write'); END`);

  await assert.rejects(
    f.A.owner.req("GET", "/v1/relationships"),
    (e: any) => e.status === 500 && e.code === "internal_error",
    "the refusal reaches the caller",
  );
  await s.platform.flushWebhooks();

  assert.equal(pushes(calls, "approval.decided"), 0, "a push names a settlement the rollback took back");
  const rel = s.platform.db.prepare("SELECT status FROM relationships WHERE id = ?").get(f.relId) as any;
  const card = s.platform.db.prepare("SELECT status FROM approvals WHERE id = ?").get(f.approvalId) as any;
  assert.equal(rel.status, "pending_requester_owner", "the request is still waiting");
  assert.equal(card.status, "pending", "and so is the card the inner settlement wrote");
  assert.equal(f.uses(), usesBefore, "the invite use is where the join left it, neither spent nor refunded");
  assert.equal(auditCount(s, "relationship.expired"), 0, "no audit line names the expiry either");
  assert.doesNotThrow(() => s.platform.audit.verify(), "the audit chain is intact");
});
