/**
 * A room's note is written by its lead for everyone in the room, so it is the lead's outbound act: a lead that was
 * stopped or removed must not keep writing it.
 *
 * The line door already answers that question for the same Bot (`403 bot_frozen` / `403 bot_revoked` from the
 * invitable check every outbound door uses); the note door did not, so the owner of a stopped lead could still put
 * up to 500 characters in front of every other owner in the room, and the room kept handing that Bot the lead label.
 * The guard belongs where the row is written, before the `face_rooms.note` update, and the rest of the door keeps
 * its order: a member check, a lead check, then the closed-room refusal, then the note's own validation.
 */
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
const join = (base: string, o: Who, code: string) => req(base, "POST", "/v1/face-rooms/join", o.owner.token, { code, bots: [o.bot.id] });
const setNote = (base: string, o: Who, roomId: string, note: string) => req(base, "POST", `/v1/face-rooms/${roomId}/note`, o.owner.token, { note });
const view = (base: string, o: Who, roomId: string) => req(base, "GET", `/v1/face-rooms/${roomId}`, o.owner.token);
const stopBot = (base: string, o: Who) => req(base, "POST", "/v1/emergency-stop", o.owner.token, { bot_id: o.bot.id });
const rowNote = (s: any, roomId: string) => (s.platform.db.prepare("SELECT note FROM face_rooms WHERE id = ?").get(roomId) as any).note;

/** Ann creates the room (so her Bot is its default lead) and Ben joins it. `open` starts the matching room. */
async function twoHomeRoom(t: any, code: string, open = true) {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const a = await join(s.base, A, code);
  assert.equal(a.status, 200);
  assert.equal((await join(s.base, B, code)).status, 200);
  const roomId = a.body.room_id as string;
  if (open) {
    const started = await req(s.base, "POST", `/v1/face-rooms/${roomId}/start`, A.owner.token, {});
    assert.equal(started.status, 200);
    assert.equal(started.body.status, "open");
  }
  return { s, A, B, roomId };
}

test("a stopped lead cannot write the room note", async (t) => {
  const { s, A, B, roomId } = await twoHomeRoom(t, "741111");
  assert.equal((await setNote(s.base, A, roomId, "what the room is for")).status, 200);
  assert.equal((await stopBot(s.base, A)).body.status, "frozen");

  const refused: any = await setNote(s.base, A, roomId, "written after the lead was stopped");
  assert.equal(refused.status, 403, "a stopped lead is refused, not answered with a written note");
  assert.equal(refused.body.error?.code, "bot_frozen", "the refusal names the stop");
  assert.equal(rowNote(s, roomId), "what the room is for", "the note the room already had is untouched");
  const guest: any = await view(s.base, B, roomId);
  assert.equal(guest.body.note, "what the room is for", "another owner in the room never reads the refused text");
});

test("a removed lead cannot write the room note either", async (t) => {
  const { s, A, B, roomId } = await twoHomeRoom(t, "742222");
  // A revoked Bot no longer holds a seat on this build, so the seat left behind is the torn state an older build
  // leaves: the identity is gone, the room still lists it as its lead. The door must refuse it by name.
  s.platform.db.prepare("UPDATE bots SET status = 'revoked' WHERE id = ?").run(A.bot.id);

  const refused: any = await setNote(s.base, A, roomId, "written after the lead was removed");
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error?.code, "bot_revoked", "the refusal names the removal");
  assert.equal(rowNote(s, roomId), null, "nothing was written for the room");
  assert.equal((await view(s.base, B, roomId)).body.note, null);
});

test("the same holds for a room whose matching window has not been started yet", async (t) => {
  const { s, A, roomId } = await twoHomeRoom(t, "743333", false);
  assert.equal((await stopBot(s.base, A)).body.status, "frozen");

  const refused: any = await setNote(s.base, A, roomId, "written while the lead is stopped");
  assert.equal(refused.status, 403, "a waiting room is not a way around the stop");
  assert.equal(refused.body.error?.code, "bot_frozen");
  assert.equal(rowNote(s, roomId), null);
});

test("control: an active lead still writes the note, and the room shows it to everyone", async (t) => {
  const { s, A, B, roomId } = await twoHomeRoom(t, "744444");
  const put: any = await setNote(s.base, A, roomId, "Saturday planning: two Bots draft, owners approve.");
  assert.equal(put.status, 200);
  assert.equal(put.body.note, "Saturday planning: two Bots draft, owners approve.");
  const guest: any = await view(s.base, B, roomId);
  assert.equal(guest.body.note, "Saturday planning: two Bots draft, owners approve.");
  assert.equal(guest.body.effective_lead_bot_handle, A.handle, "the active lead is still the lead");
});

test("control: a member who is not the lead is still refused by the lead check", async (t) => {
  const { s, A, B, roomId } = await twoHomeRoom(t, "745555");
  const denied: any = await setNote(s.base, B, roomId, "ben's note");
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error?.code, "not_lead", "the lead check keeps its own answer");
  assert.equal(rowNote(s, roomId), null);
  assert.equal((await setNote(s.base, A, roomId, "ann's note")).status, 200);
});

test("control: a closed room is still a 409 room_closed", async (t) => {
  const { s, A, roomId } = await twoHomeRoom(t, "746666");
  // A closed room keeps its seats in the row the door reads (the closure itself belongs to the doors that end it):
  // this is the state the closed-room refusal exists for, and it must answer before anything about the lead.
  s.platform.db.prepare("UPDATE face_rooms SET status = 'closed' WHERE id = ?").run(roomId);
  const refused: any = await setNote(s.base, A, roomId, "written into a closed room");
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error?.code, "room_closed", "the closed room still says it is closed");
  assert.equal(rowNote(s, roomId), null);
});
