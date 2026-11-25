import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

async function req(base: string, method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  const json = text ? JSON.parse(text) : {};
  return { status: r.status, body: json };
}
const tok = (o: { owner: { token: string } }) => o.owner.token;
const join = (base: string, o: { owner: { token: string }; bot: { id: string } }, code: string, ip?: string) =>
  req(base, "POST", "/v1/face-rooms/join", tok(o), { code, bots: [o.bot.id] }, ip ? { "x-forwarded-for": ip } : {});
const mint = (base: string, o: { owner: { token: string } }, roomId: string) =>
  req(base, "POST", `/v1/face-rooms/${roomId}/invites`, tok(o));
const joinInvite = (base: string, o: { owner: { token: string }; bot: { id: string } }, ticket: string, ip?: string) =>
  req(base, "POST", "/v1/face-rooms/join-invite", tok(o), { ticket, bots: [o.bot.id] }, ip ? { "x-forwarded-for": ip } : {});

type Owner = { owner: { token: string; req: (method: string, path: string, body?: unknown) => Promise<any> }; bot: { id: string } };
const auditRows = async (o: Owner, action: string): Promise<any[]> =>
  ((await o.owner.req("GET", "/v1/audit-events?limit=200")).events as any[]).filter((e: any) => e.action === action);
const keysOf = (e: any) => Object.keys(e.data ?? {}).sort();

test("the row a room-mate can read about your join does not carry your address", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "nina");
  const B = await ownerWithBot(s.base, "otto");
  const a = await join(s.base, A, "525252", "198.51.100.7");
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const b = await join(s.base, B, "525252", "203.0.113.9");
  assert.equal(b.status, 200, JSON.stringify(b.body));

  const seen = (await auditRows(A, "face_room.joined")).filter((e: any) => (e.data?.bots ?? []).includes(B.bot.id));
  assert.equal(seen.length, 1, "the room-mate has exactly one joined row to read");
  assert.deepEqual(keysOf(seen[0]), ["bots"], "a room-mate reads who joined, not where from");
});

test("the creator's own row still says the address it was created from", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "pia");
  const B = await ownerWithBot(s.base, "quin");
  const a = await join(s.base, A, "535353", "198.51.100.7");
  assert.equal(a.status, 200, JSON.stringify(a.body));
  await join(s.base, B, "535353", "203.0.113.9");

  const created = await auditRows(A, "face_room.created");
  assert.equal(created.length, 1);
  assert.equal(created[0].data.ip, "198.51.100.7", "the creator still sees the address of the creation");
  assert.deepEqual(created[0].data.bots, [A.bot.id]);
});

test("a lockout row stays with the locked owner and keeps its address", async (t) => {
  const s = await startServer({ faceRooms: { failsBeforeLockout: 2, attemptsPerAccount: 20 } });
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "rosa");
  const B = await ownerWithBot(s.base, "sven");
  const aIp = "198.51.100.10";
  assert.equal((await join(s.base, A, "141414", aIp)).status, 200);
  assert.equal((await join(s.base, B, "141414", "198.51.100.11")).status, 200);
  assert.equal((await join(s.base, A, "12", aIp)).status, 400);
  assert.equal((await join(s.base, A, "34", aIp)).status, 400);
  const locked = await join(s.base, A, "56", aIp);
  assert.equal(locked.status, 429);
  assert.equal(locked.body.error.code, "locked_out");

  const mine = await auditRows(A, "face_room.lockout");
  assert.equal(mine.length, 1);
  assert.equal(mine[0].data.ip, aIp, "the locked owner still sees the address that was locked out");
  assert.equal((await auditRows(B, "face_room.lockout")).length, 0, "the room-mate never sees it");
});

test("a join through a ticket carries the bots and the fact it was a ticket, nothing else", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "tina");
  const B = await ownerWithBot(s.base, "umar");
  const room = await join(s.base, A, "545454", "198.51.100.7");
  assert.equal(room.status, 200, JSON.stringify(room.body));
  const m = await mint(s.base, A, room.body.room_id);
  assert.equal(m.status, 201, JSON.stringify(m.body));
  const b = await joinInvite(s.base, B, m.body.ticket, "203.0.113.30");
  assert.equal(b.status, 200, JSON.stringify(b.body));

  const seen = (await auditRows(A, "face_room.joined")).filter((e: any) => (e.data?.bots ?? []).includes(B.bot.id));
  assert.equal(seen.length, 1);
  assert.deepEqual(keysOf(seen[0]), ["bots", "invite"], "a ticket join is still marked as one, minus the address");
  assert.equal(seen[0].data.invite, true);
});
