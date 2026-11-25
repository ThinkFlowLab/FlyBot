// `joinInvite` is the one door an owner's console join and a Bot's signed `invite.join` both reach, and it hands
// `payload.message` straight to the DLP scan and then to the INSERT. Nothing on the way checks its type: an object or
// a boolean reached better-sqlite3 as bindings and answered 500 `internal_error` (no row, no use, no audit), while an
// array or a fraction was accepted and stored as the text "1.0" / "1.5" — a join message nobody typed, read by the
// inviter's owner on GET /v1/relationships. A join message is a string; anything else is a 400 `invalid_request`
// refused after the relationship_exists 409 (an already-connected caller keeps that answer) and before the DLP scan,
// the row and the invite's use. The auto-accept regrant above the gate stores no message and keeps its own answer, and
// the DLP 422 shape is untouched.
import assert from "node:assert/strict";
import { test } from "node:test";
import { friends, ownerWithBot, startServer } from "./helpers.js";

const owner = (o: any) => ({ kind: "owner" as const, ownerId: o.owner_id });

async function ownerJoin(base: string, token: string, code: string, body: unknown) {
  const r = await fetch(`${base}/v1/invites/${encodeURIComponent(code)}/join`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, json: text ? (JSON.parse(text) as any) : {} };
}

/** The Bot-signed door answers the same refusals; `signed` throws on a non-2xx, so the error carries status and code. */
async function botJoin(bot: any, code: string, payload: Record<string, unknown>) {
  try {
    return { status: 201, json: await bot.signed(`/v1/invites/${encodeURIComponent(code)}/join`, "invite.join", payload) };
  } catch (e: any) {
    return { status: e.status as number, json: e.body ?? { error: { code: e.code, message: e.message } } };
  }
}

/** Only this invite's own footprint: the stale-relationship sweep runs before the gate and may touch other rows. */
function residue(p: any, inviteId: string, inviterBot: string, joinerBot: string) {
  const one = (sql: string, ...a: any[]) => (p.db.prepare(sql).get(...a) as any).n as number;
  return {
    relationships: one("SELECT COUNT(*) n FROM relationships WHERE requester_bot = ? AND target_bot = ?", joinerBot, inviterBot),
    links: one("SELECT COUNT(*) n FROM relationship_invites WHERE invite_id = ?", inviteId),
    uses: (p.db.prepare("SELECT uses FROM invites WHERE id = ?").get(inviteId) as any).uses as number,
    joins: (p.audit.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action = 'invite.joined' AND subject = ?").get(inviteId) as any).n as number,
    events: one(
      "SELECT COUNT(*) n FROM events WHERE type IN ('relationship.requested','relationship.changed','approval.created','invite.joined') AND bot_id IN (?, ?)",
      joinerBot,
      inviterBot,
    ),
  };
}

const isStringRefusal = (r: { status: number; json: any }) =>
  r.status === 400 && r.json?.error?.code === "invalid_request" && r.json?.error?.message === "message must be a string";

const bad: [string, unknown][] = [
  ["an object", {}],
  ["a boolean", true],
  ["an array", [1]],
  ["a fraction", 1.5],
];

for (const [label, value] of bad) {
  test(`an owner join naming the message with ${label} is a 400 and writes nothing`, async (t) => {
    const s = await startServer();
    t.after(s.stop);
    const p = s.platform as any;
    const A = await ownerWithBot(s.base, "ann");
    const B = await ownerWithBot(s.base, "ben");
    const inv = p.createInvite(owner(A), { bot_id: A.bot.id, auto_accept: false, max_uses: 1 });
    const before = residue(p, inv.invite_id, A.bot.id, B.bot.id);

    const r = await ownerJoin(s.base, B.owner.token, inv.code, { from_bot_id: B.bot.id, message: value });
    assert.equal(r.status, 400, JSON.stringify(r.json));
    assert.ok(isStringRefusal(r), JSON.stringify(r.json));
    assert.deepEqual(residue(p, inv.invite_id, A.bot.id, B.bot.id), before, "no row, no invite use, no audit and no event");
  });
}

for (const [label, value] of bad) {
  test(`a Bot-signed join naming the message with ${label} is a 400 and writes nothing`, async (t) => {
    const s = await startServer();
    t.after(s.stop);
    const p = s.platform as any;
    const A = await ownerWithBot(s.base, "ann");
    const B = await ownerWithBot(s.base, "ben");
    const inv = p.createInvite(owner(A), { bot_id: A.bot.id, auto_accept: false, max_uses: 1 });
    const before = residue(p, inv.invite_id, A.bot.id, B.bot.id);

    const r = await botJoin(B.bot, inv.code, { code: inv.code, message: value });
    assert.equal(r.status, 400, JSON.stringify(r.json));
    assert.ok(isStringRefusal(r), JSON.stringify(r.json));
    assert.deepEqual(residue(p, inv.invite_id, A.bot.id, B.bot.id), before, "no row, no invite use, no audit and no event");
  });
}

test("an absent message and null still store the default sentence, and the empty string stays empty", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const p = s.platform as any;

  for (const [label, body, expected] of [
    ["absent", {}, "Joined via invite link"],
    ["null", { message: null }, "Joined via invite link"],
    ["empty", { message: "" }, ""],
  ] as const) {
    const A = await ownerWithBot(s.base, `inv${label}`);
    const B = await ownerWithBot(s.base, `jn${label}`);
    const inv = p.createInvite(owner(A), { bot_id: A.bot.id, auto_accept: false, max_uses: 1 });

    const r = await ownerJoin(s.base, B.owner.token, inv.code, { from_bot_id: B.bot.id, ...body });
    assert.equal(r.status, 201, `${label}: ${JSON.stringify(r.json)}`);
    const row = p.db.prepare("SELECT message FROM relationships WHERE id = ?").get(r.json.relationship_id) as any;
    assert.equal(row.message, expected, `${label} keeps the written message`);
    assert.equal(residue(p, inv.invite_id, A.bot.id, B.bot.id).joins, 1, `${label} still audits a real join`);
  }
});

