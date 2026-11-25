// Onboarding mints a Bot whose signing key the platform keeps (`bot_custody`), and nothing on the audit chain said
// so: the row was written by `storeCustody`, which appended nothing, and only the later `enable_custody` door wrote
// its own `bot.custody_enabled`. So the one moment an owner's key first comes under platform custody — an
// unauthenticated sign-up — left no governance record, while the same fact recorded later did. The record now
// follows the write: `storeCustody` appends it for the owner that is taking custody, inside onboarding's own
// transaction, where `auditFollowsCommit` holds it until that transaction commits (a rollback drops the row and its
// record together). The `enable_custody` door passes through the same call, so it still writes exactly one.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bulkAuth, ownerWithBot, startServer } from "./helpers.js";

const one = (s: any, sql: string, ...args: unknown[]) => (s.platform.db.prepare(sql).get(...args) as any).n as number;
const counts = (s: any) => ({
  owners: one(s, "SELECT COUNT(*) n FROM owners"),
  bots: one(s, "SELECT COUNT(*) n FROM bots"),
  botKeys: one(s, "SELECT COUNT(*) n FROM bot_keys"),
  tokens: one(s, "SELECT COUNT(*) n FROM tokens"),
  custody: one(s, "SELECT COUNT(*) n FROM bot_custody"),
});
const custodyRows = (s: any, subject?: string) => (s.platform.audit.db.prepare(
  subject ? "SELECT actor, subject, data FROM audit_events WHERE action = 'bot.custody_enabled' AND subject = ?" : "SELECT actor, subject, data FROM audit_events WHERE action = 'bot.custody_enabled'",
).all(...(subject ? [subject] : [])) as any[]).map((r) => ({ ...r, data: JSON.parse(r.data) }));

test("onboarding one Bot writes exactly one custody record and no other table grows", async (t) => {
  const s = await startServer(bulkAuth as any);
  t.after(s.stop);

  const r = await fetch(s.base + "/v1/onboard", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ display_name: "Probe Owner", bot_handle: "probe.owner.bot" }),
  });
  const body = (await r.json()) as any;
  assert.equal(r.status, 201, JSON.stringify(body));
  assert.deepEqual(counts(s), { owners: 1, bots: 1, botKeys: 1, tokens: 3, custody: 1 }, "the sign-up writes the same rows it always did");

  const rows = custodyRows(s);
  assert.equal(rows.length, 1, "the custody row has its own audit record");
  assert.equal(rows[0].actor, `owner:${body.owner_id}`, "the owner taking custody is the actor");
  assert.equal(rows[0].subject, body.bot.bot_id);
  const stored = s.platform.db.prepare("SELECT kid FROM bot_custody WHERE bot_id = ?").get(body.bot.bot_id) as any;
  assert.equal(rows[0].data.kid, stored.kid, "the record names the key that was stored");
  assert.equal(rows[0].data.mode, "onboarded");
});

test("enabling custody later still writes exactly one record, not two", async (t) => {
  const s = await startServer(bulkAuth as any);
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "late");

  s.platform.enableCustody({ kind: "owner", ownerId: A.owner_id } as any, A.bot.id, {});
  const rows = custodyRows(s, A.bot.id);
  assert.equal(rows.length, 1, "the enable door writes its own record once");
  assert.equal(rows[0].actor, `owner:${A.owner_id}`);
  assert.equal(rows[0].data.kid, (s.platform.db.prepare("SELECT kid FROM bot_custody WHERE bot_id = ?").get(A.bot.id) as any).kid);
  assert.ok(["rotated", "uploaded"].includes(rows[0].data.mode), rows[0].data.mode);
});
