import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { bulkAuth, startServer } from "./helpers.js";
import { home } from "./flybot_workspace_helpers.js";

type Actor = Awaited<ReturnType<typeof home>>;
type Job = {id: string; agent_id: string; agent_owner_id: string; status: string};
let service: Awaited<ReturnType<typeof startServer>>;
before(async () => { service = await startServer(bulkAuth); });
after(async () => { await service.stop(); });

const lead = {agent_ref: "z-manager", name: "产品经理助理"};
const engineer = {agent_ref: "a-engineer", name: "研发工程师助理"};
const reviewer = {agent_ref: "b-reviewer", name: "测试工程师助理"};
const queue = "/v1/ot/agent-inbox?managed=1";
const ownerId = async (actor: Actor) => (await actor.ok("GET", "/v1/ot/me")).owner_id;
const roomPath = (group: {id: string}) => "/v1/ot/conversations/" + group.id;
const targets = (message: {reply_jobs: Job[]}) => message.reply_jobs.map(job => job.agent_id);

async function answer(actor: Actor, room: string, request: any, job: Job, isolated = false) {
  const claim_id = randomUUID();
  const attempt = 1;
  const receipt = await actor.ok("POST", "/v1/ot/agent-reply-jobs/" + job.id, {
    action: "start", attempt, source_revision: request.revision, claim_id, accept_group_text_turn: true, accept_discretionary_reply: true,
  });
  assert.equal(receipt.group_text_only === true, isolated);
  const reply = await actor.ok("POST", room + "/agent-messages", {
    agent_ref: job.agent_id, body: "收到，已开始核对。", mode: "mention", reply_to: request.id,
    job_id: job.id, claim_id, attempt,
  });
  assert.equal(reply.reply_job_id, job.id);
  return reply;
}

test("uploaded captions route only explicit mentions, and every caption reply uses the text-only claim", async () => {
  const [sender, recipient] = await Promise.all([
    home(service.base, "caption-sender"), home(service.base, "caption-recipient"),
  ]);
  const senderId = await ownerId(sender), recipientId = await ownerId(recipient);
  const contact = await sender.ok("POST", "/v1/ot/contacts", {handle:recipient.handle});
  await recipient.ok("POST", "/v1/ot/contacts/" + contact.id, {action:"accept"});
  const group = await sender.ok("POST", "/v1/ot/conversations", {
    kind:"group", account_group:true, title:"Attachment captions", members:[recipient.handle], agents:[lead],
  });
  const room = roomPath(group), messages = room + "/messages";
  await sender.ok("PATCH", room + "/agents/" + lead.agent_ref, {auto_reply:true});
  await recipient.ok("PUT", room + "/agents/" + engineer.agent_ref, {name:engineer.name});
  const attachment = {title:"@所有人 资料.txt", mime:"text/plain", data:Buffer.from("FILE_BYTES_EXCLUDED").toString("base64")};
  const send = (body?: string, options = {}) => sender.ok("POST", messages, {attachment, body, direct:true, ...options});
  const ordinary = await send("Please look at the attached plan");
  const uncaptioned = await send();
  const literal = await send("The literal example is `@所有人`.");
  for (const msg of [ordinary, uncaptioned, literal]) assert.deepEqual(targets(msg), []);

  const typed = await send("@研发工程师助理 请核对标题");
  assert.deepEqual(targets(typed), [engineer.agent_ref]);
  const request = {client_key:"exact-caption-mention", agent_mentions:[{owner_id:senderId,agent_id:lead.agent_ref}]};
  const selected = await send("请核对排期", request);
  assert.deepEqual(targets(selected), [lead.agent_ref]);
  const replayed = await send("请核对排期", request);
  assert.equal(replayed.id, selected.id);
  assert.deepEqual(replayed.reply_jobs, selected.reply_jobs);
  const unavailable = await sender.call("POST", messages, {
    attachment, direct:true, body:"请选择", agent_mentions:[{owner_id:recipientId,agent_id:lead.agent_ref}],
  });
  assert.equal(unavailable.status, 400);

  const everyone = await send("@所有人 请核对更新");
  assert.deepEqual(targets(everyone), [lead.agent_ref, engineer.agent_ref]);
  const notifications = (await recipient.ok("GET", "/v1/ot/notifications")).notifications;
  assert.deepEqual(notifications.filter((item: any) => item.kind === "messenger.mention")
    .map((item: any) => item.data.message_id), [everyone.id]);
  for (const [actor, message, expectedId] of [[sender, selected, lead.agent_ref], [recipient, typed, engineer.agent_ref]] as const) {
    const inbox = await actor.ok("GET", queue);
    assert.equal(inbox.items.length, 0);
    const entry = inbox.jobs.find((job: any) => job.message.id === message.id);
    assert.equal(entry.agent_ref, expectedId);
    assert.equal(entry.group_text_only, true);
    assert.equal(entry.discretionary, undefined);
    assert.ok(!JSON.stringify(entry).includes(attachment.data));
    await answer(actor, room, message, message.reply_jobs[0], true);
  }
});

