/**
 * A write the assistant made is not the owner's own click.
 *
 * README promises connector writes are audited as `owner:<id>:mcp`, and the /ui audit page renders that tag as
 * "(through your assistant)" (`public/ui.js`, `auditActor`). A connector reaches the platform two ways: the MCP
 * tools at /mcp, and the REST routes that pass a connector token through (`ownerAny`), which is the door the
 * `set_webhook` tool description itself points at (`curl -X PUT …/v1/connector/webhook`). Both are "connector
 * writes", so both must carry the tag.
 *
 * On the MCP side, nearly every tool reaches the platform through `tagged()`, which rewrites the audit actor for
 * the duration of one synchronous call. Four write tools were registered without it, so a home-member add, a
 * home-member removal, a file upload and a webhook test made through the connector were recorded as the owner's
 * own web action -- for the upload, as the Bot's. `test_webhook` cannot use that wrapper: the platform call is
 * async and appends its row after the await, so it takes its actor explicitly instead.
 *
 * On the REST side the actor came from `actorOf(principal)`, which ignored the token's scope, so the webhook trio,
 * a profile update and the grant routes wrote the same bare actor a web session writes.
 *
 * (1) is the defect shape over /mcp. (2) is the same four writes through the web session: the bare actors stay, so
 * this is tagging the assistant, not tagging every audit row. (3) and (4) are the same pair for the REST gate.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CAPABILITIES } from "../src/policy.js";
import { friends, startServer } from "./helpers.js";

const b64 = (s: string) => Buffer.from(s).toString("base64");
let n = 0;

type S = Awaited<ReturnType<typeof startServer>>;

/** Every webhook push answers 200, so `test_webhook` settles without touching the network. */
const fakeFetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;

async function req(base: string, method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}

/** One tool call over the connector surface, answered in the tool's own JSON. */
async function call(s: S, token: string, name: string, args: unknown = {}) {
  const r = await fetch(s.base + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const j: any = await r.json();
  if (j.result?.isError) throw new Error(j.result.content[0].text);
  assert.ok(j.result, JSON.stringify(j));
  return JSON.parse(j.result.content[0].text);
}

/** A FlyBot home, its connector token, and an owner login for the web side. */
async function home(t: any) {
  const s = await startServer({ fetchImpl: fakeFetch });
  t.after(s.stop);
  const username = `mcpwriter${++n}`;
  const on: any = await req(s.base, "POST", "/v1/onboard/flybot", undefined, { username, password: "secret-pw", display_name: "MCP Writer" });
  assert.equal(on.status, 201, JSON.stringify(on.body));
  const login: any = await req(s.base, "POST", "/v1/auth/login", undefined, { username, password: "secret-pw" });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const me: any = await req(s.base, "GET", "/v1/me", login.body.owner_token);
  return { s, connector: on.body.connector.token as string, web: login.body.owner_token as string, homeId: on.body.home.bot_id as string, ownerId: me.body.owner_id as string };
}

/** Two friends, each with a connector token minted from their web session. */
async function pair(t: any) {
  const s = await startServer({ fetchImpl: fakeFetch });
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const mint = async (o: any) => {
    const r: any = await o.owner.req("POST", "/v1/connector-tokens", { label: "writer" });
    return r.token as string;
  };
  return { s, A, B, connectorA: await mint(A), connectorB: await mint(B) };
}

async function auditFrom(s: S, token: string, afterSeq = 0) {
  const r: any = await req(s.base, "GET", "/v1/audit-events?limit=1000", token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return (r.body.events as any[]).filter((e) => e.seq > afterSeq);
}

const lastSeq = (events: any[]) => (events.length ? events[events.length - 1].seq : 0);

/** The four writes under test, in the order they happen; each returns the row its audit entry names. */
async function writes(s: S, connector: string, homeId: string) {
  const added: any = await call(s, connector, "add_home_member", { home: homeId, name: "writer" });
  const up: any = await call(s, connector, "upload_attachment", { bot_id: added.bot_id, name: "plan.md", content_base64: b64("# Plan\nship it") });
  await call(s, connector, "set_webhook", { bot_id: added.bot_id, url: "https://hook.test/routine" });
  await call(s, connector, "test_webhook", { bot_id: added.bot_id });
  await call(s, connector, "remove_home_member", { home: homeId, member: added.bot_id });
  return { memberId: added.bot_id as string, attachmentId: up.attachment.id as string };
}

const WRITE_ROWS = (memberId: string, attachmentId: string) => (e: any) =>
  (e.action === "home.member_added" && e.subject === memberId)
  || (e.action === "attachment.uploaded" && e.subject === attachmentId)
  || (e.action === "bot.webhook_tested" && e.subject === memberId)
  || (e.action === "home.member_revoked" && e.subject === memberId);

test("(1) writes made through /mcp are audited as :mcp", async (t) => {
  const { s, connector, web, homeId, ownerId } = await home(t);
  const { memberId, attachmentId } = await writes(s, connector, homeId);

  const rows = (await auditFrom(s, web)).filter(WRITE_ROWS(memberId, attachmentId)).map((e) => `${e.action} ${e.actor}`);

  assert.deepEqual(rows, [
    `home.member_added owner:${ownerId}:mcp`,
    `attachment.uploaded bot:${memberId}:mcp`,
    `bot.webhook_tested owner:${ownerId}:mcp`,
    `home.member_revoked owner:${ownerId}:mcp`,
  ], "every one of these four writes is the assistant's, in the order it happened");
});

test("(2) control: the same writes through the web session keep their bare actor", async (t) => {
  const { s, web, homeId, ownerId } = await home(t);

  const added: any = await req(s.base, "POST", `/v1/homes/${homeId}/members`, web, { name: "writer" });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const memberId = added.body.bot_id as string;
  const up: any = await req(s.base, "POST", "/v1/attachments", web, { bot_id: memberId, name: "plan.md", content_base64: b64("# Plan\nship it") });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const attachmentId = up.body.attachment.id as string;
  assert.equal((await req(s.base, "PUT", `/v1/bots/${memberId}/webhook`, web, { url: "https://hook.test/routine" })).status, 200);
  assert.equal((await req(s.base, "POST", `/v1/bots/${memberId}/webhook/test`, web)).status, 200);
  assert.equal((await req(s.base, "DELETE", `/v1/homes/${homeId}/members/${memberId}`, web)).status, 200);

  const rows = (await auditFrom(s, web)).filter(WRITE_ROWS(memberId, attachmentId)).map((e) => `${e.action} ${e.actor}`);

  assert.deepEqual(rows, [
    `home.member_added owner:${ownerId}`,
    `attachment.uploaded bot:${memberId}`,
    `bot.webhook_tested owner:${ownerId}`,
    `home.member_revoked owner:${ownerId}`,
  ], "the owner's own web writes are not tagged as the assistant's");
});

/** The REST writes a connector can make, each with the token the caller hands in. The share between the two
 *  friends is revoked first so the re-share below is a fresh write, not the idempotent answer. */
async function restWrites(s: S, writeTok: string, granteeTok: string, botId: string, friendBotId: string) {
  const put: any = await req(s.base, "PUT", "/v1/connector/webhook", writeTok, { bot_id: botId, url: "https://hook.test/routine" });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const test: any = await req(s.base, "POST", "/v1/connector/webhook/test", writeTok, { bot_id: botId });
  assert.equal(test.status, 200, JSON.stringify(test.body));
  const del: any = await req(s.base, "DELETE", `/v1/connector/webhook?bot_id=${botId}`, writeTok);
  assert.equal(del.status, 200, JSON.stringify(del.body));
  const prof: any = await req(s.base, "PATCH", `/v1/bots/${botId}/profile`, writeTok, { display_name: "REST Writer" });
  assert.equal(prof.status, 200, JSON.stringify(prof.body));

  const listed: any = await req(s.base, "GET", `/v1/bots/${botId}/grants`, writeTok);
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  const share = listed.body.grants.find((g: any) => g.grantee.bot_id === friendBotId && !g.reply_only);
  assert.ok(share, "the friendship's full share is listed");
  const revoked: any = await req(s.base, "DELETE", `/v1/bots/${botId}/grants/${share.grant_id}`, writeTok);
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));

  const created: any = await req(s.base, "POST", `/v1/bots/${botId}/grants`, writeTok, { friend_bot_id: friendBotId });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const declined: any = await req(s.base, "DELETE", `/v1/remote-bots/${created.body.grant_id}`, granteeTok);
  assert.equal(declined.status, 200, JSON.stringify(declined.body));
}

