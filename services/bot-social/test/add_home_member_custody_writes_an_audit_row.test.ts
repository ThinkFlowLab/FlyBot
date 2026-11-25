// A FlyBot home can add a member whose signing key the platform then keeps: `addHomeMember` calls `storeCustody`,
// so a `bot_custody` row exists for that member. The audit chain said nothing about it — the only record the same
// fact produces elsewhere is `enable_custody`'s `bot.custody_enabled`, so a key entering custody through the member
// door was invisible to an audit reader. Both doors that add a member (REST `POST /v1/homes/:id/members` and the
// MCP tool `add_home_member`) must write exactly one record for the member, naming the stored kid and the mode,
// and the record must carry no secret material.
//
// Re-adding a name that is already an active member is the idempotent upsert FlyBot does on every start: it does
// not call `storeCustody` at all, so it must not add a second record.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startServer } from "./helpers.js";
import { mcp } from "./flybot_helpers.js";

const req = async (base: string, method: string, path: string, token?: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
};

async function flyHome(base: string, name: string) {
  const onboard = await req(base, "POST", "/v1/onboard/flybot", undefined, { username: name, password: "secret-pw", display_name: name });
  assert.equal(onboard.status, 201, JSON.stringify(onboard.body));
  const login = await req(base, "POST", "/v1/auth/login", undefined, { username: name, password: "secret-pw" });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return { ownerToken: login.body.owner_token as string, ownerId: onboard.body.owner_id as string, homeId: onboard.body.home.bot_id as string, connectorToken: onboard.body.connector.token as string };
}

/** `bot.custody_enabled` records written for one subject, in the order they were appended. */
const custodyRecords = (s: any, subject: string) => (s.platform.audit.db.prepare(
  "SELECT actor, subject, data FROM audit_events WHERE action = 'bot.custody_enabled' AND subject = ? ORDER BY seq",
).all(subject) as any[]).map((r) => ({ ...r, data: JSON.parse(r.data) }));

const storedKid = (s: any, botId: string) => (s.platform.db.prepare("SELECT kid FROM bot_custody WHERE bot_id = ?").get(botId) as any)?.kid;

test("adding a member over REST writes the member's custody record once", async () => {
  const s = await startServer();
  try {
    const { ownerToken, ownerId, homeId } = await flyHome(s.base, "custodian");

    const added = await req(s.base, "POST", `/v1/homes/${homeId}/members`, ownerToken, { name: "writer", display_name: "Writer" });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    const memberId = added.body.bot_id as string;

    const records = custodyRecords(s, memberId);
    assert.equal(records.length, 1, `the member's custody row has its own audit record, saw ${JSON.stringify(records)}`);
    assert.equal(records[0].actor, `owner:${ownerId}`, "the owner whose home keeps the key is the actor");
    assert.equal(records[0].data.kid, storedKid(s, memberId), "the record names the key that was stored");
    assert.equal(records[0].data.mode, "added");
    assert.deepEqual(Object.keys(records[0].data).sort(), ["kid", "mode"], "the record carries no key material");

    // The member's key is still the one in custody: this slice records the write, it does not change it.
    assert.ok(storedKid(s, memberId), "the custody row is written exactly as before");

    // FlyBot calls add_member on every start; an already-active name must not append a second record.
    const again = await req(s.base, "POST", `/v1/homes/${homeId}/members`, ownerToken, { name: "writer" });
    assert.equal(again.status, 201, JSON.stringify(again.body));
    assert.equal(again.body.reactivated, true);
    assert.equal(custodyRecords(s, memberId).length, 1, "the idempotent re-add writes no second record");
  } finally { await s.stop(); }
});

test("adding a member over the MCP tool writes the member's custody record once", async () => {
  const s = await startServer();
  try {
    const { ownerId, homeId, connectorToken } = await flyHome(s.base, "mcpkeeper");

    const added = await mcp(s.base, connectorToken, "add_home_member", { home: homeId, name: "coder", display_name: "Coder" });
    const memberId = (added as any).bot_id as string | undefined;
    assert.ok(memberId, `the tool registers the member, got ${JSON.stringify(added)}`);

    const records = custodyRecords(s, memberId!);
    assert.equal(records.length, 1, `the MCP door writes the same record, saw ${JSON.stringify(records)}`);
    assert.ok(records[0].actor.startsWith(`owner:${ownerId}`), `the home's owner is the actor, got ${records[0].actor}`);
    assert.equal(records[0].data.kid, storedKid(s, memberId!));
    assert.equal(records[0].data.mode, "added");
  } finally { await s.stop(); }
});
