/**
 * A query key sent twice reaches a route as an array. A route that reads a single value out of that array gets the
 * wrong answer in one of two ways: the array is bound to SQLite and the route answers 500, or it is compared
 * against a string and the route reads "not sent" — a 404/403 that blames the caller, a filter that matches
 * nothing, or a fallback that quietly picks another Bot. `oneQ` in `src/server.ts` refuses such a key with a 400
 * that names it, before the route sees it; a key sent once, empty value included, keeps doing exactly what it did.
 *
 * The table below walks every gate that reads one value out of the query, so a new one cannot quietly skip the
 * helper. The last test scans the source for that same mistake instead of relying on the table staying complete.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { bulkAuth, friends, startServer } from "./helpers.js";

const enc = (v: string) => encodeURIComponent(v);
const b64 = (v: string) => Buffer.from(v).toString("base64");

async function call(base: string, method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json: any = {};
  try { json = JSON.parse(text); } catch { /* the OAuth callback answers a page, not JSON */ }
  return { status: r.status, code: json?.error?.code, message: json?.error?.message, body: json };
}

function assertRefused(r: { status: number; code?: string; message?: string }, key: string) {
  assert.equal(r.status, 400, `a repeated ${key} must be refused, not read as "not sent" or handed to SQLite`);
  assert.equal(r.code, "invalid_request", `a repeated ${key} is a malformed request, not an authority answer`);
  assert.equal(r.message, `${key} must be sent once`, `the refusal names the key that was sent twice`);
}

type World = Awaited<ReturnType<typeof world>>;

/** One server holding every fixture the gates below need: a delivered file, a live grant, a home, a room. */
async function world(t: any) {
  const s: any = await startServer({ ...bulkAuth });
  t.after(s.stop);
  const { A, B } = await friends(s.base);

  // A file that is really deliverable: uploaded, sent on a draft, approved, so the peer may read it.
  const up: any = await call(s.base, "POST", "/v1/attachments", A.owner.token, { bot_id: A.bot.id, name: "p.txt", content_base64: b64("hello") });
  const file = up.body.attachment;
  const conv: any = await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "attachment" });
  const draft: any = await A.bot.signed(`/v1/conversations/${conv.conversation_id}/messages`, "message.draft",
    { text: "see attached", attachments: [file] }, { conversation_id: conv.conversation_id });
  const decided: any = await A.owner.req("POST", `/v1/approvals/${draft.approval_id}/decision`, { decision: "approved" });
  assert.equal(decided.status, "delivered", "fixture: the file reaches the peer");

  // A live grant A -> B: the grantee may decline it, and the decline names the Bot it is for.
  const granted: any = await call(s.base, "POST", `/v1/bots/${A.bot.id}/grants`, A.owner.token, { friend_owner_id: B.owner_id, friend_bot_id: B.bot.id });
  assert.equal(granted.status, 201, "fixture: the grant is live");
  const remote: any = await call(s.base, "GET", "/v1/remote-bots", B.owner.token);
  const grantId = remote.body.bots?.[0]?.grant_id as string;
  assert.ok(grantId, "fixture: the grantee sees the grant");

  // A FlyBot home and its connector token: the one owner whose `home` filter is not a 404.
  const onboard: any = await call(s.base, "POST", "/v1/onboard/flybot", undefined, { display_name: "Home" });
  const homeId = onboard.body.home.bot_id as string;
  const homeToken = onboard.body.connector.token as string;

  // One open room with both homes seated, and B's Bot thinking toward it.
  const opened: any = await call(s.base, "POST", "/v1/face-rooms/join", A.owner.token, { code: "770101", bots: [A.bot.id] });
  const joined: any = await call(s.base, "POST", "/v1/face-rooms/join", B.owner.token, { code: "770101", bots: [B.bot.id] });
  const roomId = opened.body.room_id as string;
  assert.equal(joined.body.room_id, roomId, "fixture: both homes are in one room");
  assert.equal((await call(s.base, "POST", `/v1/face-rooms/${roomId}/start`, A.owner.token, {})).status, 200, "fixture: the room is open");
  assert.equal((await call(s.base, "PUT", "/v1/presence", B.reg.bot_token, { state: "thinking", room_id: roomId })).status, 200, "fixture: B's Bot is thinking toward the room");

  return { s, A, B, file, grantId, homeId, homeToken, roomId };
}

type Leg = {
  gate: string;
  key: string;
  /** A repeat of the key, the same value twice: Fastify hands this over as an array. */
  dup: () => Promise<{ status: number; code?: string; message?: string }>;
  /** The same key sent once: the request the gate has always answered. */
  single: () => Promise<any>;
  expect: number;
  /** Extra assertions for a single call whose body is the evidence, not only its status. */
  check?: (r: any) => void;
};

