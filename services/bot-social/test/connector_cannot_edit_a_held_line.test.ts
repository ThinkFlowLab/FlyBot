/**
 * A connector token may decide the owner's own default hold, but it may not edit the line on the way through.
 *
 * `README.md` says an owner edit on approval cannot change a message's attachment refs, and the edit exists so the
 * person who owns the line settles what the platform held for them: `decide_approval` takes `edited_payload`, the
 * delivery path re-scans it and refuses only `block`-level hits, and every finding the owner cares about (their own
 * `sensitive_terms`, an email, a phone number, money, a calendar detail, suspected injection) is filed as `approve`.
 * So a clean card — the platform found nothing, its hold is the blanket switch — can be edited by the connector that
 * drafts it into a line the owner's settings would have held for review, and delivered, with the recipient reading
 * `approved_by_owner: true` of a line no owner saw.
 *
 * The rule below is about the caller, not the text: recomputing the hold over the edited text only narrows the gap
 * (the edit simply lands on an `approve` finding). The controls are the half that must not get wider — a connector
 * deciding a card without an edit still delivers, an owner login still edits and decides, and `edited_params` on an
 * action card keeps the recomputation it has.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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

const connect = async (base: string, token: string) => {
  const c = new Client({ name: "t", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return c;
};
const textOf = (r: any) => JSON.parse(r.content[0].text);
/** Step one only, as the client sees it: `isError` lives on the result, not on its parsed body. */
const stepOne = async (c: any, args: any) => await c.callTool({ name: "decide_approval", arguments: args });
const eventCount = (s: any, type: string) => (s.platform.db.prepare("SELECT COUNT(*) n FROM events WHERE type = ?").get(type) as any).n;

/** The card the connector could not touch: still pending, undelivered, and nothing recorded as decided. */
function untouched(s: any, ownerId: string, approvalId: string, messageId: string) {
  const pending = s.platform.listApprovals({ kind: "owner", ownerId }, "pending").map((a: any) => a.approval_id);
  assert.ok(pending.includes(approvalId), `approval ${approvalId} is still pending`);
  const row = s.platform.db.prepare("SELECT status, delivered_payload, delivered_at FROM messages WHERE id = ?").get(messageId) as any;
  assert.equal(row.status, "pending_approval", "the line is not in the conversation");
  assert.equal(row.delivered_payload, null, "nothing was stored as delivered");
  assert.equal(row.delivered_at, null, "nothing was delivered");
  const decided = s.platform.auditEvents({ kind: "owner", ownerId }, { limit: 300 }).events
    .filter((e: any) => e.action === "approval.decided" && e.subject === approvalId);
  assert.equal(decided.length, 0, "no decision was recorded in the audit chain");
}

/** A clean draft from A's bot to B: the platform finds nothing, so the hold is the owner's own default switch. */
async function cleanCard(s: any) {
  const { A, B } = await friends(s.base);
  s.platform.enableCustody({ kind: "owner", ownerId: A.owner_id }, A.bot.id, { private_key_pem: A.kp.privateKeyPem });
  await A.owner.req("PATCH", "/v1/me", { sensitive_terms: ["swordfish"] });
  const owner = { kind: "owner" as const, ownerId: A.owner_id };
  const sent: any = s.platform.sendAsMember(owner, { from_bot_id: A.bot.id, to: B.handle, text: "planning sync" });
  assert.equal(sent.message.status, "pending_approval");
  assert.equal(sent.message.policy.hold_reason, "blanket_outbound", "a clean line is held by the blanket switch only");
  return { A, B, owner, sent, aprId: sent.message.approval_id as string };
}

test("a connector cannot edit a clean card into an owner term", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, sent, aprId } = await cleanCard(s);
  const c = await connect(s.base, s.platform.createConnectorToken({ kind: "owner", ownerId: A.owner_id }, { label: "test" }).token);
  const before = eventCount(s, "message.received");
  const step1 = await stepOne(c, { approval_id: aprId, decision: "approved_with_edits", edited_payload: { text: "the swordfish code is 42" } });
  await c.close();

  assert.equal((step1 as any).isError, true, "the connector's edit is refused at the first step");
  const refusal = textOf(step1 as any);
  assert.equal(refusal.code, "owner_must_decide");
  assert.equal(refusal.confirm_code, undefined, "no confirmation code is issued for a refused edit");
  untouched(s, A.owner_id, aprId, sent.message.message_id);
  assert.equal(eventCount(s, "message.received"), before, "the peer received nothing");
});

test("the refusal is about who edits, not what the edited text says", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, sent, aprId } = await cleanCard(s);
  const c = await connect(s.base, s.platform.createConnectorToken({ kind: "owner", ownerId: A.owner_id }, { label: "test" }).token);
  const step1 = await stepOne(c, { approval_id: aprId, decision: "approved_with_edits", edited_payload: { text: "planning session" } });
  await c.close();

  assert.equal((step1 as any).isError, true, "a clean rewrite is refused the same way");
  assert.equal(textOf(step1 as any).code, "owner_must_decide");
  untouched(s, A.owner_id, aprId, sent.message.message_id);
});

