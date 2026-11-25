/**
 * P21 — `grantSummary` must not list a grant whose `expires_at` has passed.
 *
 * `grantSummary` is the internal aggregate behind `announceActivation`, the join response's `grants_ready` and
 * `grantBotToFriend`; it selected every `status='active'` row and ignored `expires_at`, so a grant that had already
 * expired still read as live there. The public views (`grantsFor`, `findGrant`, `listBotGrants`) already expire
 * lazily, so this fixes the internal consumer without changing the HTTP surface.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { friends, startServer } from "./helpers.js";

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(); });
after(async () => { await S.stop(); });

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const setFreebusyExpiry = (relId: string, at: string) =>
  S.platform.db.prepare("UPDATE grants SET expires_at = ? WHERE relationship_id = ? AND capability = 'calendar.freebusy.read'").run(at, relId);
const caps = (relId: string) => S.platform.grantSummary(relId).flatMap((g: any) => g.capabilities as string[]);

describe("grantSummary does not list an expired grant (P21)", () => {
  test("(a) an active grant with a past expires_at is not part of the summary", async () => {
    const { relId } = await friends(S.base, { freebusy: true });
    assert.ok(caps(relId).includes("calendar.freebusy.read"), "the live grant is listed");
    setFreebusyExpiry(relId, ago(1000));
    assert.ok(!caps(relId).includes("calendar.freebusy.read"), "the expired grant is not listed");
  });

  test("(b) control: a NULL or future expiry is still listed", async () => {
    const { relId } = await friends(S.base, { freebusy: true });
    setFreebusyExpiry(relId, new Date(Date.now() + 86400e3).toISOString());
    assert.ok(caps(relId).includes("calendar.freebusy.read"), "a future expiry is listed");
  });

  test("(c) boundary: an expiry equal to now is already over (the filter is strict)", async () => {
    const { relId } = await friends(S.base, { freebusy: true });
    // Written as the wall clock instant of this test; by the time the query runs, "now" is at or past it and the
    // filter is `expires_at > now`, so an expiry equal to now must never count as live.
    setFreebusyExpiry(relId, new Date().toISOString());
    assert.ok(!caps(relId).includes("calendar.freebusy.read"), "expiry == now is not live");
  });

  test("(d) the public view is unchanged: it already hid the expired grant and flips the row", async () => {
    const { B, relId } = await friends(S.base, { freebusy: true });
    setFreebusyExpiry(relId, ago(1000));
    const listed = (await B.owner.req("GET", `/v1/bots/${B.bot.id}/grants`)).grants as any[];
    assert.ok(!listed.some((g) => g.capabilities.includes("calendar.freebusy.read")), "the public view hides it");
    const row = S.platform.db.prepare("SELECT status FROM grants WHERE relationship_id = ? AND capability = 'calendar.freebusy.read'").get(relId) as any;
    assert.equal(row.status, "expired", "and lazily flips the row to expired");
  });
});
