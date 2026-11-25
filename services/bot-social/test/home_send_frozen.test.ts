import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

// The home page "send as member" acts as one of the owner's custodial Bots. A Bot that is emergency-stopped is
// resumable and every other owner-side door says so with `bot_frozen` (#143, #186); this one ended in one flat
// check for every non-active state, so the owner was told the identity had been revoked.

async function req(base: string, method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}

/** A FlyBot home with one custodial member, the owner's login token and an unrelated peer Bot. */
async function homeWithMember(base: string, name: string) {
  const peer = await ownerWithBot(base, `${name}peer`);
  const home = await req(base, "POST", "/v1/onboard/flybot", undefined, { display_name: name, username: `${name}own`, password: "secret-pw" });
  assert.equal(home.status, 201);
  const login = await req(base, "POST", "/v1/auth/login", undefined, { username: `${name}own`, password: "secret-pw" });
  const token = login.body.owner_token as string;
  const member = await req(base, "POST", `/v1/homes/${home.body.home.bot_id}/members`, token, { name: "writer", display_name: "Writer" });
  assert.equal(member.status, 201);
  // The two are friends before the stop, so a refused send can only be about the Bot's state.
  const rel = await req(base, "POST", "/v1/relationships", token, { from_bot_id: member.body.bot_id, target_handle: peer.handle, message: "hi", requested_capabilities: ["chat.public"] });
  assert.equal(rel.status, 201);
  await req(base, "POST", `/v1/relationships/${rel.body.relationship_id}/consent`, peer.owner.token, { decision: "accept", grant_capabilities: [{ capability: "chat.public" }] });
  return { peer, homeId: home.body.home.bot_id as string, token, memberId: member.body.bot_id as string };
}

test("sending as your own stopped member names the stop, not a removal", async () => {
  const s = await startServer();
  try {
    const h = await homeWithMember(s.base, "hsfrz");
    const stop = await req(s.base, "POST", "/v1/emergency-stop", h.token, { bot_id: h.memberId });
    assert.equal(stop.status, 200);
    const send = await req(s.base, "POST", `/v1/homes/${h.homeId}/send`, h.token, { from_bot_id: h.memberId, to: h.peer.handle, text: "hello from the home page" });
    assert.equal(send.status, 403);
    assert.equal(send.body.error.code, "bot_frozen");
    assert.equal(send.body.error.message, "this bot is frozen (emergency stop)");
  } finally { await s.stop(); }
});

test("an active member still sends from the home page", async () => {
  const s = await startServer();
  try {
    const h = await homeWithMember(s.base, "hslive");
    const send = await req(s.base, "POST", `/v1/homes/${h.homeId}/send`, h.token, { from_bot_id: h.memberId, to: h.peer.handle, text: "hello from the home page" });
    assert.equal(send.status, 202);
    assert.ok(send.body.message?.message_id);
  } finally { await s.stop(); }
});
