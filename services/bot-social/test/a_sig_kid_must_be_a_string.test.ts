// `verifyEnvelope` looks the caller's key up with `SELECT * FROM bot_keys WHERE bot_id = ? AND kid = ?` and passes
// `env.sig.kid` straight into the bind list (`src/platform.ts:1744` on 7559b151). `sig.kid` is never checked for
// being a string, so a shape that is not a key name still reaches SQLite's binder:
//   - `{}`, `[]` are read as a named-parameter map and answer `RangeError: Too few parameter values were provided`;
//   - `true` / `false` answer `TypeError: SQLite3 can only bind numbers, strings, bigints, buffers, and null`;
//   - `["k1","x"]` answers `RangeError: Too many parameter values were provided`.
// Each of those becomes a 500 `internal_error` before the signature is even compared, so the refusal is neither a
// 4xx nor a `signature.rejected` audit line — the log stays silent about a request the platform could not read.
// Worse, a single-element array is flattened by the binder as a positional parameter, so `["k1"]` verifies exactly
// as the string `"k1"`: on 7559b151 it creates a pending relationship (and, behind an active relationship, a
// conversation) that the caller named with a value they never typed.
//
// A key id is a string. Anything else is refused by the envelope gate, before the key lookup, with the shape the
// other envelope refusals already use: 400 `invalid_envelope`, through `reject()` so the attempt leaves its
// `signature.rejected` audit line. `null` and an omitted `sig.kid` keep their existing answer (401
// `invalid_signature`, "unknown, revoked or expired kid"), and every string key id keeps its lookup byte for byte.
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

/** Every row a signed request could leave behind before it fails: the relationship, the conversation, the
 *  message, the event and the approval, plus the audit entry. */
function residue(p: any) {
  const one = (db: any, sql: string) => (db.prepare(sql).get() as any).n as number;
  return {
    relationships: one(p.db, "SELECT COUNT(*) n FROM relationships"),
    conversations: one(p.db, "SELECT COUNT(*) n FROM conversations"),
    messages: one(p.db, "SELECT COUNT(*) n FROM messages"),
    idemKeys: one(p.db, "SELECT COUNT(*) n FROM idempotency_keys"),
    events: one(p.db, "SELECT COUNT(*) n FROM events"),
    approvals: one(p.db, "SELECT COUNT(*) n FROM approvals"),
    audits: one(p.audit.db, "SELECT COUNT(*) n FROM audit_events"),
  };
}

function lastAudit(p: any) {
  return p.audit.db.prepare("SELECT action, data FROM audit_events ORDER BY seq DESC LIMIT 1").get() as
    | { action: string; data: string }
    | undefined;
}

function withoutAudit(r: ReturnType<typeof residue>) {
  const { audits: _audits, ...rest } = r;
  return rest;
}

const signedRelationship = (A: any, B: any, kid?: unknown) => {
  const env: any = A.bot.envelope("relationship.request", {
    target_handle: B.handle,
    message: "key id shape probe",
    requested_capabilities: ["chat.public"],
  });
  if (kid !== undefined) env.sig.kid = kid;
  return env;
};

test("a sig.kid that is not a string is refused, not answered 500", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "kidann");
  const B = await ownerWithBot(s.base, "kidben");
  const p: any = s.platform;

  // Every shape that cannot name a key. `["k1","x"]` is the binder's too-many-values case and `["k1"]` is handled
  // in the test below, because before the gate that one does not fail at all — it authenticates.
  for (const [label, value] of [
    ["an object", {}],
    ["an object without a usable toString", { toString: null }],
    ["an empty array", []],
    ["an array of key id and junk", ["k1", "junk"]],
    ["a boolean true", true],
    ["a boolean false", false],
  ] as [string, unknown][]) {
    const before = residue(p);
    const r = await req(s.base, "/v1/relationships", A.bot.cred.token, signedRelationship(A, B, value));
    assert.equal(r.status, 400, `sig.kid given ${label} must be refused, not answered ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error?.code, "invalid_envelope", JSON.stringify(r.body));
    assert.equal(r.body.error?.message, "sig.kid must be a string");
    assert.deepEqual(withoutAudit(residue(p)), withoutAudit(before), `sig.kid given ${label} wrote no relationship, event, approval or message`);
    assert.equal(residue(p).audits, before.audits + 1, `sig.kid given ${label} writes exactly one audit line`);
    const audit = lastAudit(p);
    assert.equal(audit?.action, "signature.rejected", `sig.kid given ${label} is audited as a rejected signature`);
    assert.equal(JSON.parse(audit!.data).code, "invalid_envelope", "and the audit carries the code that was returned");
  }
});

test("a single-element array no longer verifies in place of its string", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "kidcat");
  const B = await ownerWithBot(s.base, "kiddan");
  const p: any = s.platform;

  const before = residue(p);
  const r = await req(s.base, "/v1/relationships", A.bot.cred.token, signedRelationship(A, B, ["k1"]));
  assert.equal(r.status, 400, `sig.kid given ["k1"] must be refused, not answered ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body.error?.code, "invalid_envelope");
  assert.equal(r.body.error?.message, "sig.kid must be a string");
  assert.equal(residue(p).relationships, before.relationships, "no relationship row is created from a flattened key id");
  assert.equal(before.relationships, 0, "the probe starts from no relationship at all");
});


test("the same gate covers every signed door, not only relationships", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "kideve");
  const B = await ownerWithBot(s.base, "kidfay");
  const p: any = s.platform;

  const env: any = A.bot.envelope("conversation.create", { peer_bot_id: B.bot.id, type: "direct", intent: {} });
  env.sig.kid = {};
  const before = residue(p);
  const r = await req(s.base, "/v1/conversations", A.bot.cred.token, env);
  assert.equal(r.status, 400, `a signed conversation.create with an object sig.kid must be refused, not answered ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body.error?.code, "invalid_envelope");
  assert.deepEqual(withoutAudit(residue(p)), withoutAudit(before), "a refused conversation.create writes no conversation, event or approval");
});

test("null and an omitted sig.kid keep their existing answer, and a string key id still verifies", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "kidgil");
  const B = await ownerWithBot(s.base, "kidhal");
  const p: any = s.platform;

  for (const [label, env] of [
    ["null", signedRelationship(A, B, null)],
    ["omitted", (() => { const e = signedRelationship(A, B, "k1"); delete e.sig.kid; return e; })()],
  ] as [string, any][]) {
    const before = residue(p);
    const r = await req(s.base, "/v1/relationships", A.bot.cred.token, env);
    assert.equal(r.status, 401, `${label} sig.kid still answers 401, not ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error?.code, "invalid_signature");
    assert.equal(r.body.error?.message, "unknown, revoked or expired kid");
    assert.equal(residue(p).audits, before.audits + 1, `${label} sig.kid still writes its signature.rejected audit line`);
    assert.equal(lastAudit(p)?.action, "signature.rejected");
  }

  // The string key id this Bot registered still names its key and still sends the request.
  const ok = await req(s.base, "/v1/relationships", A.bot.cred.token, signedRelationship(A, B, "k1"));
  assert.equal(ok.status, 201, `a string sig.kid still verifies: ${JSON.stringify(ok.body)}`);
  const row = p.get("SELECT * FROM relationships WHERE id = ?", ok.body.relationship_id);
  assert.equal(row.requester_bot, A.bot.id);
});
