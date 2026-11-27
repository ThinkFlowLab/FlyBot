import {after, before, test} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {setTimeout as delay} from "node:timers/promises";
import {bulkAuth, startServer} from "./helpers.js";
import {home} from "./flybot_workspace_helpers.js";

let service: Awaited<ReturnType<typeof startServer>>;
before(async () => { service = await startServer(bulkAuth); });
after(async () => { await service.stop(); });

const inbox = "/v1/ot/native-group-inbox";
const rooms = "/v1/ot/conversations";
const agents = [{agent_ref:"native-a",name:"Planner"},{agent_ref:"native-b",name:"Reviewer"}];

test("a solo native group queues one real round and mirrors its Bot handoffs exactly once", async () => {
  const owner = await home(service.base, "native-round-owner");
  const outsider = await home(service.base, "native-round-outsider");
  const {owner_id,display_name} = await owner.ok("GET", "/v1/ot/me");
  const author = {owner_id,display_name};
  const group = await owner.ok("POST", rooms, {kind:"group",account_group:true,title:"Native group",agents});
  const room = rooms + "/" + group.id;
  const message = {body:"Check the native discussion",native_round:true,client_key:randomUUID(),
    agent_mentions:[{owner_id,agent_id:agents[0].agent_ref}]};
  const first = await owner.ok("POST", room + "/messages", message);
  assert.deepEqual(first.reply_jobs, []);
  assert.equal(first.body, "@Planner " + message.body);
  assert.equal((await owner.ok("POST", room + "/messages", message)).id, first.id);
  const second = await owner.ok("POST", room + "/messages", {body:"Follow up",native_round:true,client_key:randomUUID()});
  const firstPath = room + "/native-rounds/" + first.id;
  const secondPath = room + "/native-rounds/" + second.id;
  assert.deepEqual((await owner.ok("GET", inbox)).items, [
    {conversation_id:group.id,message_id:first.id,body:message.body,agent_mentions:message.agent_mentions,state:"queued",seq:first.seq,author,text_only:false},
    {conversation_id:group.id,message_id:second.id,body:"Follow up",agent_mentions:[],state:"queued",seq:second.seq,author,text_only:false},
  ]);
  assert.deepEqual((await outsider.ok("GET", inbox)).items, []);
  assert.equal((await outsider.call("POST", firstPath, {action:"start"})).status, 404);
  assert.equal((await owner.call("POST", secondPath, {action:"start"})).status, 409);

  const firstLine = {agent_ref:agents[0].agent_ref,body:"@Reviewer Verify the plan",client_key:"native-room:10"};
  assert.equal((await owner.call("POST", firstPath + "/lines", firstLine)).status, 409);
  assert.deepEqual(await owner.ok("POST", firstPath, {action:"start"}), {state:"running",started:true});
  assert.deepEqual(await owner.ok("POST", firstPath, {action:"start"}), {state:"running",started:false});
  assert.equal((await owner.ok("GET", inbox)).items[0].state, "running");
  const called = await owner.ok("POST", firstPath + "/lines", firstLine);
  assert.equal((await owner.ok("POST", firstPath + "/lines", firstLine)).id, called.id);
  assert.equal((await owner.call("POST", firstPath + "/lines", {...firstLine,body:"Different"})).status, 409);
  assert.equal((await owner.call("POST", firstPath + "/lines", {...firstLine,agent_ref:"no-seat",client_key:"invalid"})).status, 404);
  const answer = await owner.ok("POST", firstPath + "/lines", {agent_ref:agents[1].agent_ref,body:"Verified",client_key:"native-room:11"});
  assert.deepEqual([called.author.name,answer.author.name], ["Planner","Reviewer"]);
  assert.deepEqual(called.reply_jobs, []);
  assert.deepEqual(answer.reply_jobs, []);
  const legacyInbox = await owner.ok("GET", "/v1/ot/agent-inbox?managed=1");
  assert.deepEqual(legacyInbox.jobs, []);
  assert.deepEqual(legacyInbox.items, []);
  assert.deepEqual(await owner.ok("POST", firstPath, {action:"finish"}), {state:"finished"});
  assert.deepEqual(await owner.ok("POST", firstPath, {action:"finish"}), {state:"finished"});
  assert.equal((await owner.ok("POST", firstPath + "/lines", firstLine)).id, called.id);
  assert.equal((await owner.call("POST", firstPath + "/lines", {...firstLine,client_key:"late"})).status, 409);
  assert.deepEqual((await owner.ok("GET", inbox)).items.map((row: {message_id:string}) => row.message_id), [second.id]);
  assert.deepEqual(await owner.ok("POST", secondPath, {action:"start"}), {state:"running",started:true});
});

