import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { bulkAuth, startServer } from "./helpers.js";
import { home } from "./flybot_workspace_helpers.js";

type Actor = Awaited<ReturnType<typeof home>>;
let service: Awaited<ReturnType<typeof startServer>>;
before(async () => { service = await startServer(bulkAuth); });
after(async () => { await service.stop(); });
const queue = "/v1/ot/agent-inbox?managed=1";
const targets = (message: any) => message.reply_jobs.map((job: any) => [job.agent_owner_id, job.agent_id]);
const pair = (owner_id: string, agent_id: string) => ({owner_id,agent_id});
const idOf = async (actor: Actor) => (await actor.ok("GET", "/v1/ot/me")).owner_id;

test("named group reply policy is owner-only and revisioned, with authoritative exact lead and audience overrides", async () => {
  const [owner, teammate, outsider] = await Promise.all([
    home(service.base, "policy-owner"), home(service.base, "policy-teammate"), home(service.base, "policy-outside"),
  ]);
  const ownerId = await idOf(owner), teammateId = await idOf(teammate);
  const team = await owner.ok("POST", "/v1/ot/teams", {name: "Group reply settings"});
  const {code} = await owner.ok("POST", `/v1/ot/teams/${team.id}/invites`, {});
  await teammate.ok("POST", "/v1/ot/invites/accept", {code});
  await owner.ok("PATCH", `/v1/ot/teams/${team.id}/members/${teammate.handle}`, {role:"admin"});
  const {workspaces} = await owner.ok("GET", "/v1/ot/workspaces");
  const workspace = workspaces.find((row: any) => row.id === team.id).workspace_id;
  const group = await owner.ok("POST", "/v1/ot/conversations", {
    kind:"group", title:"Policy scope", team_id:team.id, members:[teammate.handle],
    agents:[{agent_ref:"shared",name:"Owner helper"},{agent_ref:"auto",name:"Auto observer"}],
  });
  const room = "/v1/ot/conversations/" + group.id;
  const change = (actor: Actor, body: object) => actor.call("POST", room + "/management", {workspace,action:"reply_policy",...body});
  const send = (actor: Actor, body: string, extra = {}) => actor.ok("POST", room + "/messages", {body,...extra});
  await owner.ok("PATCH", room + "/agents/auto", {auto_reply:true});
  await teammate.ok("PUT", room + "/agents/shared", {name:"Teammate helper"});
  await teammate.ok("PUT", room + "/agents/other:helper", {name:"Second teammate helper"});
  const selected = pair(teammateId, "shared");
  assert.deepEqual(group.group_agent_routing, {mode:"shared",policy:{mode:"lead",lead:pair(ownerId,"shared")},
    can_edit:true,native_group_host:ownerId,native_group_coordinator:true});
  const initial = await owner.ok("GET", room);
  const revision = initial.group_management.revision;
  const chooseLead = {revision,mode:"lead",lead:selected};
  assert.equal((await change(teammate, chooseLead)).status, 403, "team administrator cannot edit another owner's group policy");
  assert.equal((await change(outsider, chooseLead)).status, 404);
  assert.equal((await change(owner, {...chooseLead, workspace:"f".repeat(32)})).status, 404);
  assert.equal((await change(owner, {...chooseLead, lead:pair(ownerId,"other:helper")})).data.error.code, "group_reply_lead_unavailable");
  assert.equal((await change(owner, {revision,mode:"default",lead:selected})).status, 400);
  assert.equal((await change(owner, {revision,mode:"lead"})).status, 400);

  const saved = (await change(owner, chooseLead)).data.conversation;
  assert.equal(saved.group_management.revision,revision + 1);
  assert.notEqual(saved.activity_version, initial.activity_version);
  assert.deepEqual(saved.group_agent_routing.policy, {mode:"lead",lead:selected});
  assert.deepEqual((await teammate.ok("GET", room)).group_agent_routing,
    {mode:"shared",policy:{mode:"lead",lead:selected},can_edit:false,native_group_host:ownerId});
  assert.equal((await change(owner, {...chooseLead,lead:{agent_id:"shared",owner_id:teammateId}})).data.conversation.group_management.revision, revision + 1);
  assert.equal((await change(owner, {revision,mode:"everyone"})).data.error.code, "group_management_conflict");
  const noOp = await change(owner, {...chooseLead,revision:revision + 1});
  assert.equal(noOp.data.conversation.group_management.revision,revision + 1);

  const ordinary = await send(owner,"请整理今天的进展");
  assert.deepEqual(targets(ordinary),[[teammateId,"shared"]]);
  assert.equal((await owner.ok("GET",queue)).items.some((item: any) => item.message.id === ordinary.id),false);
  const leadJob = ordinary.reply_jobs[0];
  const claim_id = randomUUID();
  const claimLead = {
    action:"start",attempt:1,source_revision:ordinary.revision,claim_id,accept_group_text_turn:true,
  };
  assert.equal((await teammate.call("POST","/v1/ot/agent-reply-jobs/"+leadJob.id,claimLead)).status,409);
  assert.deepEqual(await teammate.ok("POST","/v1/ot/agent-reply-jobs/"+leadJob.id,{
    ...claimLead,accept_discretionary_reply:true,
  }),{ok:true,group_text_only:true,discretionary:true,prior_replies:[]});
  const reply = await teammate.ok("POST",room+"/agent-messages",{
    agent_ref:"shared",body:"当前进展已核对",mode:"mention",reply_to:ordinary.id,job_id:leadJob.id,attempt:1,claim_id,
  });
  const explicit = await send(owner,"@Owner helper 请再检查", {agent_mentions:[pair(ownerId,"shared")]});
  assert.deepEqual(targets(explicit),[[ownerId,"shared"]]);
  const all = await send(owner,"@all 请大家提供意见");
  assert.deepEqual(new Set(targets(all).map(([owner,agent]:string[])=>owner+"/"+agent)),
    new Set([ownerId+"/shared",ownerId+"/auto",teammateId+"/shared",teammateId+"/other:helper"]));

  const everyone = (await change(owner, {revision:revision + 1,mode:"everyone"})).data.conversation;
  assert.deepEqual(everyone.group_agent_routing.policy,{mode:"everyone"});
  const everyoneMessage = await send(owner,"这是今天的发布计划");
  assert.equal(targets(everyoneMessage).length,4);
  for (const actor of [owner, teammate]) {
    const jobs = (await actor.ok("GET", queue)).jobs.filter((job: any) => job.message.id === everyoneMessage.id);
    assert.equal(jobs.length, 2);
    assert.ok(jobs.every((job: any) => job.discretionary));
  }
  assert.deepEqual(targets(await send(owner,"再解释一项", {reply_to:reply.id})),[[teammateId,"shared"]]);
  const mentions = {revision:everyone.group_management.revision,mode:"mentions"};
  assert.equal((await change(teammate, mentions)).status,403);
  assert.equal((await change(owner, {...mentions,lead:selected})).status,400);
  const quiet = (await change(owner,mentions)).data.conversation;
  assert.deepEqual((await teammate.ok("GET",room)).group_agent_routing.policy,{mode:"mentions"});
  const plain = await send(owner,"请看看这条没有提及的消息");
  const quoteWithoutMention = await send(owner,"再解释一项", {reply_to:reply.id});
  assert.deepEqual(targets(plain),[]);
  assert.deepEqual(targets(quoteWithoutMention),[]);
  assert.ok(!(await owner.ok("GET",queue)).items.some((item: any) => [plain.id,quoteWithoutMention.id].includes(item.message.id)));
  assert.equal((await owner.call("POST",room+"/agent-messages",{
    agent_ref:"auto",body:"旧自动回复流程也不能回复",mode:"auto",reply_to:plain.id,
  })).data.error.code,"reply_job_unavailable");
  assert.deepEqual(targets(await send(owner,"@Teammate helper 请确认", {reply_to:reply.id})),[[teammateId,"shared"]]);
  assert.equal(targets(await send(teammate,"@所有人 请确认")).length,4);
  const last = (await change(owner,{revision:quiet.group_management.revision,mode:"lead",lead:selected})).data.conversation;
  assert.deepEqual(last.group_agent_routing.policy,{mode:"lead",lead:selected});

  await owner.ok("PATCH", `/v1/ot/teams/${team.id}/members/${teammate.handle}`, {suspended:true});
  const stale = await owner.ok("GET",room);
  assert.deepEqual(stale.group_agent_routing.policy,{mode:"lead",lead:selected,lead_unavailable:true});
  const fallback = await send(owner,"今天再帮我检查发布记录");
  assert.deepEqual(new Set(targets(fallback).map(([id,agent]:string[])=>id+"/"+agent)),
    new Set([ownerId+"/shared",ownerId+"/auto"]));
  const fallbackJobs = (await owner.ok("GET",queue)).jobs.filter((job: any) => job.message.id === fallback.id);
  assert.equal(fallbackJobs.length,2);
  assert.ok(fallbackJobs.every((job: any) => job.discretionary));
  const quotedUnavailable = await send(owner,"同一个问题", {reply_to:reply.id});
  assert.deepEqual(targets(quotedUnavailable),[]);
  assert.equal((await owner.call("POST", room+"/agent-messages",{
    agent_ref:"auto",body:"Unselected legacy reply",mode:"auto",reply_to:quotedUnavailable.id,
  })).data.error.code,"reply_job_unavailable");
  const explicitAvailable = await send(owner,"请回答", {agent_mentions:[pair(ownerId,"shared")]});
  assert.deepEqual(targets(explicitAvailable),[[ownerId,"shared"]]);
  const reset = (await change(owner,{revision:stale.group_management.revision,mode:"default"})).data.conversation;
  assert.deepEqual(reset.group_agent_routing.policy,{mode:"default"});
  const autoOptIn = await send(owner,"默认策略的普通消息");
  const inbox = await owner.ok("GET",queue);
  assert.ok(inbox.items.some((item: any) => item.message.id === autoOptIn.id && item.agent_ref === "auto"));
  assert.ok(!inbox.items.some((item: any) => item.message.id === quotedUnavailable.id));
  assert.ok(!inbox.items.some((item: any) => item.message.id === plain.id));
});

