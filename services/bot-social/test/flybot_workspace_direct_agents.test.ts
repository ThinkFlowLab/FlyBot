import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { bulkAuth, startServer } from "./helpers.js";
import { home } from "./flybot_workspace_helpers.js";

let service: Awaited<ReturnType<typeof startServer>>;
before(async () => { service = await startServer(bulkAuth); });
after(async () => { await service.stop(); });

const inbox = "/v1/ot/agent-inbox?managed=1";
const jobPath = (job: {id: string}) => `/v1/ot/agent-reply-jobs/${job.id}`;
const profileId = async (actor: Awaited<ReturnType<typeof home>>) => (await actor.ok("GET", "/v1/ot/me")).owner_id;

test("a human DM keeps its thread and sends paired prompts through isolated managed jobs", async () => {
  const [sender, worker, outsider] = await Promise.all([
    home(service.base, "dm-author"), home(service.base, "dm-worker"), home(service.base, "dm-outsider"),
  ]);
  const contacts = "/v1/ot/contacts";
  const contact = await sender.ok("POST", contacts, {handle:worker.handle});
  await worker.ok("POST", `${contacts}/${contact.id}`, {action:"accept"});
  const dm = await sender.ok("POST", "/v1/ot/conversations", {kind:"dm",peer:worker.handle});
  const room = `/v1/ot/conversations/${dm.id}`;
  const messages = `${room}/messages`;
  const senderId = await profileId(sender), workerId = await profileId(worker);
  const own = {owner_id:senderId,agent_id:"shared"}, target = {owner_id:workerId,agent_id:"shared"};
  assert.equal(dm.direct_agent_requests,true);
  assert.equal(dm.group_agent_requests,undefined);
  assert.deepEqual(dm.agents,[]);
  const unrelated = await sender.ok("POST", messages, {direct:true,body:"Unrelated DM history"});
  const quote = await worker.ok("POST", messages, {direct:true,body:"Explicit selected message"});

  assert.equal((await outsider.call("PUT", `${room}/agents/shared`, {name:"Intruder"})).status,404);
  assert.equal((await worker.call("PUT", `${room}/agents/shared`, {name:"Worker",auto_reply:true})).status,400);
  await worker.ok("PUT", `${room}/agents/shared`, {name:"Worker"});
  const roster = await sender.ok("PUT", `${room}/agents/shared`, {name:"Sender",auto_reply:false});
  assert.equal(roster.id,dm.id);
  assert.deepEqual(roster.agents.map((agent: any) => [agent.owner.owner_id,agent.agent_ref,agent.auto_reply]).sort(),
    [[senderId,"shared",false],[workerId,"shared",false]].sort());
  assert.equal((await worker.call("PATCH", `${room}/agents/shared`, {auto_reply:true})).status,400);
  assert.equal((await sender.call("DELETE", `${room}/agents/shared?owner_id=${await profileId(outsider)}`)).status,404);
  const ordinary = await sender.ok("POST",messages,{direct:true,body:"@shared Plain DM"});
  assert.deepEqual(ordinary.reply_jobs,[]);
  assert.deepEqual((await worker.ok("GET",inbox)).jobs,[]);
  const request = {direct:true,direct_agent_request:true,body:"Check the text",client_key:"dm-genuine-request-1",
    reply_to:quote.id,agent_mentions:[own,target]};
  const send = (extra = {}) => sender.call("POST",messages,{...request,...extra});
  const sharedGroup = await sender.ok("POST","/v1/ot/conversations",{kind:"group",account_group:true,title:"Separate group",members:[worker.handle]});
  assert.equal(sharedGroup.direct_agent_requests,undefined);
  assert.equal((await sender.call("POST",`/v1/ot/conversations/${sharedGroup.id}/messages`,request)).status,404);
  const slug = "dm-test-public-listing";
  await worker.ok("PUT","/v1/ot/listings",{kind:"agent",ref:"shared",slug,title:"Public preview",chat_enabled:true});
  const guest = await sender.ok("POST",`/v1/ot/discover/${slug}/start`);
  const guestRoom = `/v1/ot/conversations/${guest.conversation_id}`;
  const guestMessage = await sender.ok("POST",`${guestRoom}/messages`,{body:"Public guest text"});
  assert.equal((await sender.ok("GET",guestRoom)).direct_agent_requests,undefined);
  assert.equal((await sender.call("POST",`${guestRoom}/messages`,request)).status,404);
  assert.equal((await send({reply_to:guestMessage.id})).data.error.code,"reply_unavailable");
  assert.equal((await outsider.call("POST",messages,request)).status,404);
  assert.equal((await send({direct_agent_request:undefined})).status,400);
  assert.equal((await send({direct:false})).status,400);
  assert.equal((await send({agent_mentions:[target,target]})).status,400);
  assert.equal((await send({studio_reference:{document_id:"abc",revision:1}})).status,400);
  assert.equal((await send({attachment:{title:"handoff.txt"}})).status,400);
  const first = (await send()).data;
  assert.equal((await send({agent_mentions:[target,own]})).data.id,first.id);
  assert.equal((await send({agent_mentions:[target]})).data.error.code,"direct_agent_request_conflict");
  assert.equal((await send({direct_agent_request:undefined})).data.error.code,"direct_agent_request_conflict");
  const jobs = first.reply_jobs as {id:string;agent_owner_id:string}[];
  assert.equal(jobs.length,2);
  const selected = jobs.find(job=>job.agent_owner_id===workerId)!;
  const sameOwner = jobs.find(job=>job.agent_owner_id===senderId)!;
  const workerQueue = await worker.ok("GET",inbox);
  assert.deepEqual(workerQueue.items.map((item: any)=>[item.mode,item.message.id]),[["public",guestMessage.id]]);
  assert.deepEqual((await worker.ok("GET","/v1/ot/agent-inbox")).items.map((item: any)=>item.message.id),[guestMessage.id]);
  assert.deepEqual(workerQueue.jobs,[{job_id:selected.id, attempt:1, conversation_id:dm.id,
    agent_ref:"shared",agent_name:"Worker",mode:"mention",direct_text_only:true,message:{id:first.id,revision:first.revision}}]);
  assert.deepEqual((await outsider.ok("GET",inbox)).jobs,[]);
  assert.equal((await sender.ok("GET",inbox)).jobs[0].direct_text_only,true);

  const claim = {action:"start",attempt:1,source_revision:first.revision,claim_id:randomUUID(),accept_direct_text_turn:true};
  const final = {agent_ref:"shared",reply_to:first.id,mode:"mention",body:"Worker reply",job_id:selected.id,
    attempt:1,claim_id:claim.claim_id};
  const progress = {attempt:1,claim_id:claim.claim_id,revision:1,text:"Working"};
  assert.equal((await outsider.call("POST",jobPath(selected),claim)).status,404);
  assert.equal((await worker.call("POST",jobPath(selected),{...claim,accept_direct_text_turn:undefined,accept_group_text_turn:true})).status,409);
  assert.equal((await worker.call("POST",jobPath(selected),{...claim,source_revision:first.revision+1})).status,409);
  assert.equal((await worker.call("POST",jobPath(selected),{...claim,claim_id:undefined})).status,409);
  assert.equal((await worker.call("POST",`${room}/agent-messages`,{...final,reply_to:ordinary.id})).status,409);
  const receipt = await worker.ok("POST",jobPath(selected),claim);
  assert.deepEqual(receipt,{ok:true,direct_text_only:true,direct_prompt:first.body,
    quoted_message:{author:(await worker.ok("GET","/v1/ot/me")).display_name,text:quote.body}});
  assert.deepEqual(await worker.ok("POST",jobPath(selected),claim),receipt);
  assert.equal((await worker.call("POST",jobPath(selected),{action:"pass",attempt:1,claim_id:claim.claim_id})).status,409);
  assert.equal((await sender.call("POST",jobPath(sameOwner),{...claim,accept_direct_text_turn:undefined})).status,409);
  const sameOwnerClaim = {...claim,claim_id:randomUUID()};
  assert.equal((await sender.ok("POST",jobPath(sameOwner),sameOwnerClaim)).direct_text_only,true);

  await worker.ok("POST",`${jobPath(selected)}/progress`,progress);
  const progressItems = (await sender.ok("GET",`${room}/reply-progress`)).items;
  assert.equal(progressItems.find((item: any)=>item.id===selected.id).text,"Working");
  assert.equal((await outsider.call("GET",`${room}/reply-progress`)).status,404);
  assert.equal((await worker.call("POST",`${room}/agent-messages`,{...final,group_memory_ids:[]})).status,400);
  assert.equal((await worker.call("POST",`${room}/agent-messages`,{...final,claim_id:randomUUID()})).status,409);
  const delivered = await worker.ok("POST",`${room}/agent-messages`,final);
  assert.equal((await worker.ok("POST",`${room}/agent-messages`,final)).id,delivered.id);
  assert.equal(delivered.reply_job_id,selected.id);

  const retry = `${messages}/${first.id}/agent-retry`;
  await sender.ok("POST",jobPath(sameOwner),{...sameOwnerClaim,action:"fail"});
  const newAttempt = await sender.ok("POST",retry,{job_id:sameOwner.id,attempt:1});
  assert.equal(newAttempt.reply_jobs.find((job: any)=>job.id===sameOwner.id).attempt,2);
  const changed = await worker.ok("PATCH",`/v1/ot/messages/${quote.id}`,{body:"Unapproved revision of quote"});
  assert.equal(changed.revision,2);
  assert.deepEqual(await sender.ok("POST",jobPath(sameOwner),{...sameOwnerClaim,attempt:2,claim_id:randomUUID()}),
    {ok:true,direct_text_only:true,direct_prompt:first.body});
  const history = (await sender.ok("GET",messages)).messages;
  assert.deepEqual(history.map((message: any)=>message.id),[unrelated.id,quote.id,ordinary.id,first.id,delivered.id]);
  assert.equal((await worker.ok("POST","/v1/ot/conversations",{kind:"dm",peer:sender.handle})).id,dm.id);
});