test("an existing single-member agent group answers naturally without creating fake mentions", async () => {
  const owner = await home(service.base, "natural-owner");
  const group = await owner.ok("POST", "/v1/ot/conversations", {
    kind: "group", account_group: true, title: "产品研发小队", agents: [lead, engineer, reviewer],
  });
  const room = roomPath(group);
  const native_group_host = await ownerId(owner);
  assert.deepEqual(group.group_agent_routing, {mode: "personal", default: "all", policy: {mode: "default"}, can_edit: true,
    native_group_host,native_group_coordinator:true});
  const send = (body: string, extras = {}) => owner.ok("POST", room + "/messages", {body, direct: true, ...extras});
  const ordinary = await send("帮我整理一下验收计划");
  assert.deepEqual(targets(ordinary), [lead.agent_ref, engineer.agent_ref, reviewer.agent_ref]);
  assert.deepEqual(ordinary.mentions, []);
  assert.equal(ordinary.body, "帮我整理一下验收计划");

  const hello = await send("你们好", {client_key: "natural-hello-fixture"});
  assert.deepEqual(targets(hello), [lead.agent_ref, engineer.agent_ref, reviewer.agent_ref]);
  assert.equal(hello.body, "你们好");
  const duplicate = await send("你们好", {client_key: "natural-hello-fixture"});
  assert.equal(duplicate.id, hello.id);
  assert.deepEqual(duplicate.reply_jobs, hello.reply_jobs);
  const loaded = (await owner.ok("GET", room + "/messages")).messages.find((row: any) => row.id === hello.id);
  assert.deepEqual(loaded.reply_jobs, hello.reply_jobs);
  assert.deepEqual(loaded.mentions, []);
  const requested = await send("都回复我一下");
  assert.deepEqual(targets(requested), targets(hello));
  const inbox = await owner.ok("GET", queue);
  assert.ok(inbox.jobs.some((row: any) => row.message.id === hello.id && row.discretionary === true));
  assert.ok(inbox.jobs.some((row: any) => row.message.id === requested.id && row.discretionary === true));
  assert.deepEqual((await owner.ok("GET", "/v1/ot/agent-inbox")).items, []);
  const replies = await Promise.all(hello.reply_jobs.map((job: Job) => answer(owner, room, hello, job)));
  assert.deepEqual((await owner.ok("GET", queue)).jobs.filter((row: any) => replies.some(reply => reply.id === row.message.id)), []);
  const followup = await send("请再解释一下", {reply_to: replies[1].id});
  assert.deepEqual(targets(followup), [engineer.agent_ref]);

  await owner.ok("PATCH", room + "/agents/" + reviewer.agent_ref, {auto_reply: true});
  assert.deepEqual((await owner.ok("GET", room)).group_agent_routing,
    {mode: "personal", default: "auto", policy: {mode: "default"}, can_edit: true,native_group_host,native_group_coordinator:true});
  const autos = await send("现在总结一下");
  assert.deepEqual(targets(autos), []);
  const addressed = await send("@研发工程师助理 你好");
  assert.deepEqual(targets(addressed), [engineer.agent_ref]);
  const explicitAll = await send("@所有智能体 再给一个建议");
  assert.deepEqual(targets(explicitAll), targets(hello));
  const latest = await owner.ok("GET", queue);
  assert.deepEqual(latest.items.filter((item: any) => item.message.id === autos.id).map((item: any) => item.agent_ref), [reviewer.agent_ref]);
  assert.deepEqual(latest.items.filter((item: any) => item.message.id === addressed.id), []);
  assert.equal((await owner.call("POST", room + "/agent-messages", {
    agent_ref: reviewer.agent_ref, body: "Unselected automatic answer", mode: "auto", reply_to: addressed.id,
  })).data.error.code, "reply_job_unavailable");

  const source = await owner.ok("POST", "/v1/ot/conversations", {
    kind: "group", account_group: true, title: "转发来源", agents: [lead],
  });
  const toForward = await owner.ok("POST", roomPath(source) + "/messages", {body: "你们好"});
  const forwarded = await owner.ok("POST", roomPath(source) + "/forward", {target_conversation_id: group.id, message_ids: [toForward.id]});
  assert.equal(forwarded.forwarded, 1);
  const copy = (await owner.ok("GET", room + "/messages")).messages.at(-1);
  assert.notEqual(copy.id, toForward.id);
  assert.deepEqual(copy.reply_jobs, []);
  assert.equal((await owner.ok("GET", queue)).items.some((item: any) => item.message.id === copy.id), false);
});

