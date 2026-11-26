import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { bulkAuth, startServer } from "./helpers.js";
import { home } from "./flybot_workspace_helpers.js";

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(bulkAuth); });
after(async () => { await S.stop(); });

test("personal groups share confirmed contacts and atomic agent rosters without a team", async () => {
  const [owner, peer, stranger] = await Promise.all([
    home(S.base,"personal-owner"), home(S.base,"personal-peer"), home(S.base,"personal-stranger"),
  ]);
  const root = "/v1/ot/conversations";
  const request = await owner.ok("POST","/v1/ot/contacts",{handle:peer.handle});
  const options = {kind:"group",account_group:true,title:"Personal test",members:[peer.handle],
    agents:[{agent_ref:"agent_1",name:"Launch helper"}],idempotency_key:"personal-group-attempt"};
  assert.equal((await owner.call("POST",root,options)).status,403);
  await peer.ok("POST","/v1/ot/contacts/"+request.id,{action:"accept"});
  const group = await owner.ok("POST",root,options);
  assert.equal(group.account_group,true);
  assert.equal(group.team_id,null);
  assert.deepEqual(group.agents.map((row:any)=>row.agent_ref),["agent_1"]);
  assert.equal((await owner.ok("POST",root,options)).id,group.id);
  assert.equal((await owner.call("POST",root,{...options,title:"Other title"})).status,409);
  assert.equal((await peer.ok("GET",root+"?scope=personal")).conversations[0].id,group.id);
  assert.equal((await stranger.call("GET",root+"/"+group.id)).status,404);
  assert.equal((await owner.call("POST",root+"/"+group.id+"/members",{handle:stranger.handle})).status,403);
  assert.equal((await stranger.ok("GET",root+"?scope=personal")).conversations.length,0);
  const added = await peer.ok("GET","/v1/ot/notifications?personal=1");
  assert.equal(added.notifications.filter((row:any)=>row.kind==="messenger.added"&&row.data.conversation_id===group.id).length,1);

  const room = root+"/"+group.id;
  const data = Buffer.from("private group file").toString("base64");
  const file = await owner.ok("POST",room+"/messages",{direct:true,attachment:{title:"group.txt",mime:"text/plain",data}});
  assert.equal((await peer.ok("GET",room+"/messages/"+file.id+"/file")).data,data);
  assert.equal((await stranger.call("GET",room+"/messages/"+file.id+"/file")).status,404);
  const msg = await peer.ok("POST",room+"/messages",{body:"@agent_1 personal launch"});
  assert.deepEqual((await owner.ok("GET","/v1/ot/agent-inbox")).items,[]);
  assert.ok((await owner.ok("GET","/v1/ot/agent-inbox?managed=1")).jobs.some((row:any)=>
    row.message.id===msg.id && row.agent_ref==="agent_1" && row.group_text_only===true));
  assert.deepEqual((await peer.ok("GET","/v1/ot/agent-inbox")).items,[]);
  const search = "/v1/ot/messages/personal-search?q=personal%20launch";
  assert.ok((await owner.ok("GET",search)).items.some((row:any)=>row.message_id===msg.id));
  assert.deepEqual((await stranger.ok("GET",search)).items,[]);
  assert.equal((await peer.call("POST",room+"/announcement",{body:"Member",revision:0})).status,403);
  const saved = await owner.ok("POST",room+"/announcement",{body:"Group plan",revision:0});
  const read = await peer.ok("GET",room+"/announcement");
  assert.equal(read.announcement.body,"Group plan");
  assert.equal(read.announcement.author_name,(await owner.ok("GET","/v1/ot/me")).display_name);
  assert.equal(read.announcement.updated_at,saved.announcement.updated_at);
  assert.ok(Number.isSafeInteger(read.announcement.updated_at));
  assert.equal((await stranger.call("GET",room+"/announcement")).status,404);
  assert.equal((await owner.call("POST",room+"/announcement",{body:"",revision:0})).status,409);
  await owner.ok("POST",room+"/announcement",{body:"",revision:1});
  const cleared = (await peer.ok("GET",room+"/announcement")).announcement;
  assert.equal(cleared.body,"");
  assert.equal(cleared.author_name,undefined);
  const translated = await owner.ok("POST",room+"/translation-sources",{items:[{id:msg.id,revision:1}]});
  assert.equal(translated.sources[0].body,"@agent_1 personal launch");
  assert.equal((await stranger.call("POST",room+"/translation-sources",{items:[]})).status,404);

  const team = await owner.ok("POST","/v1/ot/teams",{name:"Separate team"});
  assert.deepEqual((await owner.ok("GET",root+"?scope=member&team_id="+team.id)).conversations,[]);
  await owner.ok("DELETE",room+"/members/"+encodeURIComponent(peer.handle));
  assert.equal((await peer.call("GET",room)).status,404);
  assert.deepEqual((await peer.ok("GET",search)).items,[]);
});

