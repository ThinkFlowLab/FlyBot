import assert from "node:assert/strict";
import { test } from "node:test";
import { startServer } from "./helpers.js";

// A pending row can be removed and later re-added by name; addHomeMember's existing-member branch flips the row back
// to `active` (revoked #173 or frozen by an emergency stop). Every other identity change in platform.ts is audited -
// home.member_added, home.member_revoked, bot.resumed, bot.emergency_stop - but that flip wrote nothing, so an audit
// reader saw the removal and then silence while the identity came back. An idempotent re-add of an active member is
// not a state change and must stay silent (FlyBot calls add_member on every start).

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
  return { ownerToken: login.body.owner_token as string, homeId: onboard.body.home.bot_id as string };
}

async function addMember(base: string, token: string, homeId: string, name: string) {
  const r = await req(base, "POST", `/v1/homes/${homeId}/members`, token, { name, display_name: name.toUpperCase() });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.bot_id as string;
}

async function auditEvents(base: string, token: string, subject: string) {
  const audit = await req(base, "GET", `/v1/audit-events?subject=${subject}`, token);
  assert.equal(audit.status, 200, JSON.stringify(audit.body));
  return audit.body.events as any[];
}

test("re-adding a removed member is audited as home.member_reactivated", async () => {
  const { base, stop } = await startServer();
  try {
    const { ownerToken, homeId } = await flyHome(base, "ruth");
    const memberId = await addMember(base, ownerToken, homeId, "writer");
    const removed = await req(base, "DELETE", `/v1/homes/${homeId}/members/${memberId}`, ownerToken);
    assert.equal(removed.status, 200, JSON.stringify(removed.body));

    const readded = await req(base, "POST", `/v1/homes/${homeId}/members`, ownerToken, { name: "writer" });
    assert.equal(readded.status, 201, JSON.stringify(readded.body));
    assert.equal(readded.body.reactivated, true);
    assert.equal(readded.body.status, "active");

    const events = await auditEvents(base, ownerToken, memberId);
    const reactivated = events.filter((e) => e.action === "home.member_reactivated");
    assert.equal(reactivated.length, 1, `the reactivation is audited once, saw ${JSON.stringify(events.map((e) => e.action))}`);
    assert.equal(reactivated[0].subject, memberId);
    assert.equal(reactivated[0].data.from, "revoked", "the audit names the state it came back from");
    assert.equal(events.some((e) => e.action === "home.member_revoked"), true, "the removal is still in the chain");
  } finally { await stop(); }
});

test("re-adding a frozen member is audited and names frozen as the state it left", async () => {
  const { base, stop } = await startServer();
  try {
    const { ownerToken, homeId } = await flyHome(base, "sam");
    const memberId = await addMember(base, ownerToken, homeId, "sleepy");
    const stopped = await req(base, "POST", "/v1/emergency-stop", ownerToken, { bot_id: memberId });
    assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
    assert.equal(stopped.body.status, "frozen");

    const readded = await req(base, "POST", `/v1/homes/${homeId}/members`, ownerToken, { name: "sleepy" });
    assert.equal(readded.status, 201, JSON.stringify(readded.body));
    assert.equal(readded.body.status, "active");

    const reactivated = (await auditEvents(base, ownerToken, memberId)).filter((e) => e.action === "home.member_reactivated");
    assert.equal(reactivated.length, 1, "the emergency stop being lifted is audited");
    assert.equal(reactivated[0].data.from, "frozen");
  } finally { await stop(); }
});

test("re-adding an active member stays silent (idempotent upsert, not a state change)", async () => {
  const { base, stop } = await startServer();
  try {
    const { ownerToken, homeId } = await flyHome(base, "tess");
    const memberId = await addMember(base, ownerToken, homeId, "busy");
    const again = await req(base, "POST", `/v1/homes/${homeId}/members`, ownerToken, { name: "busy" });
    assert.equal(again.status, 201, JSON.stringify(again.body));
    assert.equal(again.body.reactivated, true);

    const events = await auditEvents(base, ownerToken, memberId);
    assert.equal(events.filter((e) => e.action === "home.member_added").length, 1, "only the first add is home.member_added");
    assert.equal(events.some((e) => e.action === "home.member_reactivated"), false, "no reactivation entry for an already active member");
  } finally { await stop(); }
});