test("ordinary agents can remain silent using a scoped claim and see only visible earlier replies to that exact message", async () => {
  const [owner, stranger] = await Promise.all([home(service.base, "judgment-owner"), home(service.base, "judgment-other")]);
  const group = await owner.ok("POST", "/v1/ot/conversations", {
    kind: "group", account_group: true, title: "Native judgment", agents: [lead, engineer, reviewer],
  });
  const room = roomPath(group);
  const send = (body: string) => owner.ok("POST", room + "/messages", {body});
  const source = await send("hello everyone");
  const [first, second, third] = source.reply_jobs;
  const start = (job: Job, revision = source.revision) => ({action: "start", attempt: 1, source_revision: revision,
    claim_id: randomUUID(), accept_discretionary_reply: true});
  const path = (job: Job) => "/v1/ot/agent-reply-jobs/" + job.id;
  const claimFirst = start(first);
  assert.equal((await owner.call("POST", path(first), {...claimFirst, accept_discretionary_reply: undefined})).status, 409);
  assert.equal((await owner.call("POST", room + "/agent-messages", {
    agent_ref: first.agent_id, body: "Unclaimed legacy response", mode: "mention", reply_to: source.id,
  })).status, 409);
  assert.deepEqual(await owner.ok("POST", path(first), claimFirst), {ok: true, discretionary: true, prior_replies: []});
  const delivered = await owner.ok("POST", room + "/agent-messages", {
    agent_ref: first.agent_id, body: "I can review this release.", mode: "mention", reply_to: source.id,
    job_id: first.id, claim_id: claimFirst.claim_id, attempt: 1,
  });
  const unrelated = await send("@z-manager another question");
  await answer(owner, room, unrelated, unrelated.reply_jobs[0]);

  const claimSecond = start(second);
  const secondStart = await owner.ok("POST", path(second), claimSecond);
  assert.deepEqual(secondStart, {ok: true, discretionary: true,
    prior_replies: [{name: lead.name, text: "I can review this release."}]});
  assert.deepEqual(await owner.ok("POST", path(second), claimSecond), secondStart);
  const pass = {action: "pass", attempt: 1, claim_id: claimSecond.claim_id};
  assert.equal((await stranger.call("POST", path(second), pass)).status, 404);
  assert.equal((await owner.call("POST", path(second), {...pass, claim_id: randomUUID()})).status, 409);
  assert.equal((await owner.call("POST", path(second), {...pass, body: "No stored text"})).status, 400);
  assert.deepEqual(await owner.ok("POST", path(second), pass), {ok: true});
  assert.deepEqual(await owner.ok("POST", path(second), pass), {ok: true});
  assert.equal((await owner.call("POST", room + "/agent-messages", {
    agent_ref: second.agent_id, body: "Phantom after pass", mode: "mention", reply_to: source.id,
    job_id: second.id, claim_id: pass.claim_id, attempt: 1,
  })).status, 409);
  const rows = (await owner.ok("GET", room + "/messages")).messages;
  assert.deepEqual(rows.filter((message: any) => message.reply_to === source.id).map((message: any) => message.id), [delivered.id]);
  const current = rows.find((message: any) => message.id === source.id);
  assert.equal(current.reply_jobs[1].status, "passed");
  assert.equal(current.reply_jobs[1].can_retry, false);
  assert.equal((await owner.call("POST", room + "/messages/" + source.id + "/agent-retry", {job_id: second.id, attempt: 1})).status, 409);

  await owner.ok("POST", "/v1/ot/messages/" + delivered.id + "/hide", {conversation_id: group.id});
  const claimThird = start(third);
  assert.deepEqual(await owner.ok("POST", path(third), claimThird), {ok: true, discretionary: true, prior_replies: []});
  await owner.ok("DELETE", room + "/agents/" + third.agent_id);
  assert.equal((await owner.call("POST", path(third), {action: "pass", attempt: 1, claim_id: claimThird.claim_id})).status, 409);

  const required = await send("@所有人 都回复我一下");
  const [quiet, responding] = required.reply_jobs;
  const oldStart = {...start(quiet, required.revision), accept_discretionary_reply: undefined};
  assert.deepEqual(await owner.ok("POST", path(quiet), oldStart), {ok: true});
  const quietCompletion = {action:"pass", attempt:1, claim_id:oldStart.claim_id};
  assert.equal((await owner.call("POST", path(quiet), {...quietCompletion, claim_id:randomUUID()})).status, 409);
  assert.deepEqual(await owner.ok("POST", path(quiet), quietCompletion), {ok:true});
  assert.deepEqual(await owner.ok("POST", path(quiet), quietCompletion), {ok:true});
  assert.equal((await owner.call("POST", path(quiet) + "/progress", {
    attempt:1, claim_id:oldStart.claim_id, revision:1, text:"Late draft",
  })).status, 409);
  assert.equal((await owner.call("POST", room + "/agent-messages", {
    agent_ref:quiet.agent_id, reply_to:required.id, body:"Late reply", mode:"mention",
    job_id:quiet.id, attempt:1, claim_id:oldStart.claim_id,
  })).status, 409);
  const response = await answer(owner, room, required, responding);
  const afterExplicit = (await owner.ok("GET", room + "/messages")).messages;
  assert.deepEqual(afterExplicit.filter((row: any) => row.reply_to === required.id).map((row: any) => row.id), [response.id]);
  assert.equal(afterExplicit.find((row: any) => row.id === required.id).reply_jobs[0].status, "passed");
});

