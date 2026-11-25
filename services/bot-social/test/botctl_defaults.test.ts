// botctl register must not bake one assistant's name into a handle: a handle cannot be renamed
// later (PATCH /v1/bots/:id/profile only takes display_name/avatar/color), so the default has to be
// neutral "<name>.bot" / "<owner>'s Bot". --handle / --display keep winning, and an existing
// ~/.bot-social/<name>.json is never touched.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { startServer } from "./helpers.js";

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(); });
after(async () => { await S.stop(); });

/** A fresh $BOTSOCIAL_HOME so each case registers into its own config directory. */
function cli() {
  const dir = mkdtempSync(join(tmpdir(), "botctl-defaults-"));
  const home = join(dir, ".bot-social");
  mkdirSync(home, { recursive: true });
  const run = (...a: string[]) => promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/botctl.ts", ...a], { env: { ...process.env, BOTSOCIAL_HOME: home, BOTSOCIAL_URL: "" }, encoding: "utf8" });
  const register = async (...a: string[]) => JSON.parse((await run("register", ...a, "--json")).stdout);
  const profile = async (name: string) => {
    const cfg = JSON.parse(readFileSync(join(home, `${name}.json`), "utf8"));
    const r = await fetch(`${S.base}/v1/bots/${cfg.bot_id}/profile`, { headers: { authorization: `Bearer ${cfg.bot_token}` } });
    assert.equal(r.status, 200, "the new Bot can read its own profile");
    return (await r.json()) as any;
  };
  return { home, run, register, profile };
}

test("the default handle is <name>.bot, not one assistant's name", async () => {
  const { register } = cli();
  const reg = await register("alice", "--url", S.base);
  assert.equal(String(reg.handle).replace(/^@/, ""), "alice.bot", "the default handle names the Bot, not one assistant");
});

test("the default display name is \"<owner>'s Bot\"", async () => {
  const { register, profile } = cli();
  await register("bella", "--url", S.base);
  assert.equal((await profile("bella")).display_name, "bella's Bot", "the default display name is the owner's Bot");
});

test("--handle and --display still win over the defaults", async () => {
  const { register, profile } = cli();
  const reg = await register("zed", "--url", S.base, "--handle", "@Zed.Bot", "--display", "Zed's Helper");
  assert.equal(String(reg.handle).replace(/^@/, ""), "zed.bot", "an explicit --handle is only lower-cased and de-@'d");
  assert.equal((await profile("zed")).display_name, "Zed's Helper", "an explicit --display is used verbatim");
});

test("an existing config is refused, never rewritten", async () => {
  const { home, run, register } = cli();
  await register("amy", "--url", S.base);
  const before = readFileSync(join(home, "amy.json"), "utf8");
  await assert.rejects(run("register", "amy", "--url", S.base), (e: any) => {
    assert.equal(e.code, 1);
    assert.match(String(e.stderr), /config already exists/);
    return true;
  });
  assert.equal(readFileSync(join(home, "amy.json"), "utf8"), before, "the old config is byte-identical");
  assert.ok(existsSync(join(home, "amy.json")));
});
