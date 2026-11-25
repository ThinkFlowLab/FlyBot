// One-time secrets panel (#16): what the console shows and downloads after Bot registration and resume.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./helpers.js";
import { OwnerClient } from "../src/client.js";
import { loadConsole, pub } from "./ui_helpers.js";

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(); });
after(async () => { await S.stop(); });

test("registration with a generated key: three secrets, plain info, and a download that matches the API response", async () => {
  const { client } = await OwnerClient.register(S.base, "secretsowner", "secret-pw", "Secrets Owner");
  const r = await client.req("POST", "/v1/bots", { handle: "secrets.bot", integration_type: "manual" });
  const { secretsModel } = loadConsole(["secretsModel"]);
  const m = JSON.parse(JSON.stringify(secretsModel(r, "https://bs.example", "secrets.bot")));
  assert.deepEqual(m.secrets.map((s: any) => s.key), ["bot_token", "webhook_secret", "private_key_pem"]);
  assert.deepEqual(m.secrets.map((s: any) => s.label), ["Bot token", "Webhook signing secret", "Private signing key"]);
  assert.equal(m.secrets[0].value, r.bot_token);
  assert.equal(m.secrets[1].value, r.webhook_secret);
  assert.equal(m.secrets[2].value, r.key.private_key_pem);
  for (const s of m.secrets) assert.ok(s.hint.length > 20);
  // Non-secret ids are plain info, not mixed into the secrets.
  assert.deepEqual(m.info.map(([k]: string[]) => k), ["Bot", "Bot ID", "Key ID"]);
  assert.equal(m.info[0][1], "@secrets.bot");
  // The download holds exactly what the Bot needs (botctl field names), and nothing owner-level.
  assert.deepEqual(Object.keys(m.file).sort(), ["base", "bot_id", "bot_token", "handle", "kid", "private_key_pem", "webhook_secret"]);
  assert.equal(m.file.base, "https://bs.example");
  assert.equal(m.file.bot_token, r.bot_token);
  assert.equal(m.file.private_key_pem, r.key.private_key_pem);
  assert.equal(m.filename, "bot-social-secrets.bot.json");
  assert.ok(!JSON.stringify(m.file).includes("otk_"), "no owner token in the Bot file");
});

test("registration with the owner's own key: no private key row; resume: only the new Bot token", async () => {
  const { client } = await OwnerClient.register(S.base, "byokowner", "secret-pw", "BYOK");
  const { generateEd25519 } = await import("../src/crypto.js");
  const kp = generateEd25519();
  const r = await client.req("POST", "/v1/bots", { handle: "byok.bot", public_key: { alg: "Ed25519", kid: "key_1", value: kp.publicKey } });
  const { secretsModel } = loadConsole(["secretsModel"]);
  const m = JSON.parse(JSON.stringify(secretsModel(r, "https://bs.example", "byok.bot")));
  assert.deepEqual(m.secrets.map((s: any) => s.key), ["bot_token", "webhook_secret"]);
  assert.equal(m.file.private_key_pem, undefined);
  await client.req("POST", "/v1/emergency-stop", { bot_id: r.bot_id });
  const res = await client.req("POST", `/v1/bots/${r.bot_id}/resume`);
  const m2 = JSON.parse(JSON.stringify(secretsModel(res, "https://bs.example", "@byok.bot")));
  assert.deepEqual(m2.secrets.map((s: any) => s.key), ["bot_token"]);
  assert.deepEqual(Object.keys(m2.file).sort(), ["base", "bot_id", "bot_token", "handle"]);
  assert.equal(m2.file.handle, "@byok.bot");
});

test("console never dumps the raw registration JSON, never uses prompt() for tokens, and never stores secrets", () => {
  const ui = pub("ui.js");
  assert.ok(!ui.includes("JSON.stringify(r, null, 2)"), "raw registration JSON dump is gone");
  assert.ok(!/prompt\([^)]*bot token/i.test(ui), "no prompt() for the resumed Bot token");
  assert.match(ui, /They are shown only once and cannot be shown again\. Anyone with them can act as this Bot\./);
  assert.match(ui, /I've saved these/);
  assert.match(ui, /addEventListener\("beforeunload", onUnloadWithSecrets\)/);
  // The only values ui.js writes to localStorage are the owner session and the selected Bot id.
  const writes = [...ui.matchAll(/localStorage\.setItem\(\s*["']([^"']+)["']/g)].map((x) => x[1]);
  assert.deepEqual([...new Set(writes)].sort(), ["bs_owner_token", "bs_sel_bot"]);
  assert.ok(!/console\.(log|info|debug)\(/.test(ui), "no console logging in the console UI");
});
