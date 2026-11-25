/**
 * A share that lapses on its own clock used to leave the card it was holding in the queue: `expireLapsedShares` flipped
 * the row and gave its seats back, but the line or action it had allowed stayed `pending_approval`. The owner opened a
 * card that could never be approved, and when they clicked it the record said `grant_revoked` and the sentence said the
 * share "was revoked" — the wrong word for a lapse, and the settlement arrived only at the click.
 *
 * These readings pin the other half of #567: the sweep that writes down a lapse also settles the cards that share was
 * holding, with the lapse's own reason (`grant_expired`), once — for the Bot that drafted the card and for the owner's
 * outlet alike. The revoke and decline doors keep their word (`grant_revoked`), a read settles nothing, and a line the
 * owner renewed before the sweep never lost the share, so its card stays decidable until the live row really ends.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { generateEd25519 } from "../src/crypto.js";
import { friends, inDays, startServer } from "./helpers.js";

const PAST = "2020-01-01T00:00:00.000Z";
const LAPSE = "grant_expired";

type Box = { t: number };
const at = (h: number, m = 0) => Date.UTC(2026, 10, 6, h, m);

async function req(base: string, method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}

/** The live chat share the grantor's owner gave that Bot: the row a lapse or a revoke acts on. */
const grantFor = (s: any, grantorOwner: string, granteeBot: string, capability = "chat.public") =>
  s.platform.db.prepare("SELECT id FROM grants WHERE grantor_owner = ? AND grantee_bot = ? AND capability = ? AND IFNULL(room_id, '') = '' AND status = 'active' ORDER BY created_at DESC LIMIT 1").get(grantorOwner, granteeBot, capability) as any;

const lapse = (s: any, grantId: string, when = PAST) =>
  s.platform.db.prepare("UPDATE grants SET expires_at = ? WHERE id = ?").run(when, grantId);

const approvalRow = (s: any, id: string) =>
  s.platform.db.prepare("SELECT status, decision, decided_at FROM approvals WHERE id = ?").get(id) as any;

const messageRow = (s: any, id: string) =>
  s.platform.db.prepare("SELECT status FROM messages WHERE id = ?").get(id) as any;

/** Every event stored for one Bot, in order, from the table itself: `listEvents` sweeps what these readings watch. */
const emitted = (s: any, botId: string) =>
  (s.platform.db.prepare("SELECT type, data FROM events WHERE bot_id = ? ORDER BY seq").all(botId) as any[])
    .map((e) => ({ type: e.type, data: JSON.parse(e.data) }));

const decided = (s: any, botId: string, approvalId: string) =>
  emitted(s, botId).filter((e) => e.type === "approval.decided" && e.data.approval_id === approvalId).map((e) => e.data);

/** The audit chain lives in its own database on the platform, not in the platform tables. */
const expiredAudits = (s: any, grantId: string) =>
  (s.platform.audit.db.prepare("SELECT * FROM audit_events WHERE action = 'grant.expired' AND subject = ?").all(grantId) as any[]);

/** The sweep every face-room door runs. */
const sweep = (owner: any) => owner.req("GET", "/v1/face-rooms");

/** A line A's Bot drafted for B's Bot: the card waits on A's owner, nothing is delivered yet. */
async function heldLine(A: any, B: any) {
  const c = await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "a line behind a lapsed share" });
  const d: any = await A.bot.draftMessage(c.conversation_id, { text: "the line the lapse must settle" });
  assert.equal(d.status, "pending_approval", JSON.stringify(d));
  return { cid: c.conversation_id as string, approvalId: d.approval_id as string, messageId: d.message_id as string };
}

/** A second Bot of the same owner, with no drafting duties: the owner's designated outlet. */
async function outletBot(owner: any, handle: string) {
  const kp = generateEd25519();
  const made = await owner.req("POST", "/v1/bots", { handle, public_key: { alg: "Ed25519", kid: "k1", value: kp.publicKey } });
  return { id: made.bot_id as string };
}