test("group mentions retry individual replies after the inbox cursor moves", async () => {
  const [owner, sender] = await Promise.all([
    home(S.base, "reply-owner"), home(S.base, "reply-sender"),
  ]);
  const request = await owner.ok("POST", "/v1/ot/contacts", {handle: sender.handle});
  await sender.ok("POST", "/v1/ot/contacts/" + request.id, {action: "accept"});
  const root = "/v1/ot/conversations";
  const group = await owner.ok("POST", root, {kind: "group", account_group: true,
    title: "Reply retries", members: [sender.handle], agents: [
      {agent_ref: "draft", name: "Draft helper"}, {agent_ref: "review", name: "Review helper"},
    ]});
  const room = root + "/" + group.id;
  const send = {body: "@draft @review Check the draft", client_key: "original"};
  const message = await sender.ok("POST", room + "/messages", send);
  assert.equal((await sender.ok("POST", room + "/messages", send)).id, message.id);
  assert.deepEqual(message.reply_jobs.map((job: any) => job.status), ["queued", "queued"]);
  const inbox = await owner.ok("GET", "/v1/ot/agent-inbox?managed=1");
  assert.deepEqual(inbox.items, []);
  const draft = inbox.jobs.find((job: any) => job.agent_ref === "draft");
  const review = inbox.jobs.find((job: any) => job.agent_ref === "review");
  assert.equal((await sender.ok("GET", "/v1/ot/agent-inbox?managed=1")).jobs.length, 0);
  const later = "/v1/ot/agent-inbox?managed=1&after=" + inbox.cursor;
  const change = (job: any) => "/v1/ot/agent-reply-jobs/" + job.job_id;
  const progress = (job: any) => change(job) + "/progress";
  const draftClaim = randomUUID(), reviewClaim = randomUUID(), retryClaim = randomUUID();
  const start = (attempt: number, claim_id: string) =>
    ({action: "start", attempt, source_revision: message.revision, claim_id, accept_group_text_turn: true});
  const listProgress = room + "/reply-progress";
  const retry = room + "/messages/" + message.id + "/agent-retry";
  const answer = (job: any, claim_id: string) => ({agent_ref: job.agent_ref, body: "Checked", reply_to: message.id,
    job_id: job.job_id, attempt: job.attempt, claim_id});
  const draftSnapshot = (attempt: number, text: string, status = "running") =>
    ({id: draft.job_id, message_id: message.id, attempt, status, text});
  const view = () => sender.ok("GET", listProgress);

  assert.equal((await sender.call("POST", change(draft), {action: "start", attempt: 1})).status, 404);
  assert.equal((await owner.call("POST", progress(draft), {attempt: 1, revision: 1, text: "Too early"})).status, 409);
  assert.equal((await fetch(S.base + listProgress)).status, 401);
  assert.deepEqual((await view()).items.at(-1), draftSnapshot(1, "", "queued"));
  await owner.ok("POST", change(draft), start(1, draftClaim));
  assert.deepEqual((await view()).items.at(-1), draftSnapshot(1, ""));
  await owner.ok("POST", change(review), start(1, reviewClaim));
  assert.equal((await owner.call("POST", change(draft), {action: "start", attempt: 1})).status, 409);
  assert.deepEqual((await owner.ok("GET", later)).jobs, []);
  const activity = root + "?scope=personal&view=activity";
  const before = await sender.ok("GET", activity);
  assert.equal((await sender.call("POST", progress(draft), {attempt: 1, revision: 1, text: "Wrong owner"})).status, 404);
  assert.equal((await owner.call("POST", progress(draft), {attempt: 1, revision: 1, text: "🤖".repeat(2001)})).status, 400);
  await owner.ok("POST", progress(draft), {attempt: 1, revision: 1, text: "Starting a draft", claim_id: draftClaim});
  await owner.ok("POST", progress(review), {attempt: 1, revision: 1, text: "Starting a review", claim_id: reviewClaim});
  assert.deepEqual((await view()).items, [
    {id: review.job_id, message_id: message.id, attempt: 1, status: "running", text: "Starting a review"},
    draftSnapshot(1, "Starting a draft"),
  ]);
  assert.deepEqual(await sender.ok("GET", activity + "&since=" + before.version), {version: before.version});
  assert.equal((await owner.call("POST", progress(draft), {attempt: 1, revision: 1, text: "Late duplicate", claim_id: draftClaim})).status, 409);
  await owner.ok("POST", progress(draft), {attempt: 1, revision: 2, text: "", claim_id: draftClaim});
  assert.deepEqual((await view()).items.at(-1), draftSnapshot(1, ""));
  const posted = await owner.ok("POST", room + "/agent-messages", answer(review, reviewClaim));
  assert.deepEqual((await view()).items, [draftSnapshot(1, "")]);
  assert.equal((await owner.call("POST", progress(review), {attempt: 1, revision: 2, text: "Late final update", claim_id: reviewClaim})).status, 409);
  await owner.ok("POST", change(draft), {action: "fail", attempt: 1, claim_id: draftClaim});
  assert.deepEqual((await view()).items, []);
  assert.equal((await owner.call("POST", retry, {job_id: draft.job_id})).status, 404);
  const senderPage = await sender.ok("GET", room + "/messages");
  const ownerPage = await owner.ok("GET", room + "/messages");
  assert.equal(senderPage.messages[0].reply_jobs.find((job: any) => job.id === draft.job_id).can_retry, true);
  assert.equal(ownerPage.messages[0].reply_jobs.find((job: any) => job.id === draft.job_id).can_retry, false);
  const retried = await sender.ok("POST", retry, {job_id: draft.job_id});
  assert.deepEqual(retried.reply_jobs.map((job: any) => job.status), ["queued", "replied"]);
  assert.deepEqual(retried.reply_jobs.map((job: any) => job.attempt), [2, 1]);
  assert.deepEqual((await view()).items, [draftSnapshot(2, "", "queued")]);
  assert.equal((await sender.call("POST", retry, {job_id: draft.job_id})).status, 409);
  const next = (await owner.ok("GET", later)).jobs;
  assert.deepEqual(next.map((job: any) => [job.job_id, job.attempt]), [[draft.job_id, 2]]);
  await owner.ok("POST", change(draft), start(2, retryClaim));
  assert.equal((await owner.call("POST", progress(draft), {attempt: 1, revision: 3, text: "Stale attempt", claim_id: draftClaim})).status, 409);
  await owner.ok("POST", progress(draft), {attempt: 2, revision: 1, text: "New draft", claim_id: retryClaim});
  assert.deepEqual((await view()).items, [draftSnapshot(2, "New draft")]);
  assert.equal((await owner.call("POST", room + "/agent-messages", answer(draft, draftClaim))).status, 409);
  const completed = await owner.ok("POST", room + "/agent-messages", answer(next[0], retryClaim));
  assert.equal((await owner.ok("POST", room + "/agent-messages", answer(next[0], retryClaim))).id, completed.id);
  const history = (await sender.ok("GET", room + "/messages")).messages;
  assert.deepEqual(history.map((row: any) => row.id), [message.id, posted.id, completed.id]);
  assert.deepEqual(history[0].reply_jobs.map((job: any) => job.status), ["replied", "replied"]);
  assert.deepEqual((await view()).items, []);
});

