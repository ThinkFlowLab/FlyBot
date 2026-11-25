import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("botsocial.env is loaded before module-level policy limits are read", () => {
  const dir = mkdtempSync(join(tmpdir(), "botsocial-env-"));
  const file = join(dir, "botsocial.env");
  writeFileSync(file, "BOTSOCIAL_NEW_CONVERSATIONS_PER_PAIR_PER_DAY=7\n");
  const env: NodeJS.ProcessEnv = { ...process.env, BOTSOCIAL_ENV_FILE: file };
  delete env.BOTSOCIAL_NEW_CONVERSATIONS_PER_PAIR_PER_DAY;
  try {
    const r = spawnSync(process.execPath, ["--import", "tsx", "-e",
      "import('./src/load-env.js').then(() => import('./src/policy.js')).then((m) => process.stdout.write(String(m.LIMITS.newConversationsPerPairPerDay)))",
    ], { cwd: process.cwd(), env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "7", "the value from botsocial.env reached the module-level LIMITS");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
