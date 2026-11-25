/**
 * A role label reaches the other homes as `room.role_changed`, and the event names the Bot that changed: that is what
 * a transcript credits and what a member's console shows next to the line. The event was written with the calling
 * owner's first Bot instead — a room whose owners each seat one Bot cannot see the difference, but an owner with two
 * Bots in the room gets an event that credits the wrong one, so the roster change reads as if it happened to a Bot
 * nobody touched.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { generateEd25519 } from "../src/crypto.js";
import { ownerWithBot, startServer } from "./helpers.js";

async function req(base: string, method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}

test("a role change credits the Bot it relabelled, not the caller's first Bot", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  // Ann's second Bot: the one whose label this test writes.
  const kp = generateEd25519();
  const second = await A.owner.req("POST", "/v1/bots", { handle: `${A.handle.slice(1)}.two`, public_key: { alg: "Ed25519", kid: "k1", value: kp.publicKey } });
  const secondBotId = second.bot_id as string;
  const secondHandle = `@${A.handle.slice(1)}.two`;

  const a = await req(s.base, "POST", "/v1/face-rooms/join", A.owner.token, { code: "646464", bots: [A.bot.id] });
  await req(s.base, "POST", "/v1/face-rooms/join", A.owner.token, { code: "646464", bots: [secondBotId] });
  await req(s.base, "POST", "/v1/face-rooms/join", B.owner.token, { code: "646464", bots: [B.bot.id] });
  const roomId = a.body.room_id as string;
  const before = await req(s.base, "GET", `/v1/face-rooms/${roomId}`, B.owner.token);

  const put = await req(s.base, "PUT", `/v1/face-rooms/${roomId}/roles`, A.owner.token, { roles: { [secondHandle]: "Reviewer" } });
  assert.equal(put.status, 200);

  const view = await req(s.base, "GET", `/v1/face-rooms/${roomId}?after=${before.body.event_cursor}`, B.owner.token);
  const events = view.body.events as any[];
  assert.equal(events.length, 1, "one label change, one event");
  assert.equal(events[0].type, "room.role_changed");
  assert.equal(events[0].actor_bot, secondBotId, "the event names the Bot whose label changed, not the caller's first Bot");

  // The control: relabelling the caller's first Bot still credits it.
  const before2 = await req(s.base, "GET", `/v1/face-rooms/${roomId}`, B.owner.token);
  assert.equal((await req(s.base, "PUT", `/v1/face-rooms/${roomId}/roles`, A.owner.token, { roles: { [A.handle]: "Writer" } })).status, 200);
  const view2 = await req(s.base, "GET", `/v1/face-rooms/${roomId}?after=${before2.body.event_cursor}`, B.owner.token);
  assert.equal((view2.body.events as any[])[0].actor_bot, A.bot.id);
});
