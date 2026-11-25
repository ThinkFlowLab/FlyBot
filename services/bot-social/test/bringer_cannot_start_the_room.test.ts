import assert from "node:assert/strict";
import { test } from "node:test";
import { expectApiError, friends, ownerWithBot, startServer } from "./helpers.js";

/** A second Bot under the same home, so a friend can bring one in while the home keeps (or loses) a seat of its own. */
async function secondBot(owner: any, handle: string) {
  const r = await owner.req("POST", "/v1/bots", { handle });
  return r.bot_id as string;
}

async function befriend(a: any, b: any) {
  const rel = await a.owner.req("POST", "/v1/relationships", { from_bot_id: a.bot.id, target_handle: b.handle, message: "hi", requested_capabilities: ["chat.public"] });
  await b.owner.req("POST", `/v1/relationships/${rel.relationship_id}/consent`, { decision: "accept", grant_capabilities: [] });
}

test("a home that only brought another home's Bot in cannot start the room", async (t) => {
  const s = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const host = await secondBot(B.owner, "bob-host.bot");
  const created = await B.owner.req("POST", "/v1/face-rooms/join", { code: "313131", bots: [host] });
  const roomId = created.room_id as string;
  const joined = await A.owner.req("POST", "/v1/face-rooms/join", { code: "313131", bots: [B.bot.id] });
  assert.equal(joined.room_id, roomId, "Alice brought Bob's Bot into the same room");
  const before = await B.owner.req("GET", `/v1/face-rooms/${roomId}`);
  assert.ok(!before.members.some((m: any) => m.bot_id === A.bot.id), "Alice has no seat of her own in the room");

  await expectApiError(A.owner.req("POST", `/v1/face-rooms/${roomId}/start`), 404, "face_room_not_found");

  const after = await B.owner.req("GET", `/v1/face-rooms/${roomId}`);
  assert.equal(after.status, "candidate", "the refused start changed nothing");
  assert.equal(after.started_at, null);
  const C = await ownerWithBot(s.base, "carol");
  const viaNumber = await C.owner.req("POST", "/v1/face-rooms/join", { code: "313131" });
  assert.equal(viaNumber.room_id, roomId, "the number still opens the room");
});

test("a home with a seat of its own starts the room and the event names its own Bot", async (t) => {
  const s = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const host = await secondBot(B.owner, "bob-host.bot");
  const created = await B.owner.req("POST", "/v1/face-rooms/join", { code: "313131", bots: [host] });
  await A.owner.req("POST", "/v1/face-rooms/join", { code: "313131", bots: [B.bot.id, A.bot.id] });

  const started = await A.owner.req("POST", `/v1/face-rooms/${created.room_id}/start`);
  assert.equal(started.status, "open");
  const ev = started.events.find((e: any) => e.type === "room.started");
  assert.equal(ev.actor_bot, A.bot.id, "the start is attributed to the starter's own Bot, not the brought guest");
});

test("the brought guest's own home starts the room", async (t) => {
  const s = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const C = await ownerWithBot(s.base, "carol");
  await befriend(B, C);
  const created = await A.owner.req("POST", "/v1/face-rooms/join", { code: "242424", bots: [A.bot.id] });
  const brought = await B.owner.req("POST", "/v1/face-rooms/join", { code: "242424", bots: [C.bot.id] });
  assert.equal(brought.room_id, created.room_id);

  const started = await C.owner.req("POST", `/v1/face-rooms/${created.room_id}/start`);
  assert.equal(started.status, "open", "the guest's own home holds a seat and may start");
});

test("the room creator starts it and a second start stays idempotent", async (t) => {
  const s = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const created = await A.owner.req("POST", "/v1/face-rooms/join", { code: "464646", bots: [A.bot.id] });
  await B.owner.req("POST", "/v1/face-rooms/join", { code: "464646", bots: [B.bot.id] });

  const first = await A.owner.req("POST", `/v1/face-rooms/${created.room_id}/start`);
  assert.equal(first.status, "open");
  const second = await A.owner.req("POST", `/v1/face-rooms/${created.room_id}/start`);
  assert.equal(second.status, "open");
  assert.equal(second.started_at, first.started_at, "a second start does not move the room");
  assert.equal(second.events.filter((e: any) => e.type === "room.started").length, 1);
});
