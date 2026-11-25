// `addHomeMember` is the door an owner's console and FlyBot's start-up both reach to register a local Bot as
// `@<name>.<home>`. The body declares `name` as a string, but nothing checks it: `String(body?.name ?? "")` turns
// `{}` into "[object Object]", `true` into "true" and `1.5` into "1.5", the sanitiser then shapes those into a
// handle, and the call answers 201 with a live member nobody named — a handle the owner's friends and every invite
// that names it read back, and a bot row, a key and an audit line that a refusal must not leave. A name is a string;
// anything else is a 400 `invalid_request` "name must be a string" refused before the home lookup, the row, the
// custody and the audit, while an absent or `null` name keeps the "member name required" answer it always had.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startServer } from "./helpers.js";

const owner = (o: any) => ({ kind: "owner" as const, ownerId: o.owner_id });

/** Only this home's footprint: refused calls must add no bot, no token, no custody and no member audit line. */
function residue(p: any, homeId: string) {
  const one = (db: any, sql: string, ...a: any[]) => (db.prepare(sql).get(...a) as any).n as number;
  return {
    bots: one(p.db, "SELECT COUNT(*) n FROM bots"),
    members: one(p.db, "SELECT COUNT(*) n FROM bots WHERE home_bot_id = ?", homeId),
    botTokens: one(p.db, "SELECT COUNT(*) n FROM tokens WHERE kind = 'bot'"),
    custody: one(p.db, "SELECT COUNT(*) n FROM bot_custody"),
    added: one(p.audit.db, "SELECT COUNT(*) n FROM audit_events WHERE action = 'home.member_added'"),
  };
}

const isNameRefusal = (e: any) => e?.status === 400 && e?.code === "invalid_request" && e?.message === "name must be a string";

const bad: [string, unknown][] = [
  ["an object", {}],
  ["a boolean", true],
  ["an array", [1]],
  ["a fraction", 1.5],
  ["zero", 0],
];

for (const [label, value] of bad) {
  test(`a home member named with ${label} is a 400 and writes nothing`, async (t) => {
    const s = await startServer();
    t.after(s.stop);
    const p = s.platform as any;
    const fly = p.onboardFlybot({ display_name: "Wes" });
    const before = residue(p, fly.home.bot_id);

    assert.throws(() => p.addHomeMember(owner(fly), fly.home.bot_id, { name: value }), isNameRefusal);
    assert.deepEqual(residue(p, fly.home.bot_id), before, "no bot, no token, no custody and no audit");
  });
}

test("a refused home member leaves an existing member's handle alone", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const p = s.platform as any;
  const fly = p.onboardFlybot({ display_name: "Wes" });
  const first = p.addHomeMember(owner(fly), fly.home.bot_id, { name: "writer" });
  const before = residue(p, fly.home.bot_id);

  assert.throws(() => p.addHomeMember(owner(fly), fly.home.bot_id, { name: {} }), isNameRefusal);
  assert.deepEqual(residue(p, fly.home.bot_id), before, "the refused call does not write");
  assert.equal(p.botByHandle("@writer.wes.home").id, first.bot_id, "the existing member is untouched");
});

test("a string name still registers a member", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const p = s.platform as any;
  const fly = p.onboardFlybot({ display_name: "Wes" });

  const added = p.addHomeMember(owner(fly), fly.home.bot_id, { name: "WriTer" });
  assert.equal(added.handle, "@writer.wes.home");
  assert.equal(p.homeMembers(fly.home.bot_id).length, 1);
});

test("an absent or null name keeps the required-name answer", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const p = s.platform as any;
  const fly = p.onboardFlybot({ display_name: "Wes" });
  const before = residue(p, fly.home.bot_id);

  for (const body of [{}, { name: null }] as any[]) {
    assert.throws(
      () => p.addHomeMember(owner(fly), fly.home.bot_id, body),
      (e: any) => e?.status === 400 && e?.code === "invalid_request" && e?.message === "member name required",
    );
  }
  assert.deepEqual(residue(p, fly.home.bot_id), before, "no bot, no token, no custody and no audit");
});
