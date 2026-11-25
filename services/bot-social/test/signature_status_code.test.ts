import assert from "node:assert/strict";
import { test } from "node:test";
import { generateEd25519, hashToken, signEnvelope } from "../src/crypto.js";
import { randomToken } from "../src/ids.js";
import { ownerWithBot, startServer } from "./helpers.js";

// A revoked Bot answers a signed request as `bot_revoked`, not as `bot_frozen`: the frozen code belongs to
// emergency stop, and the revocation contract keeps a revoked Bot indistinguishable from one that never
// existed (`platform.ts` requestRelationship's 404 branch). The status gate also has to go through reject(),
// so the refusal carries a `signature.rejected` audit line with the code that was returned.
//
// A frozen Bot is the control: its signed request must keep answering `bot_frozen`.

const req = async (base: string, method: string, path: string, token?: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
};

test("a revoked Bot's signed request is refused as bot_revoked and audited as such", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const fly = s.platform.onboardFlybot({ display_name: "Rivet" });
  const login = await req(s.base, "POST", "/v1/auth/login", undefined, { username: fly.username, password: fly.generated_password });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const ownerToken = login.body.owner_token as string;

  const added = await req(s.base, "POST", `/v1/homes/${fly.home.bot_id}/members`, ownerToken, { name: "writer", display_name: "Writer" });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const botId = added.body.bot_id as string;
  const kp = generateEd25519();
  const key = await req(s.base, "POST", `/v1/bots/${botId}/keys`, ownerToken, { kid: "revoked-sig", value: kp.publicKey });
  assert.equal(key.status, 201, JSON.stringify(key.body));
  const peer = await ownerWithBot(s.base, "revoked-sig-peer");

  const removed = await req(s.base, "DELETE", `/v1/homes/${fly.home.bot_id}/members/${botId}`, ownerToken);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.status, "revoked");

  // rotateBotToken now refuses a revoked identity (#177 ①), so this test writes the token row itself: it only
  // pins what verifyEnvelope answers when a token that exists during the revocation calls a signed route.
  const token = randomToken("btk");
  (s.platform as any).run("INSERT INTO tokens (token_hash, kind, subject_id, created_at) VALUES (?,?,?,?)", hashToken(token), "bot", botId, new Date().toISOString());

  const env = signEnvelope({
    type: "relationship.request", from: botId, kid: "revoked-sig", privateKeyPem: kp.privateKeyPem,
    payload: { target_handle: peer.handle, message: "signed probe", requested_capabilities: ["chat.public"] },
  });
  const refused = await req(s.base, "POST", "/v1/relationships", token, env);
  assert.equal(refused.status, 403, `a revoked Bot's signed request must be refused, got ${refused.status} ${JSON.stringify(refused.body)}`);
  assert.equal(refused.body.error.code, "bot_revoked");

  const audit = await req(s.base, "GET", `/v1/audit-events?subject=${botId}`, ownerToken);
  const rejections = (audit.body.events ?? []).filter((e: any) => e.action === "signature.rejected");
  assert.equal(rejections.length, 1, "the status refusal is audited");
  assert.equal(rejections[0].data.code, "bot_revoked", "and the audit carries the code that was returned");
});

test("a frozen Bot's signed request still answers bot_frozen", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "frozen-sig");
  const peer = await ownerWithBot(s.base, "frozen-sig-peer");
  const stopped = await A.owner.req("POST", "/v1/emergency-stop", { bot_id: A.bot.id });
  assert.equal(stopped.status, "frozen");
  const rotated = await A.owner.req("POST", `/v1/bots/${A.bot.id}/token`);

  const env = signEnvelope({
    type: "relationship.request", from: A.bot.id, kid: "k1", privateKeyPem: A.kp.privateKeyPem,
    payload: { target_handle: peer.handle, message: "signed probe", requested_capabilities: ["chat.public"] },
  });
  const refused = await req(s.base, "POST", "/v1/relationships", rotated.bot_token, env);
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(refused.body.error.code, "bot_frozen", "the freeze keeps its own code");
});
