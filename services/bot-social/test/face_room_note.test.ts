// bot-social #421: a face room's note says what the room is for; it is room metadata, not a transcript line, so a Bot
// that joins after it was written still reads it.
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
type Who = Awaited<ReturnType<typeof ownerWithBot>>;
const join = (base: string, o: Who, code: string, bots: string[] = [o.bot.id]) => req(base, "POST", "/v1/face-rooms/join", o.owner.token, { code, bots });
const view = (base: string, o: Who, roomId: string, after?: number) => req(base, "GET", `/v1/face-rooms/${roomId}${after !== undefined ? `?after=${after}` : ""}`, o.owner.token);
const setLead = (base: string, o: Who, roomId: string, bot: string | null) => req(base, "POST", `/v1/face-rooms/${roomId}/lead`, o.owner.token, { bot });
const setNote = (base: string, o: Who, roomId: string, note: unknown, token = o.owner.token) => req(base, "POST", `/v1/face-rooms/${roomId}/note`, token, { note });

/** Ann creates the room, so the default lead is Ann's Bot; Ben joins the same code. */
async function twoHomeRoom(t: any, code = "636363") {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const a = await join(s.base, A, code);
  assert.equal(a.status, 200);
  assert.equal((await join(s.base, B, code)).status, 200);
  return { s, A, B, roomId: a.body.room_id as string };
}

test("a member who joins later reads the note while the lines above its seat stay hidden", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const a = await join(s.base, A, "646464");
  assert.equal(a.status, 200);
  const roomId = a.body.room_id as string;
  // A line that exists before Ben takes a seat: Ann pins the lead explicitly.
  assert.equal((await setLead(s.base, A, roomId, A.handle)).status, 200);
  const note = "Saturday planning: two Bots draft, owners approve.";
  const put = await setNote(s.base, A, roomId, note);
  assert.equal(put.status, 200);
  assert.equal(put.body.note, note);
  assert.equal((await join(s.base, B, "646464")).status, 200);
  const late = await view(s.base, B, roomId);
  assert.equal(late.status, 200);
  assert.equal(late.body.note, note, "a Bot that joined after the note still reads it");
  assert.ok(
    late.body.events.every((e: any) => e.type === "member.joined" && e.member.bot_id === B.bot.id),
    "nothing above the later member's floor comes back with the note",
  );
  assert.ok(!late.body.events.some((e: any) => e.type === "room.lead_changed"), "the earlier lead change is not part of its view");
});

test("only the room lead writes the note", async (t) => {
  const { s, A, B, roomId } = await twoHomeRoom(t);
  const denied = await setNote(s.base, B, roomId, "Ben's note");
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, "not_lead");
  const byLeadBot = await setNote(s.base, A, roomId, "Ann's Bot writes it", A.reg.bot_token);
  assert.equal(byLeadBot.status, 200);
  assert.equal(byLeadBot.body.note, "Ann's Bot writes it");
  const outsider = await ownerWithBot(s.base, "cy");
  assert.equal((await setNote(s.base, outsider, roomId, "nope")).status, 404);
});

test("the note is trimmed and kept between 1 and 500 characters", async (t) => {
  const { s, A, roomId } = await twoHomeRoom(t, "656565");
  const blank = await setNote(s.base, A, roomId, "   ");
  assert.equal(blank.status, 400);
  assert.equal(blank.body.error.code, "invalid_note");
  assert.equal((await setNote(s.base, A, roomId, "")).status, 400);
  assert.equal((await setNote(s.base, A, roomId, 7)).status, 400);
  const max = "x".repeat(500);
  const ok = await setNote(s.base, A, roomId, max);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.note, max);
  const tooLong = await setNote(s.base, A, roomId, "x".repeat(501));
  assert.equal(tooLong.status, 400);
  assert.equal(tooLong.body.error.code, "invalid_note");
  const trimmed = await setNote(s.base, A, roomId, "  what this room is for  ");
  assert.equal(trimmed.status, 200);
  assert.equal(trimmed.body.note, "what this room is for");
});

test("a note is room metadata: writing it moves no cursor and adds no transcript line", async (t) => {
  const { s, A, B, roomId } = await twoHomeRoom(t, "666666");
  const beforeA = await view(s.base, A, roomId);
  const beforeB = await view(s.base, B, roomId);
  const put = await setNote(s.base, A, roomId, "Notes live on the room, not in the conversation.");
  assert.equal(put.status, 200);
  assert.equal(put.body.event_cursor, beforeA.body.event_cursor, "the writer's cursor does not move");
  assert.equal(put.body.events.length, beforeA.body.events.length);
  const afterA = await view(s.base, A, roomId);
  const afterB = await view(s.base, B, roomId);
  assert.equal(afterA.body.event_cursor, beforeA.body.event_cursor);
  assert.equal(afterB.body.event_cursor, beforeB.body.event_cursor);
  assert.equal(afterA.body.events.length, beforeA.body.events.length);
  assert.equal(afterB.body.events.length, beforeB.body.events.length);
  assert.deepEqual((await view(s.base, A, roomId, beforeA.body.event_cursor)).body.events, []);
  assert.deepEqual((await view(s.base, B, roomId, beforeB.body.event_cursor)).body.events, []);
  assert.equal(afterB.body.note, "Notes live on the room, not in the conversation.");
});
