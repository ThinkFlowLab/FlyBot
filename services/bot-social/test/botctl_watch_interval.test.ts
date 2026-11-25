// `botctl watch --interval` sets the pause between polls. A non-numeric value used to become NaN,
// which `Math.max(10, NaN)` keeps as NaN, and `setTimeout(fn, NaN)` fires immediately: a user who
// asked to watch for a while instead hammered their own server a few hundred times a second.
// These cases run the real command for a short window and count the requests it makes.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Platform } from "../src/platform.js";
import { buildServer } from "../src/server.js";

const WINDOW_MS = 700;
const MAX_REQUESTS = 30;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let base = "";
let requests = 0;
let env: NodeJS.ProcessEnv;
let close: () => Promise<void>;

before(async () => {
  const platform = new Platform({});
  const app = buildServer(platform);
  app.addHook("onRequest", async () => { requests++; });
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  close = async () => { await app.close(); };
  const dir = mkdtempSync(join(tmpdir(), "botctl-watch-"));
  const home = join(dir, ".bot-social");
  mkdirSync(home, { recursive: true });
  env = { ...process.env, BOTSOCIAL_HOME: home, BOTSOCIAL_URL: "" };
  const reg = spawn(process.execPath, ["--import", "tsx", "scripts/botctl.ts", "register", "watchbot", "--url", base, "--json"], { env });
  await new Promise<void>((resolve, reject) => {
    reg.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`register exited ${code}`))));
    reg.once("error", reject);
  });
});

after(async () => { await close(); });

/** Run `watch --interval <value>` for one window after its first poll and count the requests made. */
async function requestsInWindow(interval: string): Promise<number> {
  const beforeFirst = requests;
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/botctl.ts", "watch", "watchbot", "--interval", interval], { env });
  const deadline = Date.now() + 30_000;
  while (requests === beforeFirst && Date.now() < deadline) await sleep(10);
  assert.ok(requests > beforeFirst, `watch --interval ${interval} never polled the server`);
  const started = requests;
  await sleep(WINDOW_MS);
  child.kill("SIGKILL");
  await new Promise((r) => child.once("exit", r));
  await sleep(50);
  return requests - started;
}

test("a non-numeric --interval does not turn watch into a tight polling loop", async () => {
  const n = await requestsInWindow("abc");
  assert.ok(n < MAX_REQUESTS, `watch made ${n} requests in ${WINDOW_MS}ms with --interval abc`);
});

test("a unit-suffixed --interval is not a tight polling loop either", async () => {
  const n = await requestsInWindow("1m");
  assert.ok(n < MAX_REQUESTS, `watch made ${n} requests in ${WINDOW_MS}ms with --interval 1m`);
});

test("a plain numeric --interval keeps its calm pace", async () => {
  const n = await requestsInWindow("60");
  assert.ok(n < MAX_REQUESTS, `watch made ${n} requests in ${WINDOW_MS}ms with --interval 60`);
});
