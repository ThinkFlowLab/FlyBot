import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { bulkAuth, startServer } from "./helpers.js";
import { home } from "./flybot_workspace_helpers.js";

let service: Awaited<ReturnType<typeof startServer>>;
before(async () => { service = await startServer(bulkAuth); });
after(async () => { await service.stop(); });

const access = "/v1/ot/agent-access";
const conversations = "/v1/ot/conversations";
const inbox = "/v1/ot/agent-inbox?managed=1";
const ref = "a".repeat(32);
const getProfile = (actor: Awaited<ReturnType<typeof home>>) => actor.ok("GET","/v1/ot/me");

test("original-agent access reuses the human DM and only revokes the exact caller-owned seat", async () => {
  const [owner,peer,outsider] = await Promise.all([
    home(service.base,"agent-access-owner"),home(service.base,"agent-access-peer"),home(service.base,"agent-access-outsider"),
  ]);
  const [ownerProfile,peerProfile,outsiderProfile] = await Promise.all([getProfile(owner),getProfile(peer),getProfile(outsider)]);
  const ownerId = ownerProfile.owner_id, peerId = peerProfile.owner_id;
  const payload = {agent_id:ref,name:"Original Reviewer",recipient_owner_id:peerId};
  const contact = await owner.ok("POST","/v1/ot/contacts",{handle:peer.handle});
  assert.equal((await owner.call("POST",access,payload)).data.error.code,"agent_access_recipient_unavailable");
  assert.equal((await owner.call("POST",access,{...payload,recipient_owner_id:outsiderProfile.owner_id})).data.error.code,
    "agent_access_recipient_unavailable");
  assert.equal((await owner.call("POST",access,{...payload,recipient_owner_id:ownerId})).status,400);
  for (const field of ["instructions","skills","workspace","auto_reply"]) {
    assert.equal((await owner.call("POST",access,{...payload,[field]:"unapproved"})).status,400);
  }
  await peer.ok("POST","/v1/ot/contacts/"+contact.id,{action:"accept"});
  const existing = await peer.ok("POST",conversations,{kind:"dm",peer:owner.handle});
  const room = conversations+"/"+existing.id;
  const messages = room+"/messages";
  const history = await owner.ok("POST",messages,{direct:true,body:"Existing human conversation"});
  const remove = access+"/"+existing.id+"/"+ref;
  const first = await owner.call("POST",access,payload);
  assert.equal(first.status,201);
  assert.equal(first.data.created,true);
  const opened = first.data.access;
  assert.deepEqual(opened,{conversation_id:existing.id,owner_id:ownerId,agent_id:ref,created_at:opened.created_at,
    recipient:{owner_id:peerId,handle:peer.handle,display_name:peerProfile.display_name}});
  assert.equal((await peer.call("DELETE",remove)).data.error.code,"agent_access_not_found");
  assert.equal((await outsider.call("DELETE",remove)).status,404);
  assert.deepEqual((await owner.ok("GET",inbox)).jobs,[]);

  // Two owners can use the same native reference without sharing the grant or its jobs.
  await peer.ok("PUT",room+"/agents/"+ref,{name:"Peer Reviewer"});
  const list = access+"?agent_id="+ref;
  assert.deepEqual(await owner.ok("GET",list),{items:[opened],next_cursor:null});
  const peerList = (await peer.ok("GET",list)).items;
  assert.deepEqual(peerList.map((row: any)=>[row.owner_id,row.agent_id,row.recipient.owner_id]),[[peerId,ref,ownerId]]);
  assert.deepEqual(await outsider.ok("GET",list),{items:[],next_cursor:null});
  const group = await owner.ok("POST",conversations,{kind:"group",account_group:true,title:"Separate group",members:[peer.handle]});
  await owner.ok("PUT",`${conversations}/${group.id}/agents/${ref}`,{name:"Group reviewer"});
  assert.equal((await owner.call("DELETE",access+"/"+group.id+"/"+ref)).data.error.code,"agent_access_not_found");
  assert.deepEqual((await owner.ok("GET",list)).items,[opened]);
  const before = (await peer.ok("GET",room)).activity_version;
  const replay = await owner.call("POST",access,payload);
  assert.equal(replay.status,200);
  assert.deepEqual(replay.data,{created:false,access:opened});
  assert.equal((await peer.ok("GET",room)).activity_version,before);

  const send = (client_key: string) => peer.ok("POST",messages,{direct:true,direct_agent_request:true,
    body:"Request the original",client_key,agent_mentions:[{owner_id:ownerId,agent_id:ref}]});
  const source = await send("access-reply-00001"), waiting = await send("access-reply-00002");
  const job = source.reply_jobs[0].id, waitingJob = waiting.reply_jobs[0].id;
  const claimPath = "/v1/ot/agent-reply-jobs/"+job;
  const claim = {action:"start",attempt:1,claim_id:randomUUID(),source_revision:source.revision,accept_direct_text_turn:true};
  assert.equal((await owner.ok("POST",claimPath,claim)).direct_text_only,true);
  const renamed = await owner.ok("POST",access,{...payload,name:"Renamed Original Reviewer"});
  assert.deepEqual(renamed,{created:false,access:opened});
  assert.equal((await owner.ok("POST",claimPath,claim)).direct_text_only,true);
  assert.deepEqual((await owner.ok("GET",inbox)).jobs.map((row: any)=>row.job_id),[waitingJob]);

  assert.deepEqual(await owner.ok("DELETE",remove),{revoked:true});
  assert.equal((await owner.call("DELETE",remove)).data.error.code,"agent_access_not_found");
  assert.deepEqual((await owner.ok("GET",list)).items,[]);
  assert.deepEqual((await peer.ok("GET",list)).items,peerList);
  assert.deepEqual((await peer.ok("GET",room)).agents.map((row: any)=>row.owner.owner_id),[peerId]);
  assert.equal((await owner.call("POST",claimPath+"/progress",{attempt:1,revision:1,claim_id:claim.claim_id,text:"late"})).status,409);
  assert.equal((await owner.call("POST",room+"/agent-messages",{agent_ref:ref,reply_to:source.id,body:"late",job_id:job,
    attempt:1,claim_id:claim.claim_id})).status,409);
  assert.equal((await peer.call("POST",messages+"/"+source.id+"/agent-retry",{job_id:job})).status,409);

  const reopened = await owner.call("POST",access,payload);
  assert.equal(reopened.status,201);
  assert.equal(reopened.data.access.conversation_id,existing.id);
  assert.deepEqual((await owner.ok("GET",inbox)).jobs,[]);
  assert.equal((await owner.call("POST","/v1/ot/agent-reply-jobs/"+waitingJob,{...claim,claim_id:randomUUID()})).status,409);
  const timeline = (await peer.ok("GET",messages)).messages;
  assert.deepEqual(timeline.map((item: any)=>item.id),[history.id,source.id,waiting.id]);
  assert.deepEqual(timeline.slice(1).map((item: any)=>item.reply_jobs[0].error_code),["direct_agent_unavailable","direct_agent_unavailable"]);
  assert.equal((await owner.ok("GET",`${conversations}/${group.id}`)).agents[0].agent_ref,ref);
});