/** A pair, a held line, and the share that holds it, already lapsed on the clock but not yet swept. */
async function lapsedLine(t: any) {
  const s: any = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const held = await heldLine(A, B);
  const g = grantFor(s, B.owner_id, A.bot.id);
  assert.ok(g, "B's owner gave A's Bot chat.public when the pair became friends");
  lapse(s, g.id);
  const relId = (s.platform.db.prepare("SELECT relationship_id FROM grants WHERE id = ?").get(g.id) as any).relationship_id as string;
  return { s, A, B, held, grantId: g.id as string, relId };
}

test("a share that lapses settles the line it was holding, exactly once", async (t) => {
  const { s, A, B, held, grantId } = await lapsedLine(t);

  // Control: before any sweep the card still waits, so the settlement below is the sweep's doing.
  assert.equal(approvalRow(s, held.approvalId).status, "pending");

  await sweep(A.owner);

  const card = approvalRow(s, held.approvalId);
  assert.equal(card.status, "cancelled", `the sweep settles the card the lapsed share held, got ${JSON.stringify(card)}`);
  assert.equal(card.decision, LAPSE, "it is recorded as a lapse, not as a revoke");
  assert.ok(card.decided_at, "with the moment it settled");
  assert.equal(messageRow(s, held.messageId).status, "cancelled", "and the line itself is cancelled");

  const told = decided(s, A.bot.id, held.approvalId);
  assert.equal(told.length, 1, `the Bot that drafted the card hears once, got ${JSON.stringify(told)}`);
  assert.equal(told[0].decision, "cancelled");
  assert.equal(told[0].reason, LAPSE, "the Bot reads the same word the record carries");
  assert.equal(expiredAudits(s, grantId).length, 1, "the lapse is still announced once, beside the settlement");

  const pending = (await A.owner.req("GET", "/v1/approvals?status=pending")).approvals.filter((a: any) => a.approval_id === held.approvalId);
  assert.equal(pending.length, 0, "the owner's queue no longer offers a card that can never be approved");
  assert.equal(emitted(s, B.bot.id).filter((e) => e.type === "message.received").length, 0, "nothing reaches the peer");
});

test("the lapse is settled once however many doors sweep", async (t) => {
  const { s, A, B, held } = await lapsedLine(t);
  await sweep(A.owner);
  await sweep(A.owner);
  // A different door that sweeps before it answers, as `grant_revoked`'s own readings use.
  await B.owner.req("GET", `/v1/bots/${B.bot.id}/grants`);
  await sweep(A.owner);

  assert.equal(decided(s, A.bot.id, held.approvalId).length, 1, "a settled lapse is not settled again");
  assert.equal(approvalRow(s, held.approvalId).decision, LAPSE);
});

test("a read settles nothing: the card still waits and the sweep behind it settles once", async (t) => {
  const { s, A, B, held, relId } = await lapsedLine(t);
  // The lazy readers `findGrant` and `GET /v1/relationships` use: they flip the lapsed row in place and must stay
  // silent. (A face-room door would sweep; that is the next half of this reading.)
  assert.equal(s.platform.findGrant(B.owner_id, A.bot.id, "chat.public"), null, "the lapsed share no longer answers a reach check");
  s.platform.grantsFor(relId, { includeExpired: true });
  assert.equal(approvalRow(s, held.approvalId).status, "pending", "a read must not settle the card");
  assert.equal(decided(s, A.bot.id, held.approvalId).length, 0, "a read must not tell the Bot");

  await sweep(A.owner);
  assert.equal(decided(s, A.bot.id, held.approvalId).length, 1, "the sweep still settles the card the read left waiting");
  assert.equal(approvalRow(s, held.approvalId).decision, LAPSE);
});