test("the personal group retains unavailable-lead metadata with an empty roster and transfers edit authority with ownership", async () => {
  const [owner, teammate] = await Promise.all([home(service.base,"policy-personal-owner"),home(service.base,"policy-personal-peer")]);
  const ownerId = await idOf(owner), teammateId = await idOf(teammate);
  const contact = await owner.ok("POST","/v1/ot/contacts",{handle:teammate.handle});
  await teammate.ok("POST",`/v1/ot/contacts/${contact.id}`,{action:"accept"});
  const group = await owner.ok("POST","/v1/ot/conversations", {
    kind:"group",account_group:true,title:"Private policy",members:[teammate.handle],agents:[{agent_ref:"first",name:"First"}],
  });
  const room = "/v1/ot/conversations/" + group.id;
  const notOwned = await teammate.call("POST",room+"/management",{
    action:"reply_policy",mode:"everyone",revision:group.group_management.revision,direct:true,
  });
  assert.equal(notOwned.status,403);
  const lead = pair(ownerId,"first");
  const picked = (await owner.ok("POST",room+"/management",{
    action:"reply_policy",mode:"lead",lead,revision:group.group_management.revision,direct:true,
  })).conversation;
  await owner.ok("DELETE",room+"/agents/first");
  const empty = await owner.ok("GET",room);
  assert.deepEqual(empty.agents,[]);
  assert.deepEqual(empty.group_agent_routing.policy,{mode:"lead",lead,lead_unavailable:true});
  const moved = (await owner.ok("POST",room+"/management",{
    action:"transfer",member_id:teammateId,revision:picked.group_management.revision,direct:true,
  })).conversation;
  assert.equal(moved.group_agent_routing.can_edit,false);
  assert.equal((await teammate.ok("GET",room)).group_agent_routing.can_edit,true);
  await teammate.ok("PUT",room+"/agents/replacement",{name:"Replacement"});
  const fallback = await owner.ok("POST",room+"/messages",{body:"请现在可用的智能体看看"});
  assert.deepEqual(targets(fallback),[[teammateId,"replacement"]]);
  const queued = (await teammate.ok("GET",queue)).jobs.find((job: any) => job.message.id === fallback.id);
  assert.ok(queued?.discretionary);
  const updated = (await teammate.ok("POST",room+"/management",{
    action:"reply_policy",mode:"lead",lead:pair(teammateId,"replacement"),revision:moved.group_management.revision,direct:true,
  })).conversation;
  assert.deepEqual(updated.group_agent_routing.policy,{mode:"lead",lead:pair(teammateId,"replacement")});
  assert.deepEqual(targets(await owner.ok("POST",room+"/messages",{body:"新主答可以回复"})),[[teammateId,"replacement"]]);
});

