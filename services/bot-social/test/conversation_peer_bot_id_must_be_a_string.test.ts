// The signed `conversation.create` envelope names the peer in `peer_bot_id`. On master 3186eda5 `openConversation`
// hands that value straight into the Bot lookup: `[peer id]` is unrolled as the SQL parameter and opens a real
// conversation — conversation row, event row, audit entries — for a value that is not a string; `{}`, `[]`,
// `[peer id, "junk"]` and `true` make the binding throw and answer 500 `internal_error`; `42` and `1.5` answer 404
// with the number in the message. A peer id is a string: anything else is a 400 `invalid_request` naming the field,
// before the lookup and before the conversation, its event and the audit entries. `undefined` and `null` keep the
// existing "peer_bot_id required" message, while a present falsy non-string (`false`, `0`) is named as the type
// error it is. A string keeps every answer it has today: an existing peer opens, an unknown one answers 404, and
// the caller's own id answers 403 `no_relationship`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { friends, startServer } from "./helpers.js";

const intent = { type: "general_chat", summary: "chat" };

async function req(base: string, path: string, token: string, body: unknown) {
  const r = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}

/** Every write a conversation create can leave behind. */
function residue(p: any) {
  const one = (sql: string) => (p.get(sql) as any).n as number;
  return {
    conversations: one("SELECT COUNT(*) n FROM conversations"),
    events: one("SELECT COUNT(*) n FROM events"),
    approvals: one("SELECT COUNT(*) n FROM approvals"),
    audits: (p.audit.db.prepare("SELECT COUNT(*) n FROM audit_events").get() as any).n as number,
  };
}

/** Send one signed conversation.create for `peer` (or without the field when `given` is false). */
async function create(A: any, peer: unknown, given = true) {
  const payload: any = { type: "direct", intent };
  if (given) payload.peer_bot_id = peer;
  return req(A.bot.cred.base, "/v1/conversations", A.bot.cred.token, A.bot.envelope("conversation.create", payload));
}

test("a peer_bot_id that is not a string is refused and writes nothing", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const p: any = s.platform;

  for (const [label, value] of [
    ["an array holding the peer id", [B.bot.id]],
    ["an array of peer id and junk", [B.bot.id, "junk"]],
    ["an empty array", []],
    ["an array holding an empty string", [""]],
    ["an object", {}],
    ["a number", 42],
    ["a decimal", 1.5],
    ["a boolean", true],
    ["false", false],
    ["zero", 0],
  ] as [string, unknown][]) {
    const before = residue(p);
    const r = await create(A, value);
    assert.equal(r.status, 400, `peer_bot_id given ${label} must be refused, not answered ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error?.code, "invalid_request", JSON.stringify(r.body));
    assert.equal(r.body.error?.message, "peer_bot_id must be a string");
    assert.deepEqual(residue(p), before, `peer_bot_id given ${label} wrote no conversation, event, approval or audit entry`);
  }
  assert.equal(residue(p).conversations, 0, "no conversation row exists after any refused shape");
});

test("a missing peer_bot_id keeps its own message", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A } = await friends(s.base);
  const p: any = s.platform;

  for (const [label, value, given] of [
    ["omitted", undefined, false],
    ["null", null, true],
    // The empty string is a string, so it still reaches the "required" answer it had before.
    ["the empty string", "", true],
  ] as [string, unknown, boolean][]) {
    const before = residue(p);
    const r = await create(A, value, given);
    assert.equal(r.status, 400, `${label} peer_bot_id still answers 400, not ${r.status}`);
    assert.equal(r.body.error?.code, "invalid_request");
    assert.equal(r.body.error?.message, "peer_bot_id required", `${label} keeps the existing message`);
    assert.deepEqual(residue(p), before, `${label} writes nothing`);
  }
});

test("a string peer_bot_id keeps every answer it has today", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const p: any = s.platform;

  // An existing peer opens the conversation, and the row names that peer.
  const ok = await create(A, B.bot.id);
  assert.equal(ok.status, 201, `an existing peer still opens a conversation: ${JSON.stringify(ok.body)}`);
  assert.equal((p.get("SELECT peer_bot FROM conversations WHERE id = ?", ok.body.conversation_id) as any).peer_bot, B.bot.id);

  // An unknown id is still the same 404, and the caller's own id the same 403.
  const missing = await create(A, "bot_doesnotexist");
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error?.code, "bot_not_found");
  assert.equal(missing.body.error?.message, "bot bot_doesnotexist not found");
  const self = await create(A, A.bot.id);
  assert.equal(self.status, 403);
  assert.equal(self.body.error?.code, "no_relationship");
});
