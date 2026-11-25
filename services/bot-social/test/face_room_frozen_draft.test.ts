import assert from "node:assert/strict";
import { test } from "node:test";
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

/** Two owners, one Bot each, in one face room; returns the room id. */
async function room(base: string, code: string, ...owners: Awaited<ReturnType<typeof ownerWithBot>>[]) {
  let roomId = "";
  for (const o of owners) {
    const r = await req(base, "POST", "/v1/face-rooms/join", o.owner.token, { code, bots: [o.bot.id] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    roomId = r.body.room_id;
  }
  return roomId;
}

// The kill switch stops a Bot's outbound side everywhere: a friend's new chat is refused (test/frozen_bot_reach),
// and the home page's send-as-member answers 403 bot_frozen (#196). A face room is the third door a person types
// as their own Bot through, so it must name the stop the same way instead of taking the line and failing later.
test("a stopped Bot cannot draft into a face room from its owner's console", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const roomId = await room(s.base, "606061", A, B);

  const stop = await req(s.base, "POST", "/v1/emergency-stop", A.owner.token, { bot_id: A.bot.id });
  assert.equal(stop.status, 200, JSON.stringify(stop.body));

  const refused = await req(s.base, "POST", `/v1/face-rooms/${roomId}/messages`, A.owner.token, { text: "typed after the stop" });
  assert.equal(refused.status, 403, `drafting as a stopped Bot must be refused, got ${refused.status} ${JSON.stringify(refused.body)}`);
  assert.equal(refused.body.error?.code, "bot_frozen");
  assert.equal(refused.body.error?.message, "this bot is frozen (emergency stop)");

  // No card was held for a line that can never be approved, and nothing reached the room.
  const pending = await req(s.base, "GET", "/v1/approvals?status=pending", A.owner.token);
  assert.equal(pending.body.approvals.filter((a: any) => a.kind === "face_room_message").length, 0, JSON.stringify(pending.body));
  const seen = await req(s.base, "GET", `/v1/face-rooms/${roomId}`, B.owner.token);
  assert.equal(seen.status, 200, JSON.stringify(seen.body));
  assert.equal(seen.body.events.filter((e: any) => e.type === "room.message" && e.from?.handle === A.handle).length, 0);

  // Control: an active Bot still drafts from the same console.
  const ok = await req(s.base, "POST", `/v1/face-rooms/${roomId}/messages`, B.owner.token, { text: "an active line" });
  assert.equal(ok.status, 202, JSON.stringify(ok.body));
  assert.equal(ok.body.status, "pending_approval");
});

// With auto-send on, the draft is decided inside the same call. That path answered 409 invalid_state "the sending
// Bot was revoked" for a Bot that is only stopped, so a resumable Bot looked like a removed identity.
test("auto-send refuses a stopped Bot's face-room line with the same stop, not a removal", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const roomId = await room(s.base, "606062", A, B);
  for (const o of [A, B]) {
    const settings = await req(s.base, "PATCH", "/v1/me", o.owner.token, { auto_approve_face_rooms: true });
    assert.equal(settings.status, 200, JSON.stringify(settings.body));
    assert.equal(settings.body.auto_approve_face_rooms, true);
  }

  await req(s.base, "POST", "/v1/emergency-stop", A.owner.token, { bot_id: A.bot.id });

  const refused = await req(s.base, "POST", `/v1/face-rooms/${roomId}/messages`, A.owner.token, { text: "auto line from a stopped Bot" });
  assert.equal(refused.status, 403, `expected the stop, got ${refused.status} ${JSON.stringify(refused.body)}`);
  assert.equal(refused.body.error?.code, "bot_frozen");
  assert.equal(refused.body.error?.message, "this bot is frozen (emergency stop)");

  // Control: the same owner's active presence still auto-sends through this path.
  const ok = await req(s.base, "POST", `/v1/face-rooms/${roomId}/messages`, B.owner.token, { text: "auto line from an active Bot" });
  assert.equal(ok.status, 202, JSON.stringify(ok.body));
  assert.equal(ok.body.status, "delivered");
  assert.equal(ok.body.auto_approved, true);
});

// Control on a clean room: nothing here is about a stop, so an active Bot's line is still taken.
test("an active Bot still drafts into a face room from its owner's console", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const roomId = await room(s.base, "606063", A, B);
  const ok = await req(s.base, "POST", `/v1/face-rooms/${roomId}/messages`, A.owner.token, { text: "an ordinary line" });
  assert.equal(ok.status, 202, JSON.stringify(ok.body));
  assert.equal(ok.body.status, "pending_approval");
});
