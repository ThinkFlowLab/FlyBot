/**
 * `owner.settings_updated` used to record `Object.keys(body)` — the keys the caller sent, not the columns the route
 * really wrote. A `PATCH /v1/me` with nothing to write therefore still appended a row: `{}` wrote `{fields:[]}`,
 * `{"nope":1}` named a field the route does not accept, and `{"timezone":""}` named `timezone` after the empty string
 * had been dropped (`const timezone = body.timezone ? … : undefined`). The audit chain then claims a settings change
 * that never happened, and every reader of it has to trust a change record that can be empty.
 *
 * These tests are behavioural: each shape is sent to a real server, the owners row is compared before and after, and
 * the audit page is read the way an owner reads it.
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
  const audit = await req(base, "GET", `/v1/audit-events?subject=${subject}&limit=1000`, token);
  assert.equal(audit.status, 200, JSON.stringify(audit.body));
  return (audit.body.events as any[]).filter((e) => e.action === "owner.settings_updated");
}

test("a settings patch that writes nothing appends no audit row", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "settingsnoopaudit");
  const ownersRow = () => s.platform.db.prepare("SELECT * FROM owners WHERE id = ?").get(A.owner_id);
  const before = ownersRow();

  for (const body of [{}, { nope: 1 }, { timezone: "" }]) {
    const patched = await req(s.base, "PATCH", "/v1/me", A.owner.token, body);
    assert.equal(patched.status, 200, `PATCH ${JSON.stringify(body)} answered ${patched.status}: ${JSON.stringify(patched.body)}`);
    assert.deepEqual(ownersRow(), before, `PATCH ${JSON.stringify(body)} changed the owners row, so it was more than "nothing to write"`);
    const rows = await settingsAudits(s.base, A.owner.token, A.owner_id);
    assert.equal(
      rows.length,
      0,
      `PATCH ${JSON.stringify(body)}: nothing was written, yet ${rows.length} "updated account settings" row(s) exist: ${JSON.stringify(rows.map((e) => e.data))}`,
    );
  }
});
