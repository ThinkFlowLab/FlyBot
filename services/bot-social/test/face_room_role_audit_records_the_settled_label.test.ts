// A `face_room.role_changed` audit row names, for each seat the write touched, the label that seat ends on. A body
// can name the same seat more than once — by handle and by bot id — and the write applies them in order, so an
// earlier entry can be a value that never lands anywhere. Recording every entry put such a value on the audit chain
// and listed one Bot twice, so the chain could not answer "what label does this Bot carry now".
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
const join = (base: string, o: Who, code: string, bots: string[]) => req(base, "POST", "/v1/face-rooms/join", o.owner.token, { code, bots });
const setRoles = (base: string, o: Who, roomId: string, roles: Record<string, unknown>) => req(base, "PUT", `/v1/face-rooms/${roomId}/roles`, o.owner.token, { roles });

/** Every role write's audit row for this room, oldest first, with `data` parsed. */
const roleRows = (s: any, roomId: string) =>
  (s.platform.audit.db.prepare("SELECT data FROM audit_events WHERE action = 'face_room.role_changed' AND subject = ? ORDER BY seq").all(roomId) as any[])
    .map((r) => JSON.parse(String(r.data)));

/** Ann brings two of her own Bots; Ben brings one. */
async function room(t: any) {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const second = await A.owner.req("POST", "/v1/bots", { handle: "ann-two.bot", display_name: "Ann Two" });
  const secondId = second.bot_id as string;
  const a = await join(s.base, A, "747474", [A.bot.id, secondId]);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal((await join(s.base, B, "747474", [B.bot.id])).status, 200);
  return { s, A, B, secondId, secondHandle: "@ann-two.bot", roomId: a.body.room_id as string };
}

test("the row records the label the seat ends on, never an entry the write replaced", async (t) => {
  const { s, A, roomId } = await room(t);
  assert.equal((await setRoles(s.base, A, roomId, { [A.bot.id]: "Reviewer" })).status, 200);

  // The same seat twice: away to "Phantom", then back to the label it already carries.
  const phantom = await setRoles(s.base, A, roomId, { [A.bot.id]: "Phantom", [A.handle]: "Reviewer" });
  assert.equal(phantom.status, 200, JSON.stringify(phantom.body));
  assert.equal(phantom.body.members.find((m: any) => m.handle === A.handle).role, "Reviewer", "the seat ends where it started");

  const rows = roleRows(s, roomId);
  assert.deepEqual(rows.at(-1).bots, [{ bot: A.bot.id, role: "Reviewer" }], "the row names the Bot and the label now on it");
  assert.equal(JSON.stringify(rows).includes("Phantom"), false, "a value that never landed is nowhere on the chain");
});

test("a write that changes nothing still leaves one row naming the label now on the Bot", async (t) => {
  const { s, A, roomId } = await room(t);
  assert.equal((await setRoles(s.base, A, roomId, { [A.bot.id]: "Writer" })).status, 200);
  const before = roleRows(s, roomId).length;

  const repeat = await setRoles(s.base, A, roomId, { [A.bot.id]: "Writer" });
  assert.equal(repeat.status, 200);
  const rows = roleRows(s, roomId);
  assert.equal(rows.length, before + 1, "the write itself is still recorded");
  assert.deepEqual(rows.at(-1).bots, [{ bot: A.bot.id, role: "Writer" }], "and it names the label the Bot carries");
});

test("each seat appears once, with the label it ends on", async (t) => {
  const { s, A, B, secondId, secondHandle, roomId } = await room(t);
  // The same seat named twice with one value is one seat, and two seats are two entries.
  const both = await setRoles(s.base, A, roomId, { [A.bot.id]: "Editor", [A.handle]: "Editor", [secondHandle]: "Reviewer" });
  assert.equal(both.status, 200, JSON.stringify(both.body));
  const bots = roleRows(s, roomId).at(-1).bots;
  assert.equal(bots.length, 2, `one entry per seat, got ${JSON.stringify(bots)}`);
  assert.deepEqual(bots, [{ bot: A.bot.id, role: "Editor" }, { bot: secondId, role: "Reviewer" }]);
  assert.equal(bots.filter((b: any) => b.bot === A.bot.id).length, 1, "no seat is listed twice");
});