test("a solo native image caption queues once and keeps the original image accessible to its owner", async () => {
  const owner = await home(service.base, "native-image-owner");
  const outsider = await home(service.base, "native-image-outsider");
  const group = await owner.ok("POST", rooms, {kind:"group",account_group:true,title:"Image group",agents});
  const room = rooms + "/" + group.id;
  assert.equal(group.group_agent_routing.native_group_images, true);
  const attachment = {title:"test.png",mime:"image/png",
    data:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh9sAAAAASUVORK5CYII="};
  const payload = {direct:true,body:"Describe this image",attachment,native_round:true,client_key:randomUUID()};
  const sent = await owner.ok("POST", room + "/messages", payload);
  assert.equal((await owner.ok("POST", room + "/messages", payload)).id, sent.id);
  assert.deepEqual(sent.reply_jobs, []);
  const [{message_id,body,text_only,has_image}] = (await owner.ok("GET", inbox)).items;
  assert.equal(message_id, sent.id);
  assert.equal(body, payload.body);
  assert.equal(text_only, false);
  assert.equal(has_image, true);
  const file = room + "/messages/" + sent.id + "/file";
  assert.deepEqual(await owner.ok("GET", file), attachment);
  assert.equal((await outsider.call("GET", file)).status, 404);
  const all = await owner.ok("POST", room + "/messages", {...payload,body:"＠全体 看这张图",client_key:randomUUID()});
  const broadcast = (await owner.ok("GET", inbox)).items.find((item: {message_id:string}) => item.message_id === all.id);
  assert.equal(broadcast.all, true);
});

type Actor = Awaited<ReturnType<typeof home>>;
async function connect(owner: Actor, member: Actor) {
  const invite = await owner.ok("POST", "/v1/ot/contacts", {handle:member.handle});
  await member.ok("POST", "/v1/ot/contacts/" + invite.id, {action:"accept"});
}
const sendNative = (actor: Actor, path: string, body: string, extra = {}) =>
  actor.ok("POST", path + "/messages", {body,native_round:true,client_key:randomUUID(),...extra});

test("late local Bot lines use a finished receipt and match the same native line key", async () => {
  const [owner,outsider] = await Promise.all([home(service.base,"native-late-owner"),home(service.base,"native-late-outsider")]);
  const group = await owner.ok("POST",rooms,{kind:"group",account_group:true,title:"Late native replies",
    agents:[...agents,{agent_ref:"native-backup",name:"Backup"}]});
  const room = `${rooms}/${group.id}`;
  const source = await sendNative(owner,room,"The first task");
  const round = `${room}/native-rounds/${source.id}`;
  const endpoint = round + "/lines";
  const line = {agent_ref:agents[0].agent_ref,body:"Work continued after the round",client_key:randomUUID()};
  const late = {...line,late:true};
  assert.equal((await owner.call("POST",endpoint,late)).status,409);
  await owner.ok("POST",round,{action:"start"});
  assert.equal((await owner.call("POST",endpoint,late)).status,409);
  assert.equal((await owner.call("POST",endpoint,{...line,late:false})).status,400);
  const regular = {...line,body:"Already mirrored before finish",client_key:randomUUID()};
  const early = await owner.ok("POST",endpoint,regular);
  await owner.ok("POST",round,{action:"finish"});
  const next = await sendNative(owner,room,"The next task");
  await owner.ok("POST",`${room}/native-rounds/${next.id}`,{action:"start"});
  assert.equal((await outsider.call("POST",endpoint,late)).status,404);
  assert.equal((await owner.call("POST",endpoint,line)).status,409);
  assert.equal((await owner.ok("POST",endpoint,{...regular,late:true})).id,early.id);
  const [posted,retried] = await Promise.all([owner.ok("POST",endpoint,late),owner.ok("POST",endpoint,late)]);
  assert.equal(retried.id,posted.id);
  assert.equal(posted.reply_to ?? null,null);
  assert.equal(posted.body,line.body);
  assert.equal(posted.author.kind,"agent");
  assert.deepEqual(posted.reply_jobs,[]);
  assert.equal((await owner.call("POST",endpoint,{...late,body:"Different content"})).data.error.code,"native_line_conflict");
  const {messages} = await owner.ok("GET",room+"/messages");
  assert.equal(messages.filter((message: {body:string}) => message.body === line.body).length,1);
  await owner.ok("DELETE",`${room}/agents/${line.agent_ref}`);
  assert.equal((await owner.call("POST",endpoint,late)).status,404);
  const alternateBot = {...late,agent_ref:agents[1].agent_ref,client_key:randomUUID()};
  await owner.ok("PATCH",`/v1/ot/messages/${source.id}`,{body:"The task was edited"});
  assert.equal((await owner.call("POST",endpoint,alternateBot)).status,409);
  await owner.ok("DELETE",`/v1/ot/messages/${source.id}`);
  assert.equal((await owner.call("POST",endpoint,alternateBot)).status,404);
});

async function sharedGroup(label: string) {
  const [owner,peer,other] = await Promise.all([
    home(service.base,"owner-"+label), home(service.base,"peer-"+label), home(service.base,"other-"+label),
  ]);
  await connect(owner,peer);
  await connect(owner,other);
  const group = await owner.ok("POST", rooms, {kind:"group",account_group:true,title:label,members:[peer.handle,other.handle],agents});
  const room = rooms + "/" + group.id;
  const profile = async (actor: Actor) => {
    const {owner_id,display_name} = await actor.ok("GET", "/v1/ot/me");
    return {owner_id,display_name};
  };
  return {owner,peer,other,room,ownerProfile:await profile(owner),peerProfile:await profile(peer),otherProfile:await profile(other)};
}

test("simultaneous authors wake only the group host and each native reply is visible to current members", async () => {
  const {owner,peer,other,room,ownerProfile,peerProfile,otherProfile} = await sharedGroup("Native shared group");
  assert.equal((await peer.ok("GET",room)).group_agent_routing.native_group_host, ownerProfile.owner_id);
  assert.equal((await peer.ok("GET",room)).group_agent_routing.can_edit, false);
  const waitStarted = Date.now();
  const waiting = owner.ok("GET", inbox + "?wait_ms=3000");
  await delay(60);
  const selection = [{owner_id:ownerProfile.owner_id,agent_id:agents[0].agent_ref}];
  const [firstAuthor, secondAuthor] = await Promise.all([
    sendNative(peer,room,"@Reviewer Check the wording"),
    sendNative(other,room,"Plan the response", {agent_mentions:selection}),
  ]);
  assert.ok((await waiting).items.length > 0);
  assert.ok(Date.now() - waitStarted < 2600, "A remote member should wake the waiting host");
  const expected = new Map([
    [firstAuthor.id,{author:peerProfile,body:"@Reviewer Check the wording",mentions:[]}],
    [secondAuthor.id,{author:otherProfile,body:"Plan the response",mentions:selection}],
  ]);
  const pending = (await owner.ok("GET",inbox)).items;
  assert.equal(pending.length, 2);
  assert.ok(pending.every((item: {text_only:boolean}) => item.text_only));
  assert.ok(pending[0].seq < pending[1].seq);
  for (const item of pending) assert.deepEqual({author:item.author,body:item.body,mentions:item.agent_mentions}, expected.get(item.message_id));
  assert.deepEqual(firstAuthor.reply_jobs,[]);
  assert.deepEqual(secondAuthor.reply_jobs,[]);
  assert.deepEqual((await peer.ok("GET", inbox)).items,[]);
  assert.deepEqual((await other.ok("GET", inbox)).items,[]);
  const active = room + "/native-rounds/" + pending[0].message_id;
  const next = room + "/native-rounds/" + pending[1].message_id;
  const line = {agent_ref:agents[0].agent_ref,body:"Handing this to @Reviewer",client_key:"shared-native:1"};
  const working = {working_agent_refs: [agents[0].agent_ref]};
  assert.equal((await peer.call("POST",active,{action:"start",text_only:true})).status,404);
  assert.equal((await peer.call("POST",active+"/lines",line)).status,404);
  assert.equal((await peer.call("POST",active+"/progress",working)).status,404);
  assert.equal((await owner.call("POST",next,{action:"start",text_only:true})).status,409);
  assert.equal((await owner.call("POST",active,{action:"start"})).data.error.code,"native_round_text_only");
  assert.deepEqual(await owner.ok("POST",active,{action:"start",text_only:true}),{started:true,state:"running",text_only:true});
  assert.equal((await owner.call("POST",active+"/progress",{working_agent_refs:["not-a-seat"]})).status,404);
  await owner.ok("POST",active+"/progress",working);
  const expectedWorking = [{id:agents[0].agent_ref,name:agents[0].name}];
  for (const viewer of [owner,peer,other]) {
    assert.deepEqual(await viewer.ok("GET",room+"/reply-progress"),{items:[],working_bots:expectedWorking,native_group_host:ownerProfile.owner_id});
  }
  const posted = await owner.ok("POST",active+"/lines",line);
  assert.equal(posted.reply_to, pending[0].message_id);
  assert.equal(posted.author.owner.owner_id, ownerProfile.owner_id);
  assert.ok((await other.ok("GET",room+"/messages")).messages.some((item: {id:string}) => item.id === posted.id));
  const legacyInbox = await owner.ok("GET", "/v1/ot/agent-inbox?managed=1");
  assert.deepEqual(legacyInbox.items,[]);
  assert.deepEqual(legacyInbox.jobs,[]);
  await owner.ok("POST",active,{action:"finish"});
  assert.deepEqual(await peer.ok("GET",room+"/reply-progress"),{items:[]});
  assert.deepEqual(await owner.ok("POST",next,{action:"start",text_only:true}),{started:true,state:"running",text_only:true});
  assert.equal((await owner.call("POST",room+"/messages",{body:"Looks good",native_round:true,client_key:randomUUID(),reply_to:posted.id})).status,400);
});

test("removed authors and former room hosts lose native privileges without blocking the next authorized round", async () => {
  const {owner,peer,other,room,peerProfile,otherProfile} = await sharedGroup("Native revocation");
  const former = await sendNative(peer,room,"Start this work");
  const valid = await sendNative(other,room,"Take over after removal");
  const formerPath = room + "/native-rounds/" + former.id;
  const validPath = room + "/native-rounds/" + valid.id;
  const currentRevision = async () => (await owner.ok("GET",room)).group_management.revision;
  const working = {working_agent_refs: [agents[0].agent_ref]};
  const line = {agent_ref:agents[0].agent_ref,body:"A native update",client_key:"revoked-native:1"};
  await owner.ok("POST",formerPath,{action:"start",text_only:true});
  await owner.ok("POST",formerPath+"/progress",working);
  await owner.ok("POST",room+"/management",{direct:true,action:"remove",revision:await currentRevision(),member_id:peerProfile.owner_id});
  assert.equal((await peer.call("GET",room+"/reply-progress")).status,404);
  assert.equal((await peer.call("POST",room+"/messages",{body:"Still here",native_round:true,client_key:randomUUID()})).status,404);
  assert.equal((await owner.call("POST",formerPath+"/lines",line)).status,409);
  assert.equal((await owner.call("POST",formerPath+"/progress",working)).status,409);
  assert.deepEqual(await other.ok("GET",room+"/reply-progress"),{items:[]});
  assert.deepEqual((await owner.ok("GET",inbox)).items.map((item: {message_id:string}) => item.message_id),[valid.id]);
  assert.deepEqual(await owner.ok("POST",validPath,{action:"start",text_only:true}),{started:true,state:"running",text_only:true});
  await owner.ok("POST",validPath+"/progress",working);
  await owner.ok("POST",room+"/management",{direct:true,action:"transfer",revision:await currentRevision(),member_id:otherProfile.owner_id});
  assert.equal((await owner.call("POST",validPath+"/lines",line)).status,404);
  assert.equal((await owner.call("POST",validPath+"/progress",working)).status,404);
  assert.equal((await other.call("POST",validPath+"/lines",line)).status,404);
  assert.deepEqual((await owner.ok("GET",inbox)).items,[]);
  assert.deepEqual((await other.ok("GET",inbox)).items,[]);
  assert.deepEqual(await other.ok("GET",room+"/reply-progress"),{items:[]});
  const transferred = (await other.ok("GET",room)).group_agent_routing;
  assert.equal(transferred.native_group_host, otherProfile.owner_id);
  assert.equal(transferred.native_group_coordinator, true);
  assert.equal((await owner.ok("GET",room)).group_agent_routing.native_group_coordinator, undefined);
});

test("a single-owner team roster relays member messages and expires progress when the sender is suspended", async () => {
  const [owner,peer,outsider] = await Promise.all([
    home(service.base,"native-team-owner"),home(service.base,"native-team-peer"),home(service.base,"native-team-outsider"),
  ]);
  const {owner_id} = await owner.ok("GET", "/v1/ot/me");
  const team = await owner.ok("POST","/v1/ot/teams",{name:"Native workspace"});
  const {code} = await owner.ok("POST",`/v1/ot/teams/${team.id}/invites`,{});
  await peer.ok("POST","/v1/ot/invites/accept",{code});
  const group = await owner.ok("POST",rooms,{kind:"group",title:"Shared team Bots",team_id:team.id,members:[peer.handle],agents});
  const room = rooms + "/" + group.id;
  const viewerSpaces = await peer.ok("GET","/v1/ot/workspaces");
  const workspace = viewerSpaces.workspaces.find((entry: {id:string}) => entry.id === team.id).workspace_id;
  assert.equal(group.group_agent_routing.native_group_host,owner_id);
  const outgoing = await sendNative(peer,room,"Please check this",{workspace,group_agent_request:true,
    agent_mentions:[{owner_id,agent_id:agents[1].agent_ref}]});
  const active = room + "/native-rounds/" + outgoing.id;
  const scopedProgress = `/v1/ot/workspaces/${workspace}/conversations/${group.id}/reply-progress`;
  await owner.ok("POST",active,{action:"start",text_only:true});
  const working = {working_agent_refs:[agents[1].agent_ref]};
  await owner.ok("POST",active+"/progress",working);
  assert.deepEqual((await peer.ok("GET",scopedProgress)).working_bots,[{id:agents[1].agent_ref,name:agents[1].name}]);
  assert.deepEqual(await peer.ok("GET",room+"/reply-progress"),await peer.ok("GET",scopedProgress));
  assert.equal((await outsider.call("GET",room+"/reply-progress")).status,404);
  assert.equal((await outsider.call("GET",scopedProgress)).status,404);
  await owner.ok("PATCH",`/v1/ot/teams/${team.id}/members/${peer.handle}`,{suspended:true});
  assert.equal((await peer.call("GET",scopedProgress)).status,404);
  assert.equal((await owner.call("POST",active+"/progress",working)).status,409);
  assert.deepEqual((await owner.ok("GET",inbox)).items,[]);
});


test("a private turn cannot continue mirroring after a guest joins and shared queued turns stay restricted", async () => {
  const [owner,peer] = await Promise.all([home(service.base,"native-private"),home(service.base,"native-later-peer")]);
  await connect(owner,peer);
  const {owner_id} = await peer.ok("GET","/v1/ot/me");
  const group = await owner.ok("POST",rooms,{kind:"group",account_group:true,title:"Changing authorization",agents});
  const room = rooms + "/" + group.id;
  const first = await sendNative(owner,room,"A standalone request");
  const original = room + "/native-rounds/" + first.id;
  const work = {working_agent_refs:[agents[0].agent_ref]};
  const line = {agent_ref:agents[0].agent_ref,body:"A private native reply",client_key:"privacy:1"};
  assert.deepEqual(await owner.ok("POST",original,{action:"start"}),{started:true,state:"running"});
  await owner.ok("POST",original+"/progress",work);
  await owner.ok("POST",room+"/members",{handle:peer.handle});
  assert.equal((await owner.ok("GET",inbox)).items[0].text_only,true);
  assert.deepEqual(await peer.ok("GET",room+"/reply-progress"),{items:[]});
  assert.equal((await owner.call("POST",original+"/lines",line)).status,409);
  assert.equal((await owner.call("POST",original+"/progress",work)).status,409);
  await owner.ok("POST",original,{action:"finish"});
  assert.equal((await owner.call("POST",original+"/lines",{...line,late:true})).status,409);
  const sentWhileShared = await sendNative(owner,room,"A shared request");
  const queued = room + "/native-rounds/" + sentWhileShared.id;
  const {revision} = (await owner.ok("GET",room)).group_management;
  await owner.ok("POST",room+"/management",{direct:true,action:"remove",revision,member_id:owner_id});
  assert.equal((await owner.ok("GET",inbox)).items[0].text_only,true);
  assert.equal((await owner.call("POST",queued,{action:"start"})).data.error.code,"native_round_text_only");
  assert.deepEqual(await owner.ok("POST",queued,{action:"start",text_only:true}),{started:true,state:"running",text_only:true});
  await owner.ok("POST",queued,{action:"finish"});
  assert.equal((await owner.call("POST",queued+"/lines",{...line,late:true})).status,409);
});


test("cross-owner Bot work is claimed once and only receipt-backed remote replies enter the group transcript", async () => {
  const {owner,peer,other,room,ownerProfile,peerProfile,otherProfile} = await sharedGroup("Cross-owner native work");
  await peer.ok("PUT",`${room}/agents/${agents[0].agent_ref}`,{name:"Guest Planner"});
  const source = await sendNative(other,room,"Ask the guest planner for an update");
  const round = `${room}/native-rounds/${source.id}`;
  const turns = round+"/turns";
  const request = {owner_id:peerProfile.owner_id,agent_ref:agents[0].agent_ref,call_key:"native-slot-1",prompt:"Original delegated prompt"};
  assert.equal((await owner.call("POST",turns,request)).status,409);
  await owner.ok("POST",round,{action:"start",text_only:true});
  assert.equal((await other.call("POST",turns,request)).status,404);
  assert.equal((await peer.call("GET",turns)).status,404);
  assert.equal((await owner.call("POST",turns,{...request,owner_id:otherProfile.owner_id})).status,404);
  const remoteWait = peer.ok("GET",inbox+"?wait_ms=3000");
  await delay(60);
  const turn = await owner.ok("POST",turns,request);
  assert.deepEqual(await owner.ok("POST",turns,request),turn);
  assert.equal((await owner.call("POST",turns,{...request,prompt:"Different prompt"})).status,409);
  const guestQueue = (await remoteWait).turns;
  assert.deepEqual(guestQueue,[{id:turn.id,message_id:source.id,conversation_id:source.conversation_id,state:"queued",...request}]);
  assert.deepEqual((await owner.ok("GET",inbox)).turns,[]);
  assert.deepEqual((await other.ok("GET",inbox)).turns,[]);
  assert.deepEqual(await other.ok("GET",room+"/reply-progress"),{items:[]});
  const guestPath = "/v1/ot/native-group-turns/"+turn.id;
  const mirrored = {agent_ref:request.agent_ref,agent_owner_id:peerProfile.owner_id,turn_id:turn.id,body:"Forged text",client_key:"remote:1"};
  assert.equal((await owner.call("POST",round+"/lines",{...mirrored,late:true})).status,400);
  assert.equal((await owner.call("POST",round+"/lines",mirrored)).status,404);
  assert.equal((await other.call("POST",guestPath,{action:"start"})).status,404);
  assert.equal((await owner.call("POST",guestPath,{action:"start"})).status,404);
  const claims = await Promise.all([peer.ok("POST",guestPath,{action:"start"}),peer.ok("POST",guestPath,{action:"start"})]);
  assert.deepEqual(claims.map(claim => claim.started).sort(),[false,true]);
  const guestBot = {id:peerProfile.owner_id+"/"+request.agent_ref,name:"Guest Planner"};
  assert.deepEqual(await other.ok("GET",room+"/reply-progress"),{items:[],native_group_host:ownerProfile.owner_id,working_bots:[guestBot]});
  const localProgress = {working_agent_refs:[agents[0].agent_ref]};
  await owner.ok("POST",round+"/progress",localProgress);
  assert.deepEqual((await other.ok("GET",room+"/reply-progress")).working_bots,[{id:agents[0].agent_ref,name:agents[0].name},guestBot]);
  const reply = {action:"finish",outcome:"message",text:"Completed by the guest Bot"};
  const settled = {state:"finished",result:{outcome:"message",text:reply.text}};
  assert.deepEqual(await peer.ok("POST",guestPath,reply),settled);
  assert.deepEqual(await peer.ok("POST",guestPath,reply),settled);
  assert.equal((await peer.call("POST",guestPath,{...reply,text:"Replace original result"})).status,409);
  assert.deepEqual((await peer.ok("GET",inbox)).turns,[]);
  assert.deepEqual((await owner.ok("GET",turns)).items,[{...turn,...settled}]);
  const collidingHumanKey = await peer.ok("POST",room+"/messages",{body:"A human message",client_key:"native-turn:"+turn.id,native_round:true});
  const posted = await owner.ok("POST",round+"/lines",mirrored);
  assert.notEqual(posted.id,collidingHumanKey.id);
  assert.equal(posted.body,reply.text);
  assert.equal(posted.author.owner.owner_id,peerProfile.owner_id);
  assert.equal(posted.author.name,"Guest Planner");
  assert.equal((await owner.ok("POST",round+"/lines",{...mirrored,client_key:"different-host-key"})).id,posted.id);
  assert.equal((await owner.call("POST",round+"/lines",{...mirrored,agent_owner_id:otherProfile.owner_id})).status,404);
  assert.deepEqual((await other.ok("GET",room+"/reply-progress")).working_bots,[{id:agents[0].agent_ref,name:agents[0].name}]);

  const expiringTurn = await owner.ok("POST",turns,{...request,call_key:"native-slot-timeout"});
  const expiringPath = "/v1/ot/native-group-turns/"+expiringTurn.id;
  assert.equal((await peer.ok("POST",expiringPath,{action:"start"})).started,true);
  service.platform.db.prepare("UPDATE ot_native_group_turns SET expires_at=0 WHERE id=?").run(expiringTurn.id);
  assert.deepEqual((await owner.ok("GET",turns)).items[1],{...expiringTurn,state:"finished",result:{outcome:"failed"}});
  assert.deepEqual((await peer.ok("GET",inbox)).turns,[]);
  assert.deepEqual(await peer.ok("POST",expiringPath,reply),{state:"finished",result:{outcome:"failed"}});
  assert.deepEqual(await peer.ok("POST",expiringPath,{action:"start"}),{state:"finished",started:false,result:{outcome:"failed"}});

  const removedTurn = await owner.ok("POST",turns,{...request,call_key:"native-slot-removed"});
  const removedPath = "/v1/ot/native-group-turns/"+removedTurn.id;
  await peer.ok("POST",removedPath,{action:"start"});
  await peer.ok("DELETE",`${room}/agents/${request.agent_ref}`);
  await delay(5);
  await peer.ok("PUT",`${room}/agents/${request.agent_ref}`,{name:"Guest Planner"});
  assert.deepEqual((await peer.ok("GET",inbox)).turns,[]);
  assert.deepEqual((await owner.ok("GET",turns)).items.at(-1),{...removedTurn,state:"finished",result:{outcome:"failed"}});
  assert.equal((await peer.call("POST",removedPath,reply)).status,404);
  assert.equal((await owner.ok("POST",turns,{...request,call_key:removedTurn.call_key})).result.outcome,"failed");

  const pendingTurn = await owner.ok("POST",turns,{...request,call_key:"native-slot-2"});
  const pendingGuestPath = "/v1/ot/native-group-turns/"+pendingTurn.id;
  await peer.ok("POST",pendingGuestPath,{action:"start"});
  const {revision} = (await owner.ok("GET",room)).group_management;
  await owner.ok("POST",room+"/management",{direct:true,action:"transfer",revision,member_id:otherProfile.owner_id});
  assert.deepEqual((await peer.ok("GET",inbox)).turns,[]);
  assert.equal((await peer.call("POST",pendingGuestPath,reply)).status,404);
  assert.equal((await other.call("GET",turns)).status,404);
  assert.deepEqual(await other.ok("GET",room+"/reply-progress"),{items:[]});
});
