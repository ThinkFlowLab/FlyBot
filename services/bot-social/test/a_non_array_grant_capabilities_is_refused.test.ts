// `POST /v1/relationships/:id/consent` declares `grant_capabilities` as a list of capability names, but the value
// goes straight into `(body.grant_capabilities ?? []).map(...)`: a string, a number, an object or a boolean has no
// `.map`, so those requests answer `500 internal_error`, and an entry that is not a name reaches the capability
// check as `unknown capability undefined`. Either way the relationship stays pending and nothing is written, but
// the caller learns nothing about the field it got wrong. A malformed list is a 400 `invalid_request`
// "grant_capabilities must be an array of strings", refused before the decision is acted on and before any grant,
// approval, event or audit row; absent, `null` and `[]` keep meaning "the defaults"; a name that is not a known
// capability still reaches the existing `unknown_capability` refusal unchanged, and the object form
// (`{capability, scope, expires_in_days}`) keeps working.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bulkAuth, ownerWithBot, startServer } from "./helpers.js";

const notAList: [string, unknown][] = [
  ["a string", "chat.public"],
  ["a number", 42],
  ["an object", {}],
  ["a boolean", true],
];

const notAName: [string, unknown][] = [
  ["a number", [42]],
  ["null", [null]],
  ["a nested list", [["x"]]],
  ["an object without a capability", [{}]],
];

/** Every row a refused consent must not write, plus the relationship's own status. */
function rows(p: any) {
  const one = (db: any, sql: string) => (db.prepare(sql).get() as any).n as number;
  return {
    relationships: one(p.db, "SELECT COUNT(*) n FROM relationships"),
    grants: one(p.db, "SELECT COUNT(*) n FROM grants"),
    approvals: one(p.db, "SELECT COUNT(*) n FROM approvals"),
    events: one(p.db, "SELECT COUNT(*) n FROM events"),
    audit: one(p.audit.db, "SELECT COUNT(*) n FROM audit_events"),
  };
}

/** A pending request B's owner can answer, on a server of its own. */
async function pending() {
  const s: any = await startServer(bulkAuth);
  const A = await ownerWithBot(s.base, "alice");
  const B = await ownerWithBot(s.base, "bob");
  const rel: any = await A.owner.req("POST", "/v1/relationships", {
    from_bot_id: A.bot.id,
    target_handle: B.handle,
    message: "hi",
    requested_capabilities: ["chat.public"],
  });
  return { s, A, B, relId: rel.relationship_id as string };
}

const statusOf = (s: any, relId: string) => (s.platform.db.prepare("SELECT status FROM relationships WHERE id = ?").get(relId) as any).status;
const capsOf = (s: any, relId: string) =>
  (s.platform.db.prepare("SELECT capability FROM grants WHERE relationship_id = ? ORDER BY capability").all(relId) as any[]).map((g) => g.capability);
const isTypeRefusal = (r: { status: number; body: any }) =>
  r.status === 400 && r.body?.error?.code === "invalid_request" && r.body?.error?.message === "grant_capabilities must be an array of strings";

const consent = (s: any, token: string, relId: string, body: unknown) =>
  fetch(`${s.base}/v1/relationships/${relId}/consent`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body ?? {}),
  }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));

for (const [label, value] of notAList) {
  test(`an accept whose grant_capabilities is ${label} is a 400 and writes nothing`, async (t) => {
    const { s, B, relId } = await pending();
    t.after(s.stop);
    const before = rows(s.platform);
    const r = await consent(s, B.owner.token, relId, { decision: "accept", grant_capabilities: value });
    assert.ok(isTypeRefusal(r), `expected a 400 grant_capabilities refusal, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.deepEqual(rows(s.platform), before, "a refused consent writes no grant, approval, event or audit row");
    assert.equal(statusOf(s, relId), "pending_target", "the relationship is not activated");
  });
}

for (const [label, value] of notAName) {
  test(`an accept whose list holds ${label} is a 400 and writes nothing`, async (t) => {
    const { s, B, relId } = await pending();
    t.after(s.stop);
    const before = rows(s.platform);
    const r = await consent(s, B.owner.token, relId, { decision: "accept", grant_capabilities: value });
    assert.ok(isTypeRefusal(r), `expected a 400 grant_capabilities refusal, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.deepEqual(rows(s.platform), before, "a refused consent writes no grant, approval, event or audit row");
    assert.equal(statusOf(s, relId), "pending_target", "the relationship is not activated");
  });
}

test("a decline whose grant_capabilities is not a list is a 400 and does not decline", async (t) => {
  const { s, B, relId } = await pending();
  t.after(s.stop);
  const before = rows(s.platform);
  const r = await consent(s, B.owner.token, relId, { decision: "decline", grant_capabilities: "chat.public" });
  assert.ok(isTypeRefusal(r), `expected a 400 grant_capabilities refusal, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.deepEqual(rows(s.platform), before, "a refused consent writes no row");
  assert.equal(statusOf(s, relId), "pending_target", "the request is still waiting, not declined");
});

test("the defaults still activate a request: no field, null, or an empty list", async (t) => {
  for (const body of [{ decision: "accept" }, { decision: "accept", grant_capabilities: null }, { decision: "accept", grant_capabilities: [] }]) {
    const { s, B, relId } = await pending();
    t.after(s.stop);
    const r = await consent(s, B.owner.token, relId, body);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, "active");
    assert.deepEqual(capsOf(s, relId), ["chat.public", "chat.public", "profile.read", "profile.read"], "minimal defaults both ways");
  }
});

test("a list of capability names still activates exactly what it names", async (t) => {
  const { s, B, relId } = await pending();
  t.after(s.stop);
  const r = await consent(s, B.owner.token, relId, { decision: "accept", grant_capabilities: ["chat.public"] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, "active");
  assert.equal(statusOf(s, relId), "active");
});

test("the object form with a capability name still activates", async (t) => {
  const { s, B, relId } = await pending();
  t.after(s.stop);
  const r = await consent(s, B.owner.token, relId, { decision: "accept", grant_capabilities: [{ capability: "chat.public" }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, "active");
});

test("a capability name that does not exist keeps the existing unknown_capability refusal", async (t) => {
  const { s, B, relId } = await pending();
  t.after(s.stop);
  const before = rows(s.platform);
  const r = await consent(s, B.owner.token, relId, { decision: "accept", grant_capabilities: ["nope"] });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.error.code, "unknown_capability", "the name-level refusal is unchanged");
  assert.deepEqual(rows(s.platform), before, "and it writes nothing");
  assert.equal(statusOf(s, relId), "pending_target");
});

test("a refused list does not consume the request: the same owner can still accept", async (t) => {
  const { s, B, relId } = await pending();
  t.after(s.stop);
  const refused = await consent(s, B.owner.token, relId, { decision: "accept", grant_capabilities: "chat.public" });
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  const ok = await consent(s, B.owner.token, relId, { decision: "accept", grant_capabilities: [] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.status, "active");
  assert.equal(capsOf(s, relId).length, 4);
});