test("managed reply claims replay without renewing the lease and fence each attempt", async t => {
  let now = Date.now();
  const service = await startServer({...bulkAuth, now: () => now});
  t.after(service.stop);
  const [owner, sender] = await Promise.all([home(service.base, "claim-owner"), home(service.base, "claim-sender")]);
  const contact = await owner.ok("POST", "/v1/ot/contacts", {handle: sender.handle});
  await sender.ok("POST", "/v1/ot/contacts/" + contact.id, {action: "accept"});
  const root = "/v1/ot/conversations";
  const group = await owner.ok("POST", root, {kind: "group", account_group: true,
    title: "Managed claims", members: [sender.handle], agents: [{agent_ref: "helper", name: "Helper"}]});
  const room = root + "/" + group.id;
  await owner.ok("POST",room+"/management",{
    direct:true,action:"reply_policy",revision:group.group_management.revision,mode:"default",
  });
  await owner.ok("PUT", room + "/agents/helper", {name: "Helper", auto_reply: true});
  const source = await sender.ok("POST", room + "/messages", {body: "@helper Can you check?"});
  const id = source.reply_jobs[0].id;
  const claim = randomUUID(), other = randomUUID();
  const job = "/v1/ot/agent-reply-jobs/" + id;
  const progress = job + "/progress";
  const answer = room + "/agent-messages";
  const retry = room + "/messages/" + source.id + "/agent-retry";
  const start = {action: "start", attempt: 1, source_revision: source.revision, claim_id: claim, accept_group_text_turn: true};
  const snapshot = {attempt: 1, revision: 1, text: "Working", claim_id: claim};
  const final = {agent_ref: "helper", body: "Checked", reply_to: source.id};
  const post = (path: string, payload: unknown) => owner.call("POST", path, payload);
  const activity = root + "?scope=personal&view=activity";

  assert.equal((await post(job, {...start, claim_id: "invalid"})).status, 400);
  assert.equal((await sender.call("POST", job, start)).status, 404);
  await owner.ok("POST", job, start);
  assert.equal((await post(job, {...start, claim_id: other})).status, 409);
  assert.equal((await post(job, {...start, claim_id: undefined})).status, 409);
  assert.equal((await post(progress, {...snapshot, claim_id: other})).status, 409);
  assert.equal((await post(progress, {...snapshot, claim_id: undefined})).status, 409);
  assert.equal((await post(job, {action: "fail", attempt: 1, claim_id: other})).status, 409);
  assert.equal((await post(job, {action: "fail", attempt: 1})).status, 409);
  assert.equal((await post(answer, {...final, job_id: id, attempt: 1, claim_id: other})).status, 409);
  assert.equal((await post(answer, {...final, job_id: id, attempt: 1})).status, 409);
  assert.equal((await post(answer, final)).status, 409);
  assert.equal((await post(answer, {...final, mode: "auto"})).status, 409);
  await owner.ok("POST", progress, snapshot);
  const before = await sender.ok("GET", activity);
  now += 179_999;
  assert.deepEqual(await owner.ok("POST", job, start), {ok: true, group_text_only: true});
  assert.deepEqual(await sender.ok("GET", activity + "&since=" + before.version), {version: before.version});
  assert.deepEqual((await sender.ok("GET", room + "/reply-progress")).items,
    [{id, message_id: source.id, attempt: 1, status: "running", text: "Working"}]);
  assert.equal((await post(progress, snapshot)).data.error.code, "reply_progress_stale");
  now++;
  assert.equal((await post(job, start)).status, 409);
  assert.deepEqual((await sender.ok("GET", room + "/reply-progress")).items, []);
  assert.equal((await sender.ok("GET", room + "/messages")).messages[0].reply_jobs[0].error_code, "reply_timeout");

  assert.equal((await sender.call("POST", retry, {job_id: id, attempt: "1"})).status, 400);
  await sender.ok("POST", retry, {job_id: id, attempt: 1});
  assert.equal((await post(answer, {...final, job_id: id, attempt: 1, claim_id: claim})).status, 409);
  await owner.ok("POST", job, {...start, attempt: 2, claim_id: other});
  assert.equal((await post(progress, {...snapshot, attempt: 2})).status, 409);
  await owner.ok("POST", job, {action: "fail", attempt: 2, claim_id: other});
  assert.equal((await sender.call("POST", retry, {job_id: id, attempt: 1})).status, 409);
  const queued = source.reply_jobs[0];
  assert.deepEqual((await sender.ok("GET", room + "/messages")).messages[0].reply_jobs[0],
    {...queued, attempt: 2, status: "failed", can_retry: true});
  await sender.ok("POST", retry, {job_id: id, attempt: 2});
  const next = randomUUID();
  await owner.ok("POST", job, {...start, attempt: 3, claim_id: next});
  const delivery = {...final, job_id: id, attempt: 3, claim_id: next};
  const reply = await owner.ok("POST", answer, delivery);
  assert.equal(reply.reply_job_id, id);
  assert.equal(reply.client_key, undefined);
  assert.equal((await owner.ok("POST", answer, delivery)).id, reply.id);
  assert.equal((await post(answer, {...delivery, claim_id: other})).status, 409);
  assert.equal((await post(job, {...start, attempt: 3, claim_id: next})).status, 409);
  const ordinarySource = await sender.ok("POST", room + "/messages", {body: "A separate conversation turn"});
  const untrackedKey = "job:otj_" + "0".repeat(26);
  const ordinary = await owner.ok("POST", answer, {...final, reply_to: ordinarySource.id, client_key: untrackedKey});
  assert.equal(ordinary.reply_job_id, undefined);
  const messages = (await sender.ok("GET", room + "/messages")).messages;
  assert.deepEqual(messages.map((row: any) => [row.id, row.reply_job_id]),
    [[source.id, undefined], [reply.id, id], [ordinarySource.id, undefined], [ordinary.id, undefined]]);
  assert.equal(messages[1].client_key, undefined);
});

