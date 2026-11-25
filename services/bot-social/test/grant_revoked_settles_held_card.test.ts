// A recipient who stops sharing a Bot must also stop the lines that Bot already sent. An outbound line waits on the
// sender's owner, and delivery re-checks the room door but not the share: approving a card whose grant was revoked
// after it was held used to deliver the message anyway (the peer's inbox, the turn count and `message.delivered` all
// moved). A settled card is not a nicer message to the owner, it is the difference between a line landing and not.
// So: the three places that end a share settle the cards it was holding, and a card an older build left pending
// behind a revoked grant is cancelled rather than delivered.
import assert from "node:assert/strict";
import { test } from "node:test";
import { friends, inDays, startServer } from "./helpers.js";

async function req(base: string, method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}

/** The live share a grantor's owner gave that Bot: what a revoke or a decline acts on. */
const grantFor = (s: any, grantorOwner: string, granteeBot: string, capability = "chat.public") =>
  s.platform.db.prepare("SELECT id FROM grants WHERE grantor_owner = ? AND grantee_bot = ? AND capability = ? AND IFNULL(room_id, '') = '' AND status = 'active' ORDER BY created_at DESC LIMIT 1").get(grantorOwner, granteeBot, capability) as any;

const cardIn = async (base: string, owner: any, status: string, id: string) =>
  (((await req(base, "GET", `/v1/approvals?status=${status}`, owner.token)).body.approvals as any[]) ?? []).find((a) => a.approval_id === id) ?? null;

const decidedEvents = async (bot: any, id: string) =>
  ((await bot.events()).events as any[]).filter((e) => e.event_type === "approval.decided" && e.approval_id === id);

const received = async (bot: any) => (await bot.events()).events.filter((e: any) => e.event_type === "message.received") as any[];

/** A line A's Bot holds for B: the card waits on A's owner, nothing is delivered yet. */
async function heldLine(A: any, B: any) {
  const c = await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "hi" });
  const d: any = await A.bot.draftMessage(c.conversation_id, { text: "the line that must not land" });
  assert.equal(d.status, "pending_approval");
  return { cid: c.conversation_id as string, approvalId: d.approval_id as string, messageId: d.message_id as string };
}

const approve = (base: string, owner: any, id: string) =>
  req(base, "POST", `/v1/approvals/${id}/decision`, owner.token, { decision: "approved" });

test("revoking chat.public settles the line already waiting on the sender's owner", async () => {
  const s = await startServer();
  try {
    const { A, B } = await friends(s.base);
    const held = await heldLine(A, B);
    const g = grantFor(s, B.owner_id, A.bot.id);
    assert.ok(g, "B's owner gave A's Bot chat.public when they became friends");
    assert.equal((await req(s.base, "DELETE", `/v1/grants/${g.id}`, B.owner.token)).status, 200);

    const settled: any = await cardIn(s.base, A.owner, "cancelled", held.approvalId);
    assert.ok(settled, "the held line is settled with the share it was waiting on");
    assert.equal(settled.decision, "grant_revoked");
    const told = await decidedEvents(A.bot, held.approvalId);
    assert.equal(told.length, 1, "the Bot that owned the card hears once");
    assert.equal(told[0].decision, "cancelled");
    assert.equal(told[0].reason, "grant_revoked");

    // and the queue it left cannot be walked back into a delivery
    const refused: any = await approve(s.base, A.owner, held.approvalId);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.error.code, "invalid_state");
    assert.equal((await received(B.bot)).length, 0, "nothing reaches the Bot whose owner stopped sharing");
  } finally { await s.stop(); }
});

test("a card an older build left pending behind a revoked grant is cancelled, never delivered", async () => {
  const s = await startServer();
  try {
    const { A, B } = await friends(s.base);
    const held = await heldLine(A, B);
    const g = grantFor(s, B.owner_id, A.bot.id);
    // The row an older build left behind: the share is gone, the card was never settled.
    s.platform.db.prepare("UPDATE grants SET status = 'revoked', revoked_at = ? WHERE id = ?").run(new Date().toISOString(), g.id);
    assert.ok(await cardIn(s.base, A.owner, "pending", held.approvalId), "the stale card is still pending");

    const refused: any = await approve(s.base, A.owner, held.approvalId);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.error.code, "invalid_state");
    assert.match(refused.body.error.message, /revoked/);
    const settled: any = await cardIn(s.base, A.owner, "cancelled", held.approvalId);
    assert.ok(settled, "the stale card is settled instead of delivered");
    assert.equal(settled.decision, "grant_revoked");
    assert.equal((s.platform.db.prepare("SELECT status FROM messages WHERE id = ?").get(held.messageId) as any).status, "cancelled", "the line itself is cancelled");
    assert.equal((await received(B.bot)).length, 0);
  } finally { await s.stop(); }
});

