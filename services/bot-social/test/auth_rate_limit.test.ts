import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { test } from "node:test";
import { startServer } from "./helpers.js";

/** POST a JSON body from a chosen local address, so "another client" is a real different peer and not a header
 *  the server has to decide whether to trust. */
function postAs(localAddress: string, url: string, body: unknown): Promise<{ status: number; body: any }> {
  const u = new URL(url);
  const payload = JSON.stringify(body ?? {});
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: u.hostname, port: u.port, path: u.pathname + u.search, method: "POST", localAddress,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        let parsed: any = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
}

const post = (url: string, body: unknown) => postAs("127.0.0.1", url, body);

test("the default account budget lets the fifth attempt through and refuses the sixth", async () => {
  const S = await startServer();
  try {
    const login = () => post(`${S.base}/v1/auth/login`, { username: "burst", password: "wrong-pw" });
    // A successful sign-up leaves the new account's bucket empty, so the five failures below are the whole budget.
    assert.equal((await post(`${S.base}/v1/owners`, { username: "burst", password: "secret-pw" })).status, 201);
    for (let i = 1; i <= 5; i++) assert.equal((await login()).status, 401, `failed attempt ${i} passes the limiter`);
    const blocked = await login();
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, "rate_limited");
    assert.ok(blocked.body.error.retry_after >= 1 && blocked.body.error.retry_after <= 600, `retry_after ${blocked.body.error.retry_after}`);
  } finally { await S.stop(); }
});

test("the default address budget allows ten attempts and refuses the eleventh", async () => {
  const S = await startServer();
  try {
    // Distinct unknown usernames, so only the address bucket can refuse.
    for (let i = 1; i <= 10; i++) {
      const r = await post(`${S.base}/v1/auth/login`, { username: `nobody${i}`, password: "wrong-pw" });
      assert.equal(r.status, 401, `attempt ${i} passes the limiter`);
    }
    const blocked = await post(`${S.base}/v1/auth/login`, { username: "nobody11", password: "wrong-pw" });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, "rate_limited");
    assert.ok(blocked.body.error.retry_after >= 1);
  } finally { await S.stop(); }
});

test("login, sign-up and both onboarding gates spend one address budget", async () => {
  const S = await startServer({ authRateLimit: { perIp: 2, perAccount: 100 } });
  try {
    assert.equal((await post(`${S.base}/v1/onboard`, { display_name: "One" })).status, 201);
    assert.equal((await post(`${S.base}/v1/onboard/flybot`, { display_name: "Two" })).status, 201);
    // The two onboarding gates and the sign-in door are the same bucket, in both directions.
    const login = await post(`${S.base}/v1/auth/login`, { username: "after-onboard", password: "wrong-pw" });
    assert.equal(login.status, 429);
    assert.equal(login.body.error.code, "rate_limited");
    const signup = await post(`${S.base}/v1/owners`, { username: "after-onboard", password: "secret-pw" });
    assert.equal(signup.status, 429);
  } finally { await S.stop(); }
});

test("a burst from one address leaves another address alone", async () => {
  const S = await startServer({ authRateLimit: { perIp: 3, perAccount: 100 } });
  try {
    const url = `${S.base}/v1/auth/login`;
    for (let i = 1; i <= 3; i++) assert.equal((await postAs("127.0.0.2", url, { username: `peer${i}`, password: "wrong-pw" })).status, 401);
    assert.equal((await postAs("127.0.0.2", url, { username: "peer4", password: "wrong-pw" })).status, 429);
    assert.equal((await postAs("127.0.0.3", url, { username: "other", password: "wrong-pw" })).status, 401);
  } finally { await S.stop(); }
});

test("a burst against one account leaves another account alone", async () => {
  const S = await startServer({ authRateLimit: { perIp: 100, perAccount: 2 } });
  try {
    const url = `${S.base}/v1/auth/login`;
    assert.equal((await post(url, { username: "same", password: "wrong-pw" })).status, 401);
    assert.equal((await post(url, { username: "same", password: "wrong-pw" })).status, 401);
    const blocked = await post(url, { username: "same", password: "wrong-pw" });
    assert.equal(blocked.status, 429);
    assert.match(blocked.body.error.message, /account/);
    assert.equal((await post(url, { username: "different", password: "wrong-pw" })).status, 401);
  } finally { await S.stop(); }
});

test("retry_after counts down as the window drains and the door opens again after it", async () => {
  let clock = 1_000_000_000;
  const S = await startServer({ now: () => clock, authRateLimit: { perIp: 100, perAccount: 2, windowMs: 600_000 } });
  try {
    const url = `${S.base}/v1/auth/login`;
    const attempt = () => post(url, { username: "decay", password: "wrong-pw" });
    for (let i = 1; i <= 2; i++) assert.equal((await attempt()).status, 401);
    const blocked = await attempt();
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.retry_after, 600);

    clock += 300_000;
    const halfway = await attempt();
    assert.equal(halfway.status, 429);
    assert.equal(halfway.body.error.retry_after, 300);

    clock += 300_001;
    assert.equal((await attempt()).status, 401, "the window drained, so the attempt reaches the password check");
  } finally { await S.stop(); }
});

test("an unknown username costs the same password work as a known one", async () => {
  const S = await startServer({ authRateLimit: { perIp: 1000, perAccount: 1000 } });
  try {
    assert.equal((await post(`${S.base}/v1/owners`, { username: "timing", password: "secret-pw" })).status, 201);
    const timeOne = async (username: string) => {
      const started = process.hrtime.bigint();
      const r = await post(`${S.base}/v1/auth/login`, { username, password: "wrong-pw" });
      const spent = Number(process.hrtime.bigint() - started) / 1e6;
      assert.equal(r.status, 401);
      return spent;
    };
    // Warm both paths once so a cold module or a first connection is not read as a timing signal.
    await timeOne("timing");
    await timeOne("ghost-warmup");
    const known: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i < 5; i++) {
      known.push(await timeOne("timing"));
      unknown.push(await timeOne(`ghost${i}`));
    }
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const knownMs = median(known);
    const unknownMs = median(unknown);
    assert.ok(unknownMs >= knownMs * 0.5, `unknown username ${unknownMs.toFixed(1)}ms vs known ${knownMs.toFixed(1)}ms: the miss skipped the password hash`);
  } finally { await S.stop(); }
});

test("the limiter keeps its tracked buckets under the ceiling", async () => {
  const { AuthRateLimiter } = await import("../src/auth-limit.js");
  let clock = 0;
  const limiter = new AuthRateLimiter({ perIp: 1, perAccount: 1, windowMs: 60_000, maxBuckets: 5 }, () => clock);
  for (let i = 0; i < 200; i++) {
    clock += 1;
    limiter.take({ ip: `203.0.113.${i}`, account: `user${i}` });
  }
  assert.ok(limiter.size <= 5, `tracked ${limiter.size} buckets`);
});
