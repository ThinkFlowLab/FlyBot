/**
 * A superseded grant row is the history a renewal left behind: `insertGrant` marks the live row `superseded` and
 * writes a new one for the same capability. Ending the old row must not end the live bundle that replaced it —
 * revoking by the old id is refused with 409 `invalid_state`, the refusal the single-grant door already gives.
 *
 * The per-Bot door (`DELETE /v1/bots/{id}/grants/{grantId}`) carries no such check: it looks the row up, builds the
 * live bundle and revokes every row in it, so a stale id the owner still has at hand tears down the share that is
 * live today, and answers 200 as if that were the ask. Both doors must give the same refusal for the same row.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { friends, startServer } from "./helpers.js";

async function req(base: string, method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  const json = text ? JSON.parse(text) : {};
  return { status: r.status, body: json.error ? { ...json.error, ...json } : json };
}

/** A's Bot shared with B's Bot as a full bundle, then one capability renewed so the bundle's first row is history. */
async function renewedBundle(s: any) {
  const { A, B, relId } = await friends(s.base);
  const bundle = await req(s.base, "POST", `/v1/bots/${A.bot.id}/grants`, A.owner.token, { friend_owner_id: B.owner_id, friend_bot_id: B.bot.id });
  assert.equal(bundle.status, 201, JSON.stringify(bundle.body));
  const renewed = await req(s.base, "POST", `/v1/relationships/${relId}/grants`, A.owner.token, { capability: "chat.public" });
  assert.equal(renewed.status, 201, JSON.stringify(renewed.body));
  const db = s.platform.db;
  const stale = db.prepare("SELECT id FROM grants WHERE grantor_owner = ? AND grantee_bot = ? AND capability = 'chat.public' AND status = 'superseded'").get(A.owner_id, B.bot.id) as any;
  assert.ok(stale, "the renewal left the bundle's first chat.public row superseded");
  const live = db.prepare("SELECT COUNT(*) n FROM grants WHERE grantor_owner = ? AND grantee_bot = ? AND status = 'active'").get(A.owner_id, B.bot.id) as any;
  return { s, A, B, staleId: stale.id as string, liveBefore: live.n as number };
}

const rowStatus = (s: any, id: string) => (s.platform.db.prepare("SELECT status FROM grants WHERE id = ?").get(id) as any).status;
const liveRows = (s: any, ownerId: string, botId: string) =>
  (s.platform.db.prepare("SELECT COUNT(*) n FROM grants WHERE grantor_owner = ? AND grantee_bot = ? AND status = 'active'").get(ownerId, botId) as any).n;

test("a superseded grant id cannot revoke the live bundle", async (t) => {
  const { s, A, B, staleId, liveBefore } = await renewedBundle(await startServer());
  t.after(s.stop);

  // The single-grant door already refuses a row that is history, word for word what a second DELETE of the same
  // row gives: this is the answer both doors owe, and the per-Bot door below is compared against it.
  const single = await req(s.base, "DELETE", `/v1/grants/${staleId}`, A.owner.token);
  assert.equal(single.status, 409, JSON.stringify(single.body));
  assert.equal(single.body.code, "invalid_state");
  assert.equal(single.body.message, "the grant is superseded");

  // Same row, per-Bot door: today it takes the live bundle down and answers 200.
  const perBot = await req(s.base, "DELETE", `/v1/bots/${A.bot.id}/grants/${staleId}`, A.owner.token);
  assert.equal(perBot.status, 409, JSON.stringify(perBot.body));
  assert.equal(perBot.body.code, single.body.code, "the two doors give the same refusal");
  assert.equal(perBot.body.message, single.body.message, "word for word");

  // The refused call changed nothing: the stale row is still history, the bundle is still live.
  assert.equal(rowStatus(s, staleId), "superseded", "the old row is still history");
  assert.equal(liveRows(s, A.owner_id, B.bot.id), liveBefore, "every live row of the bundle is still active");

  // And the share is still a share: the grantee still sees the Bot.
  const remote = await req(s.base, "GET", "/v1/remote-bots", B.owner.token);
  assert.equal(remote.status, 200, JSON.stringify(remote.body));
  assert.ok((remote.body.bots as any[]).some((b: any) => b.granted_bot?.bot_id === A.bot.id || b.bot_id === A.bot.id), "B still sees A's Bot");
});
