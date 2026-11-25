/**
 * `owner.settings_updated` records `{ fields: ["auto_approve_face_rooms"] }`, so switching auto-approve on and then
 * off writes two audit rows that read exactly alike: the chain cannot answer the one question a reader has about
 * that switch — which way the account was set when, and when it was turned on. The sibling event one door away
 * (`relationship.settings_updated`) already records the value, so the convention is established; this event simply
 * never picked it up. Record the value for the two settings whose value is the point — `auto_approve_face_rooms` as
 * a boolean and `sensitive_terms` as a count (never the words themselves, which are the owner's secrets) — keep
 * `fields` exactly as it is, and leave timezone / display_name / notify_bot_id as field names only.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

const req = async (base: string, method: string, path: string, token?: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
};

async function settingsAudits(base: string, token: string, subject: string) {
  const audit = await req(base, "GET", `/v1/audit-events?subject=${subject}`, token);
  assert.equal(audit.status, 200, JSON.stringify(audit.body));
  return (audit.body.events as any[]).filter((e) => e.action === "owner.settings_updated");
}

test("turning auto-approve on and off leaves two audits that say which way it went", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "auditset");

  for (const value of [true, false]) {
    const patched = await req(s.base, "PATCH", "/v1/me", A.owner.token, { auto_approve_face_rooms: value });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.auto_approve_face_rooms, value);
  }

  const rows = await settingsAudits(s.base, A.owner.token, A.owner_id);
  assert.equal(rows.length, 2, "one audit row per settings change");
  assert.deepEqual(rows.map((e) => e.data.fields), [["auto_approve_face_rooms"], ["auto_approve_face_rooms"]], "the field list is unchanged");
  assert.deepEqual(rows.map((e) => e.data.auto_approve_face_rooms), [true, false], "each row says which way the switch was set");
});

test("changing the sensitive words records how many there are, never the words", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "auditterms");

  const set = await req(s.base, "PATCH", "/v1/me", A.owner.token, { sensitive_terms: ["swordfish", "bluebird"] });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  const cleared = await req(s.base, "PATCH", "/v1/me", A.owner.token, { sensitive_terms: [] });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));

  const rows = await settingsAudits(s.base, A.owner.token, A.owner_id);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((e) => e.data.sensitive_terms), [2, 0], "the chain says how many terms were set and that they were cleared");
  for (const e of rows) {
    const raw = JSON.stringify(e.data);
    for (const word of ["swordfish", "bluebird"]) assert.ok(!raw.includes(word), `the audit must not carry the term itself: ${word} in ${raw}`);
  }
});

test("a change to another setting stays a field name and does not borrow these values", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "auditother");

  const patched = await req(s.base, "PATCH", "/v1/me", A.owner.token, { display_name: "Renamed Owner" });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));

  const rows = await settingsAudits(s.base, A.owner.token, A.owner_id);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].data.fields, ["display_name"], "the field list still names what changed");
  assert.equal("auto_approve_face_rooms" in rows[0].data, false, "an unrelated patch does not report the auto-approve value");
  assert.equal("sensitive_terms" in rows[0].data, false, "an unrelated patch does not report a terms count");
});
