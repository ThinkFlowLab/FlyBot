import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {test, type TestContext} from "node:test";
import {bulkAuth, startServer} from "./helpers.js";
import {home} from "./flybot_workspace_helpers.js";

type Message = {id: string; revision: number; reply_jobs: {id: string}[]};

async function fixture(t: TestContext) {
  let now = Date.now();
  const service = await startServer({...bulkAuth, now: () => now});
  t.after(() => service.stop());
  const [worker, author] = await Promise.all([home(service.base, "lease-worker"), home(service.base, "lease-author")]);
  const contact = await author.ok("POST", "/v1/ot/contacts", {handle:worker.handle});
  await worker.ok("POST", "/v1/ot/contacts/" + contact.id, {action:"accept"});
  const {owner_id} = await worker.ok("GET", "/v1/ot/me");
  const agent = {agent_ref:"lease-helper", name:"Lease helper"};
  const group = await worker.ok("POST", "/v1/ot/conversations", {
    kind:"group", account_group:true, title:"Long-running collaboration", members:[author.handle], agents:[agent],
  });
  const room = "/v1/ot/conversations/" + group.id;
  const job = (source: Message) => source.reply_jobs[0]!.id;
  const task = (source: Message) => "/v1/ot/agent-reply-jobs/" + job(source);
  const send = (body: string): Promise<Message> => author.ok("POST", room + "/messages", {
    body, agent_mentions:[{owner_id, agent_id:agent.agent_ref}],
  });
  const stored = (source: Message) => service.platform.db.prepare<[string], {
    updated_at:number; lease_expires_at:number|null; attempt:number; status:string;
  }>("SELECT updated_at,lease_expires_at,attempt,status FROM ot_agent_reply_jobs WHERE id=?").get(job(source));
  const view = async (source: Message) => (await author.ok("GET", room + "/messages")).messages
    .find((message: Message) => message.id === source.id).reply_jobs[0];
  async function claim(source: Message, attempt = 1) {
    const claim_id = randomUUID();
    const receipt = await worker.ok("POST", task(source), {
      action:"start", attempt, claim_id, source_revision:source.revision, accept_group_text_turn:true,
    });
    assert.equal(receipt.group_text_only, true);
    return claim_id;
  }
  const keepalive = (source: Message, claim_token: string, attempt = 1) => worker.call("POST", task(source), {
    action:"keepalive", attempt, claim_token,
  });
  const reply = (source: Message, claim_id: string, attempt = 1) => worker.call("POST", room + "/agent-messages", {
    body:"The run finished.", agent_ref:agent.agent_ref, reply_to:source.id, job_id:job(source), attempt, claim_id,
  });
  const pass = (source: Message, claim_id: string, attempt = 1) => worker.call("POST", task(source), {
    action:"pass", attempt, claim_id,
  });
  const fail = (source: Message, claim_id: string, attempt = 1) => worker.call("POST", task(source), {
    action:"fail", attempt, claim_id,
  });
  return {service,worker,author,room,job,task,send,stored,view,claim,keepalive,reply,pass,fail,
    move(ms: number) { now += ms; }};
}

test("heartbeat preserves a managed running reply and its progress without moving the claim start", async t => {
  const f = await fixture(t);
  const running = await f.send("Review this source in depth");
  const queued = await f.send("Write a separate summary");
  const claim = await f.claim(running);
  const initial = f.stored(running)!;
  assert.equal(initial.lease_expires_at, initial.updated_at + 180_000);
  // A previously claimed row from before the migration has no stored lease.
  f.service.platform.db.prepare("UPDATE ot_agent_reply_jobs SET lease_expires_at=NULL WHERE id=?").run(f.job(running));
  const snapshot = {attempt:1, revision:1, claim_id:claim, text:"Review in progress"};
  await f.worker.ok("POST", f.task(running)+"/progress", snapshot);
  const {activity_version:activity} = await f.author.ok("GET", f.room);
  assert.equal(typeof activity,"string");
  f.move(120_000);
  const forged = await f.author.call("POST", f.task(running), {action:"keepalive",attempt:1,claim_token:claim});
  assert.equal(forged.status,404);
  assert.equal((await f.keepalive(running,randomUUID())).status,409);
  assert.equal((await f.keepalive(running,claim,2)).status,409);
  assert.equal((await f.worker.call("POST",f.task(running),{action:"keepalive",attempt:1,claim_id:claim})).status,400);
  assert.deepEqual(await f.keepalive(running,claim), {status:200,data:{ok:true}});
  const renewed = f.stored(running)!;
  assert.equal(renewed.updated_at, initial.updated_at);
  assert.equal(renewed.lease_expires_at, initial.updated_at + 300_000);
  assert.equal((await f.author.ok("GET", f.room)).activity_version, activity);

  f.move(90_000);
  assert.equal((await f.view(running)).status,"running");
  assert.equal((await f.view(queued)).status,"queued");
  const active = await f.author.ok("GET", f.room + "/reply-progress");
  assert.deepEqual(active.items.map((row: {id:string; text:string}) => [row.id,row.text]),
    [[f.job(queued),""],[f.job(running),snapshot.text]]);
  assert.deepEqual((await f.worker.ok("GET", "/v1/ot/agent-inbox?managed=1")).jobs.map((row: {job_id:string}) => row.job_id),
    [f.job(queued)]);
  await f.worker.ok("POST", f.task(running)+"/progress", {...snapshot,revision:2,text:"Review finished"});
  assert.equal((await f.reply(running,claim)).status,201);
  f.move(390_000);
  assert.equal((await f.view(queued)).error_code,"reply_timeout");
  assert.equal((await f.view(queued)).can_retry,true);
  assert.deepEqual((await f.author.ok("GET", f.room + "/reply-progress")).items,[]);
  assert.deepEqual((await f.worker.ok("GET", "/v1/ot/agent-inbox?managed=1")).jobs,[]);
});

