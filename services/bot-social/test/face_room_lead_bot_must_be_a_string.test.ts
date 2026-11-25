// A face room's lead is named in the body of `POST /v1/face-rooms/:id/lead` as `bot`, or by one of its three older
// aliases (`bot_handle`, `handle`, `bot_id`). `setFaceRoomLead` reads that value with `String(...)`, and `String([])`
// as well as `String([""])` are the empty string, so an array reads as "nobody named": the door answers 200 and
// quietly clears the room's lead, writing `face_rooms.lead_bot_id = NULL` plus a `face_room.lead_changed` audit row
// and a `room.lead_changed` room event — a change the caller never asked for. Objects, booleans and numbers take the
// other old path and are answered 400 `bot_not_in_room`, which names the wrong problem. A wrong-typed name is a 400
// that names the field, and it writes nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

async function req(base: string, method: string, path: string, token: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}
type Who = Awaited<ReturnType<typeof ownerWithBot>>;

/** Two homes, one Bot each. Ann creates the room, so Ben's Bot is the lead this door can set and clear. */
async function room(t: any, code: string) {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const a = await req(s.base, "POST", "/v1/face-rooms/join", A.owner.token, { code, bots: [A.bot.id] });
  assert.equal(a.status, 200);
  assert.equal((await req(s.base, "POST", "/v1/face-rooms/join", B.owner.token, { code, bots: [B.bot.id] })).status, 200);
  const roomId = a.body.room_id as string;
  const p: any = s.platform;
  const lead = () => (p.get("SELECT lead_bot_id FROM face_rooms WHERE id = ?", roomId) as any).lead_bot_id;
  const audits = () => (p.audit.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action = 'face_room.lead_changed' AND subject = ?").get(roomId) as any).n as number;
  const events = () => (p.get("SELECT COUNT(*) n FROM face_room_events WHERE room_id = ?", roomId) as any).n as number;
  const setLead = (body: unknown, who: Who = A) => req(s.base, "POST", `/v1/face-rooms/${roomId}/lead`, who.owner.token, body);
  return { s, p, A, B, roomId, lead, audits, events, setLead };
}

test("a lead name that is not a string is refused, on every alias the door reads", async (t) => {
  const f = await room(t, "717171");
  const wrong: [string, unknown][] = [
    ["an array", []],
    ["an array holding an empty string", [""]],
    ["an array holding a handle", ["@someone.bot"]],
    ["an object", {}],
    ["a boolean", true],
    ["a number", 1.5],
    ["zero", 0],
  ];
  for (const field of ["bot", "bot_handle", "handle", "bot_id"]) {
    for (const [label, value] of wrong) {
      assert.equal((await f.setLead({ bot: f.B.bot.id })).status, 200, "the fixture sets a lead first");
      const before = { lead: f.lead(), audits: f.audits(), events: f.events() };
      const r = await f.setLead({ [field]: value });
      assert.equal(r.status, 400, `${field} given ${label} must be refused, not answered ${r.status} ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error?.code, "invalid_request");
      assert.equal(r.body.error?.message, `${field} must be a string`);
      assert.equal(f.lead(), before.lead, `${field} given ${label} left the lead alone`);
      assert.equal(f.audits(), before.audits, `${field} given ${label} wrote no lead audit row`);
      assert.equal(f.events(), before.events, `${field} given ${label} wrote no room event`);
    }
  }
});

test("the alias read first is the one a wrong-typed body is answered for", async (t) => {
  const f = await room(t, "727272");
  // `bot` is read first, so an explicit array there is the field refused even when a usable `bot_handle` follows it.
  assert.equal((await f.setLead({ bot: f.B.bot.id })).status, 200);
  const before = { lead: f.lead(), audits: f.audits(), events: f.events() };
  const r = await f.setLead({ bot: [], bot_handle: f.B.handle });
  assert.equal(r.status, 400);
  assert.equal(r.body.error?.code, "invalid_request");
  assert.equal(r.body.error?.message, "bot must be a string");
  assert.equal(f.lead(), before.lead);
  assert.equal(f.audits(), before.audits);
  assert.equal(f.events(), before.events);
});

test("the ways a lead is really cleared, and a string that names one, still work", async (t) => {
  const f = await room(t, "737373");
  // Cleared by an absent name, an explicit null, and an empty or blank string: the existing semantics, unchanged.
  for (const [label, body] of [["omitted", {}], ["null", { bot: null }], ["empty string", { bot: "" }], ["blank string", { bot: "   " }]] as [string, any][]) {
    assert.equal((await f.setLead({ bot: f.B.bot.id })).status, 200);
    const audits = f.audits();
    const r = await f.setLead(body);
    assert.equal(r.status, 200, `${label} still clears the lead: ${JSON.stringify(r.body)}`);
    assert.equal(f.lead(), null, `${label} clears the lead`);
    assert.equal(f.audits(), audits + 1, `${label} writes the clear`);
  }
  // A string that names a Bot in the room sets it, by id and by handle.
  for (const [label, value] of [["id", f.B.bot.id], ["handle", f.B.handle]] as [string, string][]) {
    assert.equal((await f.setLead({ bot: null })).status, 200);
    const r = await f.setLead({ bot: value });
    assert.equal(r.status, 200, `a string ${label} still sets the lead: ${JSON.stringify(r.body)}`);
    assert.equal(f.lead(), f.B.bot.id, `a string ${label} picks Ben's Bot`);
  }
  // A wrong-typed name on a caller who may not pick the lead is still refused as "not the creator", not as a type.
  const r = await f.setLead({ bot: [] }, f.B);
  assert.equal(r.status, 403, "the creator check still answers first");
  assert.equal(r.body.error?.code, "not_room_creator");
});