test("activity snapshots are scoped and skip message content until the client needs it", async () => {
  const [owner, reader, outsider] = await Promise.all([
    home(S.base, "activity-owner"), home(S.base, "activity-reader"), home(S.base, "activity-other"),
  ]);
  const request = await owner.ok("POST", "/v1/ot/contacts", {handle: reader.handle});
  await reader.ok("POST", "/v1/ot/contacts/" + request.id, {action: "accept"});
  const root = "/v1/ot/conversations";
  const activity = root + "?scope=personal&view=activity";
  const group = await owner.ok("POST", root, {kind: "group", account_group: true, title: "Live chat check", members: [reader.handle]});
  const get = () => reader.ok("GET", activity);
  const baseline = await get();
  const before = baseline.items.find((row: any) => row.id === group.id);
  assert.equal(before.activity_version, group.activity_version);
  assert.deepEqual(await reader.ok("GET", activity + "&since=" + baseline.version), {version: baseline.version});
  assert.deepEqual((await outsider.ok("GET", activity)).items, []);
  const message = await owner.ok("POST", root + "/" + group.id + "/messages", {body: "Private smoke-test text"});
  const next = await get();
  assert.equal(next.items[0].unread_count, 1);
  assert.equal(next.items[0].last_seq, message.seq);
  assert.notEqual(next.items[0].activity_version, before.activity_version);
  assert.equal(JSON.stringify(next).includes(message.body), false);
  assert.equal((await reader.ok("GET", root + "/" + group.id)).activity_version, next.items[0].activity_version);
  await owner.ok("PATCH", "/v1/ot/messages/" + message.id, {body: "Revised private text"});
  const edited = await get();
  assert.equal(edited.items[0].last_seq, next.items[0].last_seq);
  assert.notEqual(edited.items[0].activity_version, next.items[0].activity_version);
  await reader.ok("POST", root + "/" + group.id + "/read", {seq:message.seq});
  const read = await get();
  assert.equal(read.items[0].activity_version, edited.items[0].activity_version);
  assert.equal(read.items[0].unread_count, 0);
  assert.notEqual(read.version, edited.version);
  await owner.ok("DELETE", root + "/" + group.id + "/members/" + encodeURIComponent(reader.handle));
  assert.deepEqual((await get()).items, []);
});