test("removing and re-attaching a DM grant fences queued and claimed jobs", async () => {
  const [sender, worker] = await Promise.all([home(service.base,"dm-grant-sender"),home(service.base,"dm-grant-worker")]);
  const contacts = "/v1/ot/contacts";
  const contact = await sender.ok("POST",contacts,{handle:worker.handle});
  await worker.ok("POST",`${contacts}/${contact.id}`,{action:"accept"});
  const dm = await sender.ok("POST","/v1/ot/conversations",{kind:"dm",peer:worker.handle});
  const room = `/v1/ot/conversations/${dm.id}`;
  const agent = `${room}/agents/worker`;
  const workerId = await profileId(worker);
  const request = (client_key: string) => ({direct:true,direct_agent_request:true,body:"Reply once",client_key,
    agent_mentions:[{owner_id:workerId,agent_id:"worker"}]});
  const msg = `${room}/messages`;
  const send = (key: string) => sender.ok("POST",msg,request(key));
  await worker.ok("PUT",agent,{name:"Worker"});
  const running = await send("dm-grant-0001"), queued = await send("dm-grant-0002");
  const runningJob = running.reply_jobs[0], queuedJob = queued.reply_jobs[0];
  const claim = {action:"start",attempt:1,source_revision:running.revision,claim_id:randomUUID(),accept_direct_text_turn:true};
  await worker.ok("POST",jobPath(runningJob),claim);
  await worker.ok("PUT",agent,{name:"Renamed"});
  assert.equal((await worker.ok("POST",jobPath(runningJob),claim)).direct_text_only,true);
  await sender.ok("DELETE",`${agent}?owner_id=${workerId}`);
  assert.deepEqual((await sender.ok("GET",room)).agents,[]);
  assert.equal((await sender.call("POST",msg,request("dm-grant-0003"))).data.error.code,"direct_agent_unavailable");
  await worker.ok("PUT",agent,{name:"Reattached"});
  assert.deepEqual((await worker.ok("GET",inbox)).jobs,[]);
  assert.deepEqual((await sender.ok("GET",`${room}/reply-progress`)).items,[]);
  assert.equal((await worker.call("POST",jobPath(queuedJob),{...claim,claim_id:randomUUID()})).status,409);
  assert.equal((await worker.call("POST",`${jobPath(runningJob)}/progress`,{attempt:1,revision:1,claim_id:claim.claim_id,text:"late"})).status,409);
  assert.equal((await worker.call("POST",`${room}/agent-messages`,{agent_ref:"worker",reply_to:running.id,body:"late",
    job_id:runningJob.id,attempt:1,claim_id:claim.claim_id})).status,409);
  assert.equal((await sender.call("POST",`${msg}/${running.id}/agent-retry`,{job_id:runningJob.id})).status,409);
  const receipt = await send("dm-grant-0001");
  assert.equal(receipt.id,running.id);
  assert.deepEqual(receipt.reply_jobs.map((job: any)=>[job.status,job.can_retry,job.error_code]),
    [["failed",false,"direct_agent_unavailable"]]);
  const current = await send("dm-grant-0003");
  assert.equal((await worker.ok("GET",inbox)).jobs[0].job_id,current.reply_jobs[0].id);
  await worker.ok("DELETE",agent);
  assert.deepEqual((await worker.ok("GET",inbox)).jobs,[]);
  await worker.ok("PUT",agent,{name:"Contact agent"});
  const contactOnly = await send("dm-grant-0004");
  await sender.ok("POST",`${contacts}/${contact.id}`,{action:"remove"});
  assert.deepEqual((await worker.ok("GET",inbox)).jobs,[]);
  assert.equal((await worker.call("POST",jobPath(contactOnly.reply_jobs[0]),{...claim,claim_id:randomUUID()})).status,409);
});

