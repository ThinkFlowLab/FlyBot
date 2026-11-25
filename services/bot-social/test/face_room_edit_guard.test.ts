import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

// A face-room draft's payload is `{ text }`. An owner approving with edits replaces that text; it must not be
// folded into whatever the request carries. Spreading `edited_payload` accepted `{ text: 42 }` (a non-string
// reached `untrusted_content.text` and every member's event), a 5000-character text (past the 1-4000 window the
// draft door enforces), and a bare `"oops"` (a string spread into `{"0":"o","1":"o",…}` while the draft's own text
// was delivered as if nothing were edited). The chat-message door (`editedPayloadOf`) and the action-params door
// (#108) already validate and rebuild; this is the same rule at the face-room door, asserted on the response and
// on what the room's members are told, not on a helper.

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

async function room(t: any) {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "fea");
  const B = await ownerWithBot(s.base, "feb");
  const a = await req(s.base, "POST", "/v1/face-rooms/join", A.owner.token, { code: "474747", bots: [A.bot.id] });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const b = await req(s.base, "POST", "/v1/face-rooms/join", B.owner.token, { code: "474747", bots: [B.bot.id] });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  const roomId = a.body.room_id as string;
  const draft = async (text = "the held line") => {
    const d = await req(s.base, "POST", `/v1/face-rooms/${roomId}/messages`, A.owner.token, { text, bot_id: A.bot.id });
    assert.equal(d.status, 202, JSON.stringify(d.body));
    return d.body;
  };
  const decide = (approvalId: string, body: any) => req(s.base, "POST", `/v1/approvals/${approvalId}/decision`, A.owner.token, body);
  const messages = async () => (await req(s.base, "GET", `/v1/face-rooms/${roomId}`, B.owner.token)).body.events.filter((e: any) => e.type === "room.message");
  const row = (sql: string, ...args: unknown[]) => s.platform.db.prepare(sql).get(...args) as any;
  return { s, A, B, roomId, draft, decide, messages, row };
}

test("an edited face-room line is rebuilt from a validated text, never merged from the request", async (t) => {
  const h = await room(t);
  const cases: [string, unknown][] = [
    ["a number instead of a string", { text: 42 }],
    ["5000 characters", { text: "x".repeat(5000) }],
    ["a bare string", "oops"],
  ];
  for (const [label, edited] of cases) {
    const d = await h.draft("the held line");
    const r = await h.decide(d.approval_id, { decision: "approved_with_edits", edited_payload: edited });
    assert.equal(r.status, 400, `${label}: refused with 4xx, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, "invalid_request", label);
    assert.equal(h.row("SELECT status FROM face_room_drafts WHERE id = ?", d.message_id).status, "pending_approval", `${label}: the line is still held`);
    assert.equal(h.row("SELECT status FROM approvals WHERE id = ?", d.approval_id).status, "pending", `${label}: the card is still pending`);
    assert.equal((await h.messages()).length, 0, `${label}: no member was told of a line`);
  }
});

test("a valid edit replaces the draft text and reaches the room as exactly that text", async (t) => {
  const h = await room(t);
  const d = await h.draft("the held line");
  const r = await h.decide(d.approval_id, { decision: "approved_with_edits", edited_payload: { text: "the owner's own line" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, "delivered");
  const [ev] = await h.messages();
  assert.ok(ev, "the room was told");
  assert.equal(ev.untrusted_content.text, "the owner's own line", "exactly the edited text, not a merge of it");
  assert.equal(ev.edited_by_owner, true);
  // The window's upper edge is still accepted.
  const d2 = await h.draft();
  const r2 = await h.decide(d2.approval_id, { decision: "approved_with_edits", edited_payload: { text: "y".repeat(4000) } });
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  const all = await h.messages();
  assert.equal(all[all.length - 1].untrusted_content.text.length, 4000);
});