test("deleting for one reader preserves the shared message, pins and reactions", async () => {
  const [sender, reader, outsider] = await Promise.all([
    home(S.base, "hide-sender"), home(S.base, "hide-reader"), home(S.base, "hide-other"),
  ]);
  const request = await sender.ok("POST", "/v1/ot/contacts", {handle: reader.handle});
  await reader.ok("POST", "/v1/ot/contacts/" + request.id, {action: "accept"});
  const root = "/v1/ot/conversations";
  const group = await sender.ok("POST", root, {kind:"group", account_group:true, title:"Private hiding", members:[reader.handle]});
  const room = root + "/" + group.id;
  const history = room + "/messages";
  const first = await sender.ok("POST", history, {body:"previous item"});
  const message = await sender.ok("POST", history, {body:"test specific hidden words"});
  const path = "/v1/ot/messages/" + message.id;
  const hide = path + "/hide";
  await reader.ok("POST", path + "/reactions", {emoji:"👍"});
  const pinned = await sender.ok("POST", path + "/pin", {});
  assert.equal(pinned.pinned_messages[0].message_id, message.id);
  assert.equal((await reader.ok("GET", history + "?limit=1&pins=1")).pinned_messages[0].pinned_by_username, pinned.pinned_messages[0].pinned_by_username);
  const senderVersion = (await sender.ok("GET", room)).activity_version;
  const readerVersion = (await reader.ok("GET", room)).activity_version;
  assert.equal((await outsider.call("POST", hide, {conversation_id:group.id})).status,404);
  assert.equal((await reader.call("POST", hide, {conversation_id:"different"})).status,404);
  for (let attempt=0; attempt<2; attempt++) {
    assert.deepEqual(await reader.ok("POST", hide, {conversation_id:group.id}), {hidden:true});
  }
  const detail = await reader.ok("GET", room);
  assert.equal(detail.last_message.id, first.id);
  assert.equal(detail.unread, 1);
  assert.notEqual(detail.activity_version, readerVersion);
  assert.equal((await sender.ok("GET", room)).activity_version, senderVersion);
  assert.deepEqual((await reader.ok("GET", history + "?pins=1")).pinned_messages, []);
  assert.equal((await reader.call("GET", history + "?around=" + message.id)).status,404);
  assert.equal((await reader.call("GET", path)).status,404);
  assert.deepEqual((await reader.ok("GET", "/v1/ot/messages/personal-search?q=hidden%20words")).items,[]);
  assert.equal((await sender.ok("GET", history + "?pins=1")).pinned_messages[0].message_id,message.id);
  const shared = await sender.ok("GET", path);
  assert.equal(shared.body, message.body);
  assert.equal(shared.retracted, false);
  assert.deepEqual(shared.reactions,[{emoji:"👍",count:1,mine:false}]);
});

