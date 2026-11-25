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

async function join(base: string, owner: { owner: { token: string }; bot: { id: string } }, code: string) {
  return req(base, "POST", "/v1/face-rooms/join", owner.owner.token, { code, bots: [owner.bot.id] });
}

test("a leave reaches the people still in the room and the person leaving, not everyone who ever was", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const C = await ownerWithBot(s.base, "cal");
  const code = "525252";
  const a = await join(s.base, A, code);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const b = await join(s.base, B, code);
  assert.equal(b.status, 200, JSON.stringify(b.body));
  const c = await join(s.base, C, code);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const roomId = a.body.room_id as string;

  const events = async (o: typeof A) => {
    const r = await o.owner.req("GET", "/v1/audit-events?limit=500");
    return (r.events as any[]).filter((e) => e.subject === roomId);
  };
  const leavesOf = (list: any[], botId: string) =>
    list.filter((e) => e.action === "face_room.left" && ((e.data?.bots ?? []) as string[]).includes(botId));

  const leftA = await req(s.base, "POST", `/v1/face-rooms/${roomId}/leave`, A.owner.token, {});
  assert.equal(leftA.status, 200, JSON.stringify(leftA.body));
  const aAfterOwnLeave = await events(A);
  assert.equal(leavesOf(aAfterOwnLeave, A.bot.id).length, 1, "the person leaving reads their own leave");

  const leftC = await req(s.base, "POST", `/v1/face-rooms/${roomId}/leave`, C.owner.token, {});
  assert.equal(leftC.status, 200, JSON.stringify(leftC.body));

  // A left before C did: C's leave must not land in A's audit view, and A's view must not grow at all.
  const aAfterCLeave = await events(A);
  assert.deepEqual(leavesOf(aAfterCLeave, C.bot.id), [], "C's leave reached the owner who left the room before C did");
  assert.equal(aAfterCLeave.length, aAfterOwnLeave.length, "the audit view of an owner who left grew when another member left");

  // Someone still in the room sees both leaves; each names exactly the bot that left.
  const bAfter = await events(B);
  const aLeave = leavesOf(bAfter, A.bot.id);
  const cLeave = leavesOf(bAfter, C.bot.id);
  assert.equal(aLeave.length, 1, "a member still in the room reads A's leave");
  assert.equal(cLeave.length, 1, "a member still in the room reads C's leave");
  assert.deepEqual(aLeave[0].data.bots, [A.bot.id]);
  assert.deepEqual(cLeave[0].data.bots, [C.bot.id]);
});
