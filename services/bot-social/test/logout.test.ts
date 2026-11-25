import assert from "node:assert/strict";
import { test } from "node:test";
import { startServer } from "./helpers.js";

test("POST /v1/auth/logout revokes the login token it was called with", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const reg = await fetch(`${s.base}/v1/owners`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "logout-user", password: "secret-pw" }) }).then((r) => r.json());
  const token = reg.owner_token as string;
  const auth = { authorization: `Bearer ${token}` };
  assert.equal((await fetch(`${s.base}/v1/me`, { headers: auth })).status, 200);

  const out = await fetch(`${s.base}/v1/auth/logout`, { method: "POST", headers: auth });
  assert.equal(out.status, 200);
  assert.deepEqual(await out.json(), { ok: true });

  assert.equal((await fetch(`${s.base}/v1/me`, { headers: auth })).status, 401);
  assert.equal((await fetch(`${s.base}/v1/auth/logout`, { method: "POST", headers: auth })).status, 401);
});

test("logging out one session leaves another login session usable", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  await fetch(`${s.base}/v1/owners`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "two-sessions", password: "secret-pw" }) });
  const login = () => fetch(`${s.base}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "two-sessions", password: "secret-pw" }) }).then((r) => r.json());
  const first = (await login()).owner_token as string;
  const second = (await login()).owner_token as string;

  assert.equal((await fetch(`${s.base}/v1/auth/logout`, { method: "POST", headers: { authorization: `Bearer ${first}` } })).status, 200);
  assert.equal((await fetch(`${s.base}/v1/me`, { headers: { authorization: `Bearer ${first}` } })).status, 401);
  assert.equal((await fetch(`${s.base}/v1/me`, { headers: { authorization: `Bearer ${second}` } })).status, 200, "the other session must stay signed in");
});
