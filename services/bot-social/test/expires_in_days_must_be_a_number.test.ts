import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

const DAY = 86400e3;
const approxDays = (iso: string) => (Date.parse(iso) - Date.now()) / DAY;

/** Alice and Bob are friends, with the grants an accepted friendship writes. Bob's owner is the grantor. */
async function pair(t: any) {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "alice");
  const B = await ownerWithBot(s.base, "bob");
  const rel = await A.owner.req("POST", "/v1/relationships", { from_bot_id: A.bot.id, target_handle: B.handle, message: "hi", requested_capabilities: ["chat.public"] });
  const relId = rel.relationship_id as string;
  const grant = (body: any) => B.owner.req("POST", `/v1/relationships/${relId}/grants`, body);
  /** The live chat.public row B's owner wrote for Alice's Bot, if any. */
  const live = () => s.platform.db.prepare(
    "SELECT id, status, expires_at FROM grants WHERE relationship_id = ? AND grantor_owner = ? AND grantee_bot = ? AND capability = 'chat.public' AND IFNULL(room_id,'') = '' AND status = 'active'",
  ).get(relId, B.owner_id, A.bot.id) as any;
  const counts = () => ({
    grants: (s.platform.db.prepare("SELECT COUNT(*) n FROM grants").get() as any).n as number,
    events: (s.platform.db.prepare("SELECT COUNT(*) n FROM events").get() as any).n as number,
    audit: (s.platform.audit.db.prepare("SELECT COUNT(*) n FROM audit_events").get() as any).n as number,
  });
  return { s, A, B, relId, grant, live, counts };
}

/** A refusal as the door answered it: `201` stands for "it was accepted and written". */
async function answer(p: Promise<unknown>) {
  try {
    await p;
    return { status: 201, code: "", message: "" };
  } catch (e: any) {
    return { status: e.status as number, code: e.code as string, message: e.message as string };
  }
}

test("a boolean expires_in_days is refused instead of reading as one day, and the live grant stays", async (t) => {
  const { B, relId, grant, live, counts } = await pair(t);
  await B.owner.req("POST", `/v1/relationships/${relId}/consent`, { decision: "accept", grant_capabilities: [] });
  const prior = live();
  assert.ok(prior, "control: the accepted friendship has a live chat.public grant");
  const before = counts();

  for (const bad of [true, false]) {
    const r = await answer(grant({ capability: "chat.public", expires_in_days: bad }));
    assert.equal(r.status, 400, `expires_in_days=${JSON.stringify(bad)} was accepted and written as a grant`);
    assert.equal(r.code, "invalid_request");
    assert.match(r.message, /expires_in_days must be a number of days/, `wrong message: ${r.message}`);
    const after = live();
    assert.equal(after?.id, prior.id, `expires_in_days=${JSON.stringify(bad)} took the live grant down`);
    assert.equal(after?.expires_at, prior.expires_at, `expires_in_days=${JSON.stringify(bad)} changed the live grant's expiry`);
    assert.deepEqual(counts(), before, `expires_in_days=${JSON.stringify(bad)} wrote rows`);
  }
});

test("an array or object expires_in_days is refused instead of being read as days", async (t) => {
  const { B, relId, grant, live, counts } = await pair(t);
  await B.owner.req("POST", `/v1/relationships/${relId}/consent`, { decision: "accept", grant_capabilities: [] });
  const prior = live();
  assert.ok(prior, "control: the accepted friendship has a live chat.public grant");
  const before = counts();

  for (const bad of [[30], ["30"], [30, 31], [], { days: 30 }, {}]) {
    const r = await answer(grant({ capability: "chat.public", expires_in_days: bad }));
    assert.equal(r.status, 400, `expires_in_days=${JSON.stringify(bad)} was accepted and written as a grant`);
    assert.equal(r.code, "invalid_request");
    assert.match(r.message, /expires_in_days must be a number of days/, `wrong message: ${r.message}`);
    const after = live();
    assert.equal(after?.id, prior.id, `expires_in_days=${JSON.stringify(bad)} took the live grant down`);
    assert.equal(after?.expires_at, prior.expires_at, `expires_in_days=${JSON.stringify(bad)} changed the live grant's expiry`);
    assert.deepEqual(counts(), before, `expires_in_days=${JSON.stringify(bad)} wrote rows`);
  }
});

