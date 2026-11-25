// `POST /v1/relationships` names the friend's Bot with `target_handle`, a string the route reads through
// `handleRef`, whose first line is `String(ref ?? "")`. On master de5903d2 that read happens before any type gate,
// so `[handle]` stringifies to the handle and the door creates a pending relationship, writes the target's event
// and the audit entry — a relationship the caller named with a value they never typed. `target_handle` is a
// string or nothing: anything else is a 400 `invalid_request` naming the field, refused before the target lookup
// and before the relationship row, the event, the approval and the audit entry. Absent and null keep their own
// message ("target_handle or target_bot_id required"), and every string keeps its lookup: the exact spelling,
// the case-insensitive match and the optional `@` still name the same Bot.
//
// The signed `conversation.create` envelope has the same shape of defect in `openConversation` (`peer_bot_id`
// straight into the Bot lookup: `[id]` creates a conversation, `{}`/`[]`/`true` answer 500). That is a separate
// call site and a separate door, so it is recorded as the same family and left for another issue; nothing here
// changes it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

async function req(base: string, path: string, token: string, body: unknown) {
  const r = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}

/** Every write a request can leave behind: a relationship, a pending invite, a conversation, an event and an
 *  approval, plus the audit entry. */
function residue(p: any) {
  const one = (sql: string) => (p.get(sql) as any).n as number;
  return {
    relationships: one("SELECT COUNT(*) n FROM relationships"),
    invites: one("SELECT COUNT(*) n FROM relationship_invites"),
    conversations: one("SELECT COUNT(*) n FROM conversations"),
    events: one("SELECT COUNT(*) n FROM events"),
    approvals: one("SELECT COUNT(*) n FROM approvals"),
    audits: (p.audit.db.prepare("SELECT COUNT(*) n FROM audit_events").get() as any).n as number,
  };
}

const rows = (p: any) => (p.get("SELECT COUNT(*) n FROM relationships") as any).n as number;

test("a target_handle that is not a string is refused and writes nothing", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const p: any = s.platform;

  for (const [label, value] of [
    ["an array holding the handle", [B.handle]],
    ["an array of handle and junk", [B.handle, "junk"]],
    ["an empty array", []],
    ["an array holding an empty string", [""]],
    ["an object", {}],
    ["a number", 42],
    ["a boolean", true],
  ] as [string, unknown][]) {
    const before = residue(p);
    const r = await req(s.base, "/v1/relationships", A.owner.token, { from_bot_id: A.bot.id, target_handle: value });
    assert.equal(r.status, 400, `target_handle given ${label} must be refused, not answered ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error?.code, "invalid_request", JSON.stringify(r.body));
    assert.equal(r.body.error?.message, "target_handle must be a string");
    assert.deepEqual(residue(p), before, `target_handle given ${label} wrote no relationship, event, approval or audit entry`);
  }
  assert.equal(rows(p), 0, "no relationship row was created by any refused shape");
});

test("the ways a target handle is named still work", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const C = await ownerWithBot(s.base, "cat");
  const D = await ownerWithBot(s.base, "dan");
  const E = await ownerWithBot(s.base, "eve");

  // The exact handle, the same without `@`, and a different case still name their Bot.
  for (const [label, handle, target] of [
    ["the @ handle", B.handle, B],
    ["the handle without @", C.handle.replace(/^@/, ""), C],
    ["an upper-case handle", D.handle.toUpperCase(), D],
  ] as [string, string, any][]) {
    const r = await req(s.base, "/v1/relationships", A.owner.token, { from_bot_id: A.bot.id, target_handle: handle });
    assert.equal(r.status, 201, `a string target_handle (${label}) still sends a request: ${JSON.stringify(r.body)}`);
    const row: any = (s.platform as any).get("SELECT * FROM relationships WHERE id = ?", r.body.relationship_id);
    assert.equal(row.target_bot, target.bot.id, `a string target_handle (${label}) still names that Bot`);
  }

  // A Bot token reads the same field through the same line: an array is refused there too.
  const before = residue(s.platform);
  const env = A.bot.envelope("relationship.request", { target_handle: [E.handle], message: "hi" });
  const signed = await req(s.base, "/v1/relationships", A.bot.cred.token, env);
  assert.equal(signed.status, 400, `a Bot-signed array target_handle must be refused, not answered ${signed.status}`);
  assert.equal(signed.body.error?.code, "invalid_request");
  assert.equal(signed.body.error?.message, "target_handle must be a string");
  assert.deepEqual(residue(s.platform), before, "a refused Bot-signed request writes nothing");
  // The same Bot token with a string still works.
  const ok = await req(s.base, "/v1/relationships", A.bot.cred.token, A.bot.envelope("relationship.request", { target_handle: E.handle, message: "hi" }));
  assert.equal(ok.status, 201, `a string target_handle still sends from a Bot: ${JSON.stringify(ok.body)}`);
});

test("a missing target and a wrong-typed alias keep their own messages", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const p: any = s.platform;

  // Absent and null mean "not given", so the pair check answers as before.
  for (const [label, body] of [
    ["omitted", { from_bot_id: A.bot.id }],
    ["null", { from_bot_id: A.bot.id, target_handle: null }],
  ] as [string, Record<string, unknown>][]) {
    const r = await req(s.base, "/v1/relationships", A.owner.token, body);
    assert.equal(r.status, 400, `${label} target_handle still answers 400, not ${r.status}`);
    assert.equal(r.body.error?.code, "invalid_request");
    assert.equal(r.body.error?.message, "target_handle or target_bot_id required", `${label} keeps the existing message`);
  }

  // With a Bot id present, a wrong-typed handle is still refused: it is a value in this body, not dead weight.
  {
    const before = residue(p);
    const r = await req(s.base, "/v1/relationships", A.owner.token, { from_bot_id: A.bot.id, target_bot_id: B.bot.id, target_handle: [] });
    assert.equal(r.status, 400, `a wrong-typed handle beside a Bot id must be refused, not answered ${r.status}`);
    assert.equal(r.body.error?.message, "target_handle must be a string");
    assert.deepEqual(residue(p), before, "nothing is written");
  }
  // The Bot id is judged first, where it already was.
  {
    const r = await req(s.base, "/v1/relationships", A.owner.token, { from_bot_id: A.bot.id, target_handle: [], target_bot_id: {} });
    assert.equal(r.status, 400);
    assert.equal(r.body.error?.message, "target_bot_id must be a string");
  }
});
