// The console's notice for a burst refused at the password doors (#75). The refusal body already carries how
// long the wait is and which budget ran out; the console has to say both, not "wait a moment". A plain wrong
// password keeps its own sentence.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startServer } from "./helpers.js";
import { loadConsole } from "./ui_helpers.js";

async function post(base: string, path: string, body: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}

test("a refused account burst says how long the wait is and that it is the account's", async () => {
  const S = await startServer();
  try {
    // A successful sign-up leaves the new account's bucket empty, so the five failures below are the whole budget.
    assert.equal((await post(S.base, "/v1/owners", { username: "burst", password: "secret-pw" })).status, 201);
    for (let i = 1; i <= 5; i++) assert.equal((await post(S.base, "/v1/auth/login", { username: "burst", password: "wrong-pw" })).status, 401, `failed attempt ${i} passes the limiter`);
    const blocked = await post(S.base, "/v1/auth/login", { username: "burst", password: "wrong-pw" });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, "rate_limited");
    assert.equal(blocked.body.error.scope, "account");
    // The window starts at the first attempt, so a slow runner may already be a second into it.
    assert.ok(blocked.body.error.retry_after >= 599 && blocked.body.error.retry_after <= 600, `retry_after ${blocked.body.error.retry_after}`);
    const { errText } = loadConsole(["errText"]);
    assert.equal(
      errText(blocked.body.error.code, blocked.body.error.message, blocked.status, blocked.body),
      "Too many requests for this account. Try again in about 10 minutes.",
    );
  } finally { await S.stop(); }
});

test("a refused address burst says the wait and that it is the network's", async () => {
  const S = await startServer();
  try {
    // Distinct unknown usernames, so only the address bucket can refuse.
    for (let i = 1; i <= 10; i++) assert.equal((await post(S.base, "/v1/auth/login", { username: `nobody${i}`, password: "wrong-pw" })).status, 401, `attempt ${i} passes the limiter`);
    const blocked = await post(S.base, "/v1/auth/login", { username: "nobody11", password: "wrong-pw" });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, "rate_limited");
    assert.equal(blocked.body.error.scope, "ip");
    assert.ok(blocked.body.error.retry_after >= 599 && blocked.body.error.retry_after <= 600, `retry_after ${blocked.body.error.retry_after}`);
    const { errText } = loadConsole(["errText"]);
    assert.equal(
      errText(blocked.body.error.code, blocked.body.error.message, blocked.status, blocked.body),
      "Too many requests from this network. Try again in about 10 minutes.",
    );
  } finally { await S.stop(); }
});

test("a wrong password still says wrong username or password", async () => {
  const S = await startServer();
  try {
    const r = await post(S.base, "/v1/auth/login", { username: "nobody", password: "wrong-pw" });
    assert.equal(r.status, 401);
    assert.equal(r.body.error.code, "invalid_credentials");
    const { errText } = loadConsole(["errText"]);
    assert.equal(errText(r.body.error.code, r.body.error.message, r.status, r.body), "Wrong username or password.");
  } finally { await S.stop(); }
});
