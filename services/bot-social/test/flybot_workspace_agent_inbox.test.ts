import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { bulkAuth, startServer } from "./helpers.js";
import { home } from "./flybot_workspace_helpers.js";

type Service = Awaited<ReturnType<typeof startServer>>;
let service: Service;
before(async () => { service = await startServer(bulkAuth); });
after(async () => { await service.stop(); });
const inbox = "/v1/ot/agent-inbox?managed=1";
const longInbox = inbox + "&wait_ms=8000";
const roomPath = (id: string) => "/v1/ot/conversations/" + id;

async function promptly<T>(response: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([response, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Expected an event-driven inbox wake")), 2000);
    })]);
  } finally { clearTimeout(timer); }
}

async function watch<T>(server: Service, path: string, start: () => Promise<T>) {
  let started!: () => void;
  const listening = new Promise<void>(resolve => { started = resolve; });
  const entered = (req: IncomingMessage) => {
    if (req.url === path) setImmediate(started);
  };
  server.app.server.on("request", entered);
  const response = start();
  try {
    await promptly(listening);
    const state = await Promise.race([response.then(() => "answered"), delay(15, "waiting")]);
    assert.equal(state, "waiting");
  } finally { server.app.server.off("request", entered); }
  return { response };
}

async function pair(label: string) {
  const [worker, requester] = await Promise.all([home(service.base, label + "-worker"), home(service.base, label + "-requester")]);
  const contact = await requester.ok("POST", "/v1/ot/contacts", {handle: worker.handle});
  await worker.ok("POST", "/v1/ot/contacts/" + contact.id, {action: "accept"});
  const {owner_id} = await worker.ok("GET", "/v1/ot/me");
  return {worker, requester, target: {owner_id, agent_id: "helper"}};
}

test("a scoped group job and its retry wake only the exact owner without blocking the claim", async () => {
  const {worker, requester, target} = await pair("wake-group");
  const outsider = await home(service.base, "wake-other");
  const group = await worker.ok("POST", "/v1/ot/conversations", {
    kind: "group", account_group: true, title: "Idle worker", members: [requester.handle],
    agents: [{agent_ref: target.agent_id, name: "Helper"}],
  });
  const room = roomPath(group.id);
  const unrelatedPath = inbox + "&wait_ms=500&after=1";
  const unrelated = await watch(service, unrelatedPath, () => outsider.ok("GET", unrelatedPath));
  const waiting = await watch(service, longInbox, () => worker.ok("GET", longInbox));
  const sent = await requester.ok("POST", room + "/messages", {body: "Review this brief", agent_mentions: [target]});
  const result = await promptly(waiting.response);
  assert.equal(result.wake_supported, true);
  assert.deepEqual(result.jobs.map((job: any) => [job.message.id, job.group_text_only]), [[sent.id, true]]);
  assert.equal(await Promise.race([unrelated.response.then(() => "answered"), delay(30, "waiting")]), "waiting");

  const job = result.jobs[0];
  const jobPath = "/v1/ot/agent-reply-jobs/" + job.job_id;
  const claim = {action: "start", attempt: 1, source_revision: sent.revision, claim_id: randomUUID(), accept_group_text_turn: true};
  const receipt = await worker.ok("POST", jobPath, claim);
  assert.equal(receipt.group_text_only, true);
  const retryWaitPath = longInbox + "&after=" + result.cursor;
  const retryWait = await watch(service, retryWaitPath, () => worker.ok("GET", retryWaitPath));
  await worker.ok("POST", jobPath + "/progress", {attempt: 1, revision: 1, claim_id: claim.claim_id, text: "Reviewing"});
  await worker.ok("POST", jobPath, {...claim, action: "fail"});
  await requester.ok("POST", room + "/messages/" + sent.id + "/agent-retry", {job_id: job.job_id, attempt: 1});
  const retried = await promptly(retryWait.response);
  assert.equal(retried.wake_supported, true);
  assert.deepEqual(retried.jobs.map((entry: any) => [entry.job_id, entry.attempt]), [[job.job_id, 2]]);
  assert.deepEqual(await unrelated.response, {cursor: 1, items: [], jobs: [], wake_supported: true});
});

