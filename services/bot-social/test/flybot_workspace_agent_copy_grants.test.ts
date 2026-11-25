import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { bulkAuth, startServer } from "./helpers.js";
import { home } from "./flybot_workspace_helpers.js";

let service: Awaited<ReturnType<typeof startServer>>;
before(async () => { service = await startServer(bulkAuth); });
after(async () => { await service.stop(); });

const root = "/v1/ot/agent-copy-grants";
const contacts = "/v1/ot/contacts";
const source = "a".repeat(32), otherSource = "b".repeat(32);
const ownerId = async (actor: Awaited<ReturnType<typeof home>>) => (await actor.ok("GET","/v1/ot/me")).owner_id;

test("private agent grants expose only the exact exported snapshot to the recipient and survive sender retries", async () => {
  const [sender,recipient,outsider] = await Promise.all([
    home(service.base,"agent-grant-owner"), home(service.base,"agent-grant-recipient"), home(service.base,"agent-grant-outsider"),
  ]);
  const senderId = await ownerId(sender), recipientId = await ownerId(recipient), outsiderId = await ownerId(outsider);
  const contact = await sender.ok("POST",contacts,{handle:recipient.handle});
  const basic = {source_agent_id:source,recipient_owner_id:recipientId,client_key:"recipient-grant-0001",
    template:{name:"Review partner",summary:"Only for this coworker",category:"research"}};
  assert.deepEqual(await sender.ok("GET",root+"/recipients"),{items:[],next_cursor:null});
  assert.equal((await sender.call("POST",root,basic)).data.error.code,"agent_copy_recipient_unavailable");
  await recipient.ok("POST",contacts+"/"+contact.id,{action:"accept"});
  const choices = await sender.ok("GET",root+"/recipients");
  assert.deepEqual(choices.items.map((item: any)=>[item.owner_id,item.handle]),[[recipientId,recipient.handle]]);
  assert.equal((await sender.call("POST",root,{...basic,recipient_owner_id:outsiderId})).data.error.code,"agent_copy_recipient_unavailable");
  assert.equal((await sender.call("POST",root,{...basic,recipient_owner_id:senderId})).status,400);
  assert.equal((await sender.call("POST",root,{...basic,template:{...basic.template,instructions:"Implicit data"}})).status,400);
  assert.equal((await sender.call("POST",root,{...basic,template:{...basic.template,quick_starts:["Implicit starter"]}})).status,400);
  for (const field of ["memory","connector_keys","tools","native_bot_id","bot_key"]) {
    assert.equal((await sender.call("POST",root,{...basic,template:{...basic.template,[field]:"private"}})).status,400);
  }
  const explicit = {...basic,share_instructions:true,share_quick_starts:true,
    template:{...basic.template,instructions:"Approved instructions\nSecond line",quick_starts:["  Approved opening  ","Check this"]}};
  const copies = await Promise.all([sender.call("POST",root,explicit),sender.call("POST",root,explicit)]);
  assert.deepEqual(copies.map(result=>result.status).sort(),[200,201]);
  const grant = copies[0].data.grant;
  assert.equal(copies[1].data.grant.id,grant.id);
  assert.match(grant.id,/^otag_[A-Z0-9]{26}$/);
  assert.equal(grant.source_agent_id,source);
  assert.equal(grant.sender.owner_id,senderId);
  assert.equal(grant.recipient.owner_id,recipientId);
  assert.equal(grant.includes_instructions,true);
  assert.equal(grant.quick_start_count,2);
  assert.equal(grant.state,"active");
  assert.equal((await sender.call("POST",root,{...explicit,template:{...explicit.template,quick_starts:["Changed"]}})).data.error.code,
    "agent_copy_request_conflict");
  const path = root+"/"+grant.id;
  for (const actor of [sender,outsider]) {
    assert.equal((await actor.call("GET",path)).status,404);
    assert.equal((await actor.call("POST",path+"/claim",{revision:"0".repeat(64)})).status,404);
  }
  assert.equal((await outsider.call("DELETE",path)).status,404);
  assert.equal((await recipient.call("DELETE",path)).status,404);
  assert.equal((await sender.call("DELETE",path+"?source_agent_id="+otherSource)).status,404);
  const preview = await recipient.ok("GET",path);
  const revision = preview.template.revision;
  assert.match(revision,/^[a-f0-9]{64}$/);
  assert.deepEqual(preview.template,{...explicit.template,quick_starts:["Approved opening","Check this"],revision});
  assert.equal("source_agent_id" in preview.grant,false);
  assert.equal((await recipient.call("POST",path+"/claim",{revision,template:{name:"Injected"}})).status,400);
  assert.equal((await recipient.call("POST",path+"/claim",{revision:"0".repeat(64)})).data.error.code,"agent_copy_version_changed");
  assert.deepEqual(await recipient.ok("POST",path+"/claim",{revision}),preview);
  assert.deepEqual(await recipient.ok("POST",path+"/claim",{revision}),preview);
  const anonymous = await fetch(service.base+path);
  assert.equal(anonymous.status,401);
  assert.equal(anonymous.headers.get("cache-control"),"private, no-store");

  for (const result of [grant, await sender.ok("GET",root+"?direction=sent"), await recipient.ok("GET",root+"?direction=received")]) {
    assert.doesNotMatch(JSON.stringify(result), /Approved opening|Approved instructions|Only for this coworker|snapshot/);
  }
  assert.deepEqual(await outsider.ok("GET",root+"?direction=received"),{items:[],next_cursor:null});
  assert.deepEqual((await recipient.ok("GET","/v1/ot/discover?kind=agent")).items,[]);
  assert.deepEqual((await recipient.ok("GET","/v1/ot/agent-inbox?managed=1")).jobs,[]);

  const second = await sender.ok("POST",root,{...basic,client_key:"recipient-grant-0002"});
  const hiddenFromSource = await sender.ok("POST",root,{...basic,source_agent_id:otherSource,client_key:"recipient-grant-0003"});
  const sent = root+"?direction=sent&limit=1&source_agent_id="+source;
  const firstPage = await sender.ok("GET",sent);
  assert.deepEqual(firstPage.items.map((item: any)=>item.id),[second.grant.id]);
  assert.equal(firstPage.next_cursor,second.grant.id);
  const secondPage = await sender.ok("GET",sent+"&after="+firstPage.next_cursor);
  assert.deepEqual(secondPage.items.map((item: any)=>item.id),[grant.id]);
  assert.equal(secondPage.next_cursor,null);
  assert.deepEqual(await sender.ok("GET",sent+"&after="+hiddenFromSource.grant.id),{items:[],next_cursor:null});
  assert.equal((await recipient.call("GET",root+"?direction=received&source_agent_id="+source)).status,400);
  const basicPreview = await recipient.ok("GET",root+"/"+second.grant.id);
  assert.equal(basicPreview.template.instructions,"");
  assert.deepEqual(basicPreview.template.quick_starts,[]);
  assert.notEqual(basicPreview.template.revision,revision);

  const revoked = await sender.ok("DELETE",path+"?source_agent_id="+source);
  assert.equal(revoked.grant.state,"revoked");
  assert.ok(Number.isSafeInteger(revoked.grant.revoked_at));
  assert.deepEqual(await sender.ok("DELETE",path),revoked);
  assert.deepEqual((await sender.call("POST",root,explicit)).data,revoked);
  assert.equal((await recipient.call("GET",path)).data.error.code,"agent_copy_revoked");
  assert.equal((await recipient.call("POST",path+"/claim",{revision})).data.error.code,"agent_copy_revoked");
  assert.equal((await recipient.call("POST",path+"/claim",{revision:"0".repeat(64)})).data.error.code,"agent_copy_revoked");
  assert.equal((await outsider.call("GET",path)).status,404);
  assert.equal((await recipient.ok("GET",root+"?direction=received")).items.find((row: any)=>row.id===grant.id).state,"revoked");
  assert.deepEqual(service.platform.db.prepare("SELECT snapshot FROM ot_agent_copy_grants WHERE id=?").get(grant.id),{snapshot:null});
});

