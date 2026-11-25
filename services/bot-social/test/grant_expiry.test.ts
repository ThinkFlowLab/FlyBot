import assert from "node:assert/strict";
import { test } from "node:test";
import { expectApiError, ownerWithBot, startServer } from "./helpers.js";

const DAY = 86400e3;
const approxDays = (iso: string) => (Date.parse(iso) - Date.now()) / DAY;

/** Alice and Bob are friends; Bob's owner holds the grants that let Alice's bot talk to Bob's. */
async function pair(t: any) {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "alice");
  const B = await ownerWithBot(s.base, "bob");
  const rel = await A.owner.req("POST", "/v1/relationships", { from_bot_id: A.bot.id, target_handle: B.handle, message: "hi", requested_capabilities: ["chat.public"] });
  await B.owner.req("POST", `/v1/relationships/${rel.relationship_id}/consent`, { decision: "accept", grant_capabilities: [] });
  const relId = rel.relationship_id as string;
  const grant = (body: any) => B.owner.req("POST", `/v1/relationships/${relId}/grants`, body);
  /** The grant Alice's bot holds, as `GET /v1/relationships` shows it to Alice. */
  const mineOnPeer = async (cap: string) => {
    const r = await A.owner.req("GET", "/v1/relationships");
    const row = r.relationships.find((x: any) => x.relationship_id === relId);
    return row.capabilities.me_on_peer.find((g: any) => g.capability === cap);
  };
  const chat = () => A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "hi" });
  const active = (cap: string) => (s.platform.db.prepare("SELECT COUNT(*) n FROM grants WHERE relationship_id = ? AND grantee_bot = ? AND capability = ? AND status = 'active'").get(relId, A.bot.id, cap) as any).n as number;
  return { s, A, B, relId, grant, mineOnPeer, chat, active };
}

test("a re-grant with a non-numeric expires_in_days is a 400 and cannot take the live grant down", async (t) => {
  const { grant, mineOnPeer, chat, active } = await pair(t);
  const first = await grant({ capability: "chat.public", expires_in_days: 30 });
  assert.equal(first.status, "active");
  assert.ok((await chat()).conversation_id, "control: the 30-day grant is usable");

  for (const bad of ["abc", {}, "1e999", 999999999999]) {
    const err = await expectApiError(grant({ capability: "chat.public", expires_in_days: bad }), 400, "invalid_request");
    assert.equal(err.status, 400);
    assert.ok(await mineOnPeer("chat.public"), `chat.public is gone from /v1/relationships after expires_in_days=${JSON.stringify(bad)}`);
    assert.equal(active("chat.public"), 1, `the old chat.public grant is no longer active after expires_in_days=${JSON.stringify(bad)}`);
    assert.ok((await chat()).conversation_id, `chat stopped working after expires_in_days=${JSON.stringify(bad)}`);
  }
});

test("a re-grant with zero or a negative expires_in_days is a 400, not a live-looking dead grant", async (t) => {
  const { grant, mineOnPeer, active } = await pair(t);
  await grant({ capability: "chat.public", expires_in_days: 30 });

  for (const bad of [-5, 0, "", []]) {
    await expectApiError(grant({ capability: "chat.public", expires_in_days: bad }), 400, "invalid_request");
    assert.ok(await mineOnPeer("chat.public"), `chat.public is gone from /v1/relationships after expires_in_days=${JSON.stringify(bad)}`);
    assert.equal(active("chat.public"), 1, `the old chat.public grant is no longer active after expires_in_days=${JSON.stringify(bad)}`);
  }
  const cap = await mineOnPeer("chat.public");
  assert.ok(approxDays(cap.expires_at) > 29, `still the 30-day grant, not a shorter one: ${cap.expires_at}`);
});

test("a bad edited expires_in_days on a grant request is a 400, the approval stays pending and the old grant lives", async (t) => {
  const { A, B, relId, grant, mineOnPeer, chat, active } = await pair(t);
  await grant({ capability: "chat.public", expires_in_days: 30 });
  const profileBefore = active("profile.read");

  const req = await A.bot.signed("/v1/grant-requests", "grant.request", { relationship_id: relId, capability: "profile.read" });
  assert.equal(req.status, "pending_owner_approval");
  const apr = req.approval_id as string;
  await expectApiError(B.owner.req("POST", `/v1/approvals/${apr}/decision`, { decision: "approved_with_edits", edited_params: { expires_in_days: "abc" } }), 400, "invalid_request");

  const pending = await B.owner.req("GET", "/v1/approvals?status=pending");
  assert.ok(pending.approvals.some((a: any) => a.approval_id === apr), "the approval was decided; a refused edit must leave it pending");
  assert.ok(await mineOnPeer("chat.public"), "the old chat.public grant is gone from /v1/relationships");
  assert.equal(active("chat.public"), 1, "the old chat.public grant is no longer active");
  assert.equal(active("profile.read"), profileBefore, "a grant was written for the refused request");
  assert.ok((await chat()).conversation_id);
});

test("a valid grant is stored, listed on both endpoints and usable; omitted days means 90", async (t) => {
  const { A, B, grant, mineOnPeer, chat } = await pair(t);
  const created = await grant({ capability: "chat.public", expires_in_days: 30 });
  assert.equal(created.status, "active");

  const cap = await mineOnPeer("chat.public");
  assert.ok(approxDays(cap.expires_at) > 29 && approxDays(cap.expires_at) < 31, `expected about 30 days, got ${cap.expires_at}`);
  const botGrants = await B.owner.req("GET", `/v1/bots/${B.bot.id}/grants`);
  assert.ok(botGrants.grants.some((g: any) => g.grantee.handle === A.handle && g.capabilities.includes("chat.public")), JSON.stringify(botGrants.grants));
  assert.ok((await chat()).conversation_id, "control: a 30-day grant is usable");

  await grant({ capability: "chat.public" });
  const fallback = await mineOnPeer("chat.public");
  assert.ok(approxDays(fallback.expires_at) > 89 && approxDays(fallback.expires_at) < 91, `expected the 90-day default, got ${fallback.expires_at}`);
});

test("a grant whose expiry has passed is absent from both the relationship and the bot-grant list", async (t) => {
  const { s, A, B, grant, mineOnPeer } = await pair(t);
  const created = await grant({ capability: "chat.public", expires_in_days: 30 });
  s.platform.db.prepare("UPDATE grants SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 3600e3).toISOString(), created.grant_id);

  assert.equal(await mineOnPeer("chat.public"), undefined, "GET /v1/relationships lists a grant whose expiry has passed");
  const botGrants = await B.owner.req("GET", `/v1/bots/${B.bot.id}/grants`);
  const listed = botGrants.grants.some((g: any) => g.grantee.handle === A.handle && g.capabilities.includes("chat.public"));
  assert.equal(listed, false, "GET /v1/bots/:id/grants lists a grant whose expiry has passed");
});
