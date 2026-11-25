// The face-room draft door is the one door of this family that did not ask what type `text` is: it ran
// `String(body?.text ?? "")` and then only checked the length. An object, an array, a number and a boolean were
// therefore accepted, stringified, and announced to the room as `[object Object]` / `1,2` / `42` / `true`; `[]`
// became "" and answered the length sentence, so a type error was reported as a missing field. With
// `auto_approve_face_rooms` on, `{}` was delivered to every other member's room without anyone approving it.
//
// Every refusal here must leave the room untouched: no draft row, no approval card, no room event, no draft budget
// spent. A normal string still drafts, and the length gate still answers absent/null/empty.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

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

async function room(t: any, opts: { autoApprove?: boolean } = {}) {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "fea");
  const B = await ownerWithBot(s.base, "feb");
  if (opts.autoApprove) {
    const me = await req(s.base, "PATCH", "/v1/me", A.owner.token, { auto_approve_face_rooms: true });
    assert.equal(me.status, 200, JSON.stringify(me.body));
  }
  const a = await req(s.base, "POST", "/v1/face-rooms/join", A.owner.token, { code: "474747", bots: [A.bot.id] });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const b = await req(s.base, "POST", "/v1/face-rooms/join", B.owner.token, { code: "474747", bots: [B.bot.id] });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  const roomId = a.body.room_id as string;
  const draft = (body: unknown) => req(s.base, "POST", `/v1/face-rooms/${roomId}/messages`, A.owner.token, body);
  const eventCount = async () => ((await req(s.base, "GET", `/v1/face-rooms/${roomId}`, B.owner.token)).body.events ?? []).length;
  const count = (sql: string, ...args: unknown[]) => (s.platform.db.prepare(sql).get(...args) as any).c as number;
  const drafts = () => count("SELECT COUNT(*) c FROM face_room_drafts");
  const approvals = () => count("SELECT COUNT(*) c FROM approvals");
  const budgetRows = () => count("SELECT COUNT(*) c FROM face_room_drafts WHERE sender_bot = ?", A.bot.id);
  return { s, A, B, roomId, draft, eventCount, drafts, approvals, budgetRows };
}

test("a non-string text is refused before a draft row, a card, an event or budget is written", async (t) => {
  const h = await room(t);
  const cases: [string, unknown][] = [
    ["an object", {}],
    ["an object with a body field", { body: "hi" }],
    ["an array of numbers", [1, 2]],
    ["a number", 42],
    ["a boolean", true],
    ["an empty array", []],
  ];
  for (const [label, text] of cases) {
    const before = await h.eventCount();
    const r = await h.draft({ text, bot_id: h.A.bot.id });
    assert.equal(r.status, 400, `${label}: answered ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, "invalid_request", label);
    assert.equal(r.body.message, "text must be a string", `${label}: names the field's type, not its length`);
    assert.equal(h.drafts(), 0, `${label}: no draft row`);
    assert.equal(h.approvals(), 0, `${label}: no approval card`);
    assert.equal(await h.eventCount(), before, `${label}: no room event`);
    assert.equal(h.budgetRows(), 0, `${label}: no draft budget spent`);
  }
});

test("with auto_approve_face_rooms on, a non-string text is still refused and the room stays empty", async (t) => {
  const h = await room(t, { autoApprove: true });
  const before = await h.eventCount();
  const r = await h.draft({ text: {}, bot_id: h.A.bot.id });
  assert.equal(r.status, 400, `the auto-approved room refused ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body.code, "invalid_request");
  assert.equal(r.body.message, "text must be a string");
  assert.equal(h.drafts(), 0, "no draft row");
  assert.equal(h.approvals(), 0, "no card was created and auto-approved");
  assert.equal(await h.eventCount(), before, "the other member's room saw no line");
  assert.equal(h.budgetRows(), 0, "no draft budget spent");
});

test("a string drafts as itself; missing, null and empty keep the length sentence; a closed room keeps its 409", async (t) => {
  const h = await room(t);
  const ok = await h.draft({ text: "hello room", bot_id: h.A.bot.id });
  assert.equal(ok.status, 202, JSON.stringify(ok.body));
  const row = h.s.platform.db.prepare("SELECT payload FROM face_room_drafts WHERE id = ?").get(ok.body.message_id) as any;
  assert.deepEqual(JSON.parse(row.payload), { text: "hello room" });
  for (const [label, body] of [["absent", { bot_id: h.A.bot.id }], ["null", { text: null, bot_id: h.A.bot.id }], ["empty", { text: "", bot_id: h.A.bot.id }]] as [string, any][]) {
    const r = await h.draft(body);
    assert.equal(r.status, 400, `${label}: ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.message, "text (1-4000 chars) required", `${label}: the length gate still answers`);
  }
  // The type gate sits after the room_closed refusal: a closed room answers 409, never a 400 about the field.
  h.s.platform.db.prepare("UPDATE face_rooms SET status = 'closed', closed_at = ? WHERE id = ?").run(new Date().toISOString(), h.roomId);
  const closed = await h.draft({ text: {}, bot_id: h.A.bot.id });
  assert.equal(closed.status, 409, `${closed.status} ${JSON.stringify(closed.body)}`);
  assert.equal(closed.body.code, "room_closed");
});
