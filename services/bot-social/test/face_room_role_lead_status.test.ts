/**
 * A member's role label is read by every other home in the room (the roster renders it for each member), so
 * writing one is that Bot's outbound act even though its owner types it: a Bot that was stopped or removed must
 * not keep putting text in front of the other owners.
 *
 * The room's line door already answers that question for the same Bot (`403 bot_frozen` / `403 bot_revoked` from
 * the invitable check every outbound door uses); the roles door did not, so the owner of a stopped lead could
 * still rename it "Still here" in everyone's roster while the same Bot could not write a line. The guard belongs
 * where the member row is written, and the rest of the door keeps its order: the member check, the roles object,
 * the Bot's own seat, the value's type and sanitizing, then the write.
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
const setRoles = (base: string, o: Who, roomId: string, roles: Record<string, unknown>) => req(base, "PUT", `/v1/face-rooms/${roomId}/roles`, o.owner.token, { roles });
const view = (base: string, o: Who, roomId: string) => req(base, "GET", `/v1/face-rooms/${roomId}`, o.owner.token);
const stopBot = (base: string, o: Who) => req(base, "POST", "/v1/emergency-stop", o.owner.token, { bot_id: o.bot.id });
const roleOf = (body: any, handle: string) => body?.members?.find((m: any) => m.handle === handle)?.role ?? null;

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

test("a stopped lead cannot rewrite the room's role labels", async (t) => {
  const { s, A, B, roomId } = await twoHomeRoom(t, "751111");
  assert.equal((await setRoles(s.base, A, roomId, { [A.handle]: "Before the stop" })).status, 200);
  assert.equal((await stopBot(s.base, A)).body.status, "frozen");

  const refused: any = await setRoles(s.base, A, roomId, { [A.handle]: "Still here" });
  assert.equal(refused.status, 403, "a stopped lead is refused, not answered with a renamed label");
  assert.equal(refused.body.error?.code, "bot_frozen", "the refusal names the stop");
  const guest: any = await view(s.base, B, roomId);
  assert.equal(roleOf(guest.body, A.handle), "Before the stop", "another owner in the room never reads the refused label");
});

test("the same holds for a stopped Bot that is not the room's lead", async (t) => {
  const { s, A, B, roomId } = await twoHomeRoom(t, "752222");
  assert.equal((await setRoles(s.base, B, roomId, { [B.handle]: "Ben's desk" })).status, 200);
  assert.equal((await stopBot(s.base, B)).body.status, "frozen");

  const refused: any = await setRoles(s.base, B, roomId, { [B.handle]: "Still here too" });
  assert.equal(refused.status, 403, "a stopped Bot's own label is not room metadata a stopped identity still writes");
  assert.equal(refused.body.error?.code, "bot_frozen");
  const lead: any = await view(s.base, A, roomId);
  assert.equal(roleOf(lead.body, B.handle), "Ben's desk", "the label every member already read is untouched");
  assert.equal(lead.body.effective_lead_bot_handle, A.handle, "the room still belongs to the active lead");
});

test("a removed lead cannot rewrite them either", async (t) => {
  const { s, A, B, roomId } = await twoHomeRoom(t, "753333");
  assert.equal((await setRoles(s.base, A, roomId, { [A.handle]: "Before the removal" })).status, 200);
  // A revoked Bot no longer holds a seat on this build, so the seat left behind is the torn state an older build
  // leaves: the identity is gone, the room still lists it as its lead. The door must refuse it by name.
  s.platform.db.prepare("UPDATE bots SET status = 'revoked' WHERE id = ?").run(A.bot.id);

  const refused: any = await setRoles(s.base, A, roomId, { [A.handle]: "Still here" });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error?.code, "bot_revoked", "the refusal names the removal");
  assert.equal(roleOf((await view(s.base, B, roomId)).body, A.handle), "Before the removal", "nothing was written for the room");
});

test("the same holds for a room whose matching window has not been started yet", async (t) => {
  const { s, A, B, roomId } = await twoHomeRoom(t, "754444", false);
  assert.equal((await stopBot(s.base, A)).body.status, "frozen");

  const refused: any = await setRoles(s.base, A, roomId, { [A.handle]: "Still here" });
  assert.equal(refused.status, 403, "a waiting room is not a way around the stop");
  assert.equal(refused.body.error?.code, "bot_frozen");
  assert.equal(roleOf((await view(s.base, B, roomId)).body, A.handle), null, "no label was written");
});

test("control: an active owner still labels its own Bot, and every member reads it", async (t) => {
  const { s, A, B, roomId } = await twoHomeRoom(t, "755555");
  const put: any = await setRoles(s.base, A, roomId, { [A.handle]: "  Writer\n@all " + "x".repeat(100) });
  assert.equal(put.status, 200);
  const mine = roleOf(put.body, A.handle);
  assert.ok(mine.startsWith("Writer") && !/[@\n]/.test(mine), "the label is sanitized like a name");
  assert.equal(mine.length, 80, "and capped at 80, as it always was");
  const guest: any = await view(s.base, B, roomId);
  assert.equal(roleOf(guest.body, A.handle), mine, "the label is shown to every member");
  assert.equal(guest.body.effective_lead_bot_handle, A.handle, "the active lead is still the lead");
  const cleared: any = await setRoles(s.base, A, roomId, { [A.handle]: null });
  assert.equal(cleared.status, 200);
  assert.equal(roleOf(cleared.body, A.handle), null);
});

test("control: a label still belongs to the owner's own Bot only", async (t) => {
  const { s, A, B, roomId } = await twoHomeRoom(t, "756666");
  const theirs: any = await setRoles(s.base, A, roomId, { [B.handle]: "Boss" });
  assert.equal(theirs.status, 404);
  assert.equal(theirs.body.error?.code, "bot_not_found", "the own-seat check keeps its own answer");
  assert.equal((await setRoles(s.base, A, roomId, {})).status, 400);
  assert.equal((await setRoles(s.base, A, roomId, { [A.handle]: 5 })).status, 400);
  const ok: any = await setRoles(s.base, B, roomId, { [B.handle]: "Boss" });
  assert.equal(ok.status, 200, "the other owner still labels their own Bot");
  assert.equal(roleOf((await view(s.base, A, roomId)).body, B.handle), "Boss");
});
