import assert from "node:assert/strict";
import { test } from "node:test";
import { expectApiError, ownerWithBot, startServer } from "./helpers.js";

let seq = 0;
const nextCode = () => String(770000 + ++seq);

const roomOpts = { attemptsPerAccount: 50, attemptsPerIp: 200, createsPerAccount: 50, createsPerIp: 200, invitesPerAccount: 50, invitesPerIp: 200 };

type Owner = Awaited<ReturnType<typeof ownerWithBot>>;

async function extraBot(A: Owner, handle: string) {
  const r = await A.owner.req("POST", "/v1/bots", { handle });
  return r.bot_id as string;
}

const count = (s: any, sql: string, ...args: unknown[]) => (s.platform.db.prepare(sql).get(...args) as any).n as number;

/** A refused join must leave no room, no code, no attempt and no audit row behind. */
async function assertNoResidue(s: any, A: Owner, code: string) {
  assert.equal(count(s, "SELECT COUNT(*) n FROM face_rooms WHERE code = ?", code), 0, "no room row");
  assert.equal(count(s, "SELECT COUNT(*) n FROM face_room_codes WHERE code = ?", code), 0, "no code row");
  assert.equal(count(s, "SELECT COUNT(*) n FROM face_room_attempts WHERE owner_id = ?", A.owner_id), 0, "no attempt row");
  const events = (await A.owner.req("GET", "/v1/audit-events?limit=500")).events as any[];
  assert.deepEqual(events.filter((e) => String(e.action).startsWith("face_room")), [], "no audit row");
}

test("an explicit empty bots list is refused before any room is written", async (t) => {
  const s = await startServer({ faceRooms: roomOpts });
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "join-empty");
  const named = await extraBot(A, "join-empty.named.bot");
  const code = nextCode();

  const err = await expectApiError(A.owner.req("POST", "/v1/face-rooms/join", { code, bots: [] }), 400, "invalid_request");
  assert.ok(err.message.endsWith("bots must name at least one Bot"), err.message);
  await assertNoResidue(s, A, code);
  assert.equal(count(s, "SELECT COUNT(*) n FROM face_room_members WHERE bot_id = ?", named), 0, "the named Bot was not seated");
});

test("a non-string element is refused instead of being coerced or looked up", async (t) => {
  const s = await startServer({ faceRooms: roomOpts });
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "join-elem");
  const named = await extraBot(A, "join-elem.named.bot");
  const shapes: unknown[] = [[{}], [true], [1.5], [0], [""], [[named]]];
  for (const bots of shapes) {
    const code = nextCode();
    const err = await expectApiError(A.owner.req("POST", "/v1/face-rooms/join", { code, bots }), 400, "invalid_request");
    assert.ok(err.message.endsWith("bots must be an array of strings"), `${JSON.stringify(bots)}: ${err.message}`);
    await assertNoResidue(s, A, code);
  }
});

test("the alias being used names the refused field", async (t) => {
  const s = await startServer({ faceRooms: roomOpts });
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "join-alias");

  let code = nextCode();
  let err = await expectApiError(A.owner.req("POST", "/v1/face-rooms/join", { code, handles: [] }), 400, "invalid_request");
  assert.ok(err.message.endsWith("handles must name at least one Bot"), err.message);
  await assertNoResidue(s, A, code);

  code = nextCode();
  err = await expectApiError(A.owner.req("POST", "/v1/face-rooms/join", { code, bot_id: {} }), 400, "invalid_request");
  assert.ok(err.message.endsWith("bot_id must be an array of strings"), err.message);
  await assertNoResidue(s, A, code);
});

test("naming a Bot, naming a handle, or naming nothing keeps today's answer", async (t) => {
  const s = await startServer({ faceRooms: roomOpts });
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "join-controls");
  const named = await extraBot(A, "join-controls.named.bot");

  const byId = await A.owner.req("POST", "/v1/face-rooms/join", { code: nextCode(), bots: [named] });
  assert.ok(byId.members.some((m: any) => m.bot_id === named), "an array of one real id seats that Bot");

  const byHandle = await A.owner.req("POST", "/v1/face-rooms/join", { code: nextCode(), bots: `@join-controls.named.bot` });
  assert.ok(byHandle.members.some((m: any) => m.bot_id === named), "a handle string still resolves");

  const absent = await A.owner.req("POST", "/v1/face-rooms/join", { code: nextCode() });
  assert.ok(absent.members.some((m: any) => m.bot_id === A.bot.id), "an absent list still seats the default member");

  const nulled = await A.owner.req("POST", "/v1/face-rooms/join", { code: nextCode(), bots: null });
  assert.ok(nulled.members.some((m: any) => m.bot_id === A.bot.id), "a null list still seats the default member");
});

test("the invite door refuses the same empty list before seating anyone", async (t) => {
  const s = await startServer({ faceRooms: roomOpts });
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "join-invite-host");
  const B = await ownerWithBot(s.base, "join-invite-guest");
  const room = await A.owner.req("POST", "/v1/face-rooms/join", { code: nextCode(), bots: [A.bot.id] });
  const roomId = room.room_id as string;
  const minted = await A.owner.req("POST", `/v1/face-rooms/${roomId}/invites`);
  const ticket = minted.ticket as string;

  const err = await expectApiError(B.owner.req("POST", "/v1/face-rooms/join-invite", { ticket, bots: [] }), 400, "invalid_request");
  assert.ok(err.message.endsWith("bots must name at least one Bot"), err.message);
  assert.equal(count(s, "SELECT COUNT(*) n FROM face_room_members WHERE room_id = ? AND bot_id = ?", roomId, B.bot.id), 0, "the guest Bot was not seated");
  assert.equal(count(s, "SELECT COUNT(*) n FROM face_room_attempts WHERE owner_id = ?", B.owner_id), 0, "no attempt row for the guest");
});
