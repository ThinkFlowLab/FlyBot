// The local-room claim door read its `bots` list with `String()`. A nested array holding one name stringified
// to that name and claimed it -- a claim the caller never wrote as a name, written as a row, granted and
// audited -- and a number, an object, a boolean or a null was looked up as the text it prints as and answered
// `404 bot_not_found` ("no bot matching 123 on this account"), naming the wrong problem. The face-room join
// door and the leave door already judge the same field with `assertFaceBotRefs`: an explicit list names Bots,
// so an element that is not a non-empty string is refused before anything is read. The local-room claim door
// was the one left out. A claim is a row plus a grant pair per Bot, so a refusal must write none of it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

const ROOM = "session-4c1f7a02-9d3e-4b58-8a6f-2e7c0d5b1a93";

async function req(base: string, method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  const json = text ? JSON.parse(text) : {};
  return { status: r.status, body: json.error ? json.error : json };
}
const mint = (base: string, o: any) => req(base, "POST", "/v1/local-room-invites", o.owner.token, { room_id: ROOM, name: "Launch plan", bot_id: o.bot.id });
const claim = (base: string, o: any, ticket: string, body: unknown) =>
  req(base, "POST", `/v1/local-room-invites/${encodeURIComponent(ticket)}/claim`, o.owner.token, body);

test("a claim's bots list is judged: an element that is not a name is refused and nothing is written", async (t) => {
  const s = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200, invitesPerAccount: 50, invitesPerIp: 200 } });
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const db: any = s.platform.db;
  const count = (sql: string, ...args: unknown[]) => Number((db.prepare(sql).get(...args) as any).n);
  const claims = () => count("SELECT COUNT(*) n FROM local_room_invite_claims");
  const roomGrants = () => count("SELECT COUNT(*) n FROM grants WHERE room_id = ?", ROOM);
  const roomRelationships = () => count("SELECT COUNT(*) n FROM relationships WHERE status = 'room'");
  const claimedRecords = () => ((s.platform as any).audit.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action = 'local_room.invite_claimed'").get() as any).n as number;

  // The shapes the shared reader turned into text: `[["@ben.bot"]]` claimed as the name it prints as, and
  // `123` / `{...}` / `true` / `null` are the strings "123" / "[object Object]" / "true" / "null" to it.
  const malformed: [string, unknown][] = [
    ["a nested array holding a name", { bots: [[B.bot.id]] }],
    ["a number", { bots: [123] }],
    ["an object", { bots: [{ id: B.bot.id }] }],
    ["a boolean", { bots: [true] }],
    ["a null beside a name", { bots: [B.bot.id, null] }],
    ["a blank entry", { bots: [""] }],
    ["an empty list", { bots: [] }],
  ];
  const answers: string[] = [];
  for (const [name, body] of malformed) {
    const m = await mint(s.base, A);
    assert.equal(m.status, 201, JSON.stringify(m.body));
    const r = await claim(s.base, B, m.body.ticket, body);
    answers.push(`${name}: ${r.status} ${r.body.code ?? "ok"}`);
  }
  assert.deepEqual(answers, malformed.map(([name]) => `${name}: 400 invalid_request`),
    "an explicit list names Bots, so every one of these is a 400 invalid_request, not a claim and not a bot_not_found");
  assert.equal(claims(), 0, "a refused claim leaves no claim row");
  assert.equal(roomGrants(), 0, "a refused claim leaves no room grant");
  assert.equal(roomRelationships(), 0, "a refused claim leaves no 'room' relationship");
  assert.equal(claimedRecords(), 0, "a refused claim writes no local_room.invite_claimed record");
});

test("a list of names still claims, and the shapes the door already took keep working", async (t) => {
  const s = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200, invitesPerAccount: 50, invitesPerIp: 200 } });
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const db: any = s.platform.db;
  const claims = () => Number((db.prepare("SELECT COUNT(*) n FROM local_room_invite_claims").get() as any).n);
  const claimedRecords = () => ((s.platform as any).audit.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action = 'local_room.invite_claimed'").get() as any).n as number;

  const bodies: [string, unknown][] = [
    ["a list of ids", { bots: [B.bot.id] }],
    ["a list of handles", { bots: [B.handle] }],
    ["the bare string the door also read", { bots: B.bot.id }],
  ];
  for (const [name, body] of bodies) {
    const m = await mint(s.base, A);
    assert.equal(m.status, 201, JSON.stringify(m.body));
    const r = await claim(s.base, B, m.body.ticket, body);
    assert.equal(r.status, 200, `${name}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.claimed, true, name);
    assert.deepEqual(r.body.bots, [B.handle], `${name}: the claim names the Bot it bound`);
  }
  assert.equal(claims(), 3, "each well-formed claim wrote its own row");
  assert.equal(claimedRecords(), 3, "each well-formed claim wrote its own record");
});