function legs(w: World): Leg[] {
  const base = w.s.base;
  return [
    {
      gate: "GET /v1/attachments/:id", key: "bot_id", expect: 200,
      dup: () => call(base, "GET", `/v1/attachments/${w.file.id}?bot_id=${enc(w.B.bot.id)}&bot_id=${enc(w.B.bot.id)}`, w.B.owner.token),
      single: () => call(base, "GET", `/v1/attachments/${w.file.id}?bot_id=${enc(w.B.bot.id)}`, w.B.owner.token),
      check: (r) => assert.equal(r.body.attachment?.id, w.file.id, "one bot_id still names the attachment"),
    },
    {
      gate: "GET /v1/remote-bots", key: "home", expect: 200,
      dup: () => call(base, "GET", `/v1/remote-bots?home=${enc(w.homeId)}&home=${enc(w.homeId)}`, w.homeToken),
      single: () => call(base, "GET", `/v1/remote-bots?home=${enc(w.homeId)}`, w.homeToken),
      check: (r) => assert.ok(Array.isArray(r.body.bots), "one home still answers the roster"),
    },
    {
      gate: "GET /v1/remote-bots", key: "home_id", expect: 200,
      dup: () => call(base, "GET", `/v1/remote-bots?home_id=${enc(w.homeId)}&home_id=${enc(w.homeId)}`, w.homeToken),
      single: () => call(base, "GET", `/v1/remote-bots?home_id=${enc(w.homeId)}`, w.homeToken),
      check: (r) => assert.ok(Array.isArray(r.body.bots), "one home_id still answers the roster"),
    },
    {
      gate: "DELETE /v1/remote-bots/:grantId", key: "bot_id", expect: 200,
      dup: () => call(base, "DELETE", `/v1/remote-bots/${w.grantId}?bot_id=${enc(w.A.bot.id)}&bot_id=${enc(w.A.bot.id)}`, w.B.owner.token),
      single: () => call(base, "DELETE", `/v1/remote-bots/${w.grantId}?bot_id=${enc(w.A.bot.id)}`, w.B.owner.token),
      check: (r) => assert.equal(r.body.status, "declined", "one bot_id still declines the grant"),
    },
    {
      gate: "GET /v1/connector/webhook", key: "bot_id", expect: 200,
      dup: () => call(base, "GET", `/v1/connector/webhook?bot_id=${enc(w.A.bot.id)}&bot_id=${enc(w.A.bot.id)}`, w.A.owner.token),
      single: () => call(base, "GET", `/v1/connector/webhook?bot_id=${enc(w.A.bot.id)}`, w.A.owner.token),
    },
    {
      gate: "DELETE /v1/connector/webhook", key: "bot_id", expect: 200,
      dup: () => call(base, "DELETE", `/v1/connector/webhook?bot_id=${enc(w.B.bot.id)}&bot_id=${enc(w.B.bot.id)}`, w.B.owner.token),
      single: () => call(base, "DELETE", `/v1/connector/webhook?bot_id=${enc(w.B.bot.id)}`, w.B.owner.token),
    },
    {
      gate: "GET /v1/friends-overview", key: "bot_id", expect: 200,
      dup: () => call(base, "GET", `/v1/friends-overview?bot_id=${enc(w.A.bot.id)}&bot_id=${enc(w.A.bot.id)}`, w.A.owner.token),
      single: () => call(base, "GET", `/v1/friends-overview?bot_id=${enc(w.A.bot.id)}`, w.A.owner.token),
      check: (r) => assert.equal(r.body.bot?.bot_id, w.A.bot.id, "one bot_id still selects that Bot"),
    },
    {
      gate: "GET /v1/approvals", key: "status", expect: 200,
      dup: () => call(base, "GET", "/v1/approvals?status=pending&status=pending", w.A.owner.token),
      single: () => call(base, "GET", "/v1/approvals?status=pending", w.A.owner.token),
      check: (r) => assert.ok(Array.isArray(r.body.approvals), "one status still answers the queue"),
    },
    {
      gate: "GET /v1/search", key: "q", expect: 200,
      dup: () => call(base, "GET", "/v1/search?q=hello&q=hello", w.A.owner.token),
      single: () => call(base, "GET", "/v1/search?q=hello", w.A.owner.token),
    },
    {
      gate: "GET /v1/presence", key: "bot_id", expect: 200,
      dup: () => call(base, "GET", `/v1/presence?bot_id=${enc(w.A.bot.id)}&bot_id=${enc(w.A.bot.id)}`, w.A.owner.token),
      single: () => call(base, "GET", `/v1/presence?bot_id=${enc(w.A.bot.id)}`, w.A.owner.token),
      check: (r) => assert.ok(Array.isArray(r.body.presence), "one bot_id still answers the line"),
    },
    {
      gate: "GET /v1/presence", key: "room_id", expect: 200,
      dup: () => call(base, "GET", `/v1/presence?room_id=${enc(w.roomId)}&room_id=${enc(w.roomId)}`, w.A.owner.token),
      single: () => call(base, "GET", `/v1/presence?room_id=${enc(w.roomId)}`, w.A.owner.token),
      check: (r) => assert.equal(r.body.presence?.length, 1, "one room_id still shows the other home thinking toward the room"),
    },
    {
      gate: "GET /v1/face-rooms/:id", key: "as", expect: 200,
      dup: () => call(base, "GET", `/v1/face-rooms/${w.roomId}?as=${enc(w.A.handle)}&as=${enc(w.A.handle)}`, w.A.owner.token),
      single: () => call(base, "GET", `/v1/face-rooms/${w.roomId}?as=${enc(w.A.handle)}`, w.A.owner.token),
      check: (r) => assert.equal(r.body.room_id, w.roomId, "one as still names the seat"),
    },
    {
      gate: "GET /v1/face-rooms/:id", key: "bot", expect: 200,
      dup: () => call(base, "GET", `/v1/face-rooms/${w.roomId}?bot=${enc(w.A.handle)}&bot=${enc(w.A.handle)}`, w.A.owner.token),
      single: () => call(base, "GET", `/v1/face-rooms/${w.roomId}?bot=${enc(w.A.handle)}`, w.A.owner.token),
      check: (r) => assert.equal(r.body.room_id, w.roomId, "one bot still names the seat through the fallback"),
    },
    {
      gate: "GET /v1/face-rooms/:id", key: "as_bot", expect: 200,
      dup: () => call(base, "GET", `/v1/face-rooms/${w.roomId}?as_bot=${enc(w.A.handle)}&as_bot=${enc(w.A.handle)}`, w.A.owner.token),
      single: () => call(base, "GET", `/v1/face-rooms/${w.roomId}?as_bot=${enc(w.A.handle)}`, w.A.owner.token),
      check: (r) => assert.equal(r.body.room_id, w.roomId, "one as_bot still names the seat"),
    },
  ];
}

