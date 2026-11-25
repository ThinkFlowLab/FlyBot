// #242: botctl must print times in the owner's own zone (and name it), carry that zone in a
// meeting intent, and fall back to a named UTC when the profile cannot be read. --json stays raw.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { BotClient, OwnerClient } from "../src/client.js";
import { startServer, ownerWithBot } from "./helpers.js";

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(); });
after(async () => { await S.stop(); });

const exec = promisify(execFile);

/** A fresh $BOTSOCIAL_HOME, one registered bot named `alice` whose owner zone is Europe/Berlin. */
async function cliWithBerlinOwner(name = "alice") {
  const home = join(mkdtempSync(join(tmpdir(), "botctl-tz-")), ".bot-social");
  mkdirSync(home, { recursive: true });
  const run = (...a: string[]) => exec(process.execPath, ["--import", "tsx", "scripts/botctl.ts", ...a], { env: { ...process.env, BOTSOCIAL_HOME: home, BOTSOCIAL_URL: "" }, encoding: "utf8" });
  const reg = JSON.parse((await run("register", name, "--url", S.base, "--json")).stdout);
  const cfg = JSON.parse(readFileSync(join(home, `${name}.json`), "utf8"));
  await new OwnerClient(S.base, cfg.owner_token).req("PATCH", "/v1/me", { timezone: "Europe/Berlin" });
  const botClient = new BotClient({ base: cfg.base, botId: cfg.bot_id, token: cfg.bot_token, kid: cfg.kid, privateKeyPem: cfg.private_key_pem });
  return { home, run, reg, cfg, botClient, save: (c: any) => writeFileSync(join(home, `${name}.json`), JSON.stringify(c, null, 2), { mode: 0o600 }) };
}

const fmt = (iso: string, timeZone: string) => new Date(iso).toLocaleString("zh-CN", { hour12: false, timeZone, timeZoneName: "short" });

test("an invite expiry is printed in the owner's zone, named, not a fixed Asia/Shanghai", async () => {
  const { run } = await cliWithBerlinOwner("anna");
  const out = (await run("invite", "--as-owner")).stdout;
  const shown = out.match(/valid until (.+)$/m)?.[1];
  assert.ok(shown, "the invite line names the expiry: " + out);
  const row = S.platform.db.prepare("SELECT expires_at FROM invites ORDER BY created_at DESC LIMIT 1").get() as any;
  assert.equal(shown, fmt(row.expires_at, "Europe/Berlin"), "the expiry is Berlin wall time, zone named");
  assert.notEqual(shown, fmt(row.expires_at, "Asia/Shanghai"), "the old fixed zone is gone");
  assert.match(shown, /GMT\+1/, "the printed time names the zone it uses");
});

test("start --intent schedule_meeting carries the owner's zone, not Asia/Shanghai", async () => {
  const { run, cfg } = await cliWithBerlinOwner("bert");
  const peer = await ownerWithBot(S.base, "bob");
  const aliceOwner = new OwnerClient(S.base, cfg.owner_token);
  const rel = await aliceOwner.req("POST", "/v1/relationships", { from_bot_id: cfg.bot_id, target_handle: peer.handle, message: "hi", requested_capabilities: ["chat.public"] });
  await peer.owner.req("POST", `/v1/relationships/${rel.relationship_id}/consent`, { decision: "accept", grant_capabilities: [] });
  await run("start", peer.handle, "--intent", "schedule_meeting", "--duration", "30", "--json");
  const row = S.platform.db.prepare("SELECT intent FROM conversations ORDER BY created_at DESC LIMIT 1").get() as any;
  assert.equal(JSON.parse(row.intent).params.timezone, "Europe/Berlin", "the meeting intent carries the owner's own zone");
});

test("when the profile cannot be read, printed times name UTC instead of a silent fixed zone", async () => {
  const { run, reg, cfg, save } = await cliWithBerlinOwner("cara");
  // An event for cara's bot: carol's owner sends it a friend request (owner-sent, so it is delivered).
  const peer = await ownerWithBot(S.base, "carol");
  await peer.owner.req("POST", "/v1/relationships", { from_bot_id: peer.bot.id, target_handle: String(reg.handle), message: "hi", requested_capabilities: ["chat.public"] });
  // Only the owner token breaks; the bot can still read its inbox.
  save({ ...cfg, owner_token: "not-a-real-owner-token" });
  const out = (await run("inbox", "--all")).stdout;
  assert.match(out, /\bUTC\b/, "an unreadable profile falls back to a zone the reader can see: " + out);
  assert.doesNotMatch(out, /GMT\+8/, "it does not pretend to be Asia/Shanghai");
});

test("--json keeps the raw ISO instants", async () => {
  const { run } = await cliWithBerlinOwner("dora");
  const out = (await run("invite", "--as-owner", "--json")).stdout;
  const j = JSON.parse(out);
  assert.match(String(j.expires_at), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/, "a raw ISO instant, not a formatted line");
  assert.doesNotMatch(out, /GMT[+-]\d/, "no formatted zone name leaks into --json");
});