test("quoted messages keep a real link and respect each reader's access", async () => {
  const [owner, peer] = await Promise.all([
    home(S.base, "quote-owner"), home(S.base, "quote-peer"),
  ]);
  const contact = await owner.ok("POST", "/v1/ot/contacts", {handle:peer.handle});
  await peer.ok("POST", "/v1/ot/contacts/" + contact.id, {action:"accept"});
  const root = "/v1/ot/conversations";
  const group = await owner.ok("POST", root, {kind:"group", account_group:true, title:"Linked replies", members:[peer.handle]});
  const other = await owner.ok("POST", root, {kind:"group", account_group:true, title:"Different room", members:[peer.handle]});
  const send = root + "/" + group.id + "/messages";
  const original = await owner.ok("POST", send, {body:"Original  room\ntext"});
  const reply = await peer.ok("POST", send, {body:"Actual answer", reply_to:original.id});
  assert.equal(reply.body, "Actual answer");
  assert.equal(reply.reply_to, original.id);
  assert.deepEqual(reply.reply_preview, {message_id:original.id, available:true,
    author:original.author.display_name, excerpt:"Original room text"});
  const payload = {body:"Wrong room", reply_to:original.id};
  const foreign = await peer.call("POST", root + "/" + other.id + "/messages", payload);
  assert.equal(foreign.status,409);
  await owner.ok("POST", "/v1/ot/messages/" + original.id + "/hide", {conversation_id:group.id});
  const preview = async (actor: typeof owner) => (await actor.ok("GET", "/v1/ot/messages/" + reply.id)).reply_preview;
  assert.deepEqual(await preview(owner), {message_id:original.id, available:false});
  assert.equal((await preview(peer)).available,true);
  const hidden = await owner.call("POST", send, payload);
  assert.equal(hidden.status,409);

  const revised = await owner.ok("POST", send, {body:"Before editing"});
  const draft = await peer.ok("POST", send, {body:"Quoted document", reply_to:revised.id, direct:true,
    attachment:{title:"reference.txt", mime:"text/plain", data:Buffer.from("Attachment contents").toString("base64")}});
  assert.equal(draft.reply_preview.excerpt,"Before editing");
  const target = "/v1/ot/messages/" + revised.id;
  await owner.ok("PATCH", target, {body:"After editing"});
  const submitted = "/v1/ot/messages/" + draft.id;
  assert.equal((await peer.ok("GET", submitted)).reply_preview.excerpt, "After editing");
  await owner.ok("DELETE", target);
  assert.deepEqual((await peer.ok("GET", submitted)).reply_preview, {message_id:revised.id, available:false});
  assert.equal((await peer.call("POST", send, {body:"Too late", reply_to:revised.id})).status,409);
});

