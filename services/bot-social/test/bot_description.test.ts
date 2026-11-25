import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";
import { req } from "./flybot_helpers.js";

const CARD = "Answers customer email in our shared inbox";

const setCard = (s: any, alice: any, description: unknown) =>
  req(s.base, "PATCH", `/v1/bots/${alice.bot.id}/profile`, alice.owner.token, { description });

test("a one-line card is trimmed, saved, and shown in the public invite preview and on a pending request", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const alice = await ownerWithBot(s.base, "alice");
  const bob = await ownerWithBot(s.base, "bob");

  const saved = await setCard(s, alice, `   ${CARD}   `);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.description, CARD, "the card is trimmed and returned by the update");

  // Anyone holding the invite link reads the card before any friendship exists.
  const inv = await alice.owner.req("POST", "/v1/invites", { bot_id: alice.bot.id, offered_capabilities: ["chat.public"], max_uses: 1, expires_in_hours: 24 });
  const preview = await req(s.base, "GET", `/v1/invites/${inv.code}`);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.inviter.description, CARD);

  // The invitee sees the card on their own pending request, still unaccepted.
  const ask = await bob.owner.req("POST", "/v1/relationships", { from_bot_id: bob.bot.id, target_handle: alice.handle, message: "hi", requested_capabilities: ["chat.public"] });
  assert.ok(["pending_target", "pending_requester_owner"].includes(ask.status), ask.status);
  const overview = await bob.owner.req("GET", "/v1/friends-overview");
  const pending = overview.pending_outgoing.find((x: any) => x.relationship_id === ask.relationship_id);
  assert.ok(pending, "the request is listed as pending");
  assert.equal(pending.peer.description, CARD, "the pending request shows the card before it is accepted");
});

test("1-280 chars is accepted, 281 is refused, and a blank or null card clears it", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const alice = await ownerWithBot(s.base, "alice");

  const max = await setCard(s, alice, "z".repeat(280));
  assert.equal(max.status, 200, JSON.stringify(max.body));
  assert.equal(max.body.description.length, 280);

  const over = await setCard(s, alice, "z".repeat(281));
  assert.equal(over.status, 400);
  assert.equal(over.body.error.code, "invalid_description");

  const blank = await setCard(s, alice, "   ");
  assert.equal(blank.status, 200, JSON.stringify(blank.body));
  assert.equal(blank.body.description, null);

  await setCard(s, alice, CARD);
  const cleared = await setCard(s, alice, null);
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.equal(cleared.body.description, null);
  const listed = await alice.owner.req("GET", "/v1/bots");
  assert.equal(listed.bots[0].description, null, "the cleared card reads back as null");
});

test("a Bot that never set a card reads null and keeps its existing fields", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const alice = await ownerWithBot(s.base, "alice");

  const prof = await alice.owner.req("GET", `/v1/bots/${alice.bot.id}/profile`);
  assert.equal(prof.description, null);

  const listed = await alice.owner.req("GET", "/v1/bots");
  const bot = listed.bots[0];
  assert.equal(bot.description, null);
  assert.equal(bot.handle, alice.handle.slice(1));
  assert.equal(bot.status, "active");
  assert.ok(bot.keys.length >= 1, "keys are still listed");

  const inv = await alice.owner.req("POST", "/v1/invites", { bot_id: alice.bot.id, offered_capabilities: ["chat.public"], max_uses: 1, expires_in_hours: 24 });
  const preview = await req(s.base, "GET", `/v1/invites/${inv.code}`);
  assert.equal(preview.body.inviter.description, null, "an unset card is a null field, not a crash");
});

test("the card and display_name/avatar are independent", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const alice = await ownerWithBot(s.base, "alice");

  const base = await req(s.base, "PATCH", `/v1/bots/${alice.bot.id}/profile`, alice.owner.token, { display_name: "Desk", avatar: "star" });
  assert.equal(base.status, 200, JSON.stringify(base.body));

  const card = await setCard(s, alice, CARD);
  assert.equal(card.body.display_name, "Desk", "setting the card leaves the name alone");
  assert.equal(card.body.avatar, "star", "setting the card leaves the avatar alone");
  assert.equal(card.body.description, CARD);

  const renamed = await req(s.base, "PATCH", `/v1/bots/${alice.bot.id}/profile`, alice.owner.token, { display_name: "Front desk" });
  assert.equal(renamed.body.description, CARD, "renaming leaves the card alone");
  const unlooked = await req(s.base, "PATCH", `/v1/bots/${alice.bot.id}/profile`, alice.owner.token, { avatar: null });
  assert.equal(unlooked.body.description, CARD, "clearing the avatar leaves the card alone");

  const prof = await alice.owner.req("GET", `/v1/bots/${alice.bot.id}/profile`);
  assert.equal(prof.description, CARD);
  assert.equal(prof.display_name, "Front desk");
  assert.equal(prof.avatar, null);
});