test("every single-value gate refuses a key sent twice, and one key keeps its answer", async (t) => {
  const w = await world(t);
  for (const leg of legs(w)) {
    await t.test(`${leg.gate} — ${leg.key}`, async () => {
      const refused = await leg.dup();
      assertRefused(refused, leg.key);
      // The repeated request must not have done what the single one does: the refusal comes before the effect.
      const single = await leg.single();
      assert.equal(single.status, leg.expect, `one ${leg.key} still answers ${leg.expect}`);
      leg.check?.(single);
    });
  }
});

test("a single key still reads the same, empty value and fallbacks included", async (t) => {
  const w = await world(t);

  // An empty value is a value: it is not a repeat, and it keeps the meaning the gate had before.
  assert.equal((await call(w.s.base, "GET", "/v1/approvals?status=", w.A.owner.token)).status, 200, "?status= is still an empty filter");
  const fromHomeId = await call(w.s.base, "GET", `/v1/remote-bots?home_id=${enc(w.homeId)}`, w.homeToken);
  const emptyHome = await call(w.s.base, "GET", `/v1/remote-bots?home=&home_id=${enc(w.homeId)}`, w.homeToken);
  assert.equal(emptyHome.status, 200, "?home= is still empty and falls through to home_id");
  assert.deepEqual(emptyHome.body.bots, fromHomeId.body.bots, "the fallback answers exactly the fallback's roster");
  // The search contract is its own: an empty q is a 400 invalid_query and stays one, with its own message.
  const emptyQ = await call(w.s.base, "GET", "/v1/search?q=", w.A.owner.token);
  assert.equal(emptyQ.status, 400);
  assert.equal(emptyQ.code, "invalid_query", "an empty q is not rewritten as a repeated key");
});

test("no single-value query read in server.ts skips oneQ", () => {
  // The helper is the one owner of the rule: a key may carry one value or none. `limit`, `since` and `after` have
  // their own parsers and their own published contracts; everything else read with `Q(req).x` must arrive through
  // `oneQ`. A new gate that forgets it fails here even if the table above is not updated.
  const src = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  const ownParser = new Set(["limit", "since", "after"]);
  const unwrapped: string[] = [];
  for (const m of src.matchAll(/Q\(req\)\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const key = m[1];
    if (ownParser.has(key)) continue;
    const before = src.slice(Math.max(0, (m.index ?? 0) - 12), m.index ?? 0);
    if (/oneQ\(\s*$/.test(before)) continue;
    unwrapped.push(`${key} (offset ${m.index})`);
  }
  assert.deepEqual(unwrapped, [], "a single-value read outside oneQ answers an array as a 500 or as \"not sent\"");
});
