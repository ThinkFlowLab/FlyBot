// `POST /v1/local-room-invites` lets an owner name the Bot whose name the link carries. On master 9aa3cd5
// `mintLocalRoomInvite` reads that name with
// `String(body?.bot_id ?? body?.bot_handle ?? body?.handle ?? "")`: `??` skips `undefined`/`null` only, so an
// array arrives as `String([]) === ""` and reads as "no Bot named". The route then falls back to the account's
// oldest active member Bot — the caller named one Bot, the ticket is minted in another's name, and the 201 writes
// the row, the attempt and the audit entry. Objects, booleans and numbers took the other old path and answered
// 404 `bot_not_found`, which names the wrong problem. A Bot name in this body is a string or nothing: anything
// else is a 400 `invalid_request` naming the field, refused before the fallback, the row, the attempt and the
// audit entry. `undefined`/`null` still mean "the default Bot" and a string still names that Bot. All three
// aliases are judged, in the order `??` reads them, so a wrong-typed alias is refused even when an earlier alias
// would have won — the rule #601 set for the two invite doors.
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

/** An owner with a FlyBot home and two member Bots, so "the default Bot" is a different Bot from the named one. */
async function homeOwnerWithTwoMembers(s: any) {
  const p: any = s.platform;
  const fly: any = p.onboardFlybot({ display_name: "Wes" });
  const member = (name: string) => p.addHomeMember({ kind: "owner", ownerId: fly.owner_id }, fly.home.bot_id, { name });
  const first = member("writer"); // the oldest member: the fallback a silently dropped name lands on
  const second = member("reader");
  const login = await fetch(s.base + "/v1/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: fly.username, password: fly.generated_password }),
  });
  const token = ((await login.json()) as any).owner_token as string;
  return { p, fly, first, second, token };
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

const lastInviter = (p: any) => "@" + p.bot(p.get("SELECT inviter_bot FROM local_room_invites ORDER BY created_at DESC, rowid DESC LIMIT 1").inviter_bot).handle;

const ROOM = "probe-room-1"; // a legal local room id that is not one of this server's face rooms
const mint = (s: any, token: string, body: Record<string, unknown>) => post(s.base, "/v1/local-room-invites", token, { room_id: ROOM, ...body });

test("a local room invite names its Bot with a string or not at all", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const { p, first, second, token } = await homeOwnerWithTwoMembers(s);
  assert.notEqual(first.handle, second.handle, "the fixture needs a default that is not the named Bot");

  // The defect: an array is neither refused nor "not given" — it mints in the default Bot's name.
  const aliases = ["bot_id", "bot_handle", "handle"] as const;
  for (const alias of aliases) {
    for (const [label, value] of [["an array", []], ["an array holding an empty string", [""]], ["an object", {}], ["a boolean", true], ["a number", 1.5]] as [string, unknown][]) {
      const before = residue(p);
      const r = await mint(s, token, { [alias]: value });
      assert.equal(r.status, 400, `${alias} given ${label} must be refused, not answered ${r.status}`);
      assert.equal(r.body.error?.code, "invalid_request", JSON.stringify(r.body));
      assert.equal(r.body.error?.message, `${alias} must be a string`);
      assert.deepEqual(residue(p), before, `${alias} given ${label} wrote no ticket, claim, attempt or audit entry`);
    }
  }

  // Controls: absent and null still mean "the default Bot", a string still names that Bot.
  for (const [label, body] of [["omitted", {}], ["null", { bot_id: null }]] as [string, any][]) {
    const r = await mint(s, token, body);
    assert.equal(r.status, 201, `${label} still mints: ${JSON.stringify(r.body)}`);
    assert.equal(lastInviter(p), first.handle, `${label} still means the default Bot`);
  }
  {
    const r = await mint(s, token, { bot_id: second.bot_id });
    assert.equal(r.status, 201, "a string bot_id still mints");
    assert.equal(lastInviter(p), second.handle, "a string bot_id still names that Bot");
  }
  {
    const r = await mint(s, token, { bot_handle: second.handle });
    assert.equal(r.status, 201, "a string bot_handle still mints");
    assert.equal(lastInviter(p), second.handle, "a string bot_handle still names that Bot");
  }
  {
    const r = await mint(s, token, { handle: second.handle });
    assert.equal(r.status, 201, "a string handle still mints");
    assert.equal(lastInviter(p), second.handle, "a string handle still names that Bot");
  }
  // `bot_id` wins over `bot_handle` in the `??` chain: two names still mint for the earlier one, as before.
  {
    const r = await mint(s, token, { bot_id: second.bot_id, bot_handle: first.handle });
    assert.equal(r.status, 201, "bot_id and bot_handle together still mint");
    assert.equal(lastInviter(p), second.handle, "the existing bot_id-first answer is unchanged");
  }
});

test("several wrong-typed Bot names report the one the body reads first", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const { p, first, second, token } = await homeOwnerWithTwoMembers(s);

  // `??` reads bot_id, then bot_handle, then handle; the refusal names the first wrong-typed field in that order.
  for (const [fields, message] of [
    [{ bot_id: [], bot_handle: {} }, "bot_id must be a string"],
    [{ bot_handle: [], handle: {} }, "bot_handle must be a string"],
    // A wrong-typed alias is refused even when an earlier alias would win: it is still a Bot name in the body.
    [{ bot_id: second.bot_id, bot_handle: [] }, "bot_handle must be a string"],
  ] as [Record<string, unknown>, string][]) {
    const before = residue(p);
    const r = await mint(s, token, fields);
    assert.equal(r.status, 400, `${JSON.stringify(fields)} must be refused`);
    assert.equal(r.body.error?.code, "invalid_request");
    assert.equal(r.body.error?.message, message);
    assert.deepEqual(residue(p), before, "a refused body writes nothing");
  }
  // The same precedence the other way round: the first alias is a real string, so it names that Bot.
  const ok = await mint(s, token, { bot_id: second.bot_id, bot_handle: first.handle });
  assert.equal(ok.status, 201);
  assert.equal(lastInviter(p), second.handle);
});