test("losing the last active relationship closes grants even if the pair later reconnects", async () => {
  const [sender,recipient,nextPeer] = await Promise.all([
    home(service.base,"agent-grant-team-owner"),home(service.base,"agent-grant-team-peer"),home(service.base,"agent-grant-second-peer"),
  ]);
  const recipientId = await ownerId(recipient), nextId = await ownerId(nextPeer);
  const team = await sender.ok("POST","/v1/ot/teams",{name:"Private agent sharing"});
  const invite = await sender.ok("POST",`/v1/ot/teams/${team.id}/invites`,{max_uses:2});
  await recipient.ok("POST","/v1/ot/invites/accept",{code:invite.code});
  await nextPeer.ok("POST","/v1/ot/invites/accept",{code:invite.code});
  const directory = await sender.ok("GET",root+"/recipients?limit=1");
  const following = await sender.ok("GET",root+"/recipients?limit=1&after="+directory.next_cursor);
  assert.deepEqual([directory.items[0].owner_id,following.items[0].owner_id].sort(),[recipientId,nextId].sort());
  assert.equal(following.next_cursor,null);
  const share = {source_agent_id:source,recipient_owner_id:recipientId,client_key:"recipient-team-0001",
    template:{name:"Team review",category:null}};
  const first = (await sender.ok("POST",root,share)).grant;
  const path = root+"/"+first.id;
  const preview = await recipient.ok("GET",path);
  const contact = await sender.ok("POST",contacts,{handle:recipient.handle});
  await recipient.ok("POST",contacts+"/"+contact.id,{action:"accept"});
  const member = `/v1/ot/teams/${team.id}/members/${recipient.handle}`;
  await sender.ok("PATCH",member,{suspended:true});
  assert.deepEqual(await recipient.ok("POST",path+"/claim",{revision:preview.template.revision}),preview);
  await sender.ok("POST",contacts+"/"+contact.id,{action:"remove"});
  assert.equal((await recipient.call("POST",path+"/claim",{revision:preview.template.revision})).data.error.code,"agent_copy_closed");
  assert.equal((await recipient.ok("GET",root+"?direction=received")).items[0].state,"closed");
  assert.deepEqual((await sender.ok("GET",root+"/recipients")).items.map((row: any)=>row.owner_id),[nextId]);
  assert.equal((await sender.call("POST",root,{...share,client_key:"recipient-team-0002"})).data.error.code,"agent_copy_recipient_unavailable");
  await sender.ok("PATCH",member,{suspended:false});
  assert.equal((await recipient.call("GET",path)).data.error.code,"agent_copy_closed");
  const open = (await sender.ok("POST",root,{...share,client_key:"recipient-team-0002"})).grant;
  assert.equal(open.state,"active");
  assert.notEqual(open.id,first.id);
  assert.equal((await sender.ok("POST",root,share)).grant.state,"closed");
  await sender.ok("PATCH",member,{suspended:true});
  assert.equal((await recipient.call("GET",root+"/"+open.id)).data.error.code,"agent_copy_closed");
  await sender.ok("DELETE",path);
  assert.equal((await recipient.call("GET",path)).data.error.code,"agent_copy_revoked");
});
