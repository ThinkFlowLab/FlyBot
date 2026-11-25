import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

// A frozen (emergency-stopped) Bot and a revoked one are different answers on every invite path (#143): frozen is
// 403 `bot_frozen` / "this bot is frozen (emergency stop)" and resumable, revoked is 403 `bot_revoked` / "this bot
// identity was revoked". The two local-room invite doors name Bots too — minting a ticket with one, and claiming a
// ticket for one — so a stop must not read as a removal there either.

async function req(base: string, method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}
const tok = (o: { owner: { token: string } }) => o.owner.token;

test("minting a local-room ticket with a stopped Bot names the stop, not a removal", async () => {
  const s = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  try {
    const A = await ownerWithBot(s.base, "lrmint");
    await req(s.base, "POST", "/v1/emergency-stop", tok(A), { bot_id: A.bot.id });
    const mint = await req(s.base, "POST", "/v1/local-room-invites", tok(A), { room_id: "lr-mint-room", bot_id: A.bot.id });
    assert.equal(mint.status, 403);
    assert.equal(mint.body.error.code, "bot_frozen");
    assert.equal(mint.body.error.message, "this bot is frozen (emergency stop)");
  } finally { await s.stop(); }
});

test("claiming a local-room ticket with a stopped Bot names the stop too", async () => {
  const s = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  try {
    const host = await ownerWithBot(s.base, "lrhost");
    const guest = await ownerWithBot(s.base, "lrguest");
    const minted = await req(s.base, "POST", "/v1/local-room-invites", tok(host), { room_id: "lr-claim-room", bot_id: host.bot.id });
    assert.equal(minted.status, 201);
    await req(s.base, "POST", "/v1/emergency-stop", tok(guest), { bot_id: guest.bot.id });
    const claim = await req(s.base, "POST", `/v1/local-room-invites/${minted.body.ticket}/claim`, tok(guest), { bots: [guest.bot.id] });
    assert.equal(claim.status, 403);
    assert.equal(claim.body.error.code, "bot_frozen");
    assert.equal(claim.body.error.message, "this bot is frozen (emergency stop)");
  } finally { await s.stop(); }
});

test("an active Bot still mints and claims", async () => {
  const s = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  try {
    const host = await ownerWithBot(s.base, "lrhost");
    const guest = await ownerWithBot(s.base, "lrguest");
    const minted = await req(s.base, "POST", "/v1/local-room-invites", tok(host), { room_id: "lr-live-room", bot_id: host.bot.id });
    assert.equal(minted.status, 201);
    const claim = await req(s.base, "POST", `/v1/local-room-invites/${minted.body.ticket}/claim`, tok(guest), { bots: [guest.bot.id] });
    assert.equal(claim.status, 200);
    assert.equal(claim.body.claimed, true);
  } finally { await s.stop(); }
});
