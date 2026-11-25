import assert from "node:assert/strict";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { describe, test } from "node:test";
import { Platform } from "../src/platform.js";
import { buildServer } from "../src/server.js";
import { ownerWithBot } from "./helpers.js";

/** Platform + HTTP server with a fake fetch that records every webhook call it is asked to make. */
async function setup(webhooks: Record<string, unknown> = {}) {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  const fetchImpl = (async (url: string, init: any) => {
    calls.push({ url, headers: init.headers, body: init.body });
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  const platform = new Platform({ fetchImpl, webhooks: { debounceMs: 20, retryBaseMs: 5, ...webhooks } });
  const app = buildServer(platform);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  return { platform, base, calls, stop: async () => { await app.close(); platform.close(); } };
}

/**
 * With allowPrivate off, a private target has to be refused before any request leaves the process.
 * An IPv6 literal is not only the `::1` / `fe80::` / `fc00::` spellings: an IPv4 address can be
 * carried in the low 32 bits (IPv4-mapped `::ffff:0:0/96`, NAT64 `64:ff9b::/96` and
 * `64:ff9b:1::/48`, and the deprecated IPv4-compatible `::/96`). `new URL()` rewrites
 * `http://[::ffff:127.0.0.1]/` to `::ffff:7f00:1`, so the class must come from the parsed bytes.
 * Every refused case also pins the fetch count: a failure caused by the network is still `failed`,
 * so only the fetch count proves the guard fired.
 */
describe("a private webhook target cannot hide behind an IPv6 spelling", () => {
  const refused = [
    "http://[::ffff:127.0.0.1]:9/x", // loopback, dotted spelling inside brackets
    "http://[::ffff:7f00:1]:9/x", // the form new URL() normalizes the line above to
    "http://[0:0:0:0:0:ffff:7f00:1]:9/x", // same 128 bits, fully expanded
    "http://[0:0:0:0:0:ffff:127.0.0.1]:9/x", // fully expanded, dotted tail
    "http://[::ffff:0:0]:9/x", // mapped 0.0.0.0, which connects to the local host
    "http://[::ffff:10.0.0.1]:9/x", // RFC 1918
    "http://[::ffff:c0a8:101]:9/x", // 192.168.1.1 in hex
    "http://[::ffff:a9fe:a9fe]:9/x", // 169.254.169.254, the cloud metadata address
    "http://[::7f00:1]:9/x", // IPv4-compatible ::/96, refused whole
    "http://[::808:808]:9/x", // IPv4-compatible of 8.8.8.8: the form is deprecated, still refused
    "http://[64:ff9b::7f00:1]:9/x", // NAT64 64:ff9b::/96 of 127.0.0.1
    "http://[64:ff9b:1::7f00:1]:9/x", // RFC 8215 64:ff9b:1::/48 of 127.0.0.1
    "http://[::1]:9/x", // plain IPv6 loopback
    "http://[::]:9/x", // unspecified
    "http://[fe80::1]:9/x", // link-local
    "http://[fd00::1]:9/x", // unique local
    "http://[fc00::1]:9/x", // unique local
    "http://127.0.0.1:9/x", // plain IPv4 loopback, already refused
  ];

  test("every loopback / private spelling fails as private without a single fetch", async () => {
    const S = await setup({ allowPrivate: false });
    try {
      const A = await ownerWithBot(S.base, "pv6");
      const leaked: string[] = [];
      for (const url of refused) {
        const before = S.calls.length;
        await A.owner.req("PUT", `/v1/bots/${A.bot.id}/webhook`, { url });
        const d = await A.owner.req("POST", `/v1/bots/${A.bot.id}/webhook/test`);
        if (d.status !== "failed" || !/private/.test(d.error ?? "")) leaked.push(`${url}: ${d.status} ${d.error}`);
        if (S.calls.length !== before) leaked.push(`${url}: fetch was called`);
      }
      assert.deepEqual(leaked, [], "these private webhook targets were not refused before fetch");
    } finally { await S.stop(); }
  });

  test("a real loopback listener is never reached through a mapped spelling", async () => {
    const hits: string[] = [];
    const recv = createServer((req, res) => { hits.push(req.url ?? ""); res.writeHead(200).end(); });
    await new Promise<void>((r) => recv.listen(0, "127.0.0.1", r));
    const port = (recv.address() as AddressInfo).port;
    const platform = new Platform({ webhooks: { allowPrivate: false, maxAttempts: 1, debounceMs: 20 } });
    const app = buildServer(platform);
    await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
      const A = await ownerWithBot(base, "pv6real");
      for (const host of ["[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "[::ffff:0:0]"]) {
        await A.owner.req("PUT", `/v1/bots/${A.bot.id}/webhook`, { url: `http://${host}:${port}/mapped` });
        const d = await A.owner.req("POST", `/v1/bots/${A.bot.id}/webhook/test`);
        assert.equal(d.status, "failed", `${host} must not be delivered`);
        assert.match(d.error, /private/, `${host} must say why it was refused`);
      }
      assert.deepEqual(hits, [], "the loopback listener must see zero requests");
    } finally { await app.close(); platform.close(); recv.close(); }
  });

  test("public IPv6 targets are still delivered", async () => {
    const S = await setup({ allowPrivate: false });
    try {
      const A = await ownerWithBot(S.base, "pv6ok");
      const publicTargets = [
        "http://[2606:4700::1111]:9/x", // a real public address
        "http://[2a03:4000::1]:9/x", // public 2a03:: block
        "http://[::ffff:808:808]:9/x", // IPv4-mapped ::ffff:8.8.8.8
        "http://[64:ff9b::808:808]:9/x", // NAT64 of 8.8.8.8
      ];
      for (const url of publicTargets) {
        const before = S.calls.length;
        await A.owner.req("PUT", `/v1/bots/${A.bot.id}/webhook`, { url });
        const d = await A.owner.req("POST", `/v1/bots/${A.bot.id}/webhook/test`);
        assert.equal(d.status, "delivered", `${url} must not be refused`);
        assert.equal(S.calls.length, before + 1, `${url} must reach fetch exactly once`);
        assert.equal(S.calls.at(-1)?.url, url);
      }
    } finally { await S.stop(); }
  });
});
