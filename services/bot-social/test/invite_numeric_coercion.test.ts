import assert from "node:assert/strict";
import { test } from "node:test";
import { bulkAuth, ownerWithBot, startServer } from "./helpers.js";

// The invite door used to read `max_uses` with Number(...) and a clamp, so a value that is not a whole number of
// uses was answered with a coerced one: 1.5 was stored as REAL 1.5 and admitted ceil(1.5) = 2 joins, i.e. a link
// wider than the caller can have meant, and "abc" / "" / true / [3] / "0x10" were silently turned into a count.
// These tests pin the contract: when present and not a finite integer >= 1, max_uses is refused whole with 400
// invalid_request and stores no row and no audit entry. Absent or null keeps the 1-use default.
//
// expires_in_hours is deliberately untouched: every value it sees is clamped to [1h, 720h] or falls back to 72h,
// which is never wider than a sane caller's intent, so those cases are pinned here as unchanged green controls.
// The bodies are sent raw so the table can exercise JSON literals a typed client cannot express (1e400 parses to
// Infinity, which is what a caller sending a value too large for a double actually sends).

type Case = { label: string; raw: string };

const inviteCount = (s: any) => (s.platform.db.prepare("SELECT COUNT(*) n FROM invites").get() as any).n as number;
const auditCount = (s: any) => (s.platform.audit.db.prepare("SELECT COUNT(*) n FROM audit_events").get() as any).n as number;

async function setup() {
  const s = await startServer(bulkAuth);
  const inviter = await ownerWithBot(s.base, "inviter");
  return { s, inviter };
}

async function rawCreate(base: string, token: string, raw: string) {
  const r = await fetch(base + "/v1/invites", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: raw });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}

const hoursOf = (s: any, code: string) => {
  const row: any = s.platform.db.prepare("SELECT created_at, expires_at FROM invites WHERE code = ?").get(code);
  return { hours: (Date.parse(row.expires_at) - Date.parse(row.created_at)) / 3600e3, expiresAt: row.expires_at };
};

/** What the door actually did, in the stable fields only (no ids or wall-clock stamps). */
const describe = (s: any, r: any) => r.status === 201
  ? `201 with stored max_uses=${JSON.stringify(r.body.max_uses)} (${typeof r.body.max_uses}) and expires in ${hoursOf(s, r.body.code).hours.toFixed(4)}h`
  : `${r.status} ${r.body.error?.code}: ${r.body.error?.message}`;

// Every non-whole, non-numeric and non-positive shape: a fractional count, a negative one, and the values the old
// Number(...) read accepted through coercion (a numeric string, an empty string, true, a one-element array, hex).
const badMaxUses: Case[] = [
  { label: "1.5 (fractional)", raw: '{"max_uses":1.5}' },
  { label: "2.5 (fractional)", raw: '{"max_uses":2.5}' },
  { label: "-3 (negative)", raw: '{"max_uses":-3}' },
  { label: "0 (not a positive count)", raw: '{"max_uses":0}' },
  { label: "\"abc\" (not a number)", raw: '{"max_uses":"abc"}' },
  { label: "\"\" (empty string)", raw: '{"max_uses":""}' },
  { label: "true (boolean)", raw: '{"max_uses":true}' },
  { label: "[3] (one-element array)", raw: '{"max_uses":[3]}' },
  { label: "\"0x10\" (hex string)", raw: '{"max_uses":"0x10"}' },
  { label: "1e400 (Infinity after parse)", raw: '{"max_uses":1e400}' },
];
for (const c of badMaxUses) {
  test(`invite create refuses max_uses ${c.label}`, async (t) => {
    const { s, inviter } = await setup();
    t.after(s.stop);
    const beforeInvites = inviteCount(s);
    const beforeAudit = auditCount(s);
    const r = await rawCreate(s.base, inviter.owner.token, c.raw);
    assert.equal(r.status, 400, `max_uses ${c.label} answered ${describe(s, r)}`);
    assert.equal(r.body.error.code, "invalid_request");
    assert.match(r.body.error.message, /max_uses must be a positive integer/);
    assert.equal(inviteCount(s), beforeInvites, "a refused invite stores no row");
    assert.equal(auditCount(s), beforeAudit, "a refused invite writes no audit row");
  });
}

test("invite create: an absent or null max_uses keeps the 1-use default, a whole count is stored as given", async (t) => {
  const { s, inviter } = await setup();
  t.after(s.stop);
  const omitted: any = await inviter.owner.req("POST", "/v1/invites", {});
  assert.equal(omitted.max_uses, 1);
  const explicitNull: any = await inviter.owner.req("POST", "/v1/invites", { max_uses: null });
  assert.equal(explicitNull.max_uses, 1, "null max_uses keeps the 1-use default");
  const three: any = await inviter.owner.req("POST", "/v1/invites", { max_uses: 3 });
  assert.equal(three.max_uses, 3);
  const row: any = s.platform.db.prepare("SELECT max_uses, typeof(max_uses) t FROM invites WHERE code = ?").get(three.code);
  assert.deepEqual({ value: row.max_uses, type: row.t }, { value: 3, type: "integer" }, "a whole count is stored as an integer");
  const over: any = await inviter.owner.req("POST", "/v1/invites", { max_uses: 51 });
  assert.equal(over.max_uses, 50, "a count above the ceiling still clamps as before");
});

// expires_in_hours is unchanged by this contract: every shape clamps to a narrower/saner window or falls back to
// the 72h default. Pinned so a later change to the hour read is visible rather than silent.
const hoursCases: { label: string; raw: string; hours: number }[] = [
  { label: "-3 (negative)", raw: '{"expires_in_hours":-3}', hours: 1 },
  { label: "\"abc\" (not a number)", raw: '{"expires_in_hours":"abc"}', hours: 72 },
  { label: "\"\" (empty string)", raw: '{"expires_in_hours":""}', hours: 72 },
  { label: "null", raw: '{"expires_in_hours":null}', hours: 72 },
  { label: "1e400 (Infinity after parse)", raw: '{"expires_in_hours":1e400}', hours: 720 },
  { label: "1.5 (fractional hours)", raw: '{"expires_in_hours":1.5}', hours: 1.5 },
];
for (const c of hoursCases) {
  test(`invite create: expires_in_hours ${c.label} stays clamped or defaulted, never wider`, async (t) => {
    const { s, inviter } = await setup();
    t.after(s.stop);
    const r = await rawCreate(s.base, inviter.owner.token, c.raw);
    assert.equal(r.status, 201, `expires_in_hours ${c.label} answered ${describe(s, r)}`);
    const span = hoursOf(s, r.body.code);
    assert.equal(Number.isNaN(Date.parse(span.expiresAt)), false, "the expiry is a real ISO date");
    assert.ok(Math.abs(span.hours - c.hours) < 0.01, `expires_in_hours ${c.label} spans ${span.hours}h, want ${c.hours}h`);
  });
}

test("invite create: a literal Infinity is refused as invalid JSON before the door", async (t) => {
  const { s, inviter } = await setup();
  t.after(s.stop);
  const r = await rawCreate(s.base, inviter.owner.token, '{"max_uses":Infinity}');
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, "invalid_request");
});
