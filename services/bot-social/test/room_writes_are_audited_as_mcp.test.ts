/**
 * A room write the assistant made is not the owner's own click.
 *
 * README: "Connector writes are audited as `owner:<id>:mcp`, separate from web actions." The /ui audit page
 * renders that tag as "(through your assistant)" (`public/ui.js`, `auditActor`). Room routes are reached through
 * `faceAuth`, which accepts owner login tokens, connector tokens and Bot tokens alike (`src/server.ts`), and
 * README says so: the FlyBot REST routes take "the token FlyBot already has". A connector that opens a room,
 * seats a guest, mints or withdraws a ticket, picks the lead, leaves or ends a local claim is writing as the
 * assistant, so every row it leaves behind must carry the tag.
 *
 * The rows below are the ones the room doors append about their own writes: the join's implicit room grants
 * (`ensurePairRoomGrant` / `ensureLocalPairGrant`), `face_room.created` / `face_room.joined` / `face_room.started`
 * / `face_room.left` / `face_room.lead_changed`, the invite rows, and the local-room claim rows.
 *
 * Two more rows are written by the same doors about a caller's own doing: `face_room.lockout`, when a home spends
 * its failed attempts and the door locks it, and `grant.used_in_room`, when a join brings another home's Bot in on
 * a share. Both name the caller, so a connector's row names the assistant.
 *
 * (1), (3), (5) and (7) are the defect shape over the face-room and local-room doors, the lockout rows and the
 * share's room use; (2), (4), (6) and (8) are the same calls through the web session, which must keep their bare
 * actor: this tags the assistant, not every audit row. A tagged row that is tagged again would read `:mcp:mcp`,
 * so the controls assert no `:mcp` appears at all.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

let n = 0;

type S = Awaited<ReturnType<typeof startServer>>;

async function req(base: string, method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}

/** One home: a web session, a Bot, and (when asked) a connector token minted from that session. */
async function home(t: any, s: S, opts: { connector: boolean }) {
  const o = await ownerWithBot(s.base, `room${++n}`);
  const connector = opts.connector ? ((await o.owner.req("POST", "/v1/connector-tokens", { label: "writer" })) as any).token as string : null;
  return { ...o, web: o.owner.token, connector };
}

