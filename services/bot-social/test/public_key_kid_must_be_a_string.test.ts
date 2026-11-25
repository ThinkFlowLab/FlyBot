import assert from "node:assert/strict";
import { test } from "node:test";
import { bulkAuth, expectApiError, ownerWithBot, startServer } from "./helpers.js";
import { generateEd25519 } from "../src/crypto.js";

const kp = generateEd25519();
const n = (db: any, sql: string) => (db.prepare(sql).get() as any).n as number;
/** Everything a refused registration could leave behind: the Bot, its key, its registration audit row. */
const counts = (s: any) => ({
  bots: n(s.platform.db, "SELECT COUNT(*) n FROM bots"),
  keys: n(s.platform.db, "SELECT COUNT(*) n FROM bot_keys"),
  registered: n(s.platform.audit.db, "SELECT COUNT(*) n FROM audit_events WHERE action = 'bot.registered'"),
});

test("a non-string public_key.kid is refused as invalid_request and writes nothing", async () => {
  const s = await startServer(bulkAuth);
  const A = await ownerWithBot(s.base, "kidshape");
  try {
    const before = counts(s);
    // Every shape SQLite would otherwise coerce or crash on: the flattened array, the number stored as REAL,
    // the object, the boolean, the multi-element array, and the absent/null name.
    const shapes: any[] = [["k1"], 42, 0, -7, 1.5, {}, [], true, false, ["a", "b"], undefined, null];
    for (const [i, kid] of shapes.entries()) {
      const e: any = await expectApiError(
        A.owner.req("POST", "/v1/bots", { handle: `bad${i}.bot`, public_key: { alg: "Ed25519", kid, value: kp.publicKey } }),
        400, "invalid_request");
      assert.match(e.message, /public_key\.kid must be a string/, `shape ${JSON.stringify(kid)} names no string`);
    }
    assert.deepEqual(counts(s), before, "a refused registration leaves no Bot, no key and no audit row");
  } finally { await s.stop(); }
});

test("a string public_key.kid is stored, answered, listed and revocable as that same string", async () => {
  const s = await startServer(bulkAuth);
  const A = await ownerWithBot(s.base, "kidstring");
  try {
    const kid = "probe-key-1";
    const r: any = await A.owner.req("POST", "/v1/bots", { handle: "kidstring.bot", public_key: { alg: "Ed25519", kid, value: kp.publicKey } });
    assert.equal(r.key.kid, kid, "the register answer echoes the name the caller wrote");
    const row: any = s.platform.db.prepare("SELECT kid FROM bot_keys WHERE bot_id = ?").get(r.bot_id);
    assert.equal(row.kid, kid, "the stored name is the same string");
    const listed: any[] = (await A.owner.req("GET", "/v1/bots") as any).bots.find((b: any) => b.id === r.bot_id).keys;
    assert.deepEqual(listed.map((k: any) => k.kid), [kid], "the listing shows the same string");
    const rev: any = await A.owner.req("DELETE", `/v1/bots/${r.bot_id}/keys/${kid}`);
    assert.equal(rev.kid, kid, "the name that revokes is the same string");
    assert.equal((s.platform.db.prepare("SELECT status FROM bot_keys WHERE bot_id = ?").get(r.bot_id) as any).status, "revoked");
  } finally { await s.stop(); }
});

test("add_key refuses a non-string kid on the same invariant", async () => {
  const s = await startServer(bulkAuth);
  const A = await ownerWithBot(s.base, "kidadd");
  try {
    const r: any = await A.owner.req("POST", "/v1/bots", { handle: "kidadd.bot", public_key: { alg: "Ed25519", kid: "first-key", value: kp.publicKey } });
    const before = counts(s);
    const e: any = await expectApiError(A.owner.req("POST", `/v1/bots/${r.bot_id}/keys`, { kid: 42, value: kp.publicKey }), 400, "invalid_request");
    assert.match(e.message, /kid must be a string/);
    assert.deepEqual(counts(s), before, "the refused key adds no row");
  } finally { await s.stop(); }
});