test("losing the last contact or team relationship closes DM grants without hiding human history", async () => {
  const [owner, peer] = await Promise.all([home(service.base,"dm-reach-owner"),home(service.base,"dm-reach-peer")]);
  const contacts = "/v1/ot/contacts";
  const contact = await owner.ok("POST",contacts,{handle:peer.handle});
  await peer.ok("POST",`${contacts}/${contact.id}`,{action:"accept"});
  const team = await owner.ok("POST","/v1/ot/teams",{name:"Shared DM reach"});
  const invite = await owner.ok("POST",`/v1/ot/teams/${team.id}/invites`,{});
  await peer.ok("POST","/v1/ot/invites/accept",{code:invite.code});
  const dm = await owner.ok("POST","/v1/ot/conversations",{kind:"dm",peer:peer.handle});
  const room = `/v1/ot/conversations/${dm.id}`;
  const agent = `${room}/agents/worker`;
  await owner.ok("PUT",agent,{name:"Worker"});
  const payload = {direct:true,direct_agent_request:true,body:"Shared team request",client_key:"dm-reach-test-0001",
    agent_mentions:[{owner_id:await profileId(owner),agent_id:"worker"}]};
  const source = await peer.ok("POST",`${room}/messages`,payload);
  const job = source.reply_jobs[0];
  await peer.ok("POST",`${contacts}/${contact.id}`,{action:"remove"});
  assert.equal((await peer.ok("GET",room)).direct_agent_requests,true,"shared active team still permits messaging");
  assert.equal((await owner.ok("GET",inbox)).jobs[0].job_id,job.id);
  const member = `/v1/ot/teams/${team.id}/members/${peer.handle}`;
  await owner.ok("PATCH",member,{suspended:true});
  const closed = await peer.ok("GET",room);
  assert.equal(closed.direct.open,false);
  assert.equal(closed.direct_agent_requests,undefined);
  assert.deepEqual(closed.agents,[]);
  assert.deepEqual((await owner.ok("GET",inbox)).jobs,[]);
  assert.equal((await peer.call("POST",`${room}/messages`,payload)).data.error.code,"not_reachable");
  assert.equal((await owner.call("PUT",agent,{name:"Worker"})).status,403);
  assert.equal((await peer.ok("GET",`${room}/messages`)).messages[0].id,source.id);
  await owner.ok("PATCH",member,{suspended:false});
  const open = await peer.ok("GET",room);
  assert.equal(open.direct_agent_requests,true);
  assert.deepEqual(open.agents,[]);
  await owner.ok("PUT",agent,{name:"Worker"});
  assert.equal((await peer.call("POST",`${room}/messages/${source.id}/agent-retry`,{job_id:job.id})).status,409);
  assert.deepEqual((await owner.ok("GET",inbox)).jobs,[]);
});

