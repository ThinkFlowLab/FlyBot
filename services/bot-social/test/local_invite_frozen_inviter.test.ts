import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

// A local-room ticket names a Bot of the minting home: that Bot is the one the link knocks on, and every claim writes
// reach with it. It therefore has to be able to hand reach out when the ticket is claimed, not only when it is minted.
// The two states are different answers everywhere else on the owner side: a frozen Bot is an emergency stop that can
// be resumed (`403 bot_frozen` / "this bot is frozen (emergency stop)"), a revoked one is gone for good
// (`403 bot_revoked` / "this bot identity was revoked"). Claiming must not read a stop as a removal.
//
// A refusal on this door is still a join attempt: it spends the same budget that ends in the account/address
// lockout, so an inviter that stays down cannot be retried for free.

async function req(base: string, method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  const json = text ? JSON.parse(text) : {};
  return { status: r.status, body: json.error ? json.error : json };
}
const tok = (o: { owner: { token: string } }) => o.owner.token;
const ROOM = "local-frozen-inviter-room";
const mint = (base: string, o: any) =>
  req(base, "POST", "/v1/local-room-invites", tok(o), { room_id: ROOM, name: "Launch plan", bot_id: o.bot.id });
const claim = (base: string, o: any, ticket: string, bots: string[]) =>
  req(base, "POST", `/v1/local-room-invites/${encodeURIComponent(ticket)}/claim`, tok(o), { bots });
const stop = (base: string, o: any) => req(base, "POST", "/v1/emergency-stop", tok(o), { bot_id: o.bot.id });

test("a ticket whose inviter was emergency-stopped answers bot_frozen, not bot_revoked", async (t) => {
  const s = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  t.after(s.stop);
  const host = await ownerWithBot(s.base, "lrinvhost");
  const guest = await ownerWithBot(s.base, "lrinvguest");
  const minted = await mint(s.base, host);
  assert.equal(minted.status, 201, JSON.stringify(minted.body));
  const stopped = await stop(s.base, host);
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.status, "frozen");

  const refused = await claim(s.base, guest, minted.body.ticket, [guest.bot.id]);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, "bot_frozen", "an emergency stop is resumable, so it is not a removal");
  assert.equal(refused.body.message, "this bot is frozen (emergency stop)");
});

test("an active inviter's ticket still claims", async (t) => {
  const s = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  t.after(s.stop);
  const host = await ownerWithBot(s.base, "lrlivhost");
  const guest = await ownerWithBot(s.base, "lrlivguest");
  const minted = await mint(s.base, host);
  assert.equal(minted.status, 201, JSON.stringify(minted.body));
  const claimed = await claim(s.base, guest, minted.body.ticket, [guest.bot.id]);
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.equal(claimed.body.claimed, true);
});

test("a ticket whose inviter was revoked keeps answering bot_revoked", async (t) => {
  const s = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  t.after(s.stop);
  const host = await ownerWithBot(s.base, "lrrevhost");
  const guest = await ownerWithBot(s.base, "lrrevguest");
  const minted = await mint(s.base, host);
  assert.equal(minted.status, 201, JSON.stringify(minted.body));
  // A removal reaches a Bot as a status change; the ticket it minted stays as it was, so only the claim itself can
  // notice that the Bot the link names is gone.
  s.platform.db.prepare("UPDATE bots SET status = 'revoked' WHERE id = ?").run(host.bot.id);
  const refused = await claim(s.base, guest, minted.body.ticket, [guest.bot.id]);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, "bot_revoked");
});

test("a frozen inviter's refusals still spend the join budget", async (t) => {
  const s = await startServer({ faceRooms: { attemptsPerAccount: 3, attemptsPerIp: 200 } });
  t.after(s.stop);
  const host = await ownerWithBot(s.base, "lrbudhost");
  const guest = await ownerWithBot(s.base, "lrbudguest");
  const minted = await mint(s.base, host);
  assert.equal(minted.status, 201, JSON.stringify(minted.body));
  await stop(s.base, host);
  for (let i = 0; i < 3; i++) {
    const refused = await claim(s.base, guest, minted.body.ticket, [guest.bot.id]);
    assert.equal(refused.status, 403, `attempt ${i + 1} is refused for the frozen inviter`);
    assert.equal(refused.body.code, "bot_frozen");
  }
  const budget = await claim(s.base, guest, minted.body.ticket, [guest.bot.id]);
  assert.equal(budget.status, 429, "the fourth attempt spends the budget");
  assert.equal(budget.body.code, "rate_limited");
  assert.equal(budget.body.scope, "account");
});

test("a frozen-inviter claim is refused while the home is locked out", async (t) => {
  const s = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200, failsBeforeLockout: 2 } });
  t.after(s.stop);
  const host = await ownerWithBot(s.base, "lrlockhost");
  const guest = await ownerWithBot(s.base, "lrlockguest");
  const minted = await mint(s.base, host);
  assert.equal(minted.status, 201, JSON.stringify(minted.body));
  await stop(s.base, host);
  for (let i = 0; i < 2; i++) {
    const bad = await req(s.base, "POST", "/v1/face-rooms/join", tok(guest), { code: "12345" });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, "invalid_code");
  }
  const refused = await claim(s.base, guest, minted.body.ticket, [guest.bot.id]);
  assert.equal(refused.status, 429);
  assert.equal(refused.body.code, "locked_out");
});
