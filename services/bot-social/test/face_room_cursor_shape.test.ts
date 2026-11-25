// The room read takes a cursor: the `event_cursor` the previous answer ended on. Only an honest cursor may be
// taken — a non-negative integer, or nothing at all. Today `?after=abc` and `?after=-1` are folded into "no
// cursor" and answer the whole window again (the same 200 a fresh reader gets), and `?after=1.5` is bound to
// `seq > 1.5`, so a malformed value silently half-applies instead of being refused.
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

/** A room with two seats and two events, read by its creator. */
async function room(t: any) {
  const S = await startServer();
  t.after(S.stop);
  const A = await ownerWithBot(S.base, "cur");
  const B = await ownerWithBot(S.base, "curb");
  const created = await req(S.base, "POST", "/v1/face-rooms/join", A.owner.token, { code: "737373", bots: [A.bot.id] });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const roomId = created.body.room_id as string;
  const joined = await req(S.base, "POST", "/v1/face-rooms/join", B.owner.token, { code: "737373", bots: [B.bot.id] });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  const read = await req(S.base, "GET", `/v1/face-rooms/${roomId}`, A.owner.token);
  assert.equal(read.body.events.length, 2, "the room has the two join events to page through");
  const last = read.body.events[read.body.events.length - 1].event_cursor as number;
  return { S, A, roomId, last };
}

test("a cursor that is not a non-negative integer is refused, not folded into 'start over'", async (t) => {
  const { S, A, roomId } = await room(t);
  for (const bad of ["abc", "-1", "1.5"]) {
    const r = await req(S.base, "GET", `/v1/face-rooms/${roomId}?after=${bad}`, A.owner.token);
    assert.equal(r.status, 400, `?after=${bad} is not a cursor: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error?.code, "invalid_request", `?after=${bad} names the refusal`);
  }
});

test("a real cursor, a zero and no cursor at all keep the paging they already had", async (t) => {
  const { S, A, roomId, last } = await room(t);

  const none = await req(S.base, "GET", `/v1/face-rooms/${roomId}`, A.owner.token);
  assert.equal(none.status, 200);
  assert.equal(none.body.events.length, 2, "no cursor answers the whole window it is allowed to read");

  const zero = await req(S.base, "GET", `/v1/face-rooms/${roomId}?after=0`, A.owner.token);
  assert.equal(zero.status, 200, JSON.stringify(zero.body));
  assert.equal(zero.body.events.length, 2, "a zero cursor is the start of the window");

  const atEnd = await req(S.base, "GET", `/v1/face-rooms/${roomId}?after=${last}`, A.owner.token);
  assert.equal(atEnd.status, 200, JSON.stringify(atEnd.body));
  assert.deepEqual(atEnd.body.events, [], "the last seen cursor answers nothing new");
  assert.equal(atEnd.body.event_cursor, last, "and it keeps the cursor it was given");
});

test("the join floor still wins over an older cursor: a late seat reads from its own join", async (t) => {
  const S = await startServer();
  t.after(S.stop);
  const A = await ownerWithBot(S.base, "fla");
  const created = await req(S.base, "POST", "/v1/face-rooms/join", A.owner.token, { code: "757575", bots: [A.bot.id] });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const roomId = created.body.room_id as string;
  // Four more seats fill the transcript up to seq 5, so the last one joins on seq 6.
  for (let i = 1; i <= 4; i++) {
    const o = await ownerWithBot(S.base, `flb${i}`);
    const j = await req(S.base, "POST", "/v1/face-rooms/join", o.owner.token, { code: "757575", bots: [o.bot.id] });
    assert.equal(j.status, 200, JSON.stringify(j.body));
  }
  const B = await ownerWithBot(S.base, "flc");
  const last = await req(S.base, "POST", "/v1/face-rooms/join", B.owner.token, { code: "757575", bots: [B.bot.id] });
  assert.equal(last.status, 200, JSON.stringify(last.body));
  assert.equal(last.body.event_cursor, 6, "this seat joined on seq 6");

  // A cursor that claims to be older than the seat can see is clamped to the seat's floor, never answered whole.
  for (const q of ["?after=0", "?after=3", "?after="]) {
    const r = await req(S.base, "GET", `/v1/face-rooms/${roomId}${q}`, B.owner.token);
    assert.equal(r.status, 200, `${q}: ${JSON.stringify(r.body)}`);
    assert.deepEqual(r.body.events.map((e: any) => e.event_cursor), [6], `${q} reads from this seat's join, not the room's start`);
  }

  const atEnd = await req(S.base, "GET", `/v1/face-rooms/${roomId}?after=6`, B.owner.token);
  assert.deepEqual(atEnd.body.events, [], "the last seen cursor answers nothing new");
});