test("declining the share from the grantee's side settles the held line the same way", async () => {
  const s = await startServer();
  try {
    const { A, B } = await friends(s.base);
    const held = await heldLine(A, B);
    const g = grantFor(s, B.owner_id, A.bot.id);
    const declined: any = await req(s.base, "DELETE", `/v1/remote-bots/${g.id}?bot_id=${B.bot.id}`, A.owner.token);
    assert.equal(declined.status, 200, JSON.stringify(declined.body));
    assert.equal(declined.body.status, "declined");

    const settled: any = await cardIn(s.base, A.owner, "cancelled", held.approvalId);
    assert.ok(settled, "declining my own share ends the lines it was holding, like a revoke");
    assert.equal(settled.decision, "grant_revoked");
    const refused: any = await approve(s.base, A.owner, held.approvalId);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal((await received(B.bot)).length, 0);
  } finally { await s.stop(); }
});

test("revoking profile.read leaves the held chat line decidable", async () => {
  const s = await startServer();
  try {
    const { A, B } = await friends(s.base);
    const held = await heldLine(A, B);
    const g = grantFor(s, B.owner_id, A.bot.id, "profile.read");
    assert.ok(g, "the share carries profile.read as well");
    assert.equal((await req(s.base, "DELETE", `/v1/grants/${g.id}`, B.owner.token)).status, 200);

    assert.ok(await cardIn(s.base, A.owner, "pending", held.approvalId), "a share of the profile is not the share of the chat");
    const ok: any = await approve(s.base, A.owner, held.approvalId);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.status, "delivered");
    assert.equal((await received(B.bot)).length, 1);
  } finally { await s.stop(); }
});

test("the peer's accept-invite draft survives the chat share ending", async () => {
  const s = await startServer();
  try {
    const { A, B } = await friends(s.base);
    const cid = (await A.bot.startConversation(B.bot.id, { type: "schedule_meeting", summary: "sync", params: { duration_minutes: 30, window: { start: inDays(1, 0), end: inDays(8, 23) } } })).conversation_id as string;
    const book: any = await A.bot.draftAction(cid, "calendar.book", { title: "Sync", start: inDays(1, 10), end: inDays(1, 11), attendees: [B.bot.id] });
    const done: any = await req(s.base, "POST", `/v1/approvals/${book.approval_id}/decision`, A.owner.token, { decision: "approved" });
    assert.equal(done.body.status, "executed");
    const acc: any = await B.bot.draftAction(cid, "calendar.accept_invite", { booking_id: done.body.result.booking_id });
    assert.equal(acc.status, "pending_approval");

    // A's owner stops sharing their Bot with B's Bot: the answer to an invite is not a line this share was carrying.
    const g = grantFor(s, A.owner_id, B.bot.id);
    assert.ok(g);
    assert.equal((await req(s.base, "DELETE", `/v1/grants/${g.id}`, A.owner.token)).status, 200);

    assert.ok(await cardIn(s.base, B.owner, "pending", acc.approval_id), "the invite decision stays decidable");
    assert.equal(await cardIn(s.base, B.owner, "cancelled", acc.approval_id), null, "and was not settled behind the owner's back");
  } finally { await s.stop(); }
});

/** Two friends whose owners also put both Bots in one face room (the join is the owner's own click). */
async function roomWithBoth(base: string, A: any, B: any) {
  const a = await req(base, "POST", "/v1/face-rooms/join", A.owner.token, { code: "515151", bots: [A.bot.id] });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const b = await req(base, "POST", "/v1/face-rooms/join", B.owner.token, { code: "515151", bots: [B.bot.id] });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  return a.body.room_id as string;
}

test("a line held in a room conversation is the room's business, not the friendship share's", async () => {
  const s = await startServer();
  try {
    const { A, B } = await friends(s.base);
    const roomId = await roomWithBoth(s.base, A, B);
    s.platform.enableCustody({ kind: "owner", ownerId: A.owner_id }, A.bot.id, { private_key_pem: A.kp.privateKeyPem });
    await req(s.base, "PATCH", "/v1/me", A.owner.token, { sensitive_terms: ["swordfish"] });
    const sent: any = s.platform.sendAsMember({ kind: "owner", ownerId: A.owner_id }, { from_bot_id: A.bot.id, to: B.handle, text: "the swordfish code", room_id: roomId });
    assert.equal(sent.message.status, "pending_approval", "the finding holds the room line");
    const conv = s.platform.db.prepare("SELECT relationship_id FROM conversations WHERE id = ?").get(sent.conversation_id) as any;
    assert.equal((s.platform.db.prepare("SELECT status FROM relationships WHERE id = ?").get(conv.relationship_id) as any).status, "room", "the thread belongs to the room");

    const g = grantFor(s, B.owner_id, A.bot.id);
    assert.ok(g);
    assert.equal((await req(s.base, "DELETE", `/v1/grants/${g.id}`, B.owner.token)).status, 200);

    assert.ok(await cardIn(s.base, A.owner, "pending", sent.message.approval_id), "the room's own door decides this line, not the friendship");
  } finally { await s.stop(); }
});