test("an expired exact claim may finish or pass once, but a heartbeat cannot restore it", async t => {
  const f = await fixture(t);
  const [late, silent] = [await f.send("Write a long reply"),await f.send("Only answer with new information")];
  const lateClaim = await f.claim(late), silentClaim = await f.claim(silent);
  f.move(180_001);
  assert.equal((await f.view(late)).error_code,"reply_timeout");
  assert.equal((await f.view(late)).can_retry,true);
  assert.equal((await f.keepalive(late,lateClaim)).status,409);
  assert.equal((await f.reply(late,randomUUID())).status,409);
  const delivered = await f.reply(late,lateClaim);
  assert.equal(delivered.status,201);
  assert.equal((await f.reply(late,lateClaim)).data.id,delivered.data.id);
  assert.deepEqual(await f.pass(silent,silentClaim),{status:200,data:{ok:true}});
  assert.deepEqual(await f.pass(silent,silentClaim),{status:200,data:{ok:true}});
  assert.equal((await f.view(silent)).status,"passed");
  assert.equal((await f.reply(silent,silentClaim)).status,409);
  const transcript = (await f.author.ok("GET",f.room+"/messages")).messages;
  assert.equal(transcript.filter((row: {reply_job_id?:string}) => row.reply_job_id===f.job(late)).length,1);
  assert.equal(transcript.filter((row: {reply_job_id?:string}) => row.reply_job_id===f.job(silent)).length,0);
});

test("a late native failure clears the timeout and accepts an exact replay without rewriting state", async t => {
  const f = await fixture(t);
  const source = await f.send("Review this shared source");
  const claim = await f.claim(source);
  f.move(180_001);
  assert.equal((await f.view(source)).error_code,"reply_timeout");
  assert.equal((await f.fail(source,randomUUID())).status,409);
  assert.deepEqual(await f.fail(source,claim),{status:200,data:{ok:true}});
  assert.equal((await f.view(source)).status,"failed");
  assert.equal((await f.view(source)).error_code,undefined);
  assert.equal((await f.view(source)).can_retry,true);
  const settled = f.stored(source);
  f.move(20_000);
  assert.deepEqual(await f.fail(source,claim),{status:200,data:{ok:true}});
  assert.deepEqual(f.stored(source),settled);
  assert.equal((await f.reply(source,claim)).status,409);
});

test("a retry or changed source fences off late completions and keepalives", async t => {
  const f = await fixture(t);
  const original = await f.send("Review once more");
  const stale = await f.claim(original);
  const changed = await f.send("Review the current version");
  const changedClaim = await f.claim(changed);
  f.move(180_001);
  await f.author.ok("POST",f.room+"/messages/"+original.id+"/agent-retry",{job_id:f.job(original),attempt:1});
  assert.equal(f.stored(original)?.lease_expires_at,null);
  const current = await f.claim(original,2);
  assert.equal((await f.reply(original,stale)).status,409);
  assert.equal((await f.pass(original,stale)).status,409);
  assert.equal((await f.fail(original,stale)).status,409);
  assert.equal((await f.keepalive(original,stale)).status,409);
  assert.equal((await f.reply(original,current,2)).status,201);
  await f.author.ok("PATCH","/v1/ot/messages/"+changed.id,{body:"The source has changed"});
  assert.equal((await f.reply(changed,changedClaim)).status,409);
  assert.equal((await f.pass(changed,changedClaim)).status,409);
  assert.equal((await f.fail(changed,changedClaim)).status,409);
  assert.equal((await f.keepalive(changed,changedClaim)).status,409);
});

test("removing an agent permanently invalidates that claim even if it is added back", async t => {
  const f = await fixture(t);
  const source = await f.send("Review this shared source");
  const claim = await f.claim(source);
  await f.worker.ok("DELETE",f.room+"/agents/lease-helper");
  await f.worker.ok("PUT",f.room+"/agents/lease-helper",{name:"Lease helper"});
  assert.equal(f.stored(source)?.status,"failed");
  assert.equal((await f.keepalive(source,claim)).status,409);
  assert.equal((await f.reply(source,claim)).status,409);
  assert.equal((await f.pass(source,claim)).status,409);
});
