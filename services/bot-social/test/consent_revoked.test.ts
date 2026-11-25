import assert from "node:assert/strict";
import { test } from "node:test";
import { startServer } from "./helpers.js";

// A pending relationship names two Bots; the card can wait for days while the target owner decides. A Bot removed
// from its FlyBot home is `revoked`, a terminal state: activeRelationship refuses every later reach, and #177 keeps
// it from reading its queue. consent() only checked the caller and the row, so Accept after a removal wrote an
// `active` friendship plus a full grant set for a dead identity and told both sides it was live; every message
// then answered 403 bot_revoked. The accept path must look at both Bots, as the rest of the identity line does.

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
  return { botId: r.body.bot_id as string, handle: r.body.handle as string };
}

/** A plain owner plus one REST Bot, the requester side of a pending_target request. */
async function plainOwner(base: string, name: string) {
  const reg = await req(base, "POST", "/v1/owners", undefined, { username: name, password: "secret-pw", display_name: name });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const ownerToken = reg.body.owner_token as string;
  const bot = await req(base, "POST", "/v1/bots", ownerToken, { handle: `${name}.bot`, display_name: name.toUpperCase() });
  assert.equal(bot.status, 201, JSON.stringify(bot.body));
  return { ownerToken, botId: bot.body.bot_id as string };
}

const auditActions = async (base: string, token: string, subject: string) => {
  const audit = await req(base, "GET", `/v1/audit-events?subject=${subject}`, token);
  assert.equal(audit.status, 200, JSON.stringify(audit.body));
  return (audit.body.events as any[]).map((e) => e.action as string);
};

test("a pending request cannot be accepted once its target Bot was removed", async () => {
  const { base, stop } = await startServer();
  try {
    const A = await plainOwner(base, "vera");
    const B = await flyHome(base, "walt");
    const target = await addMember(base, B.ownerToken, B.homeId, "writer");
    const asked = await req(base, "POST", "/v1/relationships", A.ownerToken, { from_bot_id: A.botId, target_handle: target.handle, requested_capabilities: ["chat.public"] });
    assert.equal(asked.status, 201, JSON.stringify(asked.body));
    assert.equal(asked.body.status, "pending_target");
    const relId = asked.body.relationship_id as string;

    const removed = await req(base, "DELETE", `/v1/homes/${B.homeId}/members/${target.botId}`, B.ownerToken);
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.equal(removed.body.status, "revoked");

    const accepted = await req(base, "POST", `/v1/relationships/${relId}/consent`, B.ownerToken, { decision: "accept", grant_capabilities: ["calendar.freebusy.read"] });
    assert.equal(accepted.status, 403, `accepting a request whose target was removed must be refused, got ${accepted.status} ${JSON.stringify(accepted.body)}`);
    assert.equal(accepted.body.error.code, "bot_revoked");

    const mine = await req(base, "GET", "/v1/relationships", B.ownerToken);
    const row = mine.body.relationships.find((r: any) => r.relationship_id === relId);
    assert.equal(row.status, "pending_target", "the row is not turned active");
    assert.deepEqual(row.capabilities.me_on_peer, [], "no grant is written for the requester");
    assert.deepEqual(row.capabilities.peer_on_me, [], "no grant is written for the revoked Bot");
    assert.equal((await auditActions(base, B.ownerToken, relId)).includes("relationship.accepted"), false, "no relationship.accepted is audited");

    const overview = await req(base, "GET", "/v1/friends-overview", A.ownerToken);
    assert.equal(overview.status, 200, JSON.stringify(overview.body));
    assert.equal(overview.body.friends.some((f: any) => f.bot_id === target.botId), false, "no active friend card is shown to the requester");
  } finally { await stop(); }
});

test("a pending request cannot be accepted once its requester Bot was removed", async () => {
  const { base, stop } = await startServer();
  try {
    const A = await flyHome(base, "xena");
    const B = await flyHome(base, "yuri");
    const requester = await addMember(base, A.ownerToken, A.homeId, "asker");
    const target = await addMember(base, B.ownerToken, B.homeId, "writer");
    const asked = await req(base, "POST", "/v1/relationships", A.ownerToken, { from_bot_id: requester.botId, target_handle: target.handle, requested_capabilities: ["chat.public"] });
    assert.equal(asked.status, 201, JSON.stringify(asked.body));
    const relId = asked.body.relationship_id as string;

    const removed = await req(base, "DELETE", `/v1/homes/${A.homeId}/members/${requester.botId}`, A.ownerToken);
    assert.equal(removed.status, 200, JSON.stringify(removed.body));

    const accepted = await req(base, "POST", `/v1/relationships/${relId}/consent`, B.ownerToken, { decision: "accept" });
    assert.equal(accepted.status, 403, `accepting a request whose requester was removed must be refused, got ${accepted.status} ${JSON.stringify(accepted.body)}`);
    assert.equal(accepted.body.error.code, "bot_revoked");

    const mine = await req(base, "GET", "/v1/relationships", B.ownerToken);
    assert.equal(mine.body.relationships.find((r: any) => r.relationship_id === relId).status, "pending_target");
  } finally { await stop(); }
});

test("a pending request between two live Bots still activates (unchanged behaviour)", async () => {
  const { base, stop } = await startServer();
  try {
    const A = await plainOwner(base, "zack");
    const B = await flyHome(base, "ada");
    const target = await addMember(base, B.ownerToken, B.homeId, "writer");
    const asked = await req(base, "POST", "/v1/relationships", A.ownerToken, { from_bot_id: A.botId, target_handle: target.handle, requested_capabilities: ["chat.public"] });
    assert.equal(asked.status, 201, JSON.stringify(asked.body));

    const accepted = await req(base, "POST", `/v1/relationships/${asked.body.relationship_id}/consent`, B.ownerToken, { decision: "accept", grant_capabilities: ["calendar.freebusy.read"] });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.status, "active");
    assert.equal(accepted.body.grants.length > 0, true, "the accepted friendship carries its grants");

    const mine = await req(base, "GET", "/v1/relationships", B.ownerToken);
    const row = mine.body.relationships.find((r: any) => r.relationship_id === asked.body.relationship_id);
    assert.equal(row.status, "active");
    assert.equal(row.capabilities.peer_on_me.some((g: any) => g.capability === "calendar.freebusy.read"), true);
  } finally { await stop(); }
});
