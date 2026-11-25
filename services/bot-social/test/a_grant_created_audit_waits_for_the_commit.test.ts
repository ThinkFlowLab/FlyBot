// The audit log lives in its own SQLite file, so an audit written inside a platform transaction outlives that
// transaction's rollback. `writeActivation` writes one `grant.created` per grant from inside one transaction, and
// the request can still be refused after the first grants are written (`expires_in_days` on one offered capability).
// That used to leave `grant.created` entries naming grants that were never made: the owner's audit trail claimed
// access it never gave. What the audit says has to follow the commit — a refused consent writes no `grant.created`,
// and a grant that is stored carries exactly one.
import assert from "node:assert/strict";
import { test } from "node:test";
import { expectApiError, ownerWithBot, startServer } from "./helpers.js";

// Only the records that name a grant: the platform also files one `grant.created` under a relationship id when a
// Bot-to-friend grant creates the relationship, and that record is not about a single grant.
const created = (s: any) => s.platform.audit.list().filter((r: any) => r.action === "grant.created" && String(r.subject ?? "").startsWith("grt_"));
const grantsOf = (s: any, relId: string) =>
  (s.platform as any).all("SELECT id, capability FROM grants WHERE relationship_id = ?", relId) as any[];

/** A pending relationship B's owner can answer. */
async function pending(s: any) {
  const A = await ownerWithBot(s.base, "alice");
  const B = await ownerWithBot(s.base, "bob");
  const rel = await A.owner.req("POST", "/v1/relationships", {
    from_bot_id: A.bot.id,
    target_handle: B.handle,
    message: "hi",
    requested_capabilities: ["chat.public"],
  });
  return { A, B, relId: rel.relationship_id as string };
}

test("a consent the platform refuses leaves no grant.created audit for a grant it never made", async () => {
  const s = await startServer();
  try {
    const { B, relId } = await pending(s);
    const before = created(s).length;
    // The default capabilities are written first, so the refusal lands after two audits are already in the log.
    await expectApiError(
      B.owner.req("POST", `/v1/relationships/${relId}/consent`, {
        decision: "accept",
        grant_capabilities: [{ capability: "calendar.freebusy.read", expires_in_days: -5 }],
      }),
      400,
      "invalid_request",
    );
    assert.equal(grantsOf(s, relId).length, 0, "the refused consent stored no grant");
    assert.equal(created(s).length - before, 0, "and wrote no grant.created audit for the grants it never made");
  } finally { await s.stop(); }
});

test("a consent the platform accepts writes one grant.created per grant it stored", async () => {
  const s = await startServer();
  try {
    const { B, relId } = await pending(s);
    const before = created(s).length;
    await B.owner.req("POST", `/v1/relationships/${relId}/consent`, { decision: "accept", grant_capabilities: [] });
    const stored = grantsOf(s, relId);
    assert.ok(stored.length > 0, "the accepted consent stored grants");
    const written = created(s).slice(before);
    assert.equal(written.length, stored.length, "one grant.created per stored grant");
    assert.deepEqual(
      written.map((r: any) => r.subject).sort(),
      stored.map((g) => g.id).sort(),
      "and each names a grant that exists",
    );
  } finally { await s.stop(); }
});
