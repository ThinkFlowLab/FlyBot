import assert from "node:assert/strict";
import { test } from "node:test";
import { startServer, ownerWithBot } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;

function counts(s: Server) {
  const out: Record<string, number> = { audit: s.platform.audit.list().length };
  for (const t of ["owners", "bots", "bot_keys", "tokens"]) out[t] = (s.platform.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n;
  return out;
}

async function post(base: string, path: string, body: unknown, token?: string) {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() as any };
}

/** The value that used to be coerced and written, and the field's own refusal after the gate. */
const SHAPES: [string, unknown, string][] = [
  ["an object", {}, "[object Object]"],
  ["an object with a key", { a: 1 }, "[object Object]"],
  ["a number", 42, "42"],
  ["a boolean", true, "true"],
  ["a one-element array", ["x"], "x"],
];

test("a connector-token label that is not a string is refused before the count and the INSERT", async (t) => {
  const s = await startServer({ authRateLimit: { perIp: 1000, perAccount: 1000 } });
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "alphactk");
  for (const [name, value, coerced] of SHAPES) {
    const before = counts(s);
    const r = await post(s.base, "/v1/connector-tokens", { label: value }, A.owner.token);
    assert.equal(r.status, 400, `${name} status`);
    assert.equal(r.body.error?.code, "invalid_request", `${name} code`);
    assert.equal(r.body.error?.message, "label must be a string", `${name} message`);
    assert.deepEqual(counts(s), before, `${name} wrote something`);
    // the label the old coercion would have stored is nowhere in the table
    const stuck = s.platform.db.prepare("SELECT COUNT(*) AS n FROM tokens WHERE label = ?").get(coerced) as any;
    assert.equal(stuck.n, 0, `${name} stored ${JSON.stringify(coerced)}`);
  }
});

test("an onboard label that is not a string is refused and leaves no owner, bot, key or token", async (t) => {
  const s = await startServer({ authRateLimit: { perIp: 1000, perAccount: 1000 } });
  t.after(s.stop);
  for (const [name, value] of SHAPES) {
    const before = counts(s);
    const r = await post(s.base, "/v1/onboard", { display_name: "labhome", label: value });
    assert.equal(r.status, 400, `${name} status`);
    assert.equal(r.body.error?.code, "invalid_request", `${name} code`);
    assert.equal(r.body.error?.message, "label must be a string", `${name} message`);
    const after = counts(s);
    assert.equal(after.owners, before.owners, `${name} owners`);
    assert.equal(after.bots, before.bots, `${name} bots`);
    assert.equal(after.bot_keys, before.bot_keys, `${name} bot_keys`);
    assert.equal(after.tokens, before.tokens, `${name} tokens`);
    assert.equal(after.audit, before.audit, `${name} audit`);
  }
});

test("an absent, null or empty label still takes the default, and a string label is unchanged", async (t) => {
  const s = await startServer({ authRateLimit: { perIp: 1000, perAccount: 1000 } });
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "alphadef");
  for (const [name, body] of [["absent", {}], ["null", { label: null }], ["empty", { label: "" }], ["blank", { label: "   " }]] as const) {
    const r = await post(s.base, "/v1/connector-tokens", body, A.owner.token);
    assert.equal(r.status, 201, `${name} status`);
    assert.equal(r.body.label, "Grok Bot", `${name} label`);
    const row = s.platform.db.prepare("SELECT label FROM tokens WHERE id = ?").get(r.body.token_id) as any;
    assert.equal(row.label, "Grok Bot", `${name} stored label`);
  }
  const r = await post(s.base, "/v1/connector-tokens", { label: "  My Grok  " }, A.owner.token);
  assert.equal(r.status, 201);
  assert.equal(r.body.label, "My Grok", "a string is trimmed as before");
  const row = s.platform.db.prepare("SELECT label FROM tokens WHERE id = ?").get(r.body.token_id) as any;
  assert.equal(row.label, "My Grok");
});