test("shared group workers judge ordinary text while explicit mentions preserve their audience and isolation", async () => {
  const [author, colleague, outsider] = await Promise.all([
    home(service.base, "natural-author"), home(service.base, "natural-peer"), home(service.base, "natural-other"),
  ]);
  const team = await author.ok("POST", "/v1/ot/teams", {name: "Shared team"});
  const {code} = await author.ok("POST", `/v1/ot/teams/${team.id}/invites`, {});
  await colleague.ok("POST", "/v1/ot/invites/accept", {code});
  const group = await author.ok("POST", "/v1/ot/conversations", {
    kind: "group", team_id: team.id, title: "共享产品讨论", members: [colleague.handle], agents: [lead],
  });
  const room = roomPath(group);
  await colleague.ok("PUT", room + "/agents/" + engineer.agent_ref, {name: engineer.name});
  assert.deepEqual((await author.ok("GET", room)).group_agent_routing, {mode: "shared", policy: {mode: "default"}, can_edit: true,
    native_group_host:await ownerId(author),native_group_coordinator:true});
  const conversation = await author.ok("POST", room + "/messages", {body: "你们好，这里先讨论排期"});
  const both = [lead.agent_ref, engineer.agent_ref];
  assert.deepEqual(targets(conversation), both);
  assert.deepEqual(conversation.mentions, []);
  assert.deepEqual((await colleague.ok("GET", queue)).items, []);
  const observation = await author.ok("POST", room + "/messages", {body: "所有智能体回复得太慢"});
  assert.deepEqual(targets(observation), both);
  const command = await author.ok("POST", room + "/messages", {body: "让智能体都回复我一下"});
  assert.deepEqual(targets(command), both);
  const alias = await author.ok("POST", room + "/messages", {body: "@all 请都检查一下"});
  assert.deepEqual(targets(alias), targets(command));
  const nativeAliases = [];
  for (const body of ["@Everyone Please check", "＠全体 请检查"]) {
    const message = await author.ok("POST", room + "/messages", {body});
    assert.deepEqual(targets(message), both);
    nativeAliases.push(message.id);
  }
  const literal = await author.ok("POST", room + "/messages", {
    body: "请检查这个例子：\n```text\n@all\n```\n[提示 @everyone](/help) 和 ` @全体`",
  });
  assert.deepEqual(targets(literal), both);
  assert.deepEqual(literal.mentions, []);
  const chinese = await author.ok("POST", room + "/messages", {
    body: `@所有人 @${colleague.handle} 都看一下`, client_key: "whole-room-exact-notice",
  });
  assert.deepEqual(targets(chinese), targets(command));
  assert.equal((await author.ok("POST", room + "/messages", {body: chinese.body, client_key: "whole-room-exact-notice"})).id, chinese.id);
  const mentioned = await colleague.ok("GET", "/v1/ot/notifications");
  assert.equal(mentioned.notifications.filter((notice: any) => notice.kind === "messenger.mention" && notice.data.message_id === chinese.id).length, 1);
  for (const id of nativeAliases) {
    assert.equal(mentioned.notifications.filter((notice: any) => notice.kind === "messenger.mention" && notice.data.message_id === id).length, 1);
  }
  assert.equal(mentioned.notifications.some((notice: any) => notice.kind === "messenger.mention" && notice.data.message_id === literal.id), false);
  for (const actor of [author, outsider]) {
    assert.equal((await actor.ok("GET", "/v1/ot/notifications")).notifications.some((notice: any) => notice.data.message_id === chinese.id), false);
  }
  const handle = await author.ok("POST", room + "/messages", {body: "@all.home 请检查一下"});
  assert.deepEqual(targets(handle), []);
  const colleagueId = await ownerId(colleague);
  const remote = command.reply_jobs.find((job: Job) => job.agent_owner_id === colleagueId);
  const agentInbox = await colleague.ok("GET", queue);
  const discretionary = [conversation, observation, command, literal].map(message => message.id);
  assert.deepEqual(agentInbox.jobs.filter((row: any) => row.discretionary).map((row: any) => row.message.id), discretionary);
  assert.equal(agentInbox.jobs.find((row: any) => row.job_id === remote.id).group_text_only, true);
  assert.equal(agentInbox.items.some((row: any) => row.message.id === command.id), false);
  assert.equal((await outsider.ok("GET", queue)).jobs.length, 0);
  assert.equal((await outsider.call("POST", room + "/messages", {body: "让智能体都回复我一下"})).status, 404);
  assert.equal((await colleague.call("POST", "/v1/ot/agent-reply-jobs/" + remote.id, {action: "start", attempt: 1})).status, 409);
  const reply = await answer(colleague, room, command, remote, true);
  const quoted = await author.ok("POST", room + "/messages", {body: "能举个例子吗？", reply_to: reply.id});
  assert.deepEqual(targets(quoted), [engineer.agent_ref]);
  assert.equal(quoted.reply_jobs[0].agent_owner_id, colleagueId);
});