test("native group routing ignores old automatic Chief bindings and keeps deliberate members and leads", async () => {
  const [owner, peer] = await Promise.all([home(service.base,"native-admin-owner"),home(service.base,"native-admin-peer")]);
  const ownerId = await idOf(owner), peerId = await idOf(peer);
  const chief = "a".repeat(32), helper = "implementation-helper";
  const create = (title: string, members: string[]) => owner.ok("POST","/v1/ot/conversations",{
    kind:"group",account_group:true,title,members,agents:[{agent_ref:helper,name:"实施助手"}],
  });
  const group = await create("Personal group without a Chief", []);
  const room = "/v1/ot/conversations/" + group.id;
  const send = (actor: Actor, body: string, extra = {}) => actor.ok("POST", room + "/messages", {body,...extra});
  assert.equal((await owner.call("PUT",room+"/native-chief",{agent_id:chief,name:"个人智能体"})).status,404);
  assert.deepEqual((await owner.ok("GET",room)).agents.map((agent: any) => agent.agent_ref),[helper]);
  assert.deepEqual(targets(await send(owner,"请主持下一步")),[[ownerId,helper]]);

  await owner.ok("PUT",room+"/agents/"+chief,{name:"个人智能体"});
  // Simulate a database upgraded from the release that inferred a group Chief.
  service.platform.db.prepare("UPDATE ot_conversations SET group_auto_lead=0,group_reply_policy=NULL WHERE id=?").run(group.id);
  service.platform.db.exec(`CREATE TABLE IF NOT EXISTS ot_group_native_chiefs (
    conversation_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, agent_ref TEXT NOT NULL)`);
  service.platform.db.prepare("INSERT INTO ot_group_native_chiefs VALUES (?,?,?)").run(group.id,ownerId,chief);

  const opened = await owner.ok("GET",room);
  assert.equal(opened.group_agent_routing.native_chief,undefined);
  assert.deepEqual(opened.agents.map((agent: any) => agent.agent_ref),[helper,chief]);
  assert.deepEqual(targets(await send(owner,"请核对下一步")),[[ownerId,helper],[ownerId,chief]]);
  assert.deepEqual(targets(await send(owner,"请专门确认",{agent_mentions:[pair(ownerId,helper)]})),[[ownerId,helper]]);
  assert.deepEqual(targets(await send(owner,"@所有人 请看看")),[[ownerId,helper],[ownerId,chief]]);
  const custom = (await owner.ok("POST",room+"/management",{action:"reply_policy",mode:"lead",lead:pair(ownerId,chief),
    revision:opened.group_management.revision,direct:true})).conversation;
  assert.deepEqual(custom.group_agent_routing.policy,{mode:"lead",lead:pair(ownerId,chief)});
  assert.deepEqual(targets(await send(owner,"请确认负责下一步")),[[ownerId,chief]]);
  assert.deepEqual(targets(await send(owner,"@all 请一起核对")),[[ownerId,chief],[ownerId,helper]]);
  await owner.ok("POST",room+"/management",{action:"reply_policy",mode:"everyone",
    revision:custom.group_management.revision,direct:true});
  assert.deepEqual(targets(await send(owner,"请依次核对")),[[ownerId,helper],[ownerId,chief]]);

  const contact = await owner.ok("POST","/v1/ot/contacts",{handle:peer.handle});
  await peer.ok("POST",`/v1/ot/contacts/${contact.id}`,{action:"accept"});
  const shared = await create("Shared group with an automatic lead", [peer.handle]);
  const sharedPath = "/v1/ot/conversations/" + shared.id;
  await peer.ok("PUT",sharedPath+"/agents/peer",{name:"伙伴助手"});
  assert.deepEqual(targets(await peer.ok("POST",sharedPath+"/messages",{body:"普通群消息"})),
    [[ownerId,helper]]);
  assert.deepEqual(targets(await peer.ok("POST",sharedPath+"/messages",{body:"请确认",
    agent_mentions:[pair(peerId,"peer")]})), [[peerId,"peer"]]);
});

