import assert from "node:assert/strict";
import { test } from "node:test";
import { startServer } from "./helpers.js";

// The approval outlet (#147) is the owner's own Bot that new approval cards are announced to. A Bot removed from
// its home is `revoked`, a terminal state: its tokens are revoked and #177 keeps it from reading its event queue.
// Yet the outlet accepted a revoked Bot, and removing the current outlet left the setting pointing at it, so every
// later card was announced into a queue nobody can read and the owner never heard about it.

const req = async (base: string, method: string, path: string, token?: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
};

/** A FlyBot home plus its owner login token (connector tokens are refused on console REST routes). */
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

async function removeMember(base: string, token: string, homeId: string, memberId: string) {
  const r = await req(base, "DELETE", `/v1/homes/${homeId}/members/${memberId}`, token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, "revoked");
}

test("a revoked Bot cannot be the approval outlet", async () => {
  const { base, stop } = await startServer();
  try {
    const { ownerToken, homeId } = await flyHome(base, "nora");
    const outletId = await addMember(base, ownerToken, homeId, "outlet");
    await removeMember(base, ownerToken, homeId, outletId);

    const patched = await req(base, "PATCH", "/v1/me", ownerToken, { notify_bot_id: outletId });
    assert.equal(patched.status, 400, `a revoked Bot must not be accepted as the outlet, got ${patched.status} ${JSON.stringify(patched.body)}`);
    assert.equal(patched.body.error.code, "invalid_request");

    const me = await req(base, "GET", "/v1/me", ownerToken);
    assert.equal(me.body.notify_bot_id, null, "the refused update leaves the setting cleared");
  } finally { await stop(); }
});

test("removing the Bot that is the current outlet clears the setting", async () => {
  const { base, stop } = await startServer();
  try {
    const { ownerToken, homeId } = await flyHome(base, "olga");
    const outletId = await addMember(base, ownerToken, homeId, "outlet");
    const designated = await req(base, "PATCH", "/v1/me", ownerToken, { notify_bot_id: outletId });
    assert.equal(designated.status, 200, JSON.stringify(designated.body));
    assert.equal(designated.body.notify_bot_id, outletId);

    await removeMember(base, ownerToken, homeId, outletId);

    const me = await req(base, "GET", "/v1/me", ownerToken);
    assert.equal(me.body.notify_bot_id, null, "a revoked outlet is not left behind: nobody can read its queue");
  } finally { await stop(); }
});

test("a frozen Bot is still a valid outlet (its queue is read again after resume)", async () => {
  const { base, stop } = await startServer();
  try {
    const { ownerToken, homeId } = await flyHome(base, "pete");
    const outletId = await addMember(base, ownerToken, homeId, "outlet");
    const stopped = await req(base, "POST", "/v1/emergency-stop", ownerToken, { bot_id: outletId });
    assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
    assert.equal(stopped.body.status, "frozen");

    const patched = await req(base, "PATCH", "/v1/me", ownerToken, { notify_bot_id: outletId });
    assert.equal(patched.status, 200, `a frozen Bot can still be the outlet, got ${patched.status} ${JSON.stringify(patched.body)}`);
    assert.equal(patched.body.notify_bot_id, outletId);
  } finally { await stop(); }
});

test("a setting that already points at a revoked Bot announces nothing (defense in depth)", async () => {
  const { base, platform, stop } = await startServer();
  const db = platform as any;
  try {
    const { ownerToken, homeId } = await flyHome(base, "quinn");
    const outletId = await addMember(base, ownerToken, homeId, "outlet");
    const designated = await req(base, "PATCH", "/v1/me", ownerToken, { notify_bot_id: outletId });
    assert.equal(designated.status, 200, JSON.stringify(designated.body));

    // A setting written before this fix can point at a row that is already revoked.
    db.run("UPDATE bots SET status = 'revoked' WHERE id = ?", outletId);
    const ownerId = db.get("SELECT owner_id FROM bots WHERE id = ?", outletId).owner_id;
    db.run("INSERT INTO approvals (id, owner_id, kind, subject_id, bot_id, conversation_id, summary, reasons, risk_flags, hold_reason, created_at, expires_at, note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      "apr_outlet_test", ownerId, "outbound_message", outletId, outletId, null, "test card", "[]", "[]", null, new Date().toISOString(), new Date(Date.now() + 3600e3).toISOString(), null);

    assert.equal(db.notifyOwnerOfApproval("apr_outlet_test"), false, "nothing is announced to a revoked outlet");
    assert.equal(db.all("SELECT 1 FROM approval_notifications WHERE approval_id = ?", "apr_outlet_test").length, 0, "no approval_notifications row is written");
    assert.equal(db.all("SELECT 1 FROM events WHERE bot_id = ? AND type = 'approval.created'", outletId).length, 0, "no approval.created event is queued for it");
  } finally { await stop(); }
});
