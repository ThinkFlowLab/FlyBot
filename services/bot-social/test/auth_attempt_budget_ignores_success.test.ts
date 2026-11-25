/**
 * A correct password is not a burst. The account bucket counts every attempt at a password door and used to be left
 * alone when a door accepted the name and the secret: five correct sign-ins inside the window spent the budget that
 * exists to slow a guesser, so the sixth correct password answered 429 rate_limited and the owner had to wait the
 * window out with the one credential that was right. A successful sign-up spends the same bucket, so a brand-new
 * owner entered that window with one attempt already gone.
 *
 * The two tests below are the defect; the two after them are the controls that must read the same before and after:
 * wrong passwords still fill the budget at exactly five, and a refusal happens before the password check, so a
 * correct password can never clear a bucket it never reached.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { startServer } from "./helpers.js";

const post = async (base: string, path: string, body: unknown) => {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() as any };
};
const login = (base: string, username: string, password: string) => post(base, "/v1/auth/login", { username, password });

test("a correct sign-in is never what fills the account budget", async () => {
  const S = await startServer();
  try {
    assert.equal((await post(S.base, "/v1/owners", { username: "steady", password: "secret-pw" })).status, 201);
    const statuses: number[] = [];
    for (let i = 1; i <= 6; i++) statuses.push((await login(S.base, "steady", "secret-pw")).status);
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200], `six correct sign-ins answered ${statuses.join(",")}`);
  } finally { await S.stop(); }
});

test("a successful sign-up does not spend the new owner's budget", async () => {
  const S = await startServer();
  try {
    assert.equal((await post(S.base, "/v1/owners", { username: "fresh", password: "secret-pw" })).status, 201);
    const wrong: number[] = [];
    for (let i = 1; i <= 5; i++) wrong.push((await login(S.base, "fresh", "wrong-pw")).status);
    assert.deepEqual(wrong, [401, 401, 401, 401, 401], `five wrong passwords answered ${wrong.join(",")}`);
    assert.equal((await login(S.base, "fresh", "wrong-pw")).status, 429, "the sixth failure is where the budget ends");
  } finally { await S.stop(); }
});

test("the password budget still stops a burst of wrong passwords", async () => {
  const S = await startServer();
  try {
    // Created through the platform, not the HTTP door, so the bucket starts empty on both sides of this change.
    S.platform.registerOwner({ username: "guessed", password: "secret-pw" });
    for (let i = 1; i <= 5; i++) assert.equal((await login(S.base, "guessed", "wrong-pw")).status, 401, `wrong attempt ${i} reaches the password check`);
    const blocked = await login(S.base, "guessed", "wrong-pw");
    assert.equal(blocked.status, 429, "the sixth wrong password is refused");
    assert.equal(blocked.body.error.code, "rate_limited");
    assert.equal(blocked.body.error.scope, "account");
    assert.match(blocked.body.error.message, /account/);
  } finally { await S.stop(); }
});

test("a correct password does not reopen a budget that is already spent", async () => {
  const S = await startServer();
  try {
    S.platform.registerOwner({ username: "spent", password: "secret-pw" });
    for (let i = 1; i <= 5; i++) assert.equal((await login(S.base, "spent", "wrong-pw")).status, 401);
    assert.equal((await login(S.base, "spent", "secret-pw")).status, 429, "the gate refuses before the password check, so nothing is forgiven");
    assert.equal((await login(S.base, "spent", "secret-pw")).status, 429, "the refusal cleared nothing");
  } finally { await S.stop(); }
});