test("active team recipients get one canonical DM and disappear from own paged access after suspension", async () => {
  const [owner,one,two] = await Promise.all([
    home(service.base,"agent-access-team"),home(service.base,"agent-access-member-one"),home(service.base,"agent-access-member-two"),
  ]);
  const [oneProfile,twoProfile] = await Promise.all([getProfile(one),getProfile(two)]);
  const team = await owner.ok("POST","/v1/ot/teams",{name:"Original agent test team"});
  const share = await owner.ok("POST",`/v1/ot/teams/${team.id}/invites`,{max_uses:2});
  for (const actor of [one,two]) await actor.ok("POST","/v1/ot/invites/accept",{code:share.code});
  const request = (recipient_owner_id: string) => ({agent_id:ref,name:"Team Work",recipient_owner_id});
  const [a,b] = await Promise.all([owner.call("POST",access,request(oneProfile.owner_id)),owner.call("POST",access,request(oneProfile.owner_id))]);
  assert.deepEqual([a.status,b.status].sort(),[200,201]);
  assert.deepEqual(a.data.access,b.data.access);
  const firstDM = a.data.access.conversation_id;
  const sameDM = await one.ok("POST",conversations,{kind:"dm",peer:owner.handle});
  assert.equal(sameDM.id,firstDM);
  assert.equal(sameDM.direct_agent_requests,true);
  const second = await owner.ok("POST",access,request(twoProfile.owner_id));
  assert.notEqual(second.access.conversation_id,firstDM);
  const list = access+"?agent_id="+ref+"&limit=1";
  const page = await owner.ok("GET",list);
  assert.equal(page.items.length,1);
  assert.equal(page.next_cursor,page.items[0].conversation_id);
  const next = await owner.ok("GET",list+"&after="+page.next_cursor);
  assert.deepEqual([page.items[0].recipient.owner_id,next.items[0].recipient.owner_id].sort(),[oneProfile.owner_id,twoProfile.owner_id].sort());
  assert.equal(next.next_cursor,null);
  const membership = `/v1/ot/teams/${team.id}/members/${one.handle}`;
  await owner.ok("PATCH",membership,{suspended:true});
  assert.deepEqual((await owner.ok("GET",list)).items.map((row: any)=>row.conversation_id),[second.access.conversation_id]);
  assert.equal((await owner.call("POST",access,request(oneProfile.owner_id))).data.error.code,"agent_access_recipient_unavailable");
  assert.equal((await one.ok("GET",conversations+"/"+firstDM)).direct.open,false);
  await owner.ok("PATCH",membership,{suspended:false});
  assert.deepEqual((await one.ok("GET",conversations+"/"+firstDM)).agents,[]);
  assert.equal((await owner.ok("POST",access,request(oneProfile.owner_id))).access.conversation_id,firstDM);
  const denied = await fetch(service.base+list);
  assert.equal(denied.status,401);
  assert.equal(denied.headers.get("cache-control"),"private, no-store");
});
