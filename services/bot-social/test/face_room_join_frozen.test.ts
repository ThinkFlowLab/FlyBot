import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

// A Bot that is frozen (emergency-stopped) or revoked is refused by every invite path with its own code, and
// `assertInvitable` is the one place that says so: `bot_frozen` / "this bot is frozen (emergency stop)" for a
// stop, `bot_revoked` / "this bot identity was revoked" for a removal (#143). Both face-room doors are invite
// paths, so a named Bot that is only stopped must not be reported as an identity that was revoked: that copy
// tells the owner the Bot is gone, when resuming it is exactly what would let it join.

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

test("the 6-digit door reports a stopped Bot as frozen, not as revoked", async () => {
  const s = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  try {
    const host = await ownerWithBot(s.base, "frzhost");
    const guest = await ownerWithBot(s.base, "frzguest");
    const opened = await req(s.base, "POST", "/v1/face-rooms/join", tok(host), { code: "733101", bots: [host.bot.id] });
    assert.equal(opened.status, 200);
    assert.equal((await req(s.base, "POST", "/v1/emergency-stop", tok(guest), { bot_id: guest.bot.id })).status, 200);
    // The host's room waits for the guest's named Bot; the stop is the only reason it cannot enter.
    const join = await req(s.base, "POST", "/v1/face-rooms/join", tok(guest), { code: "733101", bots: [guest.bot.id] });
    assert.equal(join.status, 403);
    assert.equal(join.body.error.code, "bot_frozen");
    assert.equal(join.body.error.message, "this bot is frozen (emergency stop)");
  } finally { await s.stop(); }
});

test("the invite door reports a stopped Bot as frozen too", async () => {
  const s = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  try {
    const host = await ownerWithBot(s.base, "frzhost");
    const guest = await ownerWithBot(s.base, "frzguest");
    const opened = await req(s.base, "POST", "/v1/face-rooms/join", tok(host), { code: "733102", bots: [host.bot.id] });
    const minted = await req(s.base, "POST", `/v1/face-rooms/${opened.body.room_id}/invites`, tok(host));
    assert.equal(minted.status, 201);
    await req(s.base, "POST", "/v1/emergency-stop", tok(guest), { bot_id: guest.bot.id });
    const join = await req(s.base, "POST", "/v1/face-rooms/join-invite", tok(guest), { ticket: minted.body.ticket, bots: [guest.bot.id] });
    assert.equal(join.status, 403);
    assert.equal(join.body.error.code, "bot_frozen");
    assert.equal(join.body.error.message, "this bot is frozen (emergency stop)");
  } finally { await s.stop(); }
});

test("an active Bot still enters through both doors", async () => {
  const s = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  try {
    const host = await ownerWithBot(s.base, "frzhost");
    const guest = await ownerWithBot(s.base, "frzguest");
    const opened = await req(s.base, "POST", "/v1/face-rooms/join", tok(host), { code: "733103", bots: [host.bot.id] });
    const minted = await req(s.base, "POST", `/v1/face-rooms/${opened.body.room_id}/invites`, tok(host));
    const join = await req(s.base, "POST", "/v1/face-rooms/join-invite", tok(guest), { ticket: minted.body.ticket, bots: [guest.bot.id] });
    assert.equal(join.status, 200);
    assert.ok(join.body.members.some((m: any) => m.handle === guest.handle));
  } finally { await s.stop(); }
});