test("a connector still decides the same clean card without an edit", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, sent, aprId } = await cleanCard(s);
  const c = await connect(s.base, s.platform.createConnectorToken({ kind: "owner", ownerId: A.owner_id }, { label: "test" }).token);
  const step1 = await stepOne(c, { approval_id: aprId, decision: "approved" });
  const step1Body = textOf(step1 as any);
  assert.equal(step1Body.status, "confirmation_required");
  const res = await c.callTool({ name: "decide_approval", arguments: { approval_id: aprId, decision: "approved", confirm_code: step1Body.confirm_code } });
  await c.close();

  assert.ok(!(res as any).isError, JSON.stringify((res as any).content));
  assert.equal(textOf(res).status, "delivered");
  const row = s.platform.db.prepare("SELECT status, delivered_payload FROM messages WHERE id = ?").get(sent.message.message_id) as any;
  assert.equal(row.status, "delivered", "the blanket hold is still the connector's to clear");
  assert.equal(JSON.parse(row.delivered_payload).text, "planning sync");
  assert.equal(eventCount(s, "message.received"), 1, "the peer received the clean line");
});

test("an owner login still edits the same card and decides it", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, sent, aprId } = await cleanCard(s);
  const decided = await req(s.base, "POST", `/v1/approvals/${aprId}/decision`, A.owner.token, { decision: "approved_with_edits", edited_payload: { text: "the swordfish code is 42" } });

  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  assert.equal(decided.body.status, "delivered");
  const row = s.platform.db.prepare("SELECT status, delivered_payload FROM messages WHERE id = ?").get(sent.message.message_id) as any;
  assert.equal(row.status, "delivered");
  assert.equal(JSON.parse(row.delivered_payload).text, "the swordfish code is 42", "the owner's edit is what went out");
  assert.equal(eventCount(s, "message.received"), 1, "the peer received the edited line");
});

test("a connector cannot edit a held face-room line either", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  s.platform.enableCustody({ kind: "owner", ownerId: A.owner_id }, A.bot.id, { private_key_pem: A.kp.privateKeyPem });
  s.platform.enableCustody({ kind: "owner", ownerId: B.owner_id }, B.bot.id, { private_key_pem: B.kp.privateKeyPem });
  const code = "626264";
  const host = await req(s.base, "POST", "/v1/face-rooms/join", A.owner.token, { code, bots: [A.bot.id] });
  assert.equal(host.status, 200, JSON.stringify(host.body));
  const roomId = host.body.room_id as string;
  const joined = await req(s.base, "POST", "/v1/face-rooms/join", B.owner.token, { code, bots: [B.bot.id] });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  const owner = { kind: "owner" as const, ownerId: A.owner_id };
  const drafted: any = s.platform.draftFaceRoomMessage(owner, roomId, { text: "hello room" });
  assert.equal(drafted.status, "pending_approval");
  const events = () => (s.platform.db.prepare("SELECT COUNT(*) n FROM face_room_events WHERE room_id = ? AND type = 'room.message'").get(roomId) as any).n;

  const c = await connect(s.base, s.platform.createConnectorToken(owner, { label: "test" }).token);
  const step1 = await stepOne(c, { approval_id: drafted.approval_id, decision: "approved_with_edits", edited_payload: { text: "the swordfish room" } });
  await c.close();

  assert.equal((step1 as any).isError, true, "the same door refuses the same edit on a face-room line");
  assert.equal(textOf(step1 as any).code, "owner_must_decide");
  const row = s.platform.db.prepare("SELECT status FROM face_room_drafts WHERE id = ?").get(drafted.message_id) as any;
  assert.equal(row.status, "pending_approval", "the line is not in the room");
  assert.equal(events(), 0, "nothing was delivered into the room");
});

test("edited_params on an action card is not what this refuses", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  s.platform.enableCustody({ kind: "owner", ownerId: A.owner_id }, A.bot.id, { private_key_pem: A.kp.privateKeyPem });
  const intent = { type: "schedule_meeting", summary: "sync", params: { duration_minutes: 30, window: { start: inDays(1, 0), end: inDays(8, 23) } } };
  const cid = (await A.bot.startConversation(B.bot.id, intent)).conversation_id as string;
  const drafted: any = await A.bot.draftAction(cid, "calendar.book",
    { title: "planning sync", start: inDays(3, 15), end: inDays(3, 15.5), attendees: [B.bot.id] });
  assert.equal(drafted.status, "pending_approval", JSON.stringify(drafted));
  const owner = { kind: "owner" as const, ownerId: A.owner_id };
  const c = await connect(s.base, s.platform.createConnectorToken(owner, { label: "test" }).token);
  const args = { approval_id: drafted.approval_id, decision: "approved", edited_params: { title: "planning session" } };
  const step1 = textOf(await c.callTool({ name: "decide_approval", arguments: args }));
  assert.equal(step1.status, "confirmation_required", "a clean params edit still reaches step one");
  const res = await c.callTool({ name: "decide_approval", arguments: { ...args, confirm_code: step1.confirm_code } });
  await c.close();

  assert.ok(!(res as any).isError, JSON.stringify((res as any).content));
  assert.equal(textOf(res).status, "executed", "the action side keeps its own rule");
  const booked = s.platform.db.prepare("SELECT status FROM actions WHERE id = ?").get(drafted.action_id) as any;
  assert.equal(booked.status, "executed");
});
