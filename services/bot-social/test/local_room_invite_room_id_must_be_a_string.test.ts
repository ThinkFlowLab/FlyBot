// `POST /v1/local-room-invites` names the room the ticket opens. On master 887a777d `mintLocalRoomInvite` reads
// that id with `String(body?.room_id ?? "").trim()` and only then judges its shape: `??` skips `undefined`/`null`
// only, so `["loc-room-2"]` arrives as `loc-room-2`, `true` as `true` and `7` as `7`, and each of those minted a
// ticket (row, attempt, audit entry) under a room id the caller never typed as a string; an object whose
// `toString` is not a function made the coercion throw and answered `500 internal_error`. A room id in this body
// is a string or nothing: anything else is a 400 `invalid_request` naming the field, refused before the coercion,
// the attempt record, the ticket row and the mint audit entry. Absent and `null` still read as "no room id" and
// keep the characters refusal; a string still gets the shape check it always had. The same rule the send door
// (`POST /v1/messages`) already applies to `room_id`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bulkAuth, startServer } from "./helpers.js";

const post = async (base: string, path: string, token: string, body: unknown) => {
  const r = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as any };
};

/** An owner with a FlyBot home and one member Bot, which is the inviter every mint here carries. */
async function homeOwner(s: any) {
  const p: any = s.platform;
  const fly: any = p.onboardFlybot({ display_name: "Wes" });
  const member = p.addHomeMember({ kind: "owner", ownerId: fly.owner_id }, fly.home.bot_id, { name: "writer" });
  const login = await fetch(s.base + "/v1/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: fly.username, password: fly.generated_password }),
  });
  return { p, fly, member, token: ((await login.json()) as any).owner_token as string };
}

/** Every write a mint can leave behind: the ticket, a claim, the attempt record and the mint audit entry. */
function residue(p: any) {
  const one = (sql: string) => (p.get(sql) as any).n as number;
  return {
    invites: one("SELECT COUNT(*) n FROM local_room_invites"),
    claims: one("SELECT COUNT(*) n FROM local_room_invite_claims"),
    attempts: one("SELECT COUNT(*) n FROM face_room_attempts"),
    minted: (p.audit.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action = 'local_room.invite_minted'").get() as any).n as number,
  };
}

const ROOM = "probe-room-id-type-1"; // a legal local room id that is not one of this server's face rooms
const CHARSET_REFUSAL = "room_id: 1-64 chars [A-Za-z0-9._:-]";
const TYPE_REFUSAL = "room_id must be a string";

test("a room_id that is not a string is refused and writes nothing", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const { p, token } = await homeOwner(s);

  // The defect: an array, a boolean and a number were coerced into a ticket; an object without `toString` was a 500.
  for (const [label, value] of [
    ["an array", ["loc-room-2"]],
    ["a boolean", true],
    ["a number", 7],
    ["an object whose toString is not a function", { toString: null }],
  ] as [string, unknown][]) {
    const before = residue(p);
    const r = await post(s.base, "/v1/local-room-invites", token, { room_id: value });
    assert.equal(r.status, 400, `room_id given ${label} must be refused, not answered ${r.status}`);
    assert.equal(r.body.error?.code, "invalid_request", JSON.stringify(r.body));
    assert.equal(r.body.error?.message, TYPE_REFUSAL, `room_id given ${label} names the field`);
    assert.deepEqual(residue(p), before, `room_id given ${label} wrote no ticket, claim, attempt or audit entry`);
  }

  // Controls: a legal string still mints; absent / null and a malformed string keep the characters refusal;
  // an object is now the field's problem, not the shape's (the coercion can no longer run over it).
  const legal = await post(s.base, "/v1/local-room-invites", token, { room_id: ROOM });
  assert.equal(legal.status, 201, JSON.stringify(legal.body));
  assert.equal(legal.body.room_id, ROOM, "a string room_id is still stored as given");

  for (const [label, body, message] of [
    ["absent", {}, CHARSET_REFUSAL],
    ["null", { room_id: null }, CHARSET_REFUSAL],
    ["an object", { room_id: {} }, TYPE_REFUSAL],
    ["a string with a space", { room_id: "has space" }, CHARSET_REFUSAL],
    ["a 65-character string", { room_id: "x".repeat(65) }, CHARSET_REFUSAL],
  ] as [string, Record<string, unknown>, string][]) {
    const before = residue(p);
    const r = await post(s.base, "/v1/local-room-invites", token, body);
    assert.equal(r.status, 400, `room_id ${label} is refused`);
    assert.equal(r.body.error?.code, "invalid_request", JSON.stringify(r.body));
    assert.equal(r.body.error?.message, message, `room_id ${label} reports the field it is`);
    assert.deepEqual(residue(p), before, `room_id ${label} wrote no ticket, claim, attempt or audit entry`);
  }

  // The one legal mint is the only write: no attempt, ticket or audit line came from a refusal.
  assert.deepEqual(residue(p), { invites: 1, claims: 0, attempts: 1, minted: 1 }, "only the legal string minted");
});