test("DM agent operations through a team workspace require the peer in that exact team", async () => {
  const [owner, peer] = await Promise.all([home(service.base,"dm-scope-owner"),home(service.base,"dm-scope-peer")]);
  const workspace = (actor: typeof owner, name: string) => actor.ok("POST","/v1/ot/workspaces",{
    name,idempotency_key:"dm-scoping-workspace-"+name,
  });
  const [shared, ownerOnly, peerOnly] = await Promise.all([
    workspace(owner,"shared"),workspace(owner,"owner"),workspace(peer,"peer"),
  ]);
  const {code} = await owner.ok("POST",`/v1/ot/teams/${shared.id}/invites`,{});
  await peer.ok("POST","/v1/ot/invites/accept",{code});
  const dm = await peer.ok("POST","/v1/ot/conversations",{kind:"dm",peer:owner.handle});
  const room = `/v1/ot/conversations/${dm.id}`;
  const owned = `${room}/agents/helper`;
  const ownerId = await profileId(owner);

  assert.equal((await owner.call("PUT",owned,{name:"Helper",workspace:ownerOnly.workspace_id})).status,404);
  await owner.ok("PUT",owned,{name:"Helper",workspace:shared.workspace_id});
  const send = (scope: string) => peer.call("POST",room+"/messages",{
    direct:true,direct_agent_request:true,body:"A shared request",agent_mentions:[{owner_id:ownerId,agent_id:"helper"}],
    client_key:"dm-scoping-request",workspace:scope,
  });
  assert.equal((await send(peerOnly.workspace_id)).status,404);
  const source = await send(shared.workspace_id);
  assert.equal(source.status,201);
  assert.equal((await send(peerOnly.workspace_id)).status,404,"even an exact replay requires workspace access");
  const job = source.data.reply_jobs[0];
  const claim = {action:"start",attempt:1,source_revision:source.data.revision,claim_id:randomUUID(),accept_direct_text_turn:true};
  await owner.ok("POST",jobPath(job),claim);
  await owner.ok("POST",jobPath(job),{...claim,action:"fail"});
  const retry = `${room}/messages/${source.data.id}/agent-retry`;
  assert.equal((await peer.call("POST",retry,{job_id:job.id,workspace:peerOnly.workspace_id})).status,404);
  assert.equal((await peer.ok("POST",retry,{job_id:job.id,workspace:shared.workspace_id})).reply_jobs[0].attempt,2);
  const detach = (scope: string) => peer.call("DELETE",`${owned}?owner_id=${ownerId}&workspace=${scope}`);
  assert.equal((await detach(peerOnly.workspace_id)).status,404);
  assert.equal((await peer.ok("GET",room)).agents.length,1);
  assert.equal((await detach(shared.workspace_id)).status,200);
  assert.deepEqual((await peer.ok("GET",room)).agents,[]);
});
