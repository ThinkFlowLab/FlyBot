// `POST /v1/bots` declares `integration_type` as a string, but `registerBot` never looked at it: an object, an
// array or a boolean reached the SQLite binder and came back as a 500 `internal_error`; `42`, `1.5`, `[1]` and
// `["x"]` answered 201 with the Bot stored under the coerced text ("42.0", "1.5", "1.0", "x") — a type the caller
// never wrote, which every later `GET /v1/bots` reads back; and `0` and `false` were swallowed by `|| "rest"` into
// the default without saying so. A type is a name, not a value to coerce: a present value that is not a string is
// a 400 `invalid_request` "integration_type must be a string" before the Bot row, its key, its token, its custody
// row and the audit line. An absent, `null` or empty value keeps the "rest" default, and every string keeps the
// value it had, spaces included — there is no allowed-values list here and none is added.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startServer, bulkAuth } from "./helpers.js";

function counts(p: any) {
  const one = (db: any, sql: string) => (db.prepare(sql).get() as any).n as number;
  return {
    owners: one(p.db, "SELECT COUNT(*) n FROM owners"),
    bots: one(p.db, "SELECT COUNT(*) n FROM bots"),
    botKeys: one(p.db, "SELECT COUNT(*) n FROM bot_keys"),
    botTokens: one(p.db, "SELECT COUNT(*) n FROM tokens WHERE kind = 'bot'"),
    custody: one(p.db, "SELECT COUNT(*) n FROM bot_custody"),
    events: one(p.db, "SELECT COUNT(*) n FROM events"),
    registered: one(p.audit.db, "SELECT COUNT(*) n FROM audit_events WHERE action = 'bot.registered'"),
    audit: one(p.audit.db, "SELECT COUNT(*) n FROM audit_events"),
  };
}

/** One owner on a private server; the door only needs a login token and an empty shop. */
async function ownerOnServer(t: any) {
  const s = await startServer(bulkAuth as any);
  t.after(s.stop);
  const r = await fetch(s.base + "/v1/owners", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "probe", password: "secret-pw", display_name: "Probe" }),
  });
  const owner = (await r.json()) as any;
  const post = async (body: unknown) => {
    const res = await fetch(s.base + "/v1/bots", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.owner_token}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as any };
  };
  return { s, p: s.platform as any, post };
}

const err = (r: { body: any }) => r.body.error ?? {};
const isTypeRefusal = (r: { status: number; body: any }) =>
  r.status === 400 && err(r).code === "invalid_request" && err(r).message === "integration_type must be a string";

// Every present non-string the gate must stop: the object, the array, `true` and an unreadable `toString` crashed
// the insert on the base; the numbers and the single-element arrays were written as text; `0` and `false` quietly
// took the default.
const bad: [string, unknown][] = [
  ["an object", {}],
  ["an array", []],
  ["an array holding a name", ["x"]],
  ["an array holding a number", [1]],
  ["a boolean", true],
  ["a false boolean", false],
  ["a whole number", 42],
  ["a fraction", 1.5],
  ["zero", 0],
  ["an object without toString", { toString: null }],
];

for (const [label, value] of bad) {
  test(`a Bot integration type given as ${label} is a 400 and writes nothing`, async (t) => {
    const { p, post } = await ownerOnServer(t);
    const before = counts(p);

    const r = await post({ handle: "probe.bot", integration_type: value });
    assert.ok(isTypeRefusal(r), `expected 400 integration_type must be a string, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.deepEqual(counts(p), before, "no Bot, no key, no token, no custody row and no audit line");
  });
}

test("a refused integration type claims no handle and mints no Bot, then the same handle registers with a string type", async (t) => {
  const { p, post } = await ownerOnServer(t);

  const refused = await post({ handle: "probe.bot", integration_type: { name: "rest" } });
  assert.ok(isTypeRefusal(refused), `expected 400, got ${refused.status} ${JSON.stringify(refused.body)}`);
  assert.equal(p.db.prepare("SELECT COUNT(*) n FROM bots").get().n, 0);

  const ok = await post({ handle: "probe.bot", integration_type: "rest" });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.handle, "@probe.bot");
  assert.equal(p.db.prepare("SELECT integration_type FROM bots WHERE handle = ?").get("probe.bot").integration_type, "rest");
});

// The shapes that already meant "no type named": the default still applies and the call still mints a Bot.
for (const [label, extra] of [["absent", {}], ["null", { integration_type: null }], ["an empty string", { integration_type: "" }]] as [string, Record<string, unknown>][]) {
  test(`an integration type that is ${label} keeps the "rest" default`, async (t) => {
    const { p, post } = await ownerOnServer(t);

    const r = await post({ handle: "probe.bot", ...extra });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(p.db.prepare("SELECT integration_type FROM bots WHERE handle = ?").get("probe.bot").integration_type, "rest");
  });
}

// Every string keeps the value it had, including one that is not in any list, surrounding spaces and an unknown name.
for (const value of ["rest", "grok-bot", " Custom-Bot ", "flybot-member"]) {
  test(`the integration type ${JSON.stringify(value)} is stored exactly as sent`, async (t) => {
    const { p, post } = await ownerOnServer(t);

    const r = await post({ handle: "probe.bot", integration_type: value });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(p.db.prepare("SELECT integration_type FROM bots WHERE handle = ?").get("probe.bot").integration_type, value);
  });
}
