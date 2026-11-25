import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { bulkAuth, friends, inDays, ownerWithBot, startServer } from "./helpers.js";

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(bulkAuth); });
after(async () => { await S.stop(); });

const meetingIntent = () => ({ type: "schedule_meeting", summary: "sync", params: { duration_minutes: 30, window: { start: inDays(1, 0), end: inDays(8, 23) } } });
const storedTz = (ownerId: string) => (S.platform.db.prepare("SELECT timezone FROM owners WHERE id = ?").get(ownerId) as any)?.timezone;
const ownerCount = () => (S.platform.db.prepare("SELECT COUNT(*) AS n FROM owners").get() as any).n;

let seq = 0;
async function post(base: string, path: string, body: unknown) {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
}

describe("owner timezone validation (P5)", () => {
  test("POST /v1/owners refuses every shape Intl does not know and creates no owner", async () => {
    // One line per shape, collected so a revert names all of them instead of stopping at the first.
    // The trailing space is the paste artefact: trimmed and accepted, and the trimmed name is what is stored.
    const shapes = ["UTC+8", "GMT+8", "Mars/Olympus", "Asia/Shanghai ", "   ", 8] as unknown[];
    const usernames: string[] = [];
    const got: string[] = [];
    for (const bad of shapes) {
      const username = `badzone${++seq}`;
      usernames.push(username);
      const r = await post(S.base, "/v1/owners", { username, password: "secret-pw", timezone: bad });
      got.push(`${JSON.stringify(bad)} -> ${r.status}${r.status === 201 ? "" : " " + (r.body?.error?.code ?? "")}`);
    }
    assert.deepEqual(got, [
      '"UTC+8" -> 400 invalid_timezone',
      '"GMT+8" -> 400 invalid_timezone',
      '"Mars/Olympus" -> 400 invalid_timezone',
      '"Asia/Shanghai " -> 201',
      '"   " -> 400 invalid_timezone',
      "8 -> 400 invalid_timezone",
    ]);
    for (const i of [0, 1, 2, 4, 5]) {
      assert.equal(S.platform.db.prepare("SELECT 1 FROM owners WHERE username = ?").get(usernames[i]), undefined, "no owner row for a refused zone");
    }
    assert.equal((S.platform.db.prepare("SELECT timezone FROM owners WHERE username = ?").get(usernames[3]) as any)?.timezone, "Asia/Shanghai", "the register path stores the trimmed name");
  });

  test("an absent or empty timezone keeps today's Asia/Shanghai default", async () => {
    for (const value of [undefined, ""] as unknown[]) {
      const username = `tzdefault${++seq}`;
      const r = await post(S.base, "/v1/owners", { username, password: "secret-pw", ...(value === undefined ? {} : { timezone: value }) });
      assert.equal(r.status, 201, `an absent/empty timezone must still register, got ${r.status}`);
      assert.equal((S.platform.db.prepare("SELECT timezone FROM owners WHERE username = ?").get(username) as any)?.timezone, "Asia/Shanghai");
    }
  });

  test("the onboard routes reach the same insert and refuse the zone too", async () => {
    const owners = ownerCount();
    const r = await post(S.base, "/v1/onboard", { username: `onboardzone${++seq}`, password: "secret-pw", bot_handle: "onboardzone.bot", timezone: "Mars/Olympus" });
    assert.equal(r.status, 400, `onboard must refuse the zone, got ${r.status}`);
    assert.equal(r.body.error.code, "invalid_timezone");
    assert.equal(ownerCount(), owners, "the whole onboarding transaction rolled back");
    assert.equal(S.platform.db.prepare("SELECT 1 FROM bots WHERE handle = ?").get("onboardzone.bot"), undefined, "no bot row either");
  });

  test("PATCH /v1/me refuses a bad zone without touching the row, and trims a pasted one", async () => {
    const A = await ownerWithBot(S.base, "tzpatch");
    assert.equal(storedTz(A.owner_id), "Asia/Shanghai");
    // A bad zone changes nothing else in the same request either: validation runs before any write.
    let refused: any;
    try { refused = await A.owner.req("PATCH", "/v1/me", { timezone: "GMT+8", display_name: "Should Not Stick" }); }
    catch (e: any) { refused = { status: e.status, code: e.code }; }
    const afterRefusal = await A.owner.req("GET", "/v1/me");
    // A trailing space is a paste artefact, not a different zone: accepted, stored trimmed.
    // (Decision: trim-and-accept, not reject — the value stored is the trimmed IANA name.)
    const trimmed = await A.owner.req("PATCH", "/v1/me", { timezone: " Asia/Shanghai\t" });
    // One comparison so a revert names every half of this contract at once.
    assert.deepEqual(
      { status: refused.status, code: refused.code, stored: afterRefusal.timezone, display_name: afterRefusal.display_name, trimmed: trimmed.timezone, storedTrimmed: storedTz(A.owner_id) },
      { status: 400, code: "invalid_timezone", stored: "Asia/Shanghai", display_name: "tzpatch", trimmed: "Asia/Shanghai", storedTrimmed: "Asia/Shanghai" },
    );
  });

  test("a valid IANA name and UTC still pass through and still work end-to-end at consumers", async () => {
    const { A, B } = await friends(S.base, { freebusy: true });
    const cid = (await A.bot.startConversation(B.bot.id, meetingIntent())).conversation_id;

    const iana = await A.owner.req("PATCH", "/v1/me", { timezone: "Asia/Shanghai" });
    assert.equal(iana.timezone, "Asia/Shanghai");
    assert.equal(storedTz(A.owner_id), "Asia/Shanghai");
    const fb = await A.bot.freebusy(cid, ["self"]);
    assert.equal(fb.results.self.busy.length, 0);
    assert.ok(fb.common_free_suggestions.length > 0, "freebusy still suggests slots");
    assert.match(fb.common_free_suggestions[0].start, /\+08:00$/);
    // calendar.book renders its approval summary in the owner's zone: inDays(3, 15) is 15:00 +08:00.
    const book = await A.bot.draftAction(cid, "calendar.book", { title: "Sync", start: inDays(3, 15), end: inDays(3, 15.5), attendees: [B.bot.id] });
    assert.equal(book.status, "pending_approval");
    const cards = (await A.owner.req("GET", "/v1/approvals")).approvals as any[];
    assert.match(cards.find((c) => c.kind === "action").summary, /Book \d{4}-\d\d-\d\d 15:00–15:30 \(Asia\/Shanghai\)/);

    const utc = await A.owner.req("PATCH", "/v1/me", { timezone: "UTC" });
    assert.equal(utc.timezone, "UTC");
    assert.equal(storedTz(A.owner_id), "UTC");
    const fbUtc = await A.bot.freebusy(cid, ["self"]);
    assert.ok(fbUtc.common_free_suggestions.length > 0);
    assert.match(fbUtc.common_free_suggestions[0].start, /\+00:00$/);
    // Same instant, UTC clock: 07:00–07:30.
    const bookUtc = await A.bot.draftAction(cid, "calendar.book", { title: "Sync UTC", start: inDays(3, 15), end: inDays(3, 15.5), attendees: [B.bot.id] });
    assert.equal(bookUtc.status, "pending_approval");
    const cardsUtc = (await A.owner.req("GET", "/v1/approvals")).approvals as any[];
    assert.match(cardsUtc.find((c) => c.kind === "action" && /UTC/.test(c.summary)).summary, /Book \d{4}-\d\d-\d\d 07:00–07:30 \(UTC\)/);
  });
});