async function auditRows(s: S, token: string, afterSeq = 0) {
  const r: any = await req(s.base, "GET", "/v1/audit-events?limit=1000", token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return (r.body.events as any[]).filter((e: any) => e.seq > afterSeq);
}

const lastSeq = (events: any[]) => (events.length ? events[events.length - 1].seq : 0);
const grants = (count: number, actor: string) => Array.from({ length: count }, () => `grant.created ${actor}`);

const FACE_ACTIONS = new Set(["face_room.created", "face_room.joined", "face_room.started", "face_room.invite_minted", "face_room.invite_revoked", "face_room.lead_changed", "face_room.left", "grant.created"]);
const LOCAL_ACTIONS = new Set(["local_room.invite_minted", "local_room.invite_claimed", "local_room.claim_ended", "local_room.invite_released", "local_room.invite_revoked", "grant.created"]);
const SHARE_ACTIONS = new Set(["face_room.created", "grant.created", "grant.used_in_room"]);

/** The face-room lifecycle, one call per door; `tok` picks the caller's token for that role. */
async function faceFlow(s: S, tok: (h: { web: string | null; connector: string | null }) => string, A: any, B: any, C: any) {
  const created: any = await req(s.base, "POST", "/v1/face-rooms/join", tok(A), { code: "515151", bots: [A.bot.id] });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const roomId = created.body.room_id as string;
  assert.equal((await req(s.base, "POST", "/v1/face-rooms/join", tok(B), { code: "515151", bots: [B.bot.id] })).status, 200, "the second home joins the matching window");
  assert.equal((await req(s.base, "POST", `/v1/face-rooms/${roomId}/start`, tok(A))).status, 200, "the creator starts the room");
  const minted: any = await req(s.base, "POST", `/v1/face-rooms/${roomId}/invites`, tok(A));
  assert.equal(minted.status, 201, JSON.stringify(minted.body));
  assert.equal((await req(s.base, "POST", "/v1/face-rooms/join-invite", tok(C), { ticket: minted.body.ticket, bots: [C.bot.id] })).status, 200, "the third home joins with the ticket");
  assert.equal((await req(s.base, "DELETE", `/v1/face-rooms/${roomId}/invites/${minted.body.ticket}`, tok(A))).status, 200, "the lead withdraws the ticket");
  assert.equal((await req(s.base, "POST", `/v1/face-rooms/${roomId}/lead`, tok(A), { bot: B.bot.id })).status, 200, "the creator picks the lead");
  assert.equal((await req(s.base, "POST", `/v1/face-rooms/${roomId}/leave`, tok(B), {})).status, 200, "the lead leaves");
  return roomId;
}

/** The local-room lifecycle: a claim, the minting owner ending it, a second claim and its release. */
async function localFlow(s: S, tok: (h: { web: string | null; connector: string | null }) => string, A: any, B: any) {
  const ROOM = "session-3f2a9c1e-6b7d-4e1a-9f0c-2d4b6a8c0e12";
  const mint = async () => {
    const r: any = await req(s.base, "POST", "/v1/local-room-invites", tok(A), { room_id: ROOM, name: "Launch plan", bot_id: A.bot.id });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.ticket as string;
  };
  const claim = async (ticket: string) => {
    const r: any = await req(s.base, "POST", `/v1/local-room-invites/${ticket}/claim`, tok(B), { bots: [B.bot.id] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.claimed, true);
  };
  const first = await mint();
  await claim(first);
  assert.equal((await req(s.base, "DELETE", `/v1/local-room-invites/${first}/claims/${encodeURIComponent(B.handle)}`, tok(A))).status, 204, "the minting owner ends the claim");
  const second = await mint();
  await claim(second);
  assert.equal((await req(s.base, "DELETE", `/v1/local-room-invites/${second}`, tok(B))).status, 204, "the guest releases its own claim");
  assert.equal((await req(s.base, "DELETE", `/v1/local-room-invites/${second}`, tok(A))).status, 204, "the minting owner withdraws the ticket");
}

test("(1) the face-room doors audit a connector's writes as :mcp", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await home(t, s, { connector: true });
  const B = await home(t, s, { connector: true });
  const C = await home(t, s, { connector: true });
  const mark = lastSeq(await auditRows(s, A.web));

  await faceFlow(s, (h) => h.connector!, A, B, C);

  const actorA = `owner:${A.owner_id}:mcp`;
  const actorB = `owner:${B.owner_id}:mcp`;
  const actorC = `owner:${C.owner_id}:mcp`;
  const rows = (await auditRows(s, A.web, mark)).filter((e: any) => FACE_ACTIONS.has(e.action)).map((e: any) => `${e.action} ${e.actor}`);

  assert.deepEqual(rows, [
    `face_room.created ${actorA}`,
    ...grants(4, actorB),
    `face_room.joined ${actorB}`,
    `face_room.started ${actorA}`,
    `face_room.invite_minted ${actorA}`,
    ...grants(4, actorC),
    `face_room.joined ${actorC}`,
    `face_room.invite_revoked ${actorA}`,
    `face_room.lead_changed ${actorA}`,
    `face_room.left ${actorB}`,
  ], "every room write a connector made is the assistant's, and the join's grants with it");
  assert.ok(!rows.some((r) => r.includes(":mcp:mcp")), "a row is tagged once, never twice");
});

test("(2) control: the same face-room writes through the web session keep their bare actor", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await home(t, s, { connector: false });
  const B = await home(t, s, { connector: false });
  const C = await home(t, s, { connector: false });
  const mark = lastSeq(await auditRows(s, A.web));

  await faceFlow(s, (h) => h.web!, A, B, C);

  const actorA = `owner:${A.owner_id}`;
  const actorB = `owner:${B.owner_id}`;
  const actorC = `owner:${C.owner_id}`;
  const rows = (await auditRows(s, A.web, mark)).filter((e: any) => FACE_ACTIONS.has(e.action)).map((e: any) => `${e.action} ${e.actor}`);

  assert.deepEqual(rows, [
    `face_room.created ${actorA}`,
    ...grants(4, actorB),
    `face_room.joined ${actorB}`,
    `face_room.started ${actorA}`,
    `face_room.invite_minted ${actorA}`,
    ...grants(4, actorC),
    `face_room.joined ${actorC}`,
    `face_room.invite_revoked ${actorA}`,
    `face_room.lead_changed ${actorA}`,
    `face_room.left ${actorB}`,
  ], "the owner's own web writes are not tagged as the assistant's");
  assert.ok(!rows.some((r) => r.includes(":mcp")), "the web session's rows carry no tag at all");
});

test("(3) the local-room doors audit a connector's writes as :mcp", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await home(t, s, { connector: true });
  const B = await home(t, s, { connector: true });
  const mark = lastSeq(await auditRows(s, A.web));

  await localFlow(s, (h) => h.connector!, A, B);

  const actorA = `owner:${A.owner_id}:mcp`;
  const actorB = `owner:${B.owner_id}:mcp`;
  const rows = (await auditRows(s, A.web, mark)).filter((e: any) => LOCAL_ACTIONS.has(e.action)).map((e: any) => `${e.action} ${e.actor}`);

  assert.deepEqual(rows, [
    `local_room.invite_minted ${actorA}`,
    ...grants(4, actorB),
    `local_room.invite_claimed ${actorB}`,
    `local_room.claim_ended ${actorA}`,
    `local_room.invite_minted ${actorA}`,
    ...grants(4, actorB),
    `local_room.invite_claimed ${actorB}`,
    `local_room.invite_released ${actorB}`,
    `local_room.invite_revoked ${actorA}`,
  ], "a connector's local-room writes are the assistant's, the claim's grants with them");
  assert.ok(!rows.some((r) => r.includes(":mcp:mcp")), "a row is tagged once, never twice");
});

