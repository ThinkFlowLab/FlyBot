import assert from "node:assert/strict";
import { test } from "node:test";
import { generateEd25519 } from "../src/crypto.js";
import { ownerWithBot, startServer } from "./helpers.js";

async function postRaw(base: string, path: string, token: string, body: unknown) {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() as any };
}

test("a block request carrying a non-string id is refused and writes nothing", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "alpha");
  const B = await ownerWithBot(s.base, "beta");
  const snapshot = () => ({
    relationships: s.platform.db.prepare("SELECT id, status FROM relationships ORDER BY id").all(),
    keys: s.platform.db.prepare("SELECT bot_id, kid FROM bot_keys ORDER BY bot_id, kid").all(),
  });
  const before = snapshot();
  // Every value here used to reach a SQL binding as it arrived: an object became named parameters and a
  // boolean had no binding at all, so the route answered 500 instead of asking for a string.
  const shapes: [string, Record<string, unknown>][] = [
    ["bot_id", { bot_id: {} }],
    ["bot_id", { bot_id: true }],
    ["my_bot_id", { my_bot_id: {} }],
    ["my_bot_id", { bot_id: B.bot.id, my_bot_id: {} }],
    ["relationship_id", { relationship_id: {} }],
    ["relationship_id", { relationship_id: true }],
    ["relationship_id", { relationship_id: [] }],
  ];
  for (const [field, body] of shapes) {
    const r = await postRaw(s.base, "/v1/blocks", A.owner.token, body);
    assert.equal(r.status, 400, `${field} ${JSON.stringify(body)} answered ${r.status}, not 400`);
    assert.equal(r.body.error.code, "invalid_request");
    assert.equal(r.body.error.message, `${field} must be a string`);
    assert.deepEqual(snapshot(), before, `${field} ${JSON.stringify(body)} wrote a row before refusing`);
  }
});

test("a key request carrying a non-string kid is refused and stores no row", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "alpha");
  const value = generateEd25519().publicKey;
  const rows = () => s.platform.db.prepare("SELECT bot_id, kid FROM bot_keys ORDER BY bot_id, kid").all() as any[];
  const before = rows();
  // An object threw a RangeError and a boolean a TypeError inside better-sqlite3 (both answered 500); a number
  // bound as REAL, so [1] and 7 were stored in the TEXT column as "1.0"/"7.0" and answered 201.
  for (const kid of [{}, true, [1], 7]) {
    const r = await postRaw(s.base, `/v1/bots/${A.bot.id}/keys`, A.owner.token, { kid, value });
    assert.equal(r.status, 400, `kid ${JSON.stringify(kid)} answered ${r.status}, not 400`);
    assert.equal(r.body.error.code, "invalid_request");
    assert.equal(r.body.error.message, "kid must be a string");
    assert.deepEqual(rows(), before, `kid ${JSON.stringify(kid)} left a key row behind`);
  }
  assert.equal(rows().some((r) => typeof r.kid !== "string" || /^\d+\.?0*$/.test(r.kid)), false, "a numeric binding was stored as a kid");
});

test("blocking, unblocking and adding keys keep their behaviour", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "alpha");
  const B = await ownerWithBot(s.base, "beta");
  const blocked = await postRaw(s.base, "/v1/blocks", A.owner.token, { bot_id: B.bot.id });
  assert.equal(blocked.status, 200);
  assert.equal(blocked.body.status, "blocked");
  // Blocking again is not an error: the same pair answers the same way.
  const again = await postRaw(s.base, "/v1/blocks", A.owner.token, { bot_id: B.bot.id });
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, blocked.body);
  const byRelationship = await postRaw(s.base, "/v1/blocks", A.owner.token, { relationship_id: blocked.body.relationship_id });
  assert.equal(byRelationship.status, 200);
  assert.equal(byRelationship.body.status, "blocked");
  const undone = await postRaw(s.base, `/v1/blocks/${blocked.body.relationship_id}/undo`, A.owner.token, {});
  assert.equal(undone.status, 200);
  assert.equal(undone.body.status, "revoked");
  // A null optional id means the field was not given: the same defaults and refusals as before still apply.
  const nullBot = await postRaw(s.base, "/v1/blocks", A.owner.token, { bot_id: null });
  assert.equal(nullBot.status, 400);
  assert.equal(nullBot.body.error.message, "bot_id or relationship_id required");
  const nullRelationship = await postRaw(s.base, "/v1/blocks", A.owner.token, { relationship_id: null });
  assert.equal(nullRelationship.status, 400);
  assert.equal(nullRelationship.body.error.message, "bot_id or relationship_id required");
  const nullMyBot = await postRaw(s.base, "/v1/blocks", A.owner.token, { bot_id: B.bot.id, my_bot_id: null });
  assert.equal(nullMyBot.status, 200);
  assert.equal(nullMyBot.body.status, "blocked");
  // Unknown ids keep their own refusals.
  assert.equal((await postRaw(s.base, "/v1/blocks", A.owner.token, { bot_id: "bot_missing" })).body.error.code, "bot_not_found");
  assert.equal((await postRaw(s.base, "/v1/blocks", A.owner.token, { relationship_id: "rel_missing" })).body.error.code, "relationship_not_found");
  // A Bot token stays outside both owner routes.
  const botOnBlocks = await postRaw(s.base, "/v1/blocks", A.bot.cred.token, { bot_id: B.bot.id });
  assert.equal(botOnBlocks.status, 403);
  assert.equal(botOnBlocks.body.error.code, "owner_only");
  // Keys: a normal add keeps the kid verbatim; the existing refusals keep their codes and messages.
  const value = generateEd25519().publicKey;
  const added = await postRaw(s.base, `/v1/bots/${A.bot.id}/keys`, A.owner.token, { kid: "k2", value });
  assert.equal(added.status, 201);
  assert.equal(added.body.kid, "k2");
  const stored = s.platform.db.prepare("SELECT kid FROM bot_keys WHERE bot_id = ? AND kid = 'k2'").get(A.bot.id);
  assert.ok(stored);
  const duplicate = await postRaw(s.base, `/v1/bots/${A.bot.id}/keys`, A.owner.token, { kid: "k2", value });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error.code, "kid_exists");
  const badKey = await postRaw(s.base, `/v1/bots/${A.bot.id}/keys`, A.owner.token, { kid: "k3", value: "not-a-key" });
  assert.equal(badKey.status, 400);
  assert.equal(badKey.body.error.code, "invalid_public_key");
  const missingKid = await postRaw(s.base, `/v1/bots/${A.bot.id}/keys`, A.owner.token, { value });
  assert.equal(missingKid.status, 400);
  assert.equal(missingKid.body.error.message, "kid and value required");
  const foreign = await postRaw(s.base, `/v1/bots/${B.bot.id}/keys`, A.owner.token, { kid: "k9", value });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.body.error.message, "not your bot");
  const botOnKeys = await postRaw(s.base, `/v1/bots/${A.bot.id}/keys`, A.bot.cred.token, { kid: "k9", value });
  assert.equal(botOnKeys.status, 403);
  assert.equal(botOnKeys.body.error.code, "owner_only");
});
