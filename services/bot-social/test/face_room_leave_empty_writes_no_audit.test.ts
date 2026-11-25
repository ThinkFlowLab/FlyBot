import assert from "node:assert/strict";
import { test } from "node:test";
import { friends, startServer } from "./helpers.js";

async function req(base: string, method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}

/** B opens a room with a second Bot of its own; A joins the number bringing one of B's Bots, so A itself never sits. */
async function bringerWithoutSeat(base: string) {
  const { A, B } = await friends(base);
  const host = (await B.owner.req("POST", "/v1/bots", { handle: "bob-host.bot" })).bot_id as string;
  const created = await req(base, "POST", "/v1/face-rooms/join", B.owner.token, { code: "313131", bots: [host] });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const roomId = created.body.room_id as string;
  const brought = await req(base, "POST", "/v1/face-rooms/join", A.owner.token, { code: "313131", bots: [B.bot.id] });
  assert.equal(brought.status, 200, JSON.stringify(brought.body));
  return { A, B, roomId, host };
}

async function leftRows(o: { owner: { req: (m: string, p: string) => Promise<any> } }, roomId: string) {
  const { events } = await o.owner.req("GET", "/v1/audit-events?limit=500");
  return (events as any[]).filter((e) => e.action === "face_room.left" && e.subject === roomId);
}

test("a leave that removes nobody writes no face_room.left row", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, roomId } = await bringerWithoutSeat(s.base);

  const left = await req(s.base, "POST", `/v1/face-rooms/${roomId}/leave`, A.owner.token, {});
  assert.equal(left.status, 200, JSON.stringify(left.body));
  assert.deepEqual(left.body.left, [], "a home with no seat removes no Bot");

  assert.deepEqual(await leftRows(A, roomId), [], "a leave that removed nobody left a row in the room's audit trail");
});

test("a leave with a real seat still writes exactly one row naming that Bot", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A } = await friends(s.base);
  const created = await req(s.base, "POST", "/v1/face-rooms/join", A.owner.token, { code: "424242", bots: [A.bot.id] });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const roomId = created.body.room_id as string;

  const left = await req(s.base, "POST", `/v1/face-rooms/${roomId}/leave`, A.owner.token, {});
  assert.equal(left.status, 200, JSON.stringify(left.body));
  assert.deepEqual(left.body.left, [A.handle]);

  const rows = await leftRows(A, roomId);
  assert.equal(rows.length, 1, "the seat that left is named once");
  assert.deepEqual(rows[0].data.bots, [A.bot.id], "the row names the Bot that left");
});

test("naming a Bot that owns a seat, from a home with no seat, is still refused and writes no row", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B, roomId } = await bringerWithoutSeat(s.base);

  const refused = await req(s.base, "POST", `/v1/face-rooms/${roomId}/leave`, A.owner.token, { bots: [B.bot.id] });
  assert.equal(refused.status, 404, JSON.stringify(refused.body));
  assert.equal(refused.body.error.code, "bot_not_found");

  assert.deepEqual(await leftRows(A, roomId), [], "a refused leave wrote no row");
});
