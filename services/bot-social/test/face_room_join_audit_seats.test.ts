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

type Owner = { owner: { token: string; req: (method: string, path: string, body?: unknown) => Promise<any> }; bot: { id: string } };

async function secondBot(o: Owner, handle: string) {
  const r = await o.owner.req("POST", "/v1/bots", { handle });
  return { id: r.bot_id as string };
}

const joinedRows = async (o: Owner, roomId: string) =>
  ((await o.owner.req("GET", "/v1/audit-events?limit=500")).events as any[])
    .filter((e: any) => e.action === "face_room.joined" && e.subject === roomId);

const memberJoinedCount = async (o: Owner, roomId: string) =>
  ((await o.owner.req("GET", `/v1/face-rooms/${roomId}?after=0`)).events as any[])
    .filter((e: any) => e.type === "member.joined").length;

test("a repeat join of an already seated Bot writes no joined row", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");

  const first = await req(s.base, "POST", "/v1/face-rooms/join", A.owner.token, { code: "616161", bots: [A.bot.id] });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const roomId = first.body.room_id as string;
  assert.equal(await memberJoinedCount(A, roomId), 1, "the first join seated the Bot once");

  const again = await req(s.base, "POST", "/v1/face-rooms/join", A.owner.token, { code: "616161", bots: [A.bot.id] });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(await memberJoinedCount(A, roomId), 1, "the repeat join added no member");
  assert.deepEqual(await joinedRows(A, roomId), [], "the repeat join wrote no joined row");
});

test("a mixed join names only the Bot that took a seat", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "bea");
  const extra = await secondBot(A, "bea-extra.bot");

  const created = await req(s.base, "POST", "/v1/face-rooms/join", A.owner.token, { code: "626262", bots: [A.bot.id] });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const roomId = created.body.room_id as string;

  const mixed = await req(s.base, "POST", "/v1/face-rooms/join", A.owner.token, { code: "626262", bots: [A.bot.id, extra.id] });
  assert.equal(mixed.status, 200, JSON.stringify(mixed.body));
  assert.equal(await memberJoinedCount(A, roomId), 2, "the mixed join added exactly one member");

  const rows = await joinedRows(A, roomId);
  assert.equal(rows.length, 1, "the mixed join wrote exactly one joined row");
  assert.deepEqual(rows[0].data.bots, [extra.id], "the row names the Bot that took the seat, not the one already in it");
});

test("a ticket join names only the newcomers and keeps its ticket mark", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "cleo");
  const B = await ownerWithBot(s.base, "drew");
  const extra = await secondBot(B, "drew-extra.bot");

  const room = await req(s.base, "POST", "/v1/face-rooms/join", A.owner.token, { code: "636363", bots: [A.bot.id] });
  assert.equal(room.status, 200, JSON.stringify(room.body));
  const roomId = room.body.room_id as string;
  const minted = await req(s.base, "POST", `/v1/face-rooms/${roomId}/invites`, A.owner.token);
  assert.equal(minted.status, 201, JSON.stringify(minted.body));
  const ticket = minted.body.ticket as string;

  const first = await req(s.base, "POST", "/v1/face-rooms/join-invite", B.owner.token, { ticket, bots: [B.bot.id] });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal((await joinedRows(B, roomId)).length, 1, "the first ticket join wrote one row");

  const again = await req(s.base, "POST", "/v1/face-rooms/join-invite", B.owner.token, { ticket, bots: [B.bot.id] });
  assert.equal(again.status, 409, JSON.stringify(again.body));
  assert.equal(again.body.error.code, "already_member");
  assert.equal((await joinedRows(B, roomId)).length, 1, "the repeat ticket join wrote no row");

  const mixed = await req(s.base, "POST", "/v1/face-rooms/join-invite", B.owner.token, { ticket, bots: [B.bot.id, extra.id] });
  assert.equal(mixed.status, 200, JSON.stringify(mixed.body));
  const rows = await joinedRows(B, roomId);
  assert.equal(rows.length, 2, "the mixed ticket join wrote exactly one new row");
  const mixedRow = rows.find((e: any) => (e.data?.bots ?? []).includes(extra.id));
  assert.ok(mixedRow, "the row names the Bot that took the seat");
  assert.deepEqual(mixedRow.data.bots, [extra.id]);
  assert.equal(mixedRow.data.invite, true, "a ticket join is still marked as one");
});

test("a first join still writes one row that names the Bot and nothing else", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "nina");
  const B = await ownerWithBot(s.base, "otto");

  const room = await req(s.base, "POST", "/v1/face-rooms/join", A.owner.token, { code: "646464", bots: [A.bot.id] });
  assert.equal(room.status, 200, JSON.stringify(room.body));
  const roomId = room.body.room_id as string;
  const joined = await req(s.base, "POST", "/v1/face-rooms/join", B.owner.token, { code: "646464", bots: [B.bot.id] });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));

  const rows = await joinedRows(A, roomId);
  assert.equal(rows.length, 1, "the room-mate has exactly one joined row to read");
  assert.deepEqual(rows[0].data.bots, [B.bot.id]);
  assert.deepEqual(Object.keys(rows[0].data ?? {}).sort(), ["bots"], "a room-mate reads who joined, not where from");
});
