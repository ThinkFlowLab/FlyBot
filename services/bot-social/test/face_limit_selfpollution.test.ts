import assert from "node:assert/strict";
import { test } from "node:test";
import { expectApiError, ownerWithBot, startServer } from "./helpers.js";

// A face-room client must not throttle itself. Reading an invite link is a read and gets its own budget; a request
// refused for being over budget is not another check and writes nothing. Neither may spend or refill the join
// budget, and nothing here relaxes the thresholds themselves.

test("an owner's own invite previews do not spend their join budget", async () => {
  const s = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 2, attemptWindowMs: 600_000 } });
  try {
    const A = await ownerWithBot(s.base, "selfprev");
    const room = await A.owner.req("POST", "/v1/face-rooms/join", { code: "410001", bots: [A.bot.id] });
    const { ticket } = await A.owner.req("POST", `/v1/face-rooms/${room.room_id}/invites`, {});
    for (let i = 1; i <= 2; i++) {
      const p = await A.owner.req("GET", `/v1/face-rooms/invites/${ticket}`);
      assert.equal(p.room_id, room.room_id, `preview ${i} still answers`);
    }
    // The two reads are recorded against the address, not against an owner: that is why the join budget's per-IP
    // query filters on `owner_id IS NOT NULL`.
    const previews = s.platform.db.prepare("SELECT owner_id, outcome FROM face_room_attempts WHERE code = 'invite' AND outcome = 'preview'").all() as any[];
    assert.equal(previews.length, 2);
    assert.ok(previews.every((r) => r.owner_id === null), "a preview row carries no owner");
    // The preview budget is still a budget: a third read is refused, but that refusal cannot reach the join one.
    await expectApiError(A.owner.req("GET", `/v1/face-rooms/invites/${ticket}`), 429, "rate_limited");
    const again = await A.owner.req("POST", "/v1/face-rooms/join", { code: "410002", bots: [A.bot.id] });
    assert.ok(again.room_id, "the owner can still join after reading their own invite twice, and a third refused read");
  } finally { await s.stop(); }
});

test("a ticket is a door check too: invalid tickets spend the join budget", async () => {
  const s = await startServer({ faceRooms: { attemptsPerAccount: 3, attemptsPerIp: 50, attemptWindowMs: 600_000 } });
  try {
    const A = await ownerWithBot(s.base, "selfinvite");
    await A.owner.req("POST", "/v1/face-rooms/join", { code: "430001", bots: [A.bot.id] });
    const bad = "x".repeat(43);
    const joinInvite = () => A.owner.req("POST", "/v1/face-rooms/join-invite", { ticket: bad, bots: [A.bot.id] });
    await expectApiError(joinInvite(), 404, "invite_not_found");
    await expectApiError(joinInvite(), 404, "invite_not_found");
    await expectApiError(joinInvite(), 429, "rate_limited"); // the third check meets the same limit a code does
  } finally { await s.stop(); }
});

test("a request refused for being over budget writes no attempt row", async () => {
  const s = await startServer({ faceRooms: { attemptsPerAccount: 2, attemptsPerIp: 50, attemptWindowMs: 600_000 } });
  try {
    const A = await ownerWithBot(s.base, "selfrows");
    const join = (code: string) => A.owner.req("POST", "/v1/face-rooms/join", { code, bots: [A.bot.id] });
    await join("440001");
    await join("440002");
    const rows = () => (s.platform.db.prepare("SELECT COUNT(*) n FROM face_room_attempts").get() as any).n as number;
    const before = rows();
    for (let i = 0; i < 3; i++) await expectApiError(join("440003"), 429, "rate_limited");
    assert.equal(rows(), before, "a refused retry is not another attempt: it writes no row");
    const refused = (s.platform.db.prepare("SELECT COUNT(*) n FROM face_room_attempts WHERE outcome = 'rate_limited'").get() as any).n as number;
    assert.equal(refused, 0, "nothing records the refusal itself");
  } finally { await s.stop(); }
});

test("a client that retries while throttled is not kept throttled by its own retries", async () => {
  let now = Date.parse("2026-10-30T00:00:00Z");
  const s = await startServer({ now: () => now, faceRooms: { attemptsPerAccount: 2, attemptsPerIp: 50, attemptWindowMs: 60_000 } });
  try {
    const A = await ownerWithBot(s.base, "selfretry");
    const join = (code: string) => A.owner.req("POST", "/v1/face-rooms/join", { code, bots: [A.bot.id] });
    await join("420001");
    await join("420002");
    await expectApiError(join("420003"), 429, "rate_limited");
    now += 20_000;
    await expectApiError(join("420003"), 429, "rate_limited");
    now += 20_000;
    await expectApiError(join("420003"), 429, "rate_limited");
    now += 21_000; // the window the owner filled has passed
    const ok = await join("420003");
    assert.ok(ok.room_id, "the window the owner filled is over: their own refused retries must not refill it");
  } finally { await s.stop(); }
});

test("a failed ticket check does not spend the preview budget", async () => {
  const s = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 3, attemptWindowMs: 600_000 } });
  try {
    const A = await ownerWithBot(s.base, "selfmirror");
    const B = await ownerWithBot(s.base, "selfmirrorb");
    // Two addresses: the host opens the room, the guest comes from elsewhere and only ever shows a dead ticket.
    const host = "203.0.113.10", guest = "203.0.113.20";
    const call = async (method: string, path: string, token: string | null, body: unknown, ip: string) => {
      const r = await fetch(s.base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), "x-forwarded-for": ip }, body: body !== undefined ? JSON.stringify(body) : undefined });
      const text = await r.text();
      return { status: r.status, body: text ? JSON.parse(text) : {} };
    };
    const opened = await call("POST", "/v1/face-rooms/join", A.owner.token, { code: "470001", bots: [A.bot.id] }, host);
    assert.equal(opened.status, 200);
    const minted = await call("POST", `/v1/face-rooms/${opened.body.room_id}/invites`, A.owner.token, {}, host);
    assert.equal(minted.status, 201);
    const bad = "z".repeat(43);
    const joinInvite = () => call("POST", "/v1/face-rooms/join-invite", B.owner.token, { ticket: bad, bots: [B.bot.id] }, guest);
    // Three dead tickets fill the guest's per-address join cap of three, so these are the last checks it can make.
    for (let i = 1; i <= 3; i++) assert.equal((await joinInvite()).status, 404, `ticket check ${i} is checked, not throttled`);
    const rows = s.platform.db.prepare("SELECT owner_id, ip, outcome FROM face_room_attempts WHERE outcome = 'invite_not_found'").all() as any[];
    assert.equal(rows.filter((r) => r.owner_id !== null && r.ip === guest).length, 3, "the failed ticket checks were recorded against the guest");
    // The same address then reads a live invite. Its own reads are the only rows the preview budget may count:
    // these three are the guest's, on the join side, and a join must not spend the read budget any more than a
    // read spends the join one.
    const preview = await call("GET", `/v1/face-rooms/invites/${minted.body.ticket}`, null, undefined, guest);
    assert.equal(preview.status, 200, "the same address can still read a live invite");
    assert.equal(preview.body.room_id, opened.body.room_id);
  } finally { await s.stop(); }
});