test("the owner's click on a lapse-settled card reads lapsed, never revoked", async (t) => {
  const { s, A, held } = await lapsedLine(t);
  await sweep(A.owner);

  const refused = await req(s.base, "POST", `/v1/approvals/${held.approvalId}/decision`, A.owner.token, { decision: "approved" });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error.code, "invalid_state", "the code stays what the decision door always answers");
  assert.match(refused.body.error.message, /lapsed/i, `the sentence names the lapse, got ${JSON.stringify(refused.body.error.message)}`);
  assert.doesNotMatch(refused.body.error.message, /revoked/i, "a lapse is not a revoke, and the owner is not told it is");
  assert.equal(approvalRow(s, held.approvalId).decision, LAPSE, "the click does not rewrite the word the sweep recorded");
});

test("a revoked share still settles as grant_revoked", async (t) => {
  const s: any = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const held = await heldLine(A, B);
  const g = grantFor(s, B.owner_id, A.bot.id);
  assert.equal((await req(s.base, "DELETE", `/v1/grants/${g.id}`, B.owner.token)).status, 200);

  assert.equal(approvalRow(s, held.approvalId).decision, "grant_revoked", "the revoke door keeps its word");
  const told = decided(s, A.bot.id, held.approvalId);
  assert.equal(told.length, 1);
  assert.equal(told[0].reason, "grant_revoked");
  const refused = await req(s.base, "POST", `/v1/approvals/${held.approvalId}/decision`, A.owner.token, { decision: "approved" });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error.message, /revoked/);
});

test("a row renewed after its lapse settles nothing, and the live row's own lapse settles once", async (t) => {
  const { s, A, B, held, grantId } = await lapsedLine(t);

  // The renewal writes a live row and leaves the lapsed one as history: the line never lost the share, so the card
  // still waits on a share that is there.
  const renewed = await B.owner.req("POST", `/v1/relationships/${(await s.platform.db.prepare("SELECT relationship_id FROM grants WHERE id = ?").get(grantId) as any).relationship_id}/grants`, { capability: "chat.public", expires_in_days: 30 });
  const liveId = renewed.grant_id as string;
  assert.notEqual(liveId, grantId);

  await sweep(A.owner);
  assert.equal(approvalRow(s, held.approvalId).status, "pending", "a renewed line never lost the share, so its card stays decidable");
  assert.equal(decided(s, A.bot.id, held.approvalId).length, 0, "and the Bot is told nothing");

  // Now the live row ends on its own clock: that lapse is the line's, and it settles the card once.
  lapse(s, liveId, "2020-02-02T00:00:00.000Z");
  await sweep(A.owner);
  const told = decided(s, A.bot.id, held.approvalId);
  assert.equal(told.length, 1, `one settlement for the line, got ${JSON.stringify(told)}`);
  assert.equal(told[0].reason, LAPSE);
  assert.equal(approvalRow(s, held.approvalId).decision, LAPSE);
});

test("the peer's accept-invite card survives the chat share lapsing", async (t) => {
  const s: any = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const cid = (await A.bot.startConversation(B.bot.id, { type: "schedule_meeting", summary: "sync", params: { duration_minutes: 30, window: { start: inDays(1, 0), end: inDays(8, 23) } } })).conversation_id as string;
  const book: any = await A.bot.draftAction(cid, "calendar.book", { title: "Sync", start: inDays(1, 10), end: inDays(1, 11), attendees: [B.bot.id] });
  const done: any = await req(s.base, "POST", `/v1/approvals/${book.approval_id}/decision`, A.owner.token, { decision: "approved" });
  assert.equal(done.body.status, "executed", JSON.stringify(done.body));
  const acc: any = await B.bot.draftAction(cid, "calendar.accept_invite", { booking_id: done.body.result.booking_id });
  assert.equal(acc.status, "pending_approval");

  const g = grantFor(s, A.owner_id, B.bot.id);
  assert.ok(g);
  lapse(s, g.id);
  await sweep(A.owner);

  assert.equal(approvalRow(s, acc.approval_id).status, "pending", "the answer to an invite outlives the chat share");
  assert.equal(decided(s, B.bot.id, acc.approval_id).length, 0, "and nobody settles it behind the owner's back");
});
