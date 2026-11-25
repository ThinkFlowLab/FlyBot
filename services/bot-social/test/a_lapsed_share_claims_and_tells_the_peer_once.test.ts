/**
 * A share that lapsed on its clock used to be claimed in one write and announced in another.
 *
 * `announceLapsedShare` is the only door that writes a lapse down. It first claims the row (`revoked_at`, one
 * conditional UPDATE, so two sweeps cannot both announce it), then appends the `grant.expired` record and then
 * emits `grant.changed` / `status: "expired"` to the Bot that lost the access. None of that was in a transaction:
 * a refusal after the claim — the `events` insert is the write that can fail last — left the row claimed and
 * silent for good, because the claim is exactly what makes every later sweep `return` early.
 *
 * The three readings pin the whole write: the refused event write rolls the claim back with it, so the row still
 * has no `revoked_at`, there is no `grant.expired` record, no `grant.changed` row, no delivery and no push — and
 * the door reports the failure instead of answering as if the lapse had been announced. The next sweep, with the
 * refusal lifted, then announces that one lapse exactly once. The control sweeps twice without any refusal: the
 * claim still makes it one announcement, which is why the fix must keep the claim inside the transaction rather
 * than drop it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

const PAST = "2020-01-01T00:00:00.000Z";
const PUSH = "https://push.test/lapsed-share";

type S = Awaited<ReturnType<typeof startServer>>;

/** A server whose webhook POSTs are captured instead of sent, so a push is counted, not guessed. */
async function server() {
  const calls: { url: string; body: string }[] = [];
  const fetchImpl = (async (url: string, init: any) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  const s = await startServer({ fetchImpl });
  return { s, calls };
}

/**
 * Ben's Bot holds a roomless `chat.public` share of Ann's Bot, already past its clock. `expires_at` is written
 * directly because the API refuses a share that is born expired; every lapse test in this suite does the same.
 */
async function lapsedShare() {
  const { s, calls } = await server();
  const A = await ownerWithBot(s.base, "ann", PUSH);
  const B = await ownerWithBot(s.base, "ben");
  const rel = await A.owner.req("POST", "/v1/relationships", { from_bot_id: A.bot.id, target_handle: B.handle, message: "hi", requested_capabilities: ["chat.public"] });
  const relId = rel.relationship_id as string;
  await B.owner.req("POST", `/v1/relationships/${relId}/consent`, { decision: "accept", grant_capabilities: [] });
  const created = await B.owner.req("POST", `/v1/relationships/${relId}/grants`, { capability: "chat.public", expires_in_days: 30 });
  const grantId = created.grant_id as string;
  s.platform.db.prepare("UPDATE grants SET expires_at = ? WHERE id = ?").run(PAST, grantId);

  const row = () => s.platform.db.prepare("SELECT * FROM grants WHERE id = ?").get(grantId) as any;
  const expiredAudits = () => (s.platform.audit.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action = 'grant.expired' AND subject = ?").get(grantId) as any).n as number;
  const changedEvents = () => (s.platform.db.prepare("SELECT COUNT(*) n FROM events WHERE type = 'grant.changed' AND bot_id = ? AND data LIKE '%\"expired\"%'").get(A.bot.id) as any).n as number;
  const deliveries = () => (s.platform.db.prepare("SELECT COUNT(*) n FROM webhook_deliveries").get() as any).n as number;
  const pushes = () => calls.filter((c) => c.body.includes("grant.changed")).length;
  /** Any face-room door runs the sweep; this is the read door the lapse tests use, and it runs in no outer
   *  transaction — the claim used to commit here on its own. */
  const sweep = () => A.owner.req("GET", "/v1/face-rooms");
  const counters = async () => {
    await s.platform.flushWebhooks();
    return { audits: expiredAudits(), events: changedEvents(), deliveries: deliveries(), pushes: pushes() };
  };
  return { s, calls, A, B, relId, grantId, row, sweep, counters };
}

test("a refused announcement leaves the claim unwritten and the lapse unannounced", async () => {
  const { s, grantId, row, sweep, counters } = await lapsedShare();
  try {
    const before = await counters();

    // Only the announcement is refused: the claim and the audit are writes the store accepts, so without a
    // transaction the row would already be claimed and the peer never told.
    s.platform.db.exec(`CREATE TEMP TRIGGER refuse_grant_changed BEFORE INSERT ON events
      WHEN NEW.type = 'grant.changed'
      BEGIN SELECT RAISE(ABORT, 'store refused the grant.changed row'); END`);

    await assert.rejects(
      sweep(),
      (e: any) => e.status === 500 && e.code === "internal_error",
      "the sweep whose announcement failed reports it instead of answering as if the lapse had been announced",
    );
    const after = await counters();

    assert.equal(row().revoked_at, null, "the claim rolled back with the announcement it belongs to");
    assert.deepEqual(
      { audits: after.audits - before.audits, events: after.events - before.events, deliveries: after.deliveries - before.deliveries, pushes: after.pushes - before.pushes },
      { audits: 0, events: 0, deliveries: 0, pushes: 0 },
      "no grant.expired record, no grant.changed row, no delivery and no push outlive the rollback",
    );
    assert.doesNotThrow(() => s.platform.audit.verify(), "the audit chain is intact");

    // The refusal is the only thing that failed: lifted, the same sweep settles the row and announces it once.
    s.platform.db.exec("DROP TRIGGER refuse_grant_changed");
    await sweep();
    const settled = await counters();

    assert.equal(row().revoked_at, PAST, "the next sweep claims the row");
    assert.equal(settled.audits - before.audits, 1, "and writes the one grant.expired record");
    assert.equal(settled.events - before.events, 1, "and one grant.changed for the Bot that lost the access");
    assert.equal(settled.deliveries - before.deliveries, 1, "and one delivery carrying it");
    assert.equal(settled.pushes - before.pushes, 1, "and one push naming it");
  } finally {
    await s.stop();
  }
});

test("the announcement is written once however many sweeps run", async () => {
  const { s, row, sweep, counters } = await lapsedShare();
  try {
    const before = await counters();

    await sweep();
    const first = await counters();
    await sweep();
    await sweep();
    const again = await counters();

    assert.equal(row().revoked_at, PAST, "the row records the moment the access really ended");
    assert.deepEqual(
      { audits: first.audits - before.audits, events: first.events - before.events, deliveries: first.deliveries - before.deliveries, pushes: first.pushes - before.pushes },
      { audits: 1, events: 1, deliveries: 1, pushes: 1 },
      "the lapse is written down and announced exactly once",
    );
    assert.deepEqual(
      { audits: again.audits - first.audits, events: again.events - first.events, deliveries: again.deliveries - first.deliveries, pushes: again.pushes - first.pushes },
      { audits: 0, events: 0, deliveries: 0, pushes: 0 },
      "a second and a third sweep neither write the lapse down again nor tell the Bot again",
    );
  } finally {
    await s.stop();
  }
});
