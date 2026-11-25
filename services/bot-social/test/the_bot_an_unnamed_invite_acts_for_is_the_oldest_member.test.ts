// Which Bot an invite acts for when its body names none is decided by `inviteBotFor`: it reads the account's active
// members oldest first (`ORDER BY created_at, id`) and prefers a member Bot over the home Bot itself. Two members
// minted in the same millisecond share the `created_at` value, and the `id` that breaks that tie is a ULID whose
// random suffix does not record which row was built first — so "the first member built" is not "the member this
// rule reads first". This fixture writes the two timestamps itself, in the opposite order to the order the rows are
// built, so the answer can only come from `created_at`: not from the build order, and not from the newest row.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startServer, bulkAuth } from "./helpers.js";

test("the Bot an unnamed invite acts for is the oldest active member", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const p: any = s.platform;
  const fly: any = p.onboardFlybot({ display_name: "Wes" });
  const owner = { kind: "owner", ownerId: fly.owner_id };
  const builtFirst: any = p.addHomeMember(owner, fly.home.bot_id, { name: "writer" });
  const builtSecond: any = p.addHomeMember(owner, fly.home.bot_id, { name: "reader" });

  // Both rows are active member Bots, so the kind preference in `inviteBotFor` cannot decide between them: only age
  // can.
  for (const id of [builtFirst.bot_id, builtSecond.bot_id]) {
    assert.equal(p.get("SELECT integration_type FROM bots WHERE id = ?", id).integration_type, "flybot-member");
    assert.equal(p.get("SELECT status FROM bots WHERE id = ?", id).status, "active");
  }

  // The row built second is the older one, and the two differ by a whole millisecond so no tie can hide behind the
  // id's random suffix.
  const older = "2026-02-01T00:00:00.001Z";
  const newer = "2026-02-01T00:00:00.002Z";
  p.run("UPDATE bots SET created_at = ? WHERE id = ?", newer, builtFirst.bot_id);
  p.run("UPDATE bots SET created_at = ? WHERE id = ?", older, builtSecond.bot_id);

  const chosen = p.inviteBotFor(fly.owner_id);
  assert.equal(chosen.id, builtSecond.bot_id, "the default invite Bot is the oldest active member, not the first one built and not the newest one");

  // The door a real caller uses answers the same Bot: an invite whose body names none is minted for the oldest member.
  const login = await fetch(s.base + "/v1/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: fly.username, password: fly.generated_password }),
  });
  const token = ((await login.json()) as any).owner_token as string;
  const r = await fetch(s.base + "/v1/invites", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: "{}",
  });
  assert.equal(r.status, 201, "an invite that names no Bot still mints a link: " + JSON.stringify(await r.clone().json().catch(() => null)));
  const invite = p.get("SELECT bot_id FROM invites ORDER BY created_at DESC, rowid DESC LIMIT 1");
  assert.equal(invite.bot_id, builtSecond.bot_id, "an invite that names no Bot is minted for the oldest active member");
});