test("forwarding is atomic, supports media and history, and keeps origin labels", async () => {
  const [sender, relay, recipient] = await Promise.all([
    home(S.base, "forward-sender"), home(S.base, "forward-relay"), home(S.base, "forward-recipient"),
  ]);
  for (const person of [sender, recipient]) {
    const request = await relay.ok("POST", "/v1/ot/contacts", {handle:person.handle});
    await person.ok("POST", "/v1/ot/contacts/" + request.id, {action:"accept"});
  }
  const root = "/v1/ot/conversations";
  const source = await relay.ok("POST", root, {kind:"group", account_group:true, title:"Older source", members:[sender.handle]});
  const target = await relay.ok("POST", root, {kind:"group", account_group:true, title:"Shared target", members:[recipient.handle],
    agents:[{agent_ref:"helper",name:"Helper"}]});
  const room = root + "/" + source.id + "/messages";
  const textMessage = await sender.ok("POST", room, {body:"Original @helper text"});
  const bytes = Buffer.from("This is the forwarded file").toString("base64");
  const fileMessage = await sender.ok("POST", room, {direct:true, attachment:{title:"forwarded.txt",mime:"text/plain",data:bytes}});
  const voice = {mime:"audio/webm",data:Buffer.from("1a45dfa30011111111222222","hex").toString("base64")};
  const recording = await sender.ok("POST", room, {voice});
  const messages = root + "/" + target.id + "/messages";
  const api = root + "/" + source.id + "/forward";
  const input = {message_ids:[recording.id,fileMessage.id,textMessage.id],target_conversation_id:target.id,request_key:"one-forward-action"};
  const hidden = await sender.ok("POST", room, {body:"Hidden source"});
  await relay.ok("POST", "/v1/ot/messages/" + hidden.id + "/hide", {conversation_id:source.id});
  const rejected = await relay.call("POST", api, {...input, message_ids:[textMessage.id,hidden.id]});
  assert.equal(rejected.status,409);
  assert.deepEqual((await recipient.ok("GET", messages)).messages, []);
  assert.equal((await recipient.call("POST",api,input)).status,404);
  assert.equal((await sender.call("POST",api,input)).status,404);
  const published = await relay.ok("POST", api, input);
  assert.deepEqual(await relay.ok("POST", api, {...input,message_ids:input.message_ids.toReversed()}),published);
  assert.equal((await relay.call("POST", api, {...input,message_ids:[textMessage.id]})).status,409);
  const forwarded = (await recipient.ok("GET", messages)).messages;
  assert.equal(forwarded.length,3);
  assert.deepEqual(forwarded.map((row: any) => row.forwarded_from), Array(3).fill({author:textMessage.author.display_name}));
  assert.equal(forwarded[0].body,textMessage.body);
  assert.deepEqual(forwarded[0].mentions,[]);
  assert.equal(forwarded[0].reply_to,null);
  assert.equal((await recipient.ok("GET", messages + "/" + forwarded[1].id + "/file")).data,bytes);
  assert.equal((await recipient.ok("GET", messages + "/" + forwarded[2].id + "/voice")).data,voice.data);
  assert.equal((await recipient.call("GET",room + "/" + fileMessage.id + "/file")).status,404);
});