test("a number and a numeric string are still a number of days", async (t) => {
  const { B, relId, grant, live } = await pair(t);
  await B.owner.req("POST", `/v1/relationships/${relId}/consent`, { decision: "accept", grant_capabilities: [] });

  for (const [given, days] of [[30, 30], ["30", 30], [1.5, 1.5]] as [any, number][]) {
    const r = await grant({ capability: "chat.public", expires_in_days: given });
    assert.equal(r.status, "active", `expires_in_days=${JSON.stringify(given)} was refused`);
    const row = live();
    assert.ok(approxDays(row.expires_at) > days - 0.1 && approxDays(row.expires_at) < days + 0.1, `expires_in_days=${JSON.stringify(given)} wrote ${row.expires_at}, not about ${days} days`);
  }
});

test("null and an omitted expires_in_days still keep the default", async (t) => {
  const { B, relId, grant, live } = await pair(t);
  await B.owner.req("POST", `/v1/relationships/${relId}/consent`, { decision: "accept", grant_capabilities: [] });

  for (const [label, body] of [["omitted", { capability: "chat.public" }], ["null", { capability: "chat.public", expires_in_days: null }]] as [string, any][]) {
    await grant(body);
    const row = live();
    assert.ok(approxDays(row.expires_at) > 89 && approxDays(row.expires_at) < 91, `expires_in_days ${label} gave ${row.expires_at}, not the 90-day default`);
  }
});

test("a wrong-typed expiry on consent is refused before any grant is written", async (t) => {
  const { s, A, B, relId } = await pair(t);
  const counts = () => ({
    grants: (s.platform.db.prepare("SELECT COUNT(*) n FROM grants").get() as any).n as number,
    events: (s.platform.db.prepare("SELECT COUNT(*) n FROM events").get() as any).n as number,
    audit: (s.platform.audit.db.prepare("SELECT COUNT(*) n FROM audit_events").get() as any).n as number,
  });
  const before = counts();

  const refused = await answer(B.owner.req("POST", `/v1/relationships/${relId}/consent`, {
    decision: "accept",
    grant_capabilities: [{ capability: "profile.read", expires_in_days: true }],
  }));
  assert.equal(refused.status, 400, "a boolean expires_in_days on consent was accepted");
  assert.equal(refused.code, "invalid_request");
  assert.match(refused.message, /expires_in_days must be a number of days/, `wrong message: ${refused.message}`);
  const row = s.platform.db.prepare("SELECT status FROM relationships WHERE id = ?").get(relId) as any;
  assert.equal(row.status, "pending_target", `the relationship became ${row.status} although the consent was refused`);
  assert.deepEqual(counts(), before, "a refused consent wrote grants, events or audit rows");

  const accepted = await B.owner.req("POST", `/v1/relationships/${relId}/consent`, {
    decision: "accept",
    grant_capabilities: [{ capability: "profile.read", expires_in_days: 30 }],
  });
  assert.equal(accepted.status, "active", "control: the same consent with a number of days is refused");
  const grant = s.platform.db.prepare(
    "SELECT expires_at FROM grants WHERE relationship_id = ? AND grantor_owner = ? AND grantee_bot = ? AND capability = 'profile.read' AND status = 'active'",
  ).get(relId, B.owner_id, A.bot.id) as any;
  assert.ok(grant && approxDays(grant.expires_at) > 29 && approxDays(grant.expires_at) < 31, `consent wrote ${grant?.expires_at}, not about 30 days`);
});