test("typed shared group mentions resolve the longest eligible name without guessing between owners", async () => {
  const [sender, teammate] = await Promise.all([
    home(service.base, "native-name-sender"), home(service.base, "native-name-peer"),
  ]);
  const team = await sender.ok("POST", "/v1/ot/teams", {name: "Shared native mentions"});
  const {code} = await sender.ok("POST", `/v1/ot/teams/${team.id}/invites`, {});
  await teammate.ok("POST", "/v1/ot/invites/accept", {code});
  const group = await sender.ok("POST", "/v1/ot/conversations", {
    kind: "group", team_id: team.id, title: "Named discussion", members: [teammate.handle],
    agents: [{agent_ref: "product", name: "Product"}],
  });
  const room = roomPath(group);
  await teammate.ok("PUT", room + "/agents/manager", {name: "Product Manager"});
  const senderId = await ownerId(sender);
  const teammateId = await ownerId(teammate);
  const send = (body: string, extras = {}) => sender.ok("POST", room + "/messages", {body, ...extras});
  const requested = "＠product manager, could you review this?";
  const sent = await send(requested);
  assert.equal(sent.body, requested);
  assert.deepEqual(sent.mentions, [`/agent/${teammateId}/manager`]);
  assert.deepEqual(sent.reply_jobs.map((job: Job) => [job.agent_owner_id, job.agent_id]), [[teammateId, "manager"]]);
  assert.deepEqual(targets(await send("@Product, please review this.")), ["product"]);
  assert.deepEqual(targets(await send("@Product and @Product Manager.")), ["product", "manager"]);
  assert.deepEqual(targets(await send("@manager Please check")), ["manager"]);
  assert.deepEqual(targets(await send("@Product Managerial staff is a phrase.")), []);
  assert.deepEqual(targets(await send("@Product/guide.md is a file reference.")), []);
  const literal = await send("Read [the @Product Manager example](/guide) and `@Product Manager`.");
  assert.deepEqual(literal.mentions, []);
  assert.deepEqual(targets(literal), ["product", "manager"]);
  const inbox = await teammate.ok("GET", queue);
  assert.ok(inbox.jobs.some((job: any) => job.message.id === sent.id && job.discretionary === undefined && job.group_text_only));
  assert.ok(inbox.jobs.some((job: any) => job.message.id === literal.id && job.discretionary === true));

  await sender.ok("PUT", room + "/agents/manager", {name: "PRODUCT MANAGER"});
  const ambiguous = await send("@Product Manager, please review this.");
  assert.deepEqual(ambiguous.mentions, []);
  assert.deepEqual(targets(ambiguous), []);
  const selected = await send("Please review this.", {agent_mentions: [{owner_id:senderId,agent_id:"manager"}]});
  assert.deepEqual(selected.mentions, [`/agent/${senderId}/manager`]);
  assert.deepEqual(selected.reply_jobs.map((job: Job) => [job.agent_owner_id, job.agent_id]), [[senderId,"manager"]]);
  await teammate.ok("PUT", room + "/agents/reviewer", {name: "Manager"});
  const displayName = await send("@Manager, please review this.");
  assert.deepEqual(displayName.mentions, [`/agent/${teammateId}/reviewer`]);
  assert.deepEqual(targets(displayName), ["reviewer"]);
});

