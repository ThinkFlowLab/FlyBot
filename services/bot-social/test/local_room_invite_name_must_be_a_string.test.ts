// `POST /v1/local-room-invites` lets the minting owner label the link with `name`, the line a stranger reads
// before joining. On master de5903d2 `mintLocalRoomInvite` hands that value straight to `sanitizePeerName`, whose
// first line is `String(value ?? "")`: an object arrives as "object Object", `[1,2]` as "1,2", `42` as "42",
// `true` as "true", and `[]` as "" — "no name" — so the door writes a name the caller never typed into a row and
// a preview a stranger sees. A name in this body is a string or nothing: anything else is a 400 `invalid_request`
// naming the field, refused before the attempt record, the ticket row and the mint audit entry. Absent and null
// still mean "no name", and every string keeps the cleaning it already had: `""` and blanks still become no name,
// `@` and control characters are still removed, whitespace still collapses, and the 60-code-unit cap still holds.
// Only this call site judges its input; `sanitizePeerName` and its other callers are untouched.
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

/** Every write a mint can leave behind: the ticket, a claim, the attempt record and the audit entry. */
function residue(p: any) {
  const one = (sql: string) => (p.get(sql) as any).n as number;
  return {
    invites: one("SELECT COUNT(*) n FROM local_room_invites"),
    claims: one("SELECT COUNT(*) n FROM local_room_invite_claims"),
    attempts: one("SELECT COUNT(*) n FROM face_room_attempts"),
    minted: (p.audit.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action = 'local_room.invite_minted'").get() as any).n as number,
  };
}

const ROOM = "probe-name-room-1"; // a legal local room id that is not one of this server's face rooms
const mint = (s: any, token: string, body: Record<string, unknown>) => post(s.base, "/v1/local-room-invites", token, { room_id: ROOM, ...body });

test("a name that is not a string is refused and writes nothing", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const { p, token } = await homeOwner(s);

  for (const [label, value] of [
    ["an object", {}],
    ["an array", []],
    ["an array holding a name", ["my room"]],
    ["an array of two numbers", [1, 2]],
    ["a number", 42],
    ["a boolean", true],
    ["zero", 0],
    ["false", false],
    ["a decimal", 1.5],
  ] as [string, unknown][]) {
    const before = residue(p);
    const r = await mint(s, token, { name: value });
    assert.equal(r.status, 400, `name given ${label} must be refused, not answered ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error?.code, "invalid_request", JSON.stringify(r.body));
    assert.equal(r.body.error?.message, "name must be a string");
    assert.deepEqual(residue(p), before, `name given ${label} wrote no ticket, claim, attempt or audit entry`);
  }
});

test("the ways a name is written and cleaned are unchanged", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const { p, token } = await homeOwner(s);

  // Absent, null, the empty string and blanks all still mean "no name": the response and the row say null.
  for (const [label, body] of [
    ["omitted", {}],
    ["null", { name: null }],
    ["empty", { name: "" }],
    ["blank", { name: "   " }],
  ] as [string, Record<string, unknown>][]) {
    const r = await mint(s, token, body);
    assert.equal(r.status, 201, `${label} name still mints: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.name, null, `${label} name still means no name`);
    assert.equal(p.get("SELECT name FROM local_room_invites ORDER BY rowid DESC LIMIT 1").name, null, `${label} name still stores no name`);
  }

  // A string is still cleaned, stored and shown to a stranger exactly as before.
  for (const [label, value, expected] of [
    ["an @ handle", "@x", "x"],
    ["a newline", "a\nb", "ab"],
    ["collapsible blanks", "  hi  there  ", "hi there"],
    ["an emoji", "\u{1F916} bot", "\u{1F916} bot"],
    ["70 characters", "x".repeat(70), "x".repeat(60)],
  ] as [string, string, string][]) {
    const r = await mint(s, token, { name: value });
    assert.equal(r.status, 201, `a string name (${label}) still mints: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.name, expected, `a string name (${label}) keeps its cleaning`);
    assert.equal(p.get("SELECT name FROM local_room_invites ORDER BY rowid DESC LIMIT 1").name, expected, `a string name (${label}) is stored cleaned`);
    const seen = await fetch(`${s.base}/v1/local-room-invites/${r.body.ticket}`);
    assert.equal(seen.status, 200, `a string name (${label}) is previewable`);
    assert.equal(((await seen.json()) as any).name, expected, `a stranger reads a string name (${label}) cleaned`);
  }
});

test("the Bot name and the link name are read and judged in body order", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const { p, member, token } = await homeOwner(s);

  // The Bot aliases are read first, so their refusal wins even when `name` is wrong too.
  for (const [fields, message] of [
    [{ bot_id: [], name: {} }, "bot_id must be a string"],
    [{ bot_handle: {}, name: 42 }, "bot_handle must be a string"],
    // With the Bot name valid, the wrong link name is the one reported.
    [{ bot_id: member.bot_id, name: {} }, "name must be a string"],
    [{ name: 42 }, "name must be a string"],
  ] as [Record<string, unknown>, string][]) {
    const before = residue(p);
    const r = await mint(s, token, fields);
    assert.equal(r.status, 400, `${JSON.stringify(fields)} must be refused, not answered ${r.status}`);
    assert.equal(r.body.error?.code, "invalid_request");
    assert.equal(r.body.error?.message, message);
    assert.deepEqual(residue(p), before, "a refused body writes nothing");
  }
});