test("(4) control: the same local-room writes through the web session keep their bare actor", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await home(t, s, { connector: false });
  const B = await home(t, s, { connector: false });
  const mark = lastSeq(await auditRows(s, A.web));

  await localFlow(s, (h) => h.web!, A, B);

  const actorA = `owner:${A.owner_id}`;
  const actorB = `owner:${B.owner_id}`;
  const rows = (await auditRows(s, A.web, mark)).filter((e: any) => LOCAL_ACTIONS.has(e.action)).map((e: any) => `${e.action} ${e.actor}`);

  assert.deepEqual(rows, [
    `local_room.invite_minted ${actorA}`,
    ...grants(4, actorB),
    `local_room.invite_claimed ${actorB}`,
    `local_room.claim_ended ${actorA}`,
    `local_room.invite_minted ${actorA}`,
    ...grants(4, actorB),
    `local_room.invite_claimed ${actorB}`,
    `local_room.invite_released ${actorB}`,
    `local_room.invite_revoked ${actorA}`,
  ], "the owner's own web writes are not tagged as the assistant's");
  assert.ok(!rows.some((r) => r.includes(":mcp")), "the web session's rows carry no tag at all");
});

/**
 * Each door that can lock a home out writes `face_room.lockout` for the caller. Two counted failures reach
 * `failsBeforeLockout`; the second writes the row. A local-room claim's own refusals are recorded under labels the
 * lockout count does not include, so that door writes its row off an address that already reached the threshold:
 * the home that trips it writes the row, tagged like the rest.
 */
async function lockoutFlow(t: any, s: S, connector: boolean) {
  const A = await home(t, s, { connector });
  const B = await home(t, s, { connector });
  const C = await home(t, s, { connector });
  const D = await home(t, s, { connector });
  const E = await home(t, s, { connector });
  const tok = (h: { web: string | null; connector: string | null }) => (connector ? h.connector : h.web)!;
  const ip = { code: "198.51.100.41", invite: "198.51.100.42", shared: "198.51.100.43" };

  // E opens a one-seat room and hands B a ticket: B's Bot cannot fit next to E's.
  const room: any = await req(s.base, "POST", "/v1/face-rooms/join", tok(E), { code: "515151", bots: [E.bot.id] }, { "x-forwarded-for": "198.51.100.44" });
  assert.equal(room.status, 200, JSON.stringify(room.body));
  const minted: any = await req(s.base, "POST", `/v1/face-rooms/${room.body.room_id}/invites`, tok(E), undefined, { "x-forwarded-for": "198.51.100.44" });
  assert.equal(minted.status, 201, JSON.stringify(minted.body));

  // The six-digit window: two wrong shapes spend the budget, the second locks.
  const badCode = () => req(s.base, "POST", "/v1/face-rooms/join", tok(A), { code: "12", bots: [A.bot.id] }, { "x-forwarded-for": ip.code });
  assert.equal((await badCode()).status, 400, "a wrong code is refused, not locked");
  assert.equal((await badCode()).status, 400, "the second wrong code reaches the threshold and is still refused for being wrong");

  // The ticket door: a room that cannot seat the home spends the same budget.
  const full = () => req(s.base, "POST", "/v1/face-rooms/join-invite", tok(B), { ticket: minted.body.ticket, bots: [B.bot.id] }, { "x-forwarded-for": ip.invite });
  assert.equal((await full()).status, 409, "a full room is refused, not locked");
  assert.equal((await full()).status, 409, "the second refusal reaches the threshold");

  // D fills the address' budget on its own door; once that lockout lapses, C's claim on the same address trips it
  // again, and the row is C's.
  const fill = () => req(s.base, "POST", "/v1/face-rooms/join", tok(D), { code: "12", bots: [D.bot.id] }, { "x-forwarded-for": ip.shared });
  assert.equal((await fill()).status, 400);
  assert.equal((await fill()).status, 400);
  await new Promise((r) => setTimeout(r, 400));
  const claim = await req(s.base, "POST", "/v1/local-room-invites/fct-none-4b1e/claim", tok(C), { bots: [C.bot.id] }, { "x-forwarded-for": ip.shared });
  assert.equal(claim.status, 404, JSON.stringify(claim.body));
  return { A, B, C };
}