test("new team groups keep one owner-qualified automatic lead as different owners add eligible Bots", async () => {
  const [owner, peer] = await Promise.all([home(service.base,"automatic-lead-owner"),home(service.base,"automatic-lead-peer")]);
  const ownerId = await idOf(owner), peerId = await idOf(peer);
  const team = await owner.ok("POST","/v1/ot/teams",{name:"Automatic lead team"});
  const {code} = await owner.ok("POST",`/v1/ot/teams/${team.id}/invites`,{});
  await peer.ok("POST","/v1/ot/invites/accept",{code});
  const {workspaces} = await owner.ok("GET","/v1/ot/workspaces");
  const workspace = workspaces.find((row: any) => row.id === team.id).workspace_id;
  const create = (title: string, agents: {agent_ref:string;name:string}[] = [], idempotency_key?:string) =>
    owner.ok("POST","/v1/ot/conversations",{kind:"group",title,team_id:team.id,members:[peer.handle],agents,idempotency_key});
  const send = (id: string, body: string, extra = {}) =>
    owner.ok("POST",`/v1/ot/conversations/${id}/messages`,{body,...extra});
  const sharedRef = "z-same-ref";
  const original = [{agent_ref:sharedRef,name:"First selected"},{agent_ref:"a-backup",name:"Second selected"}];
  const key = randomUUID();
  const created = await create("Existing Bot seats",original,key);
  const room = "/v1/ot/conversations/" + created.id;
  const policy = {mode:"lead",lead:pair(ownerId,sharedRef)};
  assert.deepEqual(created.group_agent_routing.policy,policy);
  const replay = await create("Existing Bot seats",original.slice().reverse(),key);
  assert.equal(replay.id,created.id);
  assert.deepEqual(replay.group_agent_routing.policy,policy);
  await peer.ok("PUT",room+"/agents/"+sharedRef,{name:"Other owner's same reference"});
  assert.deepEqual((await peer.ok("GET",room)).group_agent_routing.policy,policy);
  assert.deepEqual(targets(await send(created.id,"Plain team message")),[[ownerId,sharedRef]]);
  assert.deepEqual(targets(await send(created.id,"Ask the peer specifically",{agent_mentions:[pair(peerId,sharedRef)]})),
    [[peerId,sharedRef]]);
  assert.equal(targets(await send(created.id,"@all Please review")).length,3);
  await owner.ok("DELETE",room+"/agents/"+sharedRef);
  assert.deepEqual((await peer.ok("GET",room)).group_agent_routing.policy,{mode:"lead",lead:pair(ownerId,"a-backup")});
  assert.deepEqual(targets(await send(created.id,"A single backup now replies")),[[ownerId,"a-backup"]]);
  await owner.ok("DELETE",room+"/agents/a-backup");
  assert.deepEqual((await owner.ok("GET",room)).group_agent_routing.policy,{mode:"lead",lead:pair(peerId,sharedRef)});
  assert.deepEqual(targets(await send(created.id,"The remaining peer now replies")),[[peerId,sharedRef]]);

  const empty = await create("First Bot joins later");
  const emptyRoom = "/v1/ot/conversations/" + empty.id;
  assert.deepEqual(empty.group_agent_routing.policy,{mode:"default"});
  await peer.ok("PUT",emptyRoom+"/agents/"+sharedRef,{name:"Peer added first"});
  const assigned = await owner.ok("GET",emptyRoom);
  assert.equal(assigned.group_management.revision,empty.group_management.revision + 1);
  assert.notEqual(assigned.activity_version,empty.activity_version);
  assert.deepEqual(assigned.group_agent_routing.policy,{mode:"lead",lead:pair(peerId,sharedRef)});
  await owner.ok("PUT",emptyRoom+"/agents/"+sharedRef,{name:"Owner added later"});
  await owner.ok("PUT",emptyRoom+"/agents/second",{name:"Owner's second Bot"});
  assert.deepEqual(targets(await send(empty.id,"The incumbent still replies")),[[peerId,sharedRef]]);

  for (const mode of ["default","everyone","mentions"]) {
    const manual = await create("Explicit policy " + mode);
    const url = "/v1/ot/conversations/" + manual.id;
    await owner.ok("POST",url+"/management",{workspace,revision:manual.group_management.revision,action:"reply_policy",mode});
    await peer.ok("PUT",url+"/agents/"+sharedRef,{name:"Peer's Bot"});
    await owner.ok("PUT",url+"/agents/"+sharedRef,{name:"Owner's Bot"});
    assert.deepEqual((await owner.ok("GET",url)).group_agent_routing.policy,{mode});
    assert.equal(targets(await send(manual.id,"Ordinary policy test")).length,mode==="mentions"?0:2);
  }
  await owner.ok("PATCH",`/v1/ot/teams/${team.id}/members/${peer.handle}`,{suspended:true});
  assert.deepEqual((await owner.ok("GET",emptyRoom)).group_agent_routing.policy,{mode:"lead",lead:pair(ownerId,sharedRef)});
  assert.deepEqual(targets(await send(empty.id,"Only one eligible owner Bot after suspension")),[[ownerId,sharedRef]]);
});