/** One row per capability the share wrote, then the share summary `grant_bot_to_friend` appends. */
const CREATED = Array.from({ length: DEFAULT_CAPABILITIES.length + 1 }, () => "grant.created");

const REST_ACTIONS = new Set(["bot.webhook_set", "bot.webhook_tested", "bot.webhook_cleared", "bot.profile_updated", "grant.created", "grant.revoked", "grant.declined"]);

test("(3) the same writes over the connector REST routes are audited as :mcp", async (t) => {
  const { s, A, B, connectorA, connectorB } = await pair(t);
  const mark = lastSeq(await auditFrom(s, B.owner.token));

  await restWrites(s, connectorB, connectorA, B.bot.id, A.bot.id);

  const botActor = `owner:${B.owner_id}:mcp`;
  const granteeActor = `owner:${A.owner_id}:mcp`;
  const rows = (await auditFrom(s, B.owner.token, mark)).filter((e) => REST_ACTIONS.has(e.action)).map((e) => `${e.action} ${e.actor}`);

  assert.deepEqual(rows, [
    `bot.webhook_set ${botActor}`,
    `bot.webhook_tested ${botActor}`,
    `bot.webhook_cleared ${botActor}`,
    `bot.profile_updated ${botActor}`,
    `grant.revoked ${botActor}`,
    ...CREATED.map((a) => `${a} ${botActor}`),
    `grant.declined ${granteeActor}`,
  ], "a connector token's REST writes are the assistant's, whichever door it came through");
});

test("(4) control: the same REST writes through the web session keep their bare actor", async (t) => {
  const { s, A, B } = await pair(t);
  const mark = lastSeq(await auditFrom(s, B.owner.token));

  await restWrites(s, B.owner.token, A.owner.token, B.bot.id, A.bot.id);

  const botActor = `owner:${B.owner_id}`;
  const granteeActor = `owner:${A.owner_id}`;
  const rows = (await auditFrom(s, B.owner.token, mark)).filter((e) => REST_ACTIONS.has(e.action)).map((e) => `${e.action} ${e.actor}`);

  assert.deepEqual(rows, [
    `bot.webhook_set ${botActor}`,
    `bot.webhook_tested ${botActor}`,
    `bot.webhook_cleared ${botActor}`,
    `bot.profile_updated ${botActor}`,
    `grant.revoked ${botActor}`,
    ...CREATED.map((a) => `${a} ${botActor}`),
    `grant.declined ${granteeActor}`,
  ], "the owner's own REST writes are not tagged as the assistant's");
});
