// A face-to-face room's note and its members' role labels are metadata every seated owner reads back, and writing
// one is an outbound act of the Bot that writes it (the lead for the note, each Bot's own owner for its label).
// Every other state change a room takes already leaves a row on the audit chain -- created, joined, left, lead
// changed, invite minted or revoked, started, a message drafted or delivered -- so these two are the only writes in
// that surface that leave no trace at all. A room whose note was rewritten or whose roster was relabelled cannot be
// told apart from one that was always that way.
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
const setNote = (base: string, o: Who, roomId: string, note: unknown) => req(base, "POST", `/v1/face-rooms/${roomId}/note`, o.owner.token, { note });
const setRoles = (base: string, o: Who, roomId: string, roles: Record<string, unknown>) => req(base, "PUT", `/v1/face-rooms/${roomId}/roles`, o.owner.token, { roles });

const auditRows = (s: any) =>
  (s.platform.audit.db.prepare("SELECT action, subject, owners, data FROM audit_events ORDER BY rowid").all() as any[]).map((r) => ({
    action: String(r.action),
    subject: String(r.subject ?? ""),
    owners: (r.owners ? JSON.parse(String(r.owners)) : []).sort(),
    data: r.data ? JSON.parse(String(r.data)) : undefined,
  }));

/** Ann opens the room, so her Bot is the lead; Ben joins the same code. */
async function twoHomeRoom(t: any, code: string) {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const a = await join(s.base, A, code);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal((await join(s.base, B, code)).status, 200);
  return { s, A, B, roomId: a.body.room_id as string };
}

test("a room note rewritten by the lead leaves one audit row naming the room and every owner", async (t) => {
  const { s, A, B, roomId } = await twoHomeRoom(t, "717171");
  const before = auditRows(s);

  const r = await setNote(s.base, A, roomId, "quiet hours after ten");
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const added = auditRows(s).slice(before.length);
  assert.equal(added.length, 1, `a note write must add exactly one row, added ${JSON.stringify(added)}`);
  assert.equal(added[0].action, "face_room.note_changed");
  assert.equal(added[0].subject, roomId);
  assert.deepEqual(added[0].owners, [A.owner_id, B.owner_id].sort(), "both owners read this room, so both name the row");
});

test("a member's role label leaves one audit row naming the Bot whose label changed", async (t) => {
  const { s, A, roomId } = await twoHomeRoom(t, "727272");
  const before = auditRows(s);

  const r = await setRoles(s.base, A, roomId, { [A.bot.id]: "Keeper of the door" });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const added = auditRows(s).slice(before.length);
  assert.equal(added.length, 1, `a roles write must add exactly one row, added ${JSON.stringify(added)}`);
  assert.equal(added[0].action, "face_room.role_changed");
  assert.equal(added[0].subject, roomId);
  assert.deepEqual(added[0].data?.bots, [{ bot: A.bot.id, role: "Keeper of the door" }], "the row names the Bot and the label now on it");
});

test("a refused write leaves no audit row", async (t) => {
  const { s, A, roomId } = await twoHomeRoom(t, "737373");
  const before = auditRows(s);

  assert.equal((await setNote(s.base, A, roomId, "")).status, 400, "an empty note is refused");
  assert.equal((await setRoles(s.base, A, roomId, { [A.bot.id]: 5 })).status, 400, "a non-string label is refused");

  assert.deepEqual(auditRows(s).slice(before.length), [], "neither refusal writes a row");
});