const lockoutRows = async (s: S, h: { web: string | null }) =>
  (await auditRows(s, h.web!)).filter((e: any) => e.action === "face_room.lockout").map((e: any) => `${e.action} ${e.actor}`);

/** F shares `chat.public` with A's Bot; then A opens a room and brings F's Bot in on that share. */
async function shareSetup(F: any, A: any) {
  const rel: any = await F.owner.req("POST", "/v1/relationships", { from_bot_id: F.bot.id, target_handle: A.handle, message: "bring my Bot along", requested_capabilities: ["chat.public"] });
  await A.owner.req("POST", `/v1/relationships/${rel.relationship_id}/consent`, { decision: "accept", grant_capabilities: [] });
  const grant: any = await F.owner.req("POST", `/v1/relationships/${rel.relationship_id}/grants`, { capability: "chat.public" });
  assert.ok(grant.grant_id, JSON.stringify(grant));
}

async function shareJoin(s: S, tok: (h: { web: string | null; connector: string | null }) => string, A: any, F: any) {
  const joined: any = await req(s.base, "POST", "/v1/face-rooms/join", tok(A), { code: "616161", bots: [A.bot.id, F.bot.id] });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
}

test("(5) a lockout a connector tripped is the assistant's row", async (t) => {
  const s = await startServer({ faceRooms: { failsBeforeLockout: 2, lockoutMs: 300, maxMembers: 1 } });
  t.after(s.stop);
  const { A, B, C } = await lockoutFlow(t, s, true);

  assert.deepEqual(await lockoutRows(s, A), [`face_room.lockout owner:${A.owner_id}:mcp`], "the code door's lockout row names the assistant");
  assert.deepEqual(await lockoutRows(s, B), [`face_room.lockout owner:${B.owner_id}:mcp`], "the ticket door's lockout row names the assistant");
  assert.deepEqual(await lockoutRows(s, C), [`face_room.lockout owner:${C.owner_id}:mcp`], "the local-room door's lockout row names the assistant");
  for (const h of [A, B, C]) assert.ok(!(await lockoutRows(s, h)).some((r) => r.includes(":mcp:mcp")), "a row is tagged once, never twice");
});

test("(6) control: a lockout the web session tripped keeps its bare actor", async (t) => {
  const s = await startServer({ faceRooms: { failsBeforeLockout: 2, lockoutMs: 300, maxMembers: 1 } });
  t.after(s.stop);
  const { A, B, C } = await lockoutFlow(t, s, false);

  assert.deepEqual(await lockoutRows(s, A), [`face_room.lockout owner:${A.owner_id}`]);
  assert.deepEqual(await lockoutRows(s, B), [`face_room.lockout owner:${B.owner_id}`]);
  assert.deepEqual(await lockoutRows(s, C), [`face_room.lockout owner:${C.owner_id}`]);
  for (const h of [A, B, C]) assert.ok(!(await lockoutRows(s, h)).some((r) => r.includes(":mcp")), "the web session's rows carry no tag at all");
});

test("(7) the share a connector's join uses in a room is audited as :mcp", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const F = await home(t, s, { connector: true });
  const A = await home(t, s, { connector: true });
  await shareSetup(F, A);
  const mark = lastSeq(await auditRows(s, A.web));

  await shareJoin(s, (h) => h.connector!, A, F);

  const actorA = `owner:${A.owner_id}:mcp`;
  const rows = (await auditRows(s, A.web, mark)).filter((e: any) => SHARE_ACTIONS.has(e.action)).map((e: any) => `${e.action} ${e.actor}`);
  assert.deepEqual(rows, [
    ...grants(4, actorA),
    `grant.used_in_room ${actorA}`,
    `face_room.created ${actorA}`,
  ], "the share's room use is the assistant's row, like the grants the join wrote: only the chat share seats the guest");
  assert.ok(!rows.some((r) => r.includes(":mcp:mcp")), "a row is tagged once, never twice");
});

test("(8) control: the same share used by the web session keeps its bare actor", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const F = await home(t, s, { connector: false });
  const A = await home(t, s, { connector: false });
  await shareSetup(F, A);
  const mark = lastSeq(await auditRows(s, A.web));

  await shareJoin(s, (h) => h.web!, A, F);

  const actorA = `owner:${A.owner_id}`;
  const rows = (await auditRows(s, A.web, mark)).filter((e: any) => SHARE_ACTIONS.has(e.action)).map((e: any) => `${e.action} ${e.actor}`);
  assert.deepEqual(rows, [
    ...grants(4, actorA),
    `grant.used_in_room ${actorA}`,
    `face_room.created ${actorA}`,
  ], "the owner's own share use is not tagged as the assistant's");
  assert.ok(!rows.some((r) => r.includes(":mcp")), "the web session's rows carry no tag at all");
});
