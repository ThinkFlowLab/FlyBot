/**
 * A friend request's `message` is outbound text another owner's Bot reads; it must take the outbound DLP scan
 * the message draft door runs, and only a `block` finding refuses — with the draft door's 422, verbatim.
 *
 * Before this, `POST /v1/relationships` stored the message raw, wrote its `relationship.requested` audit line
 * and event, and handed the target Bot the raw text as `untrusted_content.message`, while the same secret in
 * `POST /v1/conversations/:id/messages` answered 422 `dlp_blocked`. The refusal must come before any row, so
 * a blocked request leaves no relationship, no audit line and no event behind. Approve-class findings (an
 * email address, a phone number) never blocked a draft, so they stay as they are here too.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

const SECRET = "my key is sk-abcdefghijklmnopqrstuvwxyz0123456789";
const BLOCKED = "outbound DLP blocked this draft";
const CLEAN = "Hi, I run the parcel bot; shall we connect the two bots?";
const APPROVE_CLASS = "reach me at ops@example.com if you want to pair up";

const relationshipRows = (s: any) => (s.platform.db.prepare("SELECT COUNT(*) n FROM relationships").get() as any).n as number;
const auditRows = (s: any) => (s.platform.audit.db.prepare("SELECT COUNT(*) n FROM audit_events").get() as any).n as number;
const requestedEvents = async (bot: any) => ((await bot.events()).events as any[]).filter((e) => e.event_type === "relationship.requested");

/** The call's outcome without asserting which way it went, so a red run can print what the door did instead. */
async function outcome(call: Promise<any>): Promise<{ accepted?: any; error?: any }> {
  try { return { accepted: await call }; } catch (error) { return { error }; }
}

/** The draft door's refusal, field for field: status, code, message and the category list. */
function refusedLikeDraft(attempt: { accepted?: any; error?: any }) {
  assert.equal(attempt.accepted?.status, undefined, `a blocked request must be refused, not accepted (${attempt.accepted?.status ?? "no status"}); the message was stored and the target Bot was told`);
  const e = attempt.error;
  assert.equal(e.status, 422, `a blocked request must be a 422, not a ${e.status} (${e.message})`);
  assert.equal(e.code, "dlp_blocked");
  assert.equal(e.body?.error?.message, BLOCKED, "the refusal is the draft door's, verbatim");
  assert.deepEqual(e.body?.error?.categories, ["secret.api_key"]);
}

test("an owner's friend request whose message carries a secret is refused like a message draft", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "alice");
  const B = await ownerWithBot(s.base, "bob");
  const rowsBefore = relationshipRows(s);
  const auditBefore = auditRows(s);

  refusedLikeDraft(await outcome(A.owner.req("POST", "/v1/relationships", { from_bot_id: A.bot.id, target_handle: B.handle, message: SECRET, requested_capabilities: ["chat.public"] })));
  assert.equal(relationshipRows(s), rowsBefore, "no relationship row is written for a refused request");
  assert.equal(auditRows(s), auditBefore, "no audit line names a request that never existed");
  assert.deepEqual(await requestedEvents(B.bot), [], "the target Bot is not told about the refused request");
});

test("a Bot-signed request carrying the same secret is refused before its approval is opened", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "alice");
  const B = await ownerWithBot(s.base, "bob");
  const rowsBefore = relationshipRows(s);
  const auditBefore = auditRows(s);

  refusedLikeDraft(await outcome(A.bot.requestFriend(B.handle, SECRET)));
  assert.equal(relationshipRows(s), rowsBefore, "no relationship row is written for a refused request");
  assert.equal(auditRows(s), auditBefore, "no audit line is written for a refused request");
  const pending: any = await A.owner.req("GET", "/v1/approvals?status=pending");
  assert.equal(pending.approvals.length, 0, "no owner card is opened for a request that was refused");
  assert.deepEqual(await requestedEvents(B.bot), []);
});

test("a clean message still opens the pending request and reaches the target Bot", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "alice");
  const B = await ownerWithBot(s.base, "bob");

  const rel: any = await A.owner.req("POST", "/v1/relationships", { from_bot_id: A.bot.id, target_handle: B.handle, message: CLEAN, requested_capabilities: ["chat.public"] });
  assert.equal(rel.status, "pending_target", "the door is not closed for clean text");
  assert.equal(rel.awaiting, "target_owner_consent");
  const row = s.platform.db.prepare("SELECT message FROM relationships WHERE id = ?").get(rel.relationship_id) as any;
  assert.equal(row.message, CLEAN, "the clean message is stored as sent");
  const evs = await requestedEvents(B.bot);
  assert.equal(evs.length, 1, "the target Bot is told once");
  assert.equal(evs[0].untrusted_content.message, CLEAN, "and reads the message as sent");
});

test("an approve-class finding is not a block, so the request still opens", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "alice");
  const B = await ownerWithBot(s.base, "bob");

  const rel: any = await A.owner.req("POST", "/v1/relationships", { from_bot_id: A.bot.id, target_handle: B.handle, message: APPROVE_CLASS, requested_capabilities: ["chat.public"] });
  assert.equal(rel.status, "pending_target");
  const row = s.platform.db.prepare("SELECT message FROM relationships WHERE id = ?").get(rel.relationship_id) as any;
  assert.equal(row.message, APPROVE_CLASS, "an email address is kept as it was before");
  const evs = await requestedEvents(B.bot);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].untrusted_content.message, APPROVE_CLASS);
});