test("an active owner gets a bounded head start on shared ordinary text while explicit jobs remain available", async () => {
  const [author, colleague, outsider] = await Promise.all([
    home(service.base, "round-author"), home(service.base, "round-peer"), home(service.base, "round-outsider"),
  ]);
  const team = await author.ok("POST", "/v1/ot/teams", {name: "Shared discussion rounds"});
  const {code} = await author.ok("POST", `/v1/ot/teams/${team.id}/invites`, {});
  await colleague.ok("POST", "/v1/ot/invites/accept", {code});
  const group = await author.ok("POST", "/v1/ot/conversations", {
    kind: "group", team_id: team.id, title: "Group round", members: [colleague.handle], agents: [lead],
  });
  const room = roomPath(group);
  const peerSeat = `${room}/agents/${engineer.agent_ref}`;
  await colleague.ok("PUT", peerSeat, {name: engineer.name});
  const outsiderGroup = await outsider.ok("POST", "/v1/ot/conversations", {
    kind: "group", account_group: true, title: "Unrelated group", agents: [reviewer],
  });

  const send = (body: string) => author.ok("POST", room + "/messages", {body});
  const job = (message: {reply_jobs: Job[]}, agent: typeof lead) => message.reply_jobs.find(row => row.agent_id === agent.agent_ref)!;
  const jobRoute = (row: Job) => "/v1/ot/agent-reply-jobs/" + row.id;
  const start = (message: {revision: number}) => ({action: "start", attempt: 1, claim_id: randomUUID(),
    source_revision: message.revision, accept_group_text_turn: true, accept_discretionary_reply: true});
  const pass = (claim: ReturnType<typeof start>) => ({action: "pass", attempt: claim.attempt, claim_id: claim.claim_id});
  const turn = await send("Which part of the launch plan still needs review?");
  const first = job(turn,engineer), second = job(turn,lead);
  const firstClaim = start(turn), secondClaim = start(turn);
  assert.ok((await colleague.ok("GET",queue)).jobs.some((entry: any) => entry.job_id === first.id));
  assert.ok((await author.ok("GET",queue)).jobs.some((entry: any) => entry.job_id === second.id));
  // The second roster entry is online first; the unclaimed first entry never holds the round.
  assert.deepEqual(await colleague.ok("POST",jobRoute(first),firstClaim),
    {ok:true, group_text_only:true, discretionary:true, prior_replies:[]});
  const raced = await author.call("POST",jobRoute(second),secondClaim);
  assert.equal(raced.status,409);
  assert.equal(raced.data.error.code,"reply_job_unavailable");
  const stored = service.platform.db.prepare<[string], {status: string}>("SELECT status FROM ot_agent_reply_jobs WHERE id=?");
  assert.equal(stored.get(second.id)?.status,"queued");
  assert.ok(!(await author.ok("GET",queue)).jobs.some((entry: any) => entry.job_id === second.id));

  const direct = await send("@all Please check the date separately");
  const left = job(direct,lead), right = job(direct,engineer);
  assert.ok((await author.ok("GET",queue)).jobs.some((entry: any) => entry.job_id === left.id && !entry.discretionary));
  const leftClaim = start(direct), rightClaim = start(direct);
  await Promise.all([author.ok("POST",jobRoute(left),leftClaim),colleague.ok("POST",jobRoute(right),rightClaim)]);
  await Promise.all([author.ok("POST",jobRoute(left),pass(leftClaim)),colleague.ok("POST",jobRoute(right),pass(rightClaim))]);

  const followup = await send("Review the documentation in a separate round");
  const authorFollowup = job(followup,lead), peerFollowup = job(followup,engineer);
  const eachClaim = start(followup);
  await author.ok("POST",jobRoute(authorFollowup),eachClaim);
  await author.ok("POST",jobRoute(authorFollowup),pass(eachClaim));
  const otherClaim = start(followup);
  await colleague.ok("POST",jobRoute(peerFollowup),otherClaim);
  await colleague.ok("POST",jobRoute(peerFollowup),pass(otherClaim));

  const idle = await author.ok("GET",queue);
  const waiter = author.ok("GET",`${queue}&after=${idle.cursor}&wait_ms=8000`);
  let outsiderWoke = false;
  const outsiderWaiter = outsider.ok("GET",`${queue}&wait_ms=8000`).then(result => {outsiderWoke = true; return result;});
  await delay(25);
  const replyText = "The deployment calendar still needs a second reviewer.";
  await colleague.ok("POST",room + "/agent-messages", {agent_ref:first.agent_id, mode:"mention", body:replyText, reply_to:turn.id,
    job_id:first.id, attempt:1, claim_id:firstClaim.claim_id});
  assert.ok((await waiter).jobs.some((entry: any) => entry.job_id === second.id));
  assert.deepEqual(await author.ok("POST",jobRoute(second),secondClaim),
    {ok:true, discretionary:true, prior_replies:[{name:engineer.name,text:replyText}]});
  await author.ok("POST",jobRoute(second),pass(secondClaim));
  assert.equal(outsiderWoke,false);
  const unrelated = await outsider.ok("POST",roomPath(outsiderGroup) + "/messages", {body:"Check a separate project"});
  assert.ok((await outsiderWaiter).jobs.some((entry: any) => entry.message.id === unrelated.id));

  const abandoned = await send("Does this handoff need more information?");
  const active = job(abandoned,engineer), waiting = job(abandoned,lead);
  const activeClaim = start(abandoned), waitingClaim = start(abandoned);
  await colleague.ok("POST",jobRoute(active),activeClaim);
  const held = await author.ok("GET",queue);
  assert.ok(!held.jobs.some((entry: any) => entry.job_id === waiting.id));
  const waitedSince = Date.now();
  const bounded = await author.ok("GET",`${queue}&after=${held.cursor}&wait_ms=8000`);
  assert.ok(bounded.jobs.some((entry: any) => entry.job_id === waiting.id), "An unfinished remote turn must not stall the next owner");
  assert.ok(Date.now() - waitedSince < 6000, "Wake at the head-start deadline, before the ordinary long poll expires");
  assert.deepEqual(await author.ok("POST",jobRoute(waiting),waitingClaim),{ok:true,discretionary:true,prior_replies:[]});
  await author.ok("POST",jobRoute(waiting),pass(waitingClaim));
  await colleague.ok("POST",jobRoute(active),pass(activeClaim));
});

test("large groups bound ordinary judgment and explicitly reach the whole roster", async () => {
  const owner = await home(service.base, "natural-cap");
  const group = await owner.ok("POST", "/v1/ot/conversations", {kind: "group", account_group: true, title: "Roster", agents: [lead]});
  const room = roomPath(group);
  for (let index = 0; index < 21; index++) {
    await owner.ok("PUT", room + "/agents/number-" + index, {name: "Agent " + index});
  }
  const result = await owner.ok("POST", room + "/messages", {body: "请所有智能体都回答"});
  assert.equal(result.reply_jobs.length, 20);
  assert.equal(new Set(targets(result)).size, 20);
  assert.equal(targets(result)[0], lead.agent_ref);
  const requested = await owner.ok("POST", room + "/messages", {body: "@所有人 请检查发布计划"});
  assert.deepEqual(targets(requested), [
    lead.agent_ref, ...Array.from({length:21}, (_, index)=>"number-" + index),
  ]);
});
