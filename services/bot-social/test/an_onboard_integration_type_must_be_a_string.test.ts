// `POST /v1/onboard` and `/v1/onboard/flybot` hand a caller's `integration_type` straight to `registerBot`,
// whose declaration says string and whose insert does not check it. An object is refused by the SQLite binder as a
// 500 `internal_error` after the owner row and its key were already built inside the transaction; a number, a
// boolean or a single-element array is accepted and stored as text (`42` becomes "42.0", `["x"]` becomes "x"), so
// the Bot outlives the call under a type the caller never wrote; `0` and `false` are falsy and quietly take the
// default. A type is either named as a string or absent: anything else is a 400 `invalid_request`
// "integration_type must be a string" before the owner, the Bot, the keys, the custody row and the audit line.
// An absent, `null` or empty `integration_type` keeps the "grok-bot" default, every string value keeps the answer
// it had, and `/v1/onboard/flybot` still pins "flybot-home" for the home Bot it creates.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startServer, bulkAuth } from "./helpers.js";

const one = (db: any, sql: string) => (db.prepare(sql).get() as any).n as number;

function counts(p: any) {
  return {
    owners: one(p.db, "SELECT COUNT(*) n FROM owners"),
    bots: one(p.db, "SELECT COUNT(*) n FROM bots"),
    botKeys: one(p.db, "SELECT COUNT(*) n FROM bot_keys"),
    botTokens: one(p.db, "SELECT COUNT(*) n FROM tokens WHERE kind = 'bot'"),
    ownerTokens: one(p.db, "SELECT COUNT(*) n FROM tokens WHERE kind = 'owner'"),
    custody: one(p.db, "SELECT COUNT(*) n FROM bot_custody"),
    registered: one(p.audit.db, "SELECT COUNT(*) n FROM audit_events WHERE action = 'bot.registered'"),
    audit: one(p.audit.db, "SELECT COUNT(*) n FROM audit_events"),
  };
}

/** One private server per shape; onboarding needs no login, only an empty shop. */
async function onServer(t: any) {
  const s: any = await startServer(bulkAuth as any);
  t.after(s.stop);
  const post = async (path: string, body: unknown) => {
    const res = await fetch(s.base + path, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as any };
  };
  return { p: s.platform as any, post };
}

const err = (r: { body: any }) => r.body.error ?? {};
const isTypeRefusal = (r: { status: number; body: any }) =>
  r.status === 400 && err(r).code === "invalid_request" && err(r).message === "integration_type must be a string";
const onboard = (extra: Record<string, unknown>) => ({ username: "probe", password: "secret-pw", display_name: "Probe", ...extra });

// Every present non-string the gate must stop: the object, the array and `true` crashed the insert on the base;
// the numbers and the single-element array were written as text; `0` and `false` were silently defaulted.
const bad: [string, unknown][] = [
  ["an object", {}],
  ["an empty array", []],
  ["an array holding a string", ["x"]],
  ["a number", 42],
  ["a fraction", 1.5],
  ["a boolean", true],
  ["the other boolean", false],
  ["zero", 0],
  ["an object with no string conversion", { toString: null }],
];

for (const [label, value] of bad) {
  test(`an onboard integration_type given as ${label} is a 400 and writes nothing`, async (t) => {
    const { p, post } = await onServer(t);
    const before = counts(p);

    const r = await post("/v1/onboard", onboard({ integration_type: value }));
    assert.ok(isTypeRefusal(r), `expected 400 integration_type must be a string, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.deepEqual(counts(p), before, "no owner, Bot, key, token, custody row or audit line");
    assert.deepEqual(p.all("SELECT handle FROM bots"), [], "nothing was registered under a coerced type");
  });
}

test("an absent, null or empty integration_type still takes the existing default", async (t) => {
  for (const extra of [{}, { integration_type: null }, { integration_type: "" }]) {
    const { p, post } = await onServer(t);
    const r = await post("/v1/onboard", onboard(extra));
    assert.equal(r.status, 201, `${JSON.stringify(extra)}: ${JSON.stringify(r.body)}`);
    assert.equal(p.get("SELECT integration_type FROM bots").integration_type, "grok-bot");
  }
});

test("every string integration_type is stored exactly as written", async (t) => {
  for (const value of ["rest", "flybot-home", "manual", "something-else"]) {
    const { p, post } = await onServer(t);
    const r = await post("/v1/onboard", onboard({ integration_type: value }));
    assert.equal(r.status, 201, `${value}: ${JSON.stringify(r.body)}`);
    assert.equal(p.get("SELECT integration_type FROM bots").integration_type, value);
  }
});

test("the existing bot_handle gate still answers first", async (t) => {
  const { p, post } = await onServer(t);
  const before = counts(p);

  const r = await post("/v1/onboard", onboard({ bot_handle: true, integration_type: {} }));
  assert.equal(r.status, 400);
  assert.equal(err(r).code, "invalid_request");
  assert.equal(err(r).message, "bot_handle must be a string", "the handle gate was already there and keeps its order");
  assert.deepEqual(counts(p), before);
});

test("the flybot route still pins the home Bot to flybot-home whatever was sent", async (t) => {
  for (const value of [{}, 1.5, true]) {
    const { p, post } = await onServer(t);
    const r = await post("/v1/onboard/flybot", onboard({ integration_type: value }));
    assert.equal(r.status, 201, `${JSON.stringify(value)}: ${JSON.stringify(r.body)}`);
    assert.equal(p.get("SELECT integration_type FROM bots").integration_type, "flybot-home", "the route owns this value, not the caller");
  }
});

test("a refused onboard leaves no half-built owner behind", async (t) => {
  const { p, post } = await onServer(t);
  const before = counts(p);

  const refused = await post("/v1/onboard", onboard({ integration_type: {} }));
  assert.ok(isTypeRefusal(refused));
  assert.deepEqual(counts(p), before, "nothing but the platform's own startup line");

  const real = await post("/v1/onboard", onboard({ integration_type: "rest" }));
  assert.equal(real.status, 201, "the same username and handle are still free after a refusal");
  assert.equal(p.get("SELECT integration_type FROM bots").integration_type, "rest");
});
