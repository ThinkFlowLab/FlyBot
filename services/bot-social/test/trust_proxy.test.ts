import assert from "node:assert/strict";
import { test } from "node:test";
import { Platform } from "../src/platform.js";
import { buildServer } from "../src/server.js";
import { loadTrustProxy, trustProxyStartupLine, TrustProxySetting } from "../src/trust-proxy.js";

// #75 ①: the client address the limits and audit rows read (req.ip) is the socket peer unless the peer is a
// proxy this deployment named. TRUST_PROXY defaults to loopback, so a direct client on the internet cannot
// pick its own address with a made-up X-Forwarded-For.

type Call = { method?: string; url: string; token?: string; body?: unknown; headers?: Record<string, string>; remoteAddress?: string };

async function call(app: any, c: Call) {
  const res = await app.inject({
    method: (c.method ?? "GET") as any,
    url: c.url,
    remoteAddress: c.remoteAddress,
    payload: c.body as any,
    headers: {
      ...(c.token ? { authorization: `Bearer ${c.token}` } : {}),
      ...(c.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(c.headers ?? {}),
    },
  });
  const text = res.body;
  return { status: res.statusCode, body: text ? JSON.parse(text) : {} };
}

async function appWith(trustProxy?: TrustProxySetting) {
  const platform = new Platform();
  const app = buildServer(platform, trustProxy === undefined ? {} : { trustProxy });
  return { app, platform, stop: async () => { await app.close(); platform.close(); } };
}

async function ownerWithBot(app: any, name: string) {
  const o = await call(app, { method: "POST", url: "/v1/owners", body: { username: name, password: "secret-pw", display_name: name } });
  assert.equal(o.status, 201, JSON.stringify(o.body));
  const b = await call(app, { method: "POST", url: "/v1/bots", token: o.body.owner_token, body: { handle: `${name}.bot` } });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  return { token: o.body.owner_token as string, bot: b.body.bot_id as string };
}

/** The address the server believed for this join, as stored on the room's created row. */
async function addressOfCreate(app: any, owner: { token: string; bot: string }, code: string, c: { remoteAddress?: string; xff?: string }) {
  const joined = await call(app, {
    method: "POST",
    url: "/v1/face-rooms/join",
    token: owner.token,
    body: { code, bots: [owner.bot] },
    remoteAddress: c.remoteAddress,
    headers: c.xff ? { "x-forwarded-for": c.xff } : {},
  });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  const audit = await call(app, { url: "/v1/audit-events?limit=200", token: owner.token });
  assert.equal(audit.status, 200, JSON.stringify(audit.body));
  const created = (audit.body.events as any[]).find((e) => e.action === "face_room.created");
  assert.ok(created, "the room created row is recorded");
  return created.data.ip as string | null;
}

test("TRUST_PROXY defaults to loopback", () => {
  assert.equal(loadTrustProxy(undefined).setting, "loopback");
  assert.equal(loadTrustProxy("").setting, "loopback");
  assert.equal(loadTrustProxy("   ").setting, "loopback");
  assert.equal(loadTrustProxy(undefined).kind, "default");
});

test("TRUST_PROXY=false believes no forwarded header", () => {
  const c = loadTrustProxy("false");
  assert.equal(c.setting, false);
  assert.equal(c.kind, "false");
});

test("TRUST_PROXY=loopback is accepted explicitly", () => {
  const c = loadTrustProxy("loopback");
  assert.equal(c.setting, "loopback");
  assert.equal(c.kind, "loopback");
});

test("TRUST_PROXY takes a comma or space separated list of addresses and cidrs", () => {
  assert.deepEqual(loadTrustProxy("10.0.0.0/8,172.16.0.0/12").setting, ["10.0.0.0/8", "172.16.0.0/12"]);
  assert.deepEqual(loadTrustProxy(" 10.0.0.0/8  172.16.0.0/12 ").setting, ["10.0.0.0/8", "172.16.0.0/12"]);
  assert.deepEqual(loadTrustProxy("203.0.113.9").setting, ["203.0.113.9"]);
  assert.deepEqual(loadTrustProxy("::1,fd00::/8").setting, ["::1", "fd00::/8"]);
});

test("TRUST_PROXY refuses a value it cannot honour", () => {
  for (const bad of ["true", "yes", "10.0.0.0/33", "10.0.0.999", "proxy.example.com", "false,10.0.0.0/8"]) {
    assert.throws(() => loadTrustProxy(bad), /TRUST_PROXY/, `"${bad}" must be refused`);
  }
});

test("the startup line names the trusted peers and the shared-bucket risk", () => {
  const byDefault = trustProxyStartupLine(loadTrustProxy(undefined));
  assert.match(byDefault, /TRUST_PROXY/);
  assert.match(byDefault, /loopback/);
  assert.match(byDefault, /429/);

  const off = trustProxyStartupLine(loadTrustProxy("false"));
  assert.match(off, /TRUST_PROXY=false/);
  assert.match(off, /429/);

  const named = trustProxyStartupLine(loadTrustProxy("10.0.0.0/8,172.16.0.0/12"));
  assert.match(named, /10\.0\.0\.0\/8/);
  assert.match(named, /172\.16\.0\.0\/12/);
});

test("a loopback proxy's X-Forwarded-For is believed by default", async (t) => {
  const s = await appWith();
  t.after(s.stop);
  const A = await ownerWithBot(s.app, "nora");
  assert.equal(await addressOfCreate(s.app, A, "616161", { remoteAddress: "127.0.0.1", xff: "198.51.100.7" }), "198.51.100.7");
});

test("a direct peer's X-Forwarded-For is not believed by default", async (t) => {
  const s = await appWith();
  t.after(s.stop);
  const A = await ownerWithBot(s.app, "oskar");
  assert.equal(await addressOfCreate(s.app, A, "626262", { remoteAddress: "203.0.113.9", xff: "198.51.100.7" }), "203.0.113.9");
});

test("TRUST_PROXY=false ignores X-Forwarded-For even from loopback", async (t) => {
  const s = await appWith(false);
  t.after(s.stop);
  const A = await ownerWithBot(s.app, "pablo");
  assert.equal(await addressOfCreate(s.app, A, "636363", { remoteAddress: "127.0.0.1", xff: "198.51.100.7" }), "127.0.0.1");
});

test("a configured proxy cidr is believed, and only it", async (t) => {
  const s = await appWith(["10.0.0.0/8"]);
  t.after(s.stop);
  const A = await ownerWithBot(s.app, "rosa");
  assert.equal(await addressOfCreate(s.app, A, "646464", { remoteAddress: "10.1.2.3", xff: "198.51.100.7" }), "198.51.100.7");
  const B = await ownerWithBot(s.app, "sven");
  assert.equal(await addressOfCreate(s.app, B, "656565", { remoteAddress: "203.0.113.9", xff: "198.51.100.8" }), "203.0.113.9");
});