test("managed waiting keeps direct, automatic and public work available without exposing DM text", async () => {
  const {worker, requester, target} = await pair("wake-modes");
  const {id} = await requester.ok("POST", "/v1/ot/conversations", {kind: "dm", peer: worker.handle});
  const dm = roomPath(id);
  await worker.ok("PUT", dm + "/agents/helper", {name: "Worker"});
  const watchingDm = await watch(service, longInbox, () => worker.ok("GET", longInbox));
  const requested = await requester.ok("POST", dm + "/messages", {
    direct: true, direct_agent_request: true, body: "Private task", client_key: "private-wake-fixture", agent_mentions: [target],
  });
  const result = await promptly(watchingDm.response);
  assert.deepEqual(result.jobs[0].message, {id: requested.id, revision: requested.revision});
  assert.equal(result.jobs[0].direct_text_only, true);
  await requester.ok("DELETE", dm + "/agents/helper?owner_id=" + target.owner_id);

  const group = await worker.ok("POST", "/v1/ot/conversations", {
    kind: "group", account_group: true, title: "Auto bounds", members: [requester.handle],
  });
  const room = roomPath(group.id);
  await worker.ok("POST",room+"/management",{
    direct:true,action:"reply_policy",revision:group.group_management.revision,mode:"default",
  });
  await worker.ok("PUT", room + "/agents/helper", {name: "Helper", auto_reply: true});
  const watchingAuto = await watch(service, longInbox, () => worker.ok("GET", longInbox));
  const automatic = await requester.ok("POST", room + "/messages", {body: "New group text"});
  const auto = await promptly(watchingAuto.response);
  assert.deepEqual(auto.items.map((item: any) => [item.mode, item.message.id]), [["auto", automatic.id]]);
  assert.deepEqual(auto.jobs, []);

  const slug = "wake-public-listing";
  await worker.ok("PUT", "/v1/ot/listings", {kind: "agent", ref: "helper", slug, title: "Public Helper", chat_enabled: true});
  const opened = await requester.ok("POST", "/v1/ot/discover/" + slug + "/start");
  const publicPath = longInbox + "&after=" + auto.cursor;
  const watchingPublic = await watch(service, publicPath, () => worker.ok("GET", publicPath));
  const guest = await requester.ok("POST", roomPath(opened.conversation_id) + "/messages", {body: "Public text"});
  const publicReply = await promptly(watchingPublic.response);
  assert.deepEqual(publicReply.items.map((item: any) => [item.mode, item.message.id]), [["public", guest.id]]);
});

test("managed wait validates bounds, releases disconnected slots, and drains before server close", async t => {
  const scoped = await startServer(bulkAuth);
  let stopped = false;
  t.after(async () => { if (!stopped) await scoped.stop(); });
  const onboard = await fetch(scoped.base + "/v1/onboard/flybot", {
    method: "POST", headers: {"content-type": "application/json", connection: "close"}, body: JSON.stringify({display_name: "Inbox waiter fixture"}),
  });
  assert.ok(onboard.ok);
  const {connector} = await onboard.json();
  const poll = (path: string, signal?: AbortSignal) => fetch(scoped.base + path, {
    headers: {authorization: "Bearer " + connector.token, connection: "close"}, signal,
  });
  for (const query of ["", "-1", "10001", "0&wait_ms=3", "3.5", "NaN"]) {
    assert.equal((await poll(inbox + "&wait_ms=" + query)).status, 400);
  }
  assert.equal((await poll("/v1/ot/agent-inbox?wait_ms=30")).status, 400);
  assert.equal((await fetch(scoped.base + longInbox, {headers: {connection: "close"}})).status, 401);
  assert.deepEqual(await (await poll(inbox + "&wait_ms=0")).json(), {cursor: 0, items: [], jobs: []});
  const expiredPath = inbox + "&wait_ms=80";
  const expired = await watch(scoped, expiredPath, () => poll(expiredPath));
  assert.deepEqual(await (await expired.response).json(), {cursor: 0, items: [], jobs: [], wake_supported: true});

  const abort = new AbortController();
  const one = await watch(scoped, longInbox, () => new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(scoped.base + longInbox, {
      headers: {authorization: "Bearer " + connector.token}, signal: abort.signal, agent: false,
    }, response => { response.resume(); resolve(response.statusCode); });
    request.once("error", reject);
    request.end();
  }));
  const secondPath = longInbox + "&limit=2";
  const two = await watch(scoped, secondPath, () => poll(secondPath));
  const overflowPath = longInbox + "&limit=3";
  assert.deepEqual(await (await promptly(poll(overflowPath))).json(), {cursor: 0, items: [], jobs: []});
  abort.abort();
  await assert.rejects(one.response, {name: "AbortError"});
  const three = await watch(scoped, overflowPath, () => poll(overflowPath));
  const stopping = scoped.stop();
  for (const request of [two, three]) {
    const response = await promptly(request.response);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await response.json(), {cursor: 0, items: [], jobs: [], wake_supported: true});
  }
  await promptly(stopping);
  stopped = true;
});