test("the signed door keeps the same default sentence and empty string", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const p = s.platform as any;

  for (const [label, extra, expected] of [
    ["absent", {}, "Joined via invite link"],
    ["empty", { message: "" }, ""],
  ] as const) {
    const A = await ownerWithBot(s.base, `invb${label}`);
    const B = await ownerWithBot(s.base, `jnb${label}`);
    const inv = p.createInvite(owner(A), { bot_id: A.bot.id, auto_accept: false, max_uses: 1 });

    const r = await botJoin(B.bot, inv.code, { code: inv.code, ...extra });
    assert.equal(r.status, 201, `${label}: ${JSON.stringify(r.json)}`);
    const row = p.db.prepare("SELECT message FROM relationships WHERE id = ?").get(r.json.relationship_id) as any;
    assert.equal(row.message, expected, `${label} keeps the written message`);
  }
});

test("the message gate sits after the relationship_exists 409 on both doors", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const p = s.platform as any;
  const { A, B } = await friends(s.base);
  const inv = p.createInvite(owner(A), { bot_id: A.bot.id, auto_accept: true });

  // An already-connected caller keeps today's 409: moving the gate above the check would answer 400 instead.
  const ownerAnswer = await ownerJoin(s.base, B.owner.token, inv.code, { from_bot_id: B.bot.id, message: {} });
  assert.equal(ownerAnswer.status, 409, JSON.stringify(ownerAnswer.json));
  assert.equal(ownerAnswer.json.error.code, "relationship_exists");

  const botAnswer = await botJoin(B.bot, inv.code, { code: inv.code, message: {} });
  assert.equal(botAnswer.status, 409, JSON.stringify(botAnswer.json));
  assert.equal(botAnswer.json.error.code, "relationship_exists");
});

test("the auto-accept regrant above the gate stores no message and keeps its answer", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const p = s.platform as any;
  const { A, B } = await friends(s.base);

  // Drop the inviter's live grants to the joiner so a fresh auto-accept invite takes the regrant path.
  const inviterOwner = p.db.prepare("SELECT owner_id FROM bots WHERE id = ?").get(A.bot.id).owner_id;
  const grants = p.db.prepare("SELECT id FROM grants WHERE grantor_owner = ? AND grantee_bot = ? AND status = 'active'").all(inviterOwner, B.bot.id) as any[];
  for (const g of grants) await A.owner.req("DELETE", `/v1/grants/${g.id}`);

  const inv = p.createInvite(owner(A), { bot_id: A.bot.id, auto_accept: true });
  const r = await ownerJoin(s.base, B.owner.token, inv.code, { from_bot_id: B.bot.id, message: {} });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.regranted, true, "the regrant path answered, it was not turned into a 400");
});

test("the DLP refusal keeps its 422 shape for a string message", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const p = s.platform as any;
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const inv = p.createInvite(owner(A), { bot_id: A.bot.id, auto_accept: false, max_uses: 1 });

  const r = await ownerJoin(s.base, B.owner.token, inv.code, { from_bot_id: B.bot.id, message: "here is the key ghp_abcdefghijklmnopqrstuvwxyz123456" });
  assert.equal(r.status, 422, JSON.stringify(r.json));
  assert.equal(r.json.error.code, "dlp_blocked");
});
