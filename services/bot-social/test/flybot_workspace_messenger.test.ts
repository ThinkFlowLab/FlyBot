// FlyBot member messenger on Bot Social: DMs, groups, unread, reactions, edits, mentions and
// group agents answered by their owner's DS-Bot (agent inbox + capped auto replies). Fixtures only.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { bulkAuth, startServer } from "./helpers.js";
import { home } from "./flybot_workspace_helpers.js";

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(bulkAuth); });
after(async () => { await S.stop(); });

function teammateClaim(revision: number, attempt = 1, claim_id = randomUUID()) {
  return {action:"start", attempt, claim_id, source_revision:revision, accept_group_text_turn:true};
}

async function teamOf(...people: Awaited<ReturnType<typeof home>>[]) {
  const [owner, ...rest] = people;
  const team = await owner.ok("POST", "/v1/ot/teams", { name: "Msg team" });
  for (const p of rest) {
    const { code } = await owner.ok("POST", `/v1/ot/teams/${team.id}/invites`, {});
    await p.ok("POST", "/v1/ot/invites/accept", { code });
  }
  return team;
}

test("DMs only between teammates; one DM per pair; unread and read cursors", async () => {
  const A = await home(S.base, "dma");
  const B = await home(S.base, "dmb");
  const X = await home(S.base, "stranger");
  await teamOf(A, B);
  assert.equal((await X.call("POST", "/v1/ot/conversations", { kind: "dm", peer: A.handle })).status, 403);
  const dm = await A.ok("POST", "/v1/ot/conversations", { kind: "dm", peer: B.handle });
  const again = await B.ok("POST", "/v1/ot/conversations", { kind: "dm", peer: A.handle });
  assert.equal(again.id, dm.id);
  const m1 = await A.ok("POST", `/v1/ot/conversations/${dm.id}/messages`, { body: "hello B", client_key: "k1" });
  const dup = await A.ok("POST", `/v1/ot/conversations/${dm.id}/messages`, { body: "hello B", client_key: "k1" });
  assert.equal(dup.id, m1.id, "client_key makes sends idempotent");
  assert.equal((await B.ok("GET", "/v1/ot/conversations")).unread, 1);
  assert.equal((await A.ok("GET", "/v1/ot/conversations")).unread, 0);
  const page = await B.ok("GET", `/v1/ot/conversations/${dm.id}/messages`);
  assert.deepEqual(page.messages.map((m: any) => m.body), ["hello B"]);
  await A.ok("POST", `/v1/ot/conversations/${dm.id}/messages`, { body: "arrived after the page loaded" });
  const partial = await B.ok("POST", `/v1/ot/conversations/${dm.id}/read`, { seq: page.messages[0].seq });
  assert.equal(partial.unread, 1);
  const allRead = await B.ok("POST", `/v1/ot/conversations/${dm.id}/read`, {});
  assert.equal(allRead.unread, 0);
  assert.equal((await B.ok("GET", "/v1/ot/conversations")).unread, 0);
  assert.equal((await X.call("GET", `/v1/ot/conversations/${dm.id}/messages`)).status, 404, "outsiders see nothing");

  await B.ok("POST", `/v1/ot/messages/${m1.id}/reactions`, { emoji: "👍" });
  assert.equal((await B.call("POST", `/v1/ot/messages/${m1.id}/reactions`, { emoji: "💩" })).status, 400);
  assert.equal((await B.call("PATCH", `/v1/ot/messages/${m1.id}`, { body: "hijack" })).status, 403);
  await A.ok("PATCH", `/v1/ot/messages/${m1.id}`, { body: "hello again" });
  const after1 = (await A.ok("GET", `/v1/ot/conversations/${dm.id}/messages`)).messages.find((message: any) => message.id === m1.id);
  assert.equal(after1.body, "hello again");
  assert.equal(after1.reactions[0].count, 1);
  await A.ok("DELETE", `/v1/ot/messages/${m1.id}`);
  assert.equal((await B.ok("GET", `/v1/ot/conversations/${dm.id}/messages`)).messages.find((message: any) => message.id === m1.id).retracted, true);
});

test("batch hide is atomic, exact-room scoped and safely replays only for the acting member", async () => {
  const owner = await home(S.base, "hide-owner");
  const reader = await home(S.base, "hide-reader");
  const outsider = await home(S.base, "hide-outsider");
  const team = await teamOf(owner, reader);
  const {workspaces} = await owner.ok("GET", "/v1/ot/workspaces");
  const workspace = workspaces.find((row: any) => row.id === team.id).workspace_id;
  const group = await owner.ok("POST", "/v1/ot/conversations", {kind: "group", title: "Exact team group", team_id: team.id, members: [reader.handle]});
  const other = await owner.ok("POST", "/v1/ot/conversations", {kind: "group", title: "Other team group", team_id: team.id, members: [reader.handle]});
  const room = `/v1/ot/conversations/${group.id}/messages`;
  const own = await owner.ok("POST", room, {body: "Owner message"});
  const received = await reader.ok("POST", room, {body: "Reader message"});
  const elsewhere = await owner.ok("POST", `/v1/ot/conversations/${other.id}/messages`, {body: "Different conversation"});
  const ids = [own.id, received.id];
  const data = {workspace, message_ids: ids};
  const hide = room + "/hide";
  assert.equal((await outsider.call("POST", hide, data)).status, 404);
  assert.equal((await owner.call("POST", hide, {message_ids: ids, direct: true})).status, 404);
  assert.equal((await owner.call("POST", hide, {workspace, message_ids: [own.id, own.id]})).status, 400);
  assert.equal((await owner.call("POST", hide, {workspace, message_ids: [own.id, elsewhere.id]})).status, 404);
  const history = async (viewer: typeof owner) => (await viewer.ok("GET", room)).messages.map((message: any) => message.id);
  assert.deepEqual(await history(owner), ids);
  assert.deepEqual(await owner.ok("POST", hide, data), {hidden_message_ids: ids});
  assert.deepEqual(await owner.ok("POST", hide, data), {hidden_message_ids: ids});
  assert.deepEqual(await history(owner), []);
  assert.deepEqual(await history(reader), ids);
  assert.equal((await owner.ok("GET", `/v1/ot/conversations/${other.id}/messages`)).messages[0].id, elsewhere.id);
});

test("an unread entry starts at the first visible unacknowledged sequence and pages forward without marking it read", async () => {
  const sender = await home(S.base, "unread-sender");
  const reader = await home(S.base, "unread-reader");
  const unrelated = await home(S.base, "unread-outsider");
  const contact = await sender.ok("POST", "/v1/ot/contacts", {handle: reader.handle});
  await reader.ok("POST", `/v1/ot/contacts/${contact.id}`, {action: "accept"});
  const group = await sender.ok("POST", "/v1/ot/conversations", {kind: "group", account_group: true,
    title: "Continue reading", members: [reader.handle]});
  const room = `/v1/ot/conversations/${group.id}`;
  const sent = [];
  for (let index = 0; index < 15; index++) sent.push(await sender.ok("POST", room + "/messages", {body: `Message ${index}`}));
  await reader.ok("POST", room + "/read", {seq: sent[2].seq});
  await reader.ok("POST", `/v1/ot/messages/${sent[3].id}/hide`, {conversation_id: group.id});
  const unread = room + "/messages?unread=1&limit=5";
  const entry = await reader.ok("GET", unread);
  assert.deepEqual(entry.first_unread, {id: sent[4].id, seq: sent[4].seq});
  assert.equal(entry.read_seq, sent[2].seq);
  assert.equal(entry.has_newer, true);
  assert.deepEqual(entry.messages.map((row: any) => row.id), [sent[1].id, sent[2].id, sent[4].id, sent[5].id, sent[6].id]);
  const newer = await reader.ok("GET", `${room}/messages?after=${sent[6].seq}&limit=5`);
  assert.deepEqual(newer.messages.map((row: any) => row.id), sent.slice(7, 12).map(row => row.id));
  assert.equal((await reader.ok("GET", room)).read_seq, sent[2].seq);
  assert.equal((await sender.ok("GET", unread)).first_unread, null);
  assert.equal((await unrelated.call("GET", unread)).status, 404);
  assert.equal((await reader.call("GET", `${unread}&after=${sent[6].seq}`)).status, 400);
});

test("groups: members, mentions notify, creator removes, members leave", async () => {
  const A = await home(S.base, "ga");
  const B = await home(S.base, "gb");
  const C = await home(S.base, "gc");
  const team = await teamOf(A, B, C);
  const g = await A.ok("POST", "/v1/ot/conversations", { kind: "group", title: "Launch", team_id: team.id, members: [B.handle] });
  assert.equal(g.members.length, 2);
  await B.ok("POST", `/v1/ot/conversations/${g.id}/members`, { handle: C.handle });
  await B.ok("POST", `/v1/ot/conversations/${g.id}/messages`, { body: `@${C.handle} can you review?` });
  const notes = await C.ok("GET", "/v1/ot/notifications");
  assert.ok(notes.notifications.some((n: any) => n.kind === "messenger.mention" && n.data.conversation_id === g.id));
  assert.equal((await B.call("DELETE", `/v1/ot/conversations/${g.id}/members/${C.handle}`)).status, 403);
  await A.ok("DELETE", `/v1/ot/conversations/${g.id}/members/${C.handle}`);
  assert.equal((await C.call("GET", `/v1/ot/conversations/${g.id}`)).status, 404);
  await B.ok("DELETE", `/v1/ot/conversations/${g.id}/members/${B.handle}`);
  assert.equal((await A.ok("GET", `/v1/ot/conversations/${g.id}`)).members.length, 1);
});

test("conversation mute hides scoped inbox rows without consuming read receipts or affecting other members", async () => {
  const [sender, reader, colleague] = await Promise.all([
    home(S.base, "muted-sender"), home(S.base, "muted-reader"), home(S.base, "muted-colleague"),
  ]);
  const team = await teamOf(sender, reader, colleague);
  const workspace = (await sender.ok("GET", "/v1/ot/workspaces")).workspaces.find((row: any) => row.id === team.id).workspace_id;
  const options = {kind:"group", team_id:team.id, members:[reader.handle,colleague.handle]};
  const muted = await sender.ok("POST", "/v1/ot/conversations", {...options, title:"Muted group"});
  const active = await sender.ok("POST", "/v1/ot/conversations", {...options, title:"Active group"});
  const mutedPath = "/v1/ot/conversations/" + muted.id;
  const notifications = "/v1/ot/notifications";
  const scoped = notifications + "?workspace_id=" + workspace + "&unread=1";
  const mark = (account: typeof reader) => account.ok("POST", notifications + "/read", {workspace_id:workspace, all:true});
  await Promise.all([mark(reader), mark(colleague)]);

  const address = `@${reader.handle} @${colleague.handle}`;
  await sender.ok("POST", mutedPath + "/messages", {body:address + " first mention"});
  const before = await reader.ok("GET", scoped);
  assert.equal(before.unread, 1);
  const hiddenId = before.notifications[0].id;
  const readSeq = (await reader.ok("GET", mutedPath)).read_seq;
  assert.equal((await reader.ok("PATCH", mutedPath, {muted:true})).muted, true);
  assert.equal((await reader.ok("GET", scoped)).unread, 0);
  await sender.ok("POST", mutedPath + "/messages", {body:address + " second mention"});
  await sender.ok("POST", mutedPath + "/messages", {workspace, attachment:{
    title:"private-work.txt", mime:"text/plain", data:Buffer.from("Shared via chat").toString("base64"),
    resource:{title:"Private work", kind:"document", revision:1},
  }});
  await sender.ok("POST", `/v1/ot/conversations/${active.id}/messages`, {body:address + " visible mention"});
  await colleague.ok("POST", "/v1/ot/follows", {handle:reader.handle});

  const inbox = await reader.ok("GET", scoped + "&limit=1&latest=1");
  assert.equal(inbox.unread, 2);
  assert.deepEqual(inbox.notifications.map((row: any) => row.kind), ["follow.new"]);
  assert.deepEqual((await reader.ok("GET", scoped)).notifications.map((row: any) => row.kind), ["messenger.mention", "follow.new"]);
  assert.equal((await reader.ok("GET", scoped + "&kind=work")).unread, 0);
  assert.equal((await colleague.ok("GET", scoped)).unread, 4);
  assert.equal((await colleague.ok("GET", scoped + "&kind=work")).unread, 1);
  assert.equal((await reader.call("POST", notifications + "/read", {workspace_id:workspace, notification_id:hiddenId})).status, 404);
  assert.deepEqual(await mark(reader), {marked:2, unread:0});
  assert.equal((await reader.ok("GET", mutedPath)).read_seq, readSeq);

  assert.equal((await reader.ok("PATCH", mutedPath, {muted:false})).muted, false);
  const restored = await reader.ok("GET", scoped);
  assert.equal(restored.unread, 3);
  assert.deepEqual(restored.notifications.map((row: any) => row.kind), ["messenger.mention", "messenger.mention", "artifact.shared"]);
  assert.ok(restored.notifications.every((row: any) => row.data.conversation_id === muted.id));
  assert.equal((await reader.ok("GET", mutedPath)).read_seq, readSeq);
});

test("personal group ownership changes are revisioned and a replay cannot remove a renewed membership", async () => {
  const [owner,next,reader] = await Promise.all([
    home(S.base,"manage-personal-owner"), home(S.base,"manage-personal-successor"), home(S.base,"manage-personal-reader"),
  ]);
  for (const contact of [next,reader]) {
    const request = await owner.ok("POST","/v1/ot/contacts",{handle:contact.handle});
    await contact.ok("POST","/v1/ot/contacts/"+request.id,{action:"accept"});
  }
  const group = await owner.ok("POST","/v1/ot/conversations",{
    kind:"group",account_group:true,title:"Personal planning",members:[next.handle,reader.handle],
  });
  const path = "/v1/ot/conversations/"+group.id;
  const management = path+"/management";
  const nextId = group.members.find((member: any) => member.handle === next.handle).owner_id;
  const readerId = group.members.find((member: any) => member.handle === reader.handle).owner_id;
  const actor = group.group_management.owner_id;
  const firstRevision = group.group_management.revision;
  const leave = {action:"leave",revision:firstRevision,direct:true};
  assert.equal(group.group_management.leave_requires_transfer,true);
  assert.equal(group.group_management.can_leave,false);
  const refused = await owner.call("POST",management,leave);
  assert.equal(refused.status,409);
  assert.equal(refused.data.error.code,"group_owner_transfer_required");
  assert.equal((await owner.call("DELETE",path+"/members/"+owner.handle)).status,409);
  assert.equal((await reader.call("PATCH",path,{title:"Cannot edit"})).status,403);
  assert.equal((await reader.call("POST",management,{action:"rename",title:"Cannot edit",revision:firstRevision,direct:true})).status,403);

  const source = await reader.ok("POST",path+"/messages",{body:"Retained note"});
  assert.equal((await owner.ok("GET",path)).group_management.revision,firstRevision);
  const rename = {action:"rename",title:"Renamed planning",revision:firstRevision,direct:true};
  const renamed = (await owner.ok("POST",management,rename)).conversation;
  assert.equal(renamed.title,"Renamed planning");
  assert.equal((await owner.ok("POST",management,rename)).conversation.group_management.revision,renamed.group_management.revision);
  const stale = await owner.call("POST",management,{...rename,title:"Overlapping update"});
  assert.equal(stale.status,409);
  assert.equal(stale.data.error.code,"group_management_conflict");
  const transfer = {action:"transfer",member_id:nextId,revision:renamed.group_management.revision,direct:true};
  const transferred = (await owner.ok("POST",management,transfer)).conversation;
  assert.equal(transferred.group_management.owner_id,nextId);
  assert.equal(transferred.group_management.can_rename,false);
  assert.notEqual(transferred.activity_version,renamed.activity_version);
  assert.equal((await owner.ok("POST",management,transfer)).conversation.group_management.owner_id,nextId);
  assert.equal((await owner.call("DELETE",path+"/members/"+reader.handle)).status,403);
  assert.equal((await owner.call("POST",path+"/announcement",{body:"Former owner",revision:0})).status,403);
  await next.ok("POST",path+"/announcement",{body:"Updated by group owner",revision:0});

  const leavePayload = {...leave,revision:transferred.group_management.revision};
  const departed = {left:true,conversation_id:group.id};
  assert.deepEqual(await owner.ok("POST",management,leavePayload),departed);
  assert.equal((await owner.call("GET",path)).status,404);
  assert.deepEqual(await owner.ok("POST",management,leavePayload),departed);
  assert.equal((await reader.call("POST",management,leavePayload)).status,409);
  await next.ok("POST",path+"/members",{handle:owner.handle});
  assert.deepEqual(await owner.ok("POST",management,leavePayload),departed);
  const rejoined = await owner.ok("GET",path);
  assert.ok(rejoined.members.some((member: any) => member.owner_id === actor));
  assert.ok((await next.ok("GET",path+"/messages")).messages.some((message: any) => message.id === source.id));
  const distance = await next.ok("POST",management,{action:"remove",member_id:readerId,revision:rejoined.group_management.revision,direct:true});
  assert.ok(!distance.conversation.members.some((member: any) => member.owner_id === readerId));
  assert.equal((await reader.call("GET",path+"/messages")).status,404);
});

test("team group recovery and removal respect active scope, revoke call peers and retain history", async () => {
  const [teamOwner,creator,admin,reader] = await Promise.all([
    home(S.base,"manage-team-owner"), home(S.base,"manage-team-creator"),
    home(S.base,"manage-team-admin"), home(S.base,"manage-team-reader"),
  ]);
  const team = await teamOf(teamOwner,creator,admin,reader);
  const otherTeam = await teamOf(teamOwner,admin);
  await teamOwner.ok("PATCH",`/v1/ot/teams/${team.id}/members/${admin.handle}`,{role:"admin"});
  const {workspaces} = await admin.ok("GET","/v1/ot/workspaces");
  const workspace = workspaces.find((row: any) => row.id === team.id).workspace_id;
  const wrongWorkspace = workspaces.find((row: any) => row.id === otherTeam.id).workspace_id;
  const group = await creator.ok("POST","/v1/ot/conversations",{
    kind:"group",team_id:team.id,title:"Recoverable review",members:[admin.handle,reader.handle],
  });
  const path = "/v1/ot/conversations/"+group.id, management = path+"/management";
  const adminId = group.members.find((member: any) => member.handle === admin.handle).owner_id;
  const readerId = group.members.find((member: any) => member.handle === reader.handle).owner_id;
  const creatorId = group.group_management.owner_id;
  const transfer = {action:"transfer",workspace,member_id:adminId,revision:group.group_management.revision};
  assert.equal((await admin.call("POST",management,transfer)).status,403);
  assert.equal((await teamOwner.call("POST",management,transfer)).status,404);
  assert.equal((await admin.call("POST",management,{...transfer,workspace:wrongWorkspace})).status,404);
  const membership = `/v1/ot/teams/${team.id}/members/${creator.handle}`;
  await teamOwner.ok("PATCH",membership,{suspended:true});
  assert.equal((await creator.call("GET",path)).status,404);
  assert.equal((await creator.call("GET",path+"/messages")).status,404);
  assert.equal((await creator.call("PATCH",path,{title:"Suspend bypass"})).status,404);
  const orphan = await admin.ok("GET",path);
  assert.equal(orphan.group_management.owner_inactive,true);
  assert.equal(orphan.group_management.can_rename,false);
  assert.equal(orphan.group_management.can_transfer,true);
  assert.ok(!orphan.group_management.active_member_ids.includes(creatorId));
  const recover = {...transfer,revision:orphan.group_management.revision};
  assert.equal((await admin.call("POST",management,{...recover,member_id:creatorId})).data.error.code,"member_not_found");
  const restored = (await admin.ok("POST",management,recover)).conversation;
  assert.equal(restored.group_management.owner_inactive,false);
  assert.equal(restored.group_management.owner_id,adminId);
  assert.equal(restored.group_management.can_rename,true);

  const call = path+"/call";
  const firstPeer = "management-admin-peer", secondPeer = "management-reader-peer";
  await reader.ok("PATCH",path,{muted:true,pinned:true});
  await reader.ok("PUT",path+"/agents/reader-helper",{name:"Reader helper"});
  const message = await admin.ok("POST",path+"/messages",{body:"@reader-helper Preserve this note"});
  const job = message.reply_jobs[0].id;
  const live = await admin.ok("POST",call+"/join",{kind:"video",start:true,peer_id:firstPeer});
  await reader.ok("POST",call+"/join",{kind:"video",peer_id:secondPeer});
  await admin.ok("POST",call+"/signal",{call_id:live.call.id,peer_id:firstPeer,to:secondPeer,client_key:"management-signal-key",
    description:{type:"offer",sdp:"v=0\r\n"}});
  const staleRemoval = {action:"remove",workspace,member_id:readerId,revision:restored.group_management.revision};
  assert.equal((await admin.call("POST",management,staleRemoval)).data.error.code,"group_management_conflict");
  const current = await admin.ok("GET",path);
  const removal = {...staleRemoval,revision:current.group_management.revision};
  const removed = (await admin.ok("POST",management,removal)).conversation;
  assert.ok(!removed.members.some((member: any) => member.owner_id === readerId));
  assert.equal(removed.agents.length,0);
  assert.deepEqual((await admin.ok("GET",call)).call.peers.map((peer: any) => peer.id),[firstPeer]);
  assert.equal((await reader.call("POST",call+"/poll",{call_id:live.call.id,peer_id:secondPeer})).status,404);
  assert.equal((await reader.call("POST",management,{action:"leave",workspace,revision:removed.group_management.revision})).status,404);
  assert.equal(S.platform.db.prepare<[string], {count: number}>("SELECT COUNT(*) AS count FROM ot_call_signals WHERE call_id=?").get(live.call.id)?.count,0);
  assert.equal(S.platform.db.prepare<[string], {status: string}>("SELECT status FROM ot_agent_reply_jobs WHERE id=?").get(job)?.status,"failed");
  assert.deepEqual((await admin.ok("POST",management,removal)).conversation.members,removed.members);

  const leave = {action:"leave",workspace,revision:removed.group_management.revision};
  const receipt = {left:true,conversation_id:group.id};
  assert.equal(removed.group_management.can_leave,true);
  assert.deepEqual(await admin.ok("POST",management,leave),receipt);
  assert.deepEqual(await admin.ok("POST",management,leave),receipt);
  assert.equal((await admin.call("GET",path+"/messages")).status,404);
  assert.equal((await admin.call("GET",call)).status,404);
  assert.equal((await admin.ok("GET","/v1/ot/call-records/"+live.call.id)).record.ended_at !== null,true);
  await teamOwner.ok("PATCH",membership,{suspended:false});
  assert.equal((await creator.call("GET",path)).status,404);
  assert.equal(S.platform.db.prepare<[string], {body: string}>("SELECT body FROM ot_messages WHERE id=?").get(message.id)?.body,message.body);
  assert.ok(S.platform.db.prepare<[string], {group_archived_at: number}>("SELECT group_archived_at FROM ot_conversations WHERE id=?").get(group.id)?.group_archived_at);
});

test("groups add multiple teammates atomically and notify each new member once", async () => {
  const owner = await home(S.base, "batch-owner");
  const first = await home(S.base, "batch-first");
  const second = await home(S.base, "batch-second");
  const outsider = await home(S.base, "batch-outside");
  const team = await teamOf(owner, first, second);
  const group = await owner.ok("POST", "/v1/ot/conversations", { kind: "group", title: "Review", team_id: team.id });
  const path = `/v1/ot/conversations/${group.id}`;
  const denied = await owner.call("POST", path + "/members", { handles: [first.handle, outsider.handle] });
  assert.equal(denied.status, 403);
  assert.equal((await first.call("GET", path)).status, 404);
  assert.equal((await first.ok("GET", "/v1/ot/notifications")).notifications
    .filter((notice: any) => notice.data.conversation_id === group.id).length, 0);
  const added = await owner.ok("POST", path + "/members", { handles: [first.handle, second.handle] });
  assert.equal(added.members.length, 3);
  await owner.ok("POST", path + "/members", { handles: [first.handle, second.handle, first.handle] });
  for (const person of [first, second]) {
    assert.equal((await person.ok("GET", path)).id, group.id);
    const notes = await person.ok("GET", "/v1/ot/notifications");
    assert.equal(notes.notifications.filter((notice: any) =>
      notice.kind === "messenger.added" && notice.data.conversation_id === group.id).length, 1);
  }
});

test("live calls notify members and relay signals only to their target peer", async () => {
  const owner = await home(S.base, "call-owner");
  const member = await home(S.base, "call-member");
  const outsider = await home(S.base, "call-outside");
  const team = await teamOf(owner, member, outsider);
  const group = await owner.ok("POST", "/v1/ot/conversations", {kind: "group", title: "Standup", team_id: team.id, members: [member.handle]});
  const root = `/v1/ot/conversations/${group.id}/call`;
  const first = "tab-owner-123456789";
  const second = "tab-member-12345678";
  assert.equal((await outsider.call("GET", root)).status, 404);
  assert.deepEqual(await member.ok("GET", root), {call: null});
  const started = await owner.ok("POST", root + "/join", {kind: "video", start: true, peer_id: first});
  const callId = started.call.id;
  const recordPath = "/v1/ot/call-records/" + callId;
  assert.equal(started.call.kind, "video");
  assert.equal((await owner.ok("POST", root + "/join", {kind: "video", start: true, peer_id: first})).call.id, callId);
  assert.equal((await owner.call("POST", root + "/join", {kind: "video", start: true, peer_id: "tab-duplicate-12345678"})).status, 409);
  const notes = await member.ok("GET", "/v1/ot/notifications");
  assert.equal(notes.notifications.filter((note: any) => note.kind === "messenger.call" && note.data.conversation_id === group.id).length, 1);
  const joined = await member.ok("POST", root + "/join", {kind: "video", peer_id: second});
  assert.equal(joined.call.id, callId);
  assert.equal(joined.call.peers.length, 2);
  const signal = {call_id: callId, peer_id: first, to: second, client_key: "signal-once-123456",
    description: {type: "offer", sdp: "v=0\r\n"}};
  await owner.ok("POST", root + "/signal", signal);
  await owner.ok("POST", root + "/signal", signal);
  assert.equal((await outsider.call("POST", root + "/poll", {call_id: callId, peer_id: second})).status, 404);
  assert.equal((await member.call("POST", root + "/poll", {call_id: callId, peer_id: first})).status, 404);
  assert.deepEqual((await owner.ok("POST", root + "/poll", {call_id: callId, peer_id: first})).signals, []);
  const received = await member.ok("POST", root + "/poll", {call_id: callId, peer_id: second});
  assert.equal(received.signals.length, 1);
  assert.deepEqual(received.signals[0].description, signal.description);
  assert.equal((await member.call("GET", recordPath)).data.error.code, "meeting_call_active");
  assert.deepEqual(await owner.ok("POST", root + "/leave", {call_id: callId, peer_id: first}), {left: true});
  assert.equal((await owner.call("GET", recordPath)).status, 409);
  assert.equal((await member.ok("GET", root)).call.peers.length, 1);
  assert.deepEqual(await member.ok("POST", root + "/leave", {call_id: callId, peer_id: second}), {left: true, handoff: {id: callId}});
  assert.deepEqual(await member.ok("GET", root), {call: null});
  const ownerRecord = (await owner.ok("GET", recordPath)).record;
  assert.deepEqual((await member.ok("GET", recordPath)).record, ownerRecord);
  assert.equal(ownerRecord.title, "Standup");
  assert.equal(ownerRecord.started_at, started.call.created_at);
  assert.equal(ownerRecord.attendees.length, 2);
  assert.equal((await outsider.call("GET", recordPath)).status, 404);
});

test("group memory sources page past the activation cursor with current membership and revisions", async () => {
  const owner = await home(S.base,"sources-owner");
  const member = await home(S.base,"sources-member");
  const other = await home(S.base,"sources-outsider");
  const team = await teamOf(owner,member,other);
  const workspaceId = (await owner.ok("GET","/v1/ot/workspaces")).workspaces.find((row: any)=>row.id===team.id).workspace_id;
  const group = await owner.ok("POST","/v1/ot/conversations",{
    kind:"group",title:"Memory source group",team_id:team.id,members:[member.handle],
  });
  const room = `/v1/ot/conversations/${group.id}`;
  const sources = room + "/memory-sources";
  const old = await owner.ok("POST",room + "/messages",{body:"Before enabling"});
  const read = (args: object) => member.ok("POST",sources,{workspace_id:workspaceId,...args});
  const start = await read({message_ids:[]});
  assert.equal(start.cursor,old.seq);
  assert.deepEqual(start.items,[]);
  assert.equal((await other.call("POST",sources,{workspace_id:workspaceId,after:0})).status,404);
  assert.equal((await member.call("POST",sources,{after:0})).status,404);
  const incoming = [];
  for (let i=0;i<14;i++) incoming.push(await owner.ok("POST",room + "/messages",{body:`Plan ${i}`}));
  await owner.ok("DELETE",`/v1/ot/messages/${incoming[2].id}`);
  await owner.ok("PATCH",`/v1/ot/messages/${incoming[4].id}`,{body:"Updated plan"});
  const first = await read({after:start.cursor});
  assert.equal(first.membership,start.membership);
  assert.deepEqual(first.items.map((item: any)=>item.id),incoming.slice(0,13).filter((_,i)=>i!==2).map(message=>message.id));
  assert.deepEqual(first.items[3],{
    id:incoming[4].id,revision:2,title:"Memory source group",author:first.items[0].author,text:"Updated plan",
  });
  const last = await read({after:first.cursor});
  assert.deepEqual(last.items.map((item: any)=>item.id),[incoming.at(-1).id]);
  assert.equal(last.cursor,incoming.at(-1).seq);
  assert.deepEqual((await read({message_ids:[incoming[2].id,old.id]})).items.map((item: any)=>item.id),[old.id]);
  await owner.ok("DELETE",room + "/members/" + member.handle);
  assert.equal((await member.call("POST",sources,{workspace_id:workspaceId,after:last.cursor})).status,404);
});

test("shared group memory is scoped, cited by group agents and retired when a source changes", async () => {
  const owner = await home(S.base, "memory-owner");
  const member = await home(S.base, "memory-member");
  const other = await home(S.base, "memory-outsider");
  const team = await teamOf(owner, member, other);
  const group = await owner.ok("POST", "/v1/ot/conversations", {
    kind: "group", title: "Launch planning", team_id: team.id, members: [member.handle],
  });
  const elsewhere = await owner.ok("POST", "/v1/ot/conversations", {
    kind: "group", title: "Different group", team_id: team.id, members: [member.handle],
  });
  const room = `/v1/ot/conversations/${group.id}`;
  const memory = room + "/memories";
  const author = await owner.ok("POST", room + "/messages", {body:"Launch discussion"});
  const decision = await member.ok("POST", room + "/messages", {body:"Launch on Friday"});
  const unrelated = await owner.ok("POST", `/v1/ot/conversations/${elsewhere.id}/messages`, {body:"Unrelated"});
  const draft = {
    title:"Launch date", body:"The rollout is scheduled for Friday.",
    client_key:"launch-note-revision-one", source_message_id:decision.id,
    sources:[{id:author.id,revision:author.revision}, {id:decision.id,revision:decision.revision}],
  };
  assert.equal((await other.call("POST", memory, draft)).status,404);
  assert.equal((await other.call("GET", memory)).status,404);
  assert.equal((await owner.call("POST", memory, {
    ...draft,sources:[...draft.sources, {id:unrelated.id,revision:unrelated.revision}],
  })).status,409);
  const {item} = await owner.ok("POST", memory, draft);
  assert.equal((await owner.ok("POST", memory, draft)).item.id,item.id);
  assert.equal((await member.ok("GET",memory)).items[0].body,draft.body);
  assert.equal((await member.call("DELETE", `${memory}/${item.id}`)).status,404);
  assert.deepEqual((await owner.ok("GET", `/v1/ot/conversations/${elsewhere.id}/memories`)).items,[]);

  await member.ok("PUT", room + "/agents/launch-helper", {name:"Launch Helper",auto_reply:false});
  const source = await owner.ok("POST",room + "/messages",{body:"@launch-helper launch date?"});
  const inbox = await member.ok("GET","/v1/ot/agent-inbox?managed=1");
  assert.deepEqual(inbox.jobs[0].group_memories,[{id:item.id,title:draft.title,body:draft.body}]);
  const claim = teammateClaim(source.revision);
  const jobId = source.reply_jobs[0].id;
  await member.ok("POST",`/v1/ot/agent-reply-jobs/${jobId}`,claim);
  const reply = {agent_ref:"launch-helper", body:"Friday", reply_to:source.id, mode:"mention",
    job_id:jobId, attempt:claim.attempt, claim_id:claim.claim_id};
  const sent = await member.ok("POST",room + "/agent-messages",{...reply,group_memory_ids:[item.id]});
  assert.deepEqual(sent.group_memory_refs,[{id:item.id,title:draft.title}]);

  await owner.ok("PATCH",`/v1/ot/messages/${author.id}`,{body:"Changed secondary source"});
  assert.deepEqual((await member.ok("GET", memory)).items,[]);
  assert.equal((await owner.call("POST",memory,draft)).status,409);
  const next = await owner.ok("POST",room + "/messages",{body:"@launch-helper new launch date?"});
  const nextClaim = teammateClaim(next.revision);
  const nextId = next.reply_jobs[0].id;
  await member.ok("POST",`/v1/ot/agent-reply-jobs/${nextId}`,nextClaim);
  assert.equal((await member.call("POST",room + "/agent-messages",{
    ...reply,reply_to:next.id,job_id:nextId,claim_id:nextClaim.claim_id,group_memory_ids:[item.id],
  })).status,409);
  const after = await owner.ok("GET",room + "/messages");
  assert.deepEqual(after.messages.find((m: any) => m.id === sent.id).group_memory_refs,[]);
});

test("group agents: the owner's DS-Bot gets mentions and auto-reply turns; auto replies capped at 3/hour", async () => {
  const A = await home(S.base, "agowner");
  const B = await home(S.base, "agpeer");
  await teamOf(A, B);
  const g = await B.ok("POST", "/v1/ot/conversations", { kind: "group", title: "Agents", members: [A.handle] });
  await A.ok("PUT", `/v1/ot/conversations/${g.id}/agents/helper`, { name: "Helper", auto_reply: false });
  assert.equal((await B.call("POST", `/v1/ot/conversations/${g.id}/agent-messages`, { agent_ref: "helper", body: "spoof" })).status, 404, "only the agent's owner posts as it");
  const ordinary = await B.ok("POST", `/v1/ot/conversations/${g.id}/messages`, { body: "no mention here" });
  const request = await B.ok("POST", `/v1/ot/conversations/${g.id}/messages`, { body: "@helper summarize please" });
  assert.deepEqual((await A.ok("GET", "/v1/ot/agent-inbox")).items, [], "a teammate mention never runs on a legacy worker");
  let inbox = await A.ok("GET", "/v1/ot/agent-inbox?managed=1");
  assert.deepEqual(inbox.jobs.map((item: any) => [item.message.id, item.mode, item.discretionary === true, item.group_text_only]), [
    [ordinary.id, "mention", true, true], [request.id, "mention", false, true],
  ]);
  assert.equal(inbox.jobs.find((item: any) => item.message.id === request.id).context.length, 2);
  assert.equal((await B.ok("GET", "/v1/ot/agent-inbox")).items.length, 0, "B owns no agent");
  const claim = teammateClaim(request.revision);
  const jobId = request.reply_jobs[0].id;
  await A.ok("POST", `/v1/ot/agent-reply-jobs/${jobId}`, claim);
  const reply = await A.ok("POST", `/v1/ot/conversations/${g.id}/agent-messages`, {
    agent_ref: "helper", body: "Summary: …", reply_to: request.id, mode: "mention",
    job_id:jobId, attempt:claim.attempt, claim_id:claim.claim_id,
  });
  assert.equal(reply.author.kind, "agent");
  assert.equal(reply.author.name, "Helper");
  inbox = await A.ok("GET", `/v1/ot/agent-inbox?after=${inbox.cursor}`);
  assert.equal(inbox.items.length, 0, "agent messages never re-enter the inbox");

  const agentSettings = `/v1/ot/conversations/${g.id}/agents/helper`;
  const old = await B.ok("POST", `/v1/ot/conversations/${g.id}/messages`, { body: "before the switch" });
  assert.equal((await B.call("PATCH",agentSettings, {auto_reply: true})).status, 404);
  assert.deepEqual(await A.ok("PATCH",agentSettings, {auto_reply:true}), {auto_reply:true});
  assert.equal((await A.ok("GET", `/v1/ot/conversations/${g.id}`)).agents[0].auto_reply, true);

  const cursor = inbox.cursor;
  for (let i = 0; i < 4; i++) await B.ok("POST", `/v1/ot/conversations/${g.id}/messages`, { body: `thought ${i}` });
  inbox = await A.ok("GET", `/v1/ot/agent-inbox?after=${cursor}`);
  assert.equal(inbox.items.length, 4);
  assert.ok(inbox.items.every((x: any) => x.mode === "auto"));
  assert.ok(inbox.items.every((x: any) => x.message.id !== old.id));
  assert.equal((await A.call("POST", `/v1/ot/conversations/${g.id}/agent-messages`, {
    agent_ref: "helper", body: "stale auto", mode: "auto", reply_to: old.id
  })).status, 409);
  for (let i = 0; i < 3; i++) await A.ok("POST", `/v1/ot/conversations/${g.id}/agent-messages`, { agent_ref: "helper", body: `auto ${i}`, mode: "auto" });
  const capped = await A.call("POST", `/v1/ot/conversations/${g.id}/agent-messages`, { agent_ref: "helper", body: "auto 4", mode: "auto" });
  assert.equal(capped.status, 429);
  assert.equal(capped.data.error.code, "agent_reply_limit");
  assert.deepEqual(await A.ok("PATCH",agentSettings, {auto_reply:false}), {auto_reply:false});
  assert.equal((await A.call("POST", `/v1/ot/conversations/${g.id}/agent-messages`, {
    agent_ref: "helper", body: "disabled while a turn was running", mode: "auto", reply_to: inbox.items[3].message.id
  })).status, 409);
});

test("explicit mentions address the selected owner, even when agents share IDs and names", async () => {
  const A = await home(S.base, "mention-a");
  const B = await home(S.base, "mention-b");
  const C = await home(S.base, "mention-c");
  await teamOf(A, B, C);
  const group = await A.ok("POST", "/v1/ot/conversations", {
    kind: "group", title: "Mentions", members: [B.handle, C.handle],
  });
  const root = `/v1/ot/conversations/${group.id}`;
  await B.ok("PUT", root + "/agents/shared", {name: "Helper"});
  await C.ok("PUT", root + "/agents/shared", {name: "Helper"});
  const owner = (await B.ok("GET", "/v1/ot/me")).owner_id;
  const target = {owner_id:owner, agent_id:"shared"};
  const posted = await A.ok("POST", root + "/messages", {body:"Please check", agent_mentions:[target]});
  assert.equal(posted.body, "@Helper Please check");
  const forB = await B.ok("GET","/v1/ot/agent-inbox?managed=1");
  assert.deepEqual(forB.jobs.map((entry: any) => [entry.message.id, entry.agent_ref, entry.mode]),
    [[posted.id, "shared", "mention"]]);
  assert.deepEqual((await C.ok("GET", "/v1/ot/agent-inbox?managed=1")).jobs, []);
  const removed = await A.call("POST", root + "/messages", {
    body:"Still there?", agent_mentions:[{owner_id:owner, agent_id:"missing"}],
  });
  assert.equal(removed.status,400);
  assert.equal((await A.ok("GET", root + "/messages")).messages.length, 1);

  await B.ok("PUT", root + "/agents/second", {name:"第二位助手"});
  const both = await A.ok("POST", root + "/messages", {
    body:"各给一个答案", agent_mentions:[target, {owner_id:owner,agent_id:"second"}],
  });
  assert.equal(both.body,"@Helper @第二位助手 各给一个答案");
  const page = await B.ok("GET", `/v1/ot/agent-inbox?managed=1&after=${forB.cursor}`);
  assert.deepEqual(page.jobs.filter((entry: any) => entry.message.id === both.id).map((entry: any) => entry.agent_ref).sort(), ["second","shared"]);
  assert.deepEqual(page.items, []);
});

test("teammate group requests authorize each owner separately and stop on requester or agent access loss", async () => {
  const [owner, requester, worker, outsider] = await Promise.all([
    home(S.base,"team-request-owner"), home(S.base,"team-requester"),
    home(S.base,"team-request-worker"), home(S.base,"team-request-outsider"),
  ]);
  const team = await owner.ok("POST","/v1/ot/workspaces",{
    name:"Teammate review",slug:"teammate-review-jobs",idempotency_key:"teammate-review-workspace",
  });
  for (const member of [requester, worker, outsider]) {
    await owner.ok("POST", `/v1/ot/teams/${team.id}/members`, {handle:member.handle,role:"member"});
  }
  const group = await owner.ok("POST","/v1/ot/conversations",{
    kind:"group",team_id:team.id,title:"Teammate review",members:[requester.handle,worker.handle],
  });
  assert.equal(group.group_agent_requests,true);
  const room = `/v1/ot/conversations/${group.id}`;
  const progressList = `/v1/ot/workspaces/${team.workspace_id}/conversations/${group.id}/reply-progress`;
  for (const actor of [requester, worker]) await actor.ok("PUT",room + "/agents/shared",{name:"Same display name"});
  await owner.ok("PUT",room + "/agents/observer",{name:"Observer",auto_reply:true});
  const senderId = (await requester.ok("GET","/v1/ot/me")).owner_id;
  const workerProfile = await worker.ok("GET","/v1/ot/me");
  const workerId = workerProfile.owner_id;
  const own = {owner_id:senderId,agent_id:"shared"}, target = {owner_id:workerId,agent_id:"shared"};
  const input = {workspace:team.workspace_id,group_agent_request:true,client_key:"teammate-review-0001",
    body:"Compare launch implications",agent_mentions:[own,target]};
  const send = (overrides = {}) => requester.call("POST",room + "/messages",{...input,...overrides});
  assert.equal((await outsider.call("POST",room + "/messages",input)).status,404);
  assert.equal((await send({agent_mentions:[target,target]})).status,400);
  assert.equal((await send({direct:true})).status,404);
  const first = (await send()).data;
  assert.equal(first.reply_jobs.length,2);
  assert.equal((await send({agent_mentions:[target,own]})).data.id,first.id);
  assert.equal((await send({agent_mentions:[target]})).data.error.code,"group_agent_request_conflict");
  assert.equal((await send({group_agent_request:undefined})).data.error.code,"group_agent_request_conflict");
  const byOwner = (message: any, id: string) => message.reply_jobs.find((item: any) => item.agent_owner_id===id);
  const selected = byOwner(first,workerId);
  assert.equal(selected.agent_owner_name,workerProfile.display_name);
  assert.equal(selected.agent_id,"shared");
  const inbox = "/v1/ot/agent-inbox?managed=1";
  const workerJobs = async () => (await worker.ok("GET",inbox)).jobs;
  assert.deepEqual(await worker.ok("GET","/v1/ot/agent-inbox"),{cursor:0,items:[]});
  const ownJobs = (await requester.ok("GET",inbox)).jobs;
  assert.equal(ownJobs[0].job_id,byOwner(first,senderId).id);
  assert.equal(ownJobs[0].group_text_only,undefined);
  const observed = await owner.ok("GET",inbox);
  assert.deepEqual(observed.items,[],"nonselected auto reply never runs for a manual group request");
  assert.deepEqual(observed.jobs,[]);
  assert.equal((await workerJobs())[0].job_id,selected.id);
  assert.equal((await workerJobs())[0].group_text_only,true);
  const jobPath = (id: string) => "/v1/ot/agent-reply-jobs/"+id;
  const current = teammateClaim(first.revision);
  assert.equal((await worker.call("POST",jobPath(selected.id),{...current,accept_group_text_turn:undefined})).status,409);
  assert.equal((await worker.call("POST",jobPath(selected.id),{...current,source_revision:undefined})).status,409);
  assert.equal((await outsider.call("POST",jobPath(selected.id),current)).status,404);
  const reply = (message: any, job: any, claim = current) => ({
    agent_ref:"shared",job_id:job.id,attempt:claim.attempt,claim_id:claim.claim_id,
    reply_to:message.id,body:"Launch implications",mode:"mention",
  });
  assert.equal((await worker.call("POST",room+"/agent-messages",{
    reply_to:first.id,agent_ref:"shared",mode:"auto",body:"Unclaimed legacy reply",
  })).status,409);
  assert.equal((await owner.call("POST",room+"/agent-messages",{
    reply_to:first.id,agent_ref:"observer",mode:"auto",body:"Unselected legacy reply",
  })).status,409);
  const receipt = await worker.ok("POST",jobPath(selected.id),current);
  assert.deepEqual(receipt,{ok:true,group_text_only:true});
  assert.deepEqual(await worker.ok("POST",jobPath(selected.id),current),receipt);
  const completed = await worker.ok("POST",room+"/agent-messages",reply(first,selected));
  assert.equal(completed.author.owner.owner_id,workerId);
  assert.equal(completed.reply_job_id,selected.id);

  const running = (await send({client_key:"teammate-review-0002",agent_mentions:[target]})).data;
  const runningJob = byOwner(running,workerId);
  const active = teammateClaim(running.revision);
  await worker.ok("POST",jobPath(runningJob.id),active);
  const output = {attempt:1,claim_id:active.claim_id,revision:1,text:"Temporary output"};
  await worker.ok("POST",jobPath(runningJob.id)+"/progress",output);
  assert.ok((await owner.ok("GET",progressList)).items.some((row: any)=>row.text===output.text));
  const pending = (await send({client_key:"teammate-review-0003",agent_mentions:[target]})).data;
  const pendingJob = byOwner(pending,workerId);

  const membership = `/v1/ot/teams/${team.id}/members/${requester.handle}`;
  await owner.ok("PATCH",membership,{suspended:true});
  assert.deepEqual((await owner.ok("GET",progressList)).items,[]);
  assert.deepEqual(await workerJobs(),[]);
  assert.equal((await worker.call("POST",jobPath(pendingJob.id),teammateClaim(pending.revision))).status,409);
  assert.equal((await worker.call("POST",jobPath(runningJob.id)+"/progress",{...output,revision:2})).status,409);
  assert.equal((await worker.call("POST",room+"/agent-messages",reply(running,runningJob,active))).status,409);
  assert.equal((await worker.ok("POST",room+"/agent-messages",reply(first,selected))).id,completed.id,
    "a completed receipt stays replayable by its active agent owner");
  await owner.ok("PATCH",membership,{suspended:false});
  assert.deepEqual(await workerJobs(),[]);
  assert.equal((await worker.call("POST",room+"/agent-messages",reply(running,runningJob,active))).status,409);
  const retryPath = room+`/messages/${pending.id}/agent-retry`;
  assert.equal((await owner.call("POST",retryPath,{job_id:pendingJob.id,attempt:1})).status,404);
  await requester.ok("POST",retryPath,{job_id:pendingJob.id,attempt:1});
  assert.equal((await workerJobs())[0].attempt,2);
  const access = teammateClaim(pending.revision,2);
  await worker.ok("POST",jobPath(pendingJob.id),access);
  await worker.ok("DELETE",room+"/agents/shared");
  assert.equal((await send({client_key:"teammate-review-0004",agent_mentions:[target]})).data.error.code,
    "group_agent_unavailable");
  assert.equal((await send({client_key:"teammate-review-0003",agent_mentions:[target]})).data.id,pending.id,
    "a lost send response is recoverable after a selected agent is withdrawn");
  assert.equal((await requester.call("POST",retryPath,{job_id:pendingJob.id,attempt:2})).status,409);
  assert.equal((await worker.call("POST",jobPath(pendingJob.id)+"/progress",{
    ...output,attempt:2,claim_id:access.claim_id,
  })).status,409);
});

test("voice messages are idempotent and only current conversation members can play them", async () => {
  const A = await home(S.base,"voice-a");
  const B = await home(S.base,"voice-b");
  const C = await home(S.base,"voice-c");
  await teamOf(A,B,C);
  const group = await A.ok("POST","/v1/ot/conversations",{kind:"group",title:"Voice",members:[B.handle]});
  const root = `/v1/ot/conversations/${group.id}/messages`;
  const voice = {mime:"audio/webm",data:Buffer.from([0x1a,0x45,0xdf,0xa3,...Array(8).fill(0)]).toString("base64")};
  assert.equal((await A.call("POST",root,{voice:{...voice,mime:"text/html"}})).status,400);
  const request = {voice,client_key:"voice-retry"};
  const sent = await A.ok("POST",root,request);
  assert.equal(sent.body,"语音消息");
  assert.deepEqual(sent.voice,{mime:voice.mime});
  assert.equal((await A.ok("POST",root,request)).id,sent.id);
  assert.equal((await B.ok("GET",root)).messages.length,1);
  const audioPath = root + "/" + sent.id + "/voice";
  assert.deepEqual(await B.ok("GET",audioPath),voice);
  assert.equal((await C.call("GET",audioPath)).status,404);
  await A.ok("DELETE",`/v1/ot/messages/${sent.id}`);
  assert.equal((await B.call("GET",audioPath)).status,404);
  assert.equal((await B.ok("GET",root)).messages[0].voice,undefined);
});

test("members can page, search and anchor shared history inside their conversation", async () => {
  const A = await home(S.base,"history-a");
  const B = await home(S.base,"history-b");
  const C = await home(S.base,"history-c");
  await teamOf(A,B,C);
  const group = await A.ok("POST","/v1/ot/conversations",{kind:"group",title:"History",members:[B.handle]});
  const path=`/v1/ot/conversations/${group.id}/messages`;
  const messages=[];
  for(let seq=1;seq<=6;seq++) messages.push(await A.ok("POST",path,{body:seq%2 ? "Planning " + seq : "Other " + seq}));
  const latest=await B.ok("GET",path+"?limit=2");
  assert.deepEqual(latest.messages.map((message:any)=>message.seq),[5,6]);
  assert.equal(latest.next_before,5);
  assert.equal(latest.has_newer,false);
  const older=await B.ok("GET",path+"?limit=2&before="+latest.next_before);
  assert.deepEqual(older.messages.map((message:any)=>message.seq),[3,4]);
  assert.equal(older.has_newer,true);
  const anchored=await B.ok("GET",path+"?limit=3&around="+messages[1].id);
  assert.deepEqual(anchored.messages.map((message:any)=>message.seq),[1,2,3]);
  assert.equal(anchored.next_before,null);
  await A.ok("DELETE",`/v1/ot/messages/${messages[2].id}`);
  const hits=await B.ok("GET",path+"?q=planning&limit=1");
  assert.deepEqual(hits.messages.map((message:any)=>message.seq),[5]);
  const next=await B.ok("GET",path+"?q=planning&limit=1&before="+hits.next_before);
  assert.deepEqual(next.messages.map((message:any)=>message.seq),[1]);
  assert.equal(next.next_before,null);
  assert.equal((await C.call("GET",path+"?around="+messages[1].id)).status,404);
  assert.equal((await C.call("GET",path+"?q=planning")).status,404);
});

test("workspace message search and scoped history require access to the workspace and conversation", async () => {
  const A = await home(S.base, "search-a");
  const B = await home(S.base, "search-b");
  const C = await home(S.base, "search-c");
  const primary = await A.ok("POST", "/v1/ot/workspaces", {name: "Search", idempotency_key: "workspace-search-primary"});
  const other = await A.ok("POST", "/v1/ot/workspaces", {name: "Other", idempotency_key: "workspace-search-secondary"});
  for (const [team, person] of [[primary, B], [other, C]] as const) {
    const {code} = await A.ok("POST", `/v1/ot/teams/${team.id}/invites`, {});
    await person.ok("POST", "/v1/ot/invites/accept", {code});
  }
  const group = async (owner: typeof A, team_id: string, title: string, members: string[]) =>
    owner.ok("POST", "/v1/ot/conversations", {kind: "group", title, team_id, members});
  const send = (owner: typeof A, id: string, body: string) =>
    owner.ok("POST", `/v1/ot/conversations/${id}/messages`, {body});
  const current = await group(A, primary.id, "Current", [B.handle]);
  const outside = await group(A, other.id, "Outside", [C.handle]);
  const hidden = await group(B, primary.id, "Hidden", []);
  const dm = await A.ok("POST", "/v1/ot/conversations", {kind: "dm", peer: B.handle});
  const outsideDm = await A.ok("POST", "/v1/ot/conversations", {kind: "dm", peer: C.handle});
  const oldest = await send(A, current.id, "Schedule% for the meeting");
  await send(A, outside.id, "Schedule% other workspace");
  await send(B, hidden.id, "Schedule% in another group");
  await send(A, outsideDm.id, "Schedule% for an outside teammate");
  const direct = await send(B, dm.id, "Schedule% direct reply");
  const removed = await send(A, current.id, "Schedule% retracted");
  await A.ok("DELETE", `/v1/ot/messages/${removed.id}`);
  await send(A, current.id, "schedule but without a percentage sign");
  const newest = await send(A, current.id, "SCHEDULE% approved");

  const scopedHistory = (conversation: string, workspace: string) =>
    `/v1/ot/conversations/${conversation}/messages?workspace_id=${workspace}&limit=1`;
  const currentPage = await A.ok("GET", scopedHistory(current.id, primary.workspace_id));
  assert.equal(currentPage.messages[0].id, newest.id);
  assert.equal((await A.call("GET", scopedHistory(outside.id, primary.workspace_id))).status, 404);
  assert.equal((await C.call("GET", scopedHistory(current.id, primary.workspace_id))).status, 404);
  assert.equal((await A.ok("GET", scopedHistory(dm.id, primary.workspace_id))).messages[0].id, direct.id);
  assert.equal((await A.call("GET", scopedHistory(outsideDm.id, primary.workspace_id))).status, 404);

  const search = `/v1/ot/workspaces/${primary.workspace_id}/messages/search?q=schedule%25&limit=2`;
  const first = await A.ok("GET", search);
  assert.deepEqual(first.items.map((row: any) => row.message_id), [newest.id, direct.id]);
  assert.equal(first.items[0].title, "Current");
  assert.equal(first.items[1].conversation_id, dm.id);
  assert.equal(first.more, true);
  const next = await A.ok("GET", search + "&before=" + first.items[1].cursor);
  assert.deepEqual(next.items.map((row: any) => row.message_id), [oldest.id]);
  assert.equal(next.more, false);
  assert.deepEqual((await A.ok("GET", search + "&conversation_id=" + outside.id)).items, []);
  assert.equal((await A.call("GET", search + "&before=invalid")).status, 400);
  assert.equal((await C.call("GET", search)).status, 404);
  const messagePath = (conversation: string, message: string, workspace = primary.workspace_id) =>
    `/v1/ot/workspaces/${workspace}/conversations/${conversation}/messages/${message}`;
  const history = messagePath(current.id, oldest.id);
  assert.deepEqual(await B.ok("GET", history), {body: oldest.body, revision: 1, title: "Current"});
  assert.equal((await A.call("GET", messagePath(current.id, oldest.id, other.workspace_id))).status, 404);
  assert.equal((await A.call("GET", messagePath(current.id, direct.id))).status, 404);
  assert.equal((await A.call("GET", messagePath(current.id, removed.id))).status, 409);
  assert.equal((await A.call("GET", messagePath(dm.id, direct.id, other.workspace_id))).status, 404);
  assert.equal((await A.ok("GET", messagePath(dm.id, direct.id))).body, direct.body);
  await A.ok("PATCH", `/v1/ot/messages/${oldest.id}`, {body: "A saved message has been edited"});
  assert.equal((await B.ok("GET", history)).revision, 2);
  await A.ok("DELETE", `/v1/ot/conversations/${current.id}/members/${B.handle}`);
  assert.deepEqual((await B.ok("GET", search + "&conversation_id=" + current.id)).items, []);
  assert.equal((await B.call("GET", history)).status, 404);
  await A.ok("PATCH", `/v1/ot/teams/${primary.id}/members/${B.handle}`, {suspended: true});
  assert.equal((await B.call("GET", search)).status, 404);
  assert.deepEqual((await A.ok("GET", search + "&conversation_id=" + dm.id)).items, []);
});

test("standalone video meetings grant access to the call only, and only its host can end it", async () => {
  const host = await home(S.base, "meeting-host");
  const guest = await home(S.base, "meeting-guest");
  const outsider = await home(S.base, "meeting-outsider");
  await teamOf(host);
  await teamOf(guest);
  const path = "/v1/ot/meeting-calls";
  const input = {title: "Design review", peer_id: "meeting-host-browser"};
  assert.equal((await host.call("POST", path + "/create", {title: input.title})).status, 400);
  const created = await host.ok("POST", path + "/create", input);
  assert.equal(created.meeting.host, true);
  assert.match(created.meeting.code, /^[\w-]{24}$/);
  assert.deepEqual((await host.ok("POST", path + "/create", input)).meeting, created.meeting);
  assert.equal((await guest.call("POST", path + "/preview", {code: "a".repeat(24)})).status, 404);
  assert.deepEqual(await guest.ok("POST", path + "/preview", {code: created.meeting.code}), {title: input.title});
  const joined = await guest.ok("POST", path + "/join", {code: created.meeting.code, peer_id: "meeting-guest-browser"});
  assert.deepEqual(joined.meeting, {title: input.title, host: false});
  assert.equal(joined.call.id, created.call.id);
  assert.deepEqual((await guest.ok("GET", "/v1/ot/conversations")).conversations, []);
  assert.deepEqual((await host.ok("GET", "/v1/ot/conversations")).conversations, []);
  const guestPeer = {call_id: joined.call.id, peer_id: joined.peer_id};
  const recordPath = "/v1/ot/call-records/" + joined.call.id;
  assert.deepEqual(await outsider.ok("POST", path + "/preview", {code: created.meeting.code}), {title: input.title});
  assert.equal((await outsider.call("GET", recordPath)).status, 404);
  assert.equal((await guest.call("GET", recordPath)).data.error.code, "meeting_call_active");
  assert.equal((await guest.ok("POST", path + "/poll", guestPeer)).call.peers.length, 2);
  assert.equal((await outsider.call("POST", path + "/poll", guestPeer)).status, 404);
  assert.equal((await guest.call("POST", path + "/end", guestPeer)).status, 403);
  const ended = await host.ok("POST", path + "/end", {call_id: created.call.id, peer_id: created.peer_id});
  assert.deepEqual(ended, {ended: true, handoff: {id: created.call.id}});
  assert.equal((await guest.call("POST", path + "/poll", guestPeer)).status, 404);
  assert.equal((await guest.call("POST", path + "/preview", {code: created.meeting.code})).status, 404);
  assert.equal((await outsider.call("POST", path + "/join", {code: created.meeting.code, peer_id: "never-attended-browser"})).status, 404);
  const closed = (await guest.ok("GET", recordPath)).record;
  assert.deepEqual((await host.ok("GET", recordPath)).record, closed);
  assert.deepEqual(Object.keys(closed).sort(), ["attendees", "ended_at", "id", "kind", "started_at", "title"]);
  assert.equal(closed.title, input.title);
  assert.ok(closed.ended_at >= closed.started_at);
  const visibleNames = await Promise.all([host.ok("GET", "/v1/ot/me"), guest.ok("GET", "/v1/ot/me")]);
  assert.deepEqual(closed.attendees.sort(), visibleNames.map(row => row.display_name).sort());
  await guest.ok("PUT", "/v1/ot/profile", {display_name: "Renamed participant"});
  assert.deepEqual((await guest.ok("GET", recordPath)).record.attendees.sort(), closed.attendees);
  assert.deepEqual(await outsider.call("GET", recordPath), await outsider.call("GET", recordPath.replace(created.call.id, "otcav_" + "Z".repeat(26))));
});

test("expired call leases close the attendance record even when no browser sends leave", async t => {
  let now = 1_800_000_000_000;
  const service = await startServer({...bulkAuth, now: () => now});
  t.after(service.stop);
  const host = await home(service.base, "expiry-host");
  const path = "/v1/ot/meeting-calls";
  const session = await host.ok("POST", path + "/create", {title: "Expired lease", peer_id: "expiry-host-browser"});
  const recordPath = "/v1/ot/call-records/" + session.call.id;
  assert.equal((await host.call("GET", recordPath)).status, 409);
  now += 60_001;
  const finished = (await host.ok("GET", recordPath)).record;
  assert.equal(finished.ended_at, now);
  assert.equal(finished.attendees.length, 1);
  assert.equal((await host.call("POST", path + "/preview", {code: session.meeting.code})).status, 404);
  assert.deepEqual((await host.ok("GET", recordPath)).record, finished);
});

test("chat files are idempotent and readable only by active members of the correct conversation", async () => {
  const author = await home(S.base, "file-author");
  const reader = await home(S.base, "file-reader");
  const teammate = await home(S.base, "file-teammate");
  const team = await teamOf(author, reader, teammate);
  const {workspaces} = await author.ok("GET", "/v1/ot/workspaces");
  const workspace = workspaces.find((row: any) => row.id === team.id).workspace_id;
  const sentTo = await author.ok("POST", "/v1/ot/conversations", {
    kind: "group", title: "Shared files", team_id: team.id, members: [reader.handle],
  });
  const forwardedTo = await author.ok("POST", "/v1/ot/conversations", {
    kind: "group", title: "Forwarded files", team_id: team.id, members: [teammate.handle],
  });
  const filePath = (conversation: string, message: string) =>
    `/v1/ot/workspaces/${workspace}/conversations/${conversation}/messages/${message}/file`;
  const post = `/v1/ot/conversations/${sentTo.id}/messages`;
  const raw = Buffer.from("plain file contents", "utf8");
  const file = {title: "评审.txt", mime: "text/plain", data: raw.toString("base64")};
  const data = {workspace, client_key: "browser-retry", attachment: file};
  const created = await author.ok("POST", post, data);
  assert.deepEqual(created.attachment, {title: file.title, mime: file.mime, bytes: raw.length});
  assert.equal((await author.ok("POST", post, data)).id, created.id);
  assert.equal((await reader.ok("GET", post)).messages.length, 1);
  assert.deepEqual(await reader.ok("GET", filePath(sentTo.id, created.id)), file);
  assert.equal((await teammate.call("GET", filePath(sentTo.id, created.id))).status, 404);
  assert.equal((await reader.call("GET", filePath(forwardedTo.id, created.id))).status, 404);
  const fakeImage = await author.call("POST", post, {workspace, attachment:{...file, title:"bad.png", mime:"image/png"}});
  assert.equal(fakeImage.status, 400);
  const forwarded = await author.ok("POST", `/v1/ot/conversations/${forwardedTo.id}/messages`, {
    workspace, attachment_from: {conversation_id: sentTo.id, message_id: created.id},
  });
  assert.deepEqual(await teammate.ok("GET", filePath(forwardedTo.id, forwarded.id)), file);
  await author.ok("DELETE", `/v1/ot/conversations/${sentTo.id}/members/${reader.handle}`);
  assert.equal((await reader.call("GET", filePath(sentTo.id, created.id))).status, 404);
  await author.ok("DELETE", "/v1/ot/messages/" + created.id);
  assert.equal((await author.call("GET", filePath(sentTo.id, created.id))).status, 404);
  assert.deepEqual(await teammate.ok("GET", filePath(forwardedTo.id, forwarded.id)), file);
});

test("sticker messages preserve their image badge and replay only the sender's visible scoped receipt", async () => {
  const [sender, reader, outsider] = await Promise.all([
    home(S.base,"sticker-sender"), home(S.base,"sticker-reader"), home(S.base,"sticker-outsider"),
  ]);
  const team = await teamOf(sender,reader);
  const otherTeam = await teamOf(sender,outsider);
  const {workspaces} = await sender.ok("GET","/v1/ot/workspaces");
  const workspace = workspaces.find((row: any) => row.id === team.id).workspace_id;
  const otherWorkspace = workspaces.find((row: any) => row.id === otherTeam.id).workspace_id;
  const group = await sender.ok("POST","/v1/ot/conversations",{kind:"group",title:"Sticker group",team_id:team.id,members:[reader.handle]});
  const copy = await sender.ok("POST","/v1/ot/conversations",{kind:"group",title:"Sticker copies",team_id:team.id,members:[reader.handle]});
  const room = `/v1/ot/conversations/${group.id}`;
  const post = room + "/messages";
  const scoped = `/v1/ot/workspaces/${workspace}/conversations/${group.id}`;
  const data = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  const attachment = {title:"欢呼.gif",mime:"image/gif",data,sticker:true};
  const key = "sent-sticker-key-1";
  const replay = {workspace,client_key:key,sticker_replay:true};
  assert.equal((await sender.call("POST",post,replay)).status,404);
  assert.equal((await sender.call("POST",post,{...replay,body:"Do not send"})).status,400);
  assert.equal((await sender.call("POST",post,{workspace,attachment:{sticker:true,title:"not-a-sticker.txt",
    mime:"text/plain",data:Buffer.from("Text").toString("base64")}})).status,400);
  const {id,attachment:sticker} = await sender.ok("POST",post,{workspace,client_key:key,attachment});
  assert.deepEqual(sticker,{title:attachment.title,mime:attachment.mime,bytes:Buffer.from(data,"base64").length,sticker:true});
  const receipt = await sender.call("POST",post,replay);
  assert.equal(receipt.status,200);
  assert.equal(receipt.data.id,id);
  assert.deepEqual(receipt.data.attachment,sticker);
  assert.equal((await sender.call("POST",post,{...replay,workspace:otherWorkspace})).status,404);
  assert.equal((await reader.call("POST",post,replay)).status,404);
  assert.equal((await outsider.call("POST",post,replay)).status,404);
  assert.equal((await sender.call("POST",post,{...replay,direct:true})).status,404);
  assert.deepEqual((await reader.ok("GET",post)).messages.map((message: any) => message.attachment),[sticker]);
  assert.deepEqual((await reader.ok("GET",scoped+"/attachments?kind=photo")).items[0].attachment,sticker);
  const forwarded = await sender.ok("POST",`/v1/ot/conversations/${copy.id}/messages`,{
    workspace,attachment_from:{conversation_id:group.id,message_id:id},
  });
  assert.deepEqual(forwarded.attachment,sticker);
  const bytes = await reader.ok("GET",`${scoped}/messages/${id}/file`);
  assert.equal(bytes.data,data);
  await sender.ok("POST",post,{workspace,client_key:"plain-text-key",body:"This is text"});
  assert.equal((await sender.call("POST",post,{...replay,client_key:"plain-text-key"})).status,404);
  await sender.ok("DELETE",`/v1/ot/messages/${id}`);
  assert.equal((await sender.call("POST",post,replay)).status,404);

  const dm = await sender.ok("POST","/v1/ot/conversations",{kind:"dm",peer:reader.handle});
  const direct = `/v1/ot/conversations/${dm.id}/messages`;
  const directSent = await sender.ok("POST",direct,{direct:true,client_key:key,attachment});
  const directReplay = await sender.call("POST",direct,{direct:true,client_key:key,sticker_replay:true});
  assert.equal(directReplay.status,200);
  assert.equal(directReplay.data.id,directSent.id);
  assert.equal((await reader.call("POST",direct,{direct:true,client_key:key,sticker_replay:true})).status,404);
});

test("team reply progress uses both memberships and drops work when access is removed", async () => {
  const [sender, worker, reader, outsider] = await Promise.all([
    home(S.base, "team-reply-sender"), home(S.base, "team-reply-worker"),
    home(S.base, "team-reply-reader"), home(S.base, "team-reply-outsider"),
  ]);
  const team = await teamOf(sender, worker, reader, outsider);
  const otherTeam = await teamOf(reader, sender);
  const {workspaces} = await reader.ok("GET", "/v1/ot/workspaces");
  const workspace = workspaces.find((row: any) => row.id === team.id).workspace_id;
  const otherWorkspace = workspaces.find((row: any) => row.id === otherTeam.id).workspace_id;
  const group = await sender.ok("POST", "/v1/ot/conversations", {kind: "group", title: "Team reply",
    team_id: team.id, members: [worker.handle, reader.handle]});
  const room = `/v1/ot/conversations/${group.id}`;
  const scoped = `/v1/ot/workspaces/${workspace}/conversations/${group.id}/reply-progress`;
  const jobRoute = (id: string) => `/v1/ot/agent-reply-jobs/${id}`;
  const helper = room + "/agents/helper";
  await sender.ok("POST",room+"/management",{
    workspace,action:"reply_policy",revision:group.group_management.revision,mode:"default",
  });
  const createJob = async (body: string) => {
    const source = await sender.ok("POST", room + "/messages", {body});
    const id = source.reply_jobs[0].id;
    const claim = teammateClaim(source.revision);
    await worker.ok("POST", jobRoute(id), claim);
    await worker.ok("POST", jobRoute(id) + "/progress", {attempt:1, claim_id:claim.claim_id, revision:1, text:"Shared draft"});
    return {id, source, claim};
  };

  await worker.ok("PUT", helper, {name: "Helper", auto_reply: true});
  const {id, source, claim} = await createJob("@helper draft a message");
  assert.deepEqual(await reader.ok("GET", scoped), {items: [{id, message_id: source.id, attempt: 1, status: "running", text: "Shared draft"}]});
  assert.equal((await reader.call("GET", scoped.replace(workspace, otherWorkspace))).status, 404);
  assert.equal((await outsider.call("GET", scoped)).status, 404);
  assert.equal((await reader.call("GET", room + "/reply-progress")).status, 404);
  await reader.ok("POST", `/v1/ot/messages/${source.id}/hide`, {conversation_id: group.id});
  assert.deepEqual((await reader.ok("GET", scoped)).items, []);
  assert.equal((await sender.ok("GET", scoped)).items[0].text, "Shared draft");

  const auto = await sender.ok("POST", room + "/messages", {body: "An automatic reply trigger"});
  const inbox = "/v1/ot/agent-inbox?managed=1";
  assert.ok((await worker.ok("GET", inbox)).items.some((item: any) => item.message.id === auto.id && item.mode === "auto"));
  const membership = `/v1/ot/teams/${team.id}/members/${encodeURIComponent(worker.handle)}`;
  await sender.ok("PATCH", membership, {suspended: true});
  assert.deepEqual((await sender.ok("GET", scoped)).items, []);
  assert.equal((await worker.call("GET", scoped)).status, 404);
  assert.deepEqual((await worker.ok("GET", inbox)).items, []);
  const untracked = {agent_ref: "helper", reply_to: auto.id, mode: "auto", body: "Old untracked reply"};
  assert.equal((await worker.call("POST", room + "/agent-messages", untracked)).status, 404);
  await sender.ok("PATCH", membership, {suspended: false});
  assert.deepEqual((await sender.ok("GET", scoped)).items, []);
  assert.equal((await worker.call("POST", jobRoute(id) + "/progress", {attempt:1, claim_id:claim.claim_id, revision:2, text:"Late"})).status, 409);

  const removed = await createJob("@helper replacement test");
  await worker.ok("DELETE", helper);
  await worker.ok("PUT", helper, {name: "Helper"});
  assert.deepEqual((await sender.ok("GET", scoped)).items, []);
  assert.equal((await worker.call("POST", jobRoute(removed.id) + "/progress", {attempt:1, claim_id:removed.claim.claim_id, revision:2, text:"Stale"})).status, 409);
});

test("editing or retracting an originating message invalidates managed reply progress", async () => {
  const [worker, sender] = await Promise.all([home(S.base, "revision-worker"), home(S.base, "revision-sender")]);
  const contact = await worker.ok("POST", "/v1/ot/contacts", {handle: sender.handle});
  await sender.ok("POST", "/v1/ot/contacts/" + contact.id, {action: "accept"});
  const group = await worker.ok("POST", "/v1/ot/conversations", {kind: "group", account_group: true,
    title: "Revised reply", members: [sender.handle], agents: [{agent_ref: "helper", name: "Helper"}]});
  const room = `/v1/ot/conversations/${group.id}`;
  const source = await sender.ok("POST", room + "/messages", {body: "@helper initial"});
  const sourceRoute = `/v1/ot/messages/${source.id}`;
  const id = source.reply_jobs[0].id;
  const jobRoute = `/v1/ot/agent-reply-jobs/${id}`;
  const progress = jobRoute + "/progress";
  const revised = await sender.ok("PATCH", sourceRoute, {body: "@helper revision two"});
  const current = teammateClaim(revised.revision);
  assert.equal((await worker.call("POST", jobRoute, {...current, source_revision:source.revision})).status, 409);
  await worker.ok("POST", jobRoute, current);
  await worker.ok("POST", progress, {attempt:1, claim_id:current.claim_id, revision:1, text:"Based on second revision"});
  const next = await sender.ok("PATCH", sourceRoute, {body: "@helper revision three"});
  assert.deepEqual((await sender.ok("GET", room + "/reply-progress")).items, []);
  assert.equal((await worker.call("POST", progress, {attempt:1, claim_id:current.claim_id, revision:2, text:"Late"})).status, 409);
  assert.equal((await worker.call("POST", room + "/agent-messages", {
    agent_ref: "helper", body: "Stale final", reply_to: source.id, job_id: id, attempt: 1, claim_id:current.claim_id,
  })).status, 409);

  await sender.ok("POST", `${room}/messages/${source.id}/agent-retry`, {job_id: id});
  const retry = teammateClaim(next.revision, 2);
  await worker.ok("POST", jobRoute, retry);
  await worker.ok("POST", progress, {attempt:2, claim_id:retry.claim_id, revision:1, text:"Current revision"});
  await sender.ok("DELETE", sourceRoute);
  assert.deepEqual((await sender.ok("GET", room + "/reply-progress")).items, []);
  assert.equal((await worker.call("POST", progress, {attempt:2, claim_id:retry.claim_id, revision:2, text:"Late"})).status, 409);
});

test("a group reply claim returns an older exact quote only while its agent owner can read it", async () => {
  const [worker, sender] = await Promise.all([home(S.base, "quote-worker"), home(S.base, "quote-sender")]);
  const contact = await worker.ok("POST", "/v1/ot/contacts", {handle: sender.handle});
  await sender.ok("POST", `/v1/ot/contacts/${contact.id}`, {action: "accept"});
  const group = await worker.ok("POST", "/v1/ot/conversations", {kind: "group", account_group: true,
    title: "Read the quote", members: [sender.handle]});
  const room = `/v1/ot/conversations/${group.id}/messages`;
  const oldText = "Earlier exact decision: keep the launch on Friday.";
  const original = await sender.ok("POST", room, {body: oldText});
  for (let i = 0; i < 13; i++) await sender.ok("POST", room, {body: `Later message ${i}`});
  await worker.ok("PUT", `/v1/ot/conversations/${group.id}/agents/helper`, {name: "Helper"});
  const request = async (id: string) => sender.ok("POST", room, {body: "@helper review", reply_to: id});
  const target = await request(original.id);
  const job = (await worker.ok("GET", "/v1/ot/agent-inbox?managed=1")).jobs.find((row: any) => row.message.id === target.id);
  assert.ok(job);
  assert.equal(job.context.some((row: any) => row.id === original.id), false);
  assert.equal(job.quoted_message, undefined);
  const claimPath = `/v1/ot/agent-reply-jobs/${job.job_id}`;
  const claim = teammateClaim(target.revision);
  assert.equal((await sender.call("POST", claimPath, claim)).status, 404);
  assert.deepEqual((await worker.ok("POST", claimPath, claim)).quoted_message,
    {author: (await sender.ok("GET", "/v1/ot/me")).display_name, text: oldText});
  await worker.ok("POST", `/v1/ot/messages/${original.id}/hide`, {conversation_id: group.id});
  assert.deepEqual(await worker.ok("POST", claimPath, claim), {ok: true, group_text_only:true});

  const retractable = await sender.ok("POST", room, {body: "Do not read the retracted sentence"});
  const beforeRetraction = await request(retractable.id);
  await sender.ok("DELETE", `/v1/ot/messages/${retractable.id}`);
  assert.deepEqual(await worker.ok("POST", `/v1/ot/agent-reply-jobs/${beforeRetraction.reply_jobs[0].id}`, claim),
    {ok: true, group_text_only:true});
  const other = await sender.ok("POST", "/v1/ot/conversations", {kind: "group", account_group: true, title: "Other group", members: [worker.handle]});
  const unrelated = await sender.ok("POST", `/v1/ot/conversations/${other.id}/messages`, {body: "Other group text"});
  assert.equal((await sender.call("POST", room, {body: "@helper review", reply_to: unrelated.id})).status, 409);
});

test("explicit Studio references keep a reviewed version private to its selected managed job", async () => {
  const [owner, sender, worker, observer] = await Promise.all([
    home(S.base, "studio-group-owner"), home(S.base, "studio-group-sender"),
    home(S.base, "studio-group-worker"), home(S.base, "studio-group-observer"),
  ]);
  const team = await owner.ok("POST", "/v1/ot/workspaces", {
    name: "Studio group", slug: "studio-group-pin", idempotency_key: "studio-group-pin-request",
  });
  const other = await sender.ok("POST", "/v1/ot/workspaces", {
    name: "Other Studio", slug: "other-studio-pin", idempotency_key: "studio-other-pin-request",
  });
  for (const member of [sender, worker, observer]) {
    await owner.ok("POST", `/v1/ot/teams/${team.id}/members`, {handle: member.handle, role: "member"});
  }
  const group = await sender.ok("POST", "/v1/ot/conversations", {
    kind: "group", title: "Studio review", team_id: team.id, members: [worker.handle, observer.handle],
  });
  const room = `/v1/ot/conversations/${group.id}`;
  const progressList = `/v1/ot/workspaces/${team.workspace_id}/conversations/${group.id}/reply-progress`;
  await worker.ok("PUT", room + "/agents/review", {name: "Review"});
  await observer.ok("PUT", room + "/agents/auto", {name: "Automatic", auto_reply: true});
  const workerId = (await worker.ok("GET", "/v1/ot/me")).owner_id;
  const documents = (workspace: string) => `/v1/ot/teams/${workspace}/studio/documents`;
  const title = "Studio-only title";
  const excerpt = "🧪".repeat(2399) + "界";
  const {document: doc} = await owner.ok("POST", documents(team.workspace_id), {
    title, body: excerpt + "studio-only tail", client_key: "first-studio-group-doc",
  });
  const {document: separate} = await sender.ok("POST", documents(other.workspace_id), {
    title: "Other workspace title", body: "Unrelated team material", client_key: "other-studio-group-doc",
  });
  const docPath = documents(team.workspace_id) + "/" + doc.id;
  const request = {
    workspace: team.workspace_id, direct: false, client_key: "studio-group-source-001", body: "Review the decision",
    agent_mentions: [{owner_id: workerId, agent_id: "review"}],
    studio_reference: {document_id: doc.id, revision: 1},
  };
  const send = (overrides = {}) => sender.call("POST", room + "/messages", {...request, ...overrides});
  assert.equal((await send({workspace: other.workspace_id})).status, 404);
  assert.equal((await send({studio_reference: {document_id: separate.id, revision: 1}})).data.error.code,
    "studio_reference_unavailable");
  assert.equal((await send({agent_mentions: [], body: "@review Try a plain mention"})).status, 400);
  assert.equal((await send({voice: {}})).status, 400);
  const workerMembership = `/v1/ot/teams/${team.id}/members/${worker.handle}`;
  await owner.ok("PATCH", workerMembership, {suspended: true});
  assert.equal((await send()).data.error.code, "studio_reference_unavailable");
  await owner.ok("PATCH", workerMembership, {suspended: false});
  assert.deepEqual((await sender.ok("GET", room + "/messages")).messages, []);

  const first = (await send()).data;
  const running = (await send({client_key: "studio-group-source-002"})).data;
  const queued = (await send({client_key: "studio-group-source-003"})).data;
  assert.deepEqual(first.studio_reference, request.studio_reference);
  assert.equal((await send({body: "Different questions are not retries"})).status, 409);
  const inboxPath = "/v1/ot/agent-inbox?managed=1";
  const inbox = await worker.ok("GET", inboxPath);
  const managed = inbox.jobs.find((job: any) => job.message.id === first.id);
  assert.ok(managed);
  assert.deepEqual(managed.message.studio_reference, request.studio_reference);
  for (const view of [first, inbox, await observer.ok("GET", room + "/messages"), await observer.ok("GET", inboxPath)]) {
    assert.doesNotMatch(JSON.stringify(view), /Studio-only title|studio-only tail|🧪/u);
  }
  assert.equal((await worker.ok("GET", "/v1/ot/agent-inbox")).items.some((item: any) => item.message.id === first.id), false);
  assert.equal((await observer.ok("GET", inboxPath)).items.some((item: any) => item.message.id === first.id), false);

  await owner.ok("PUT", docPath, {revision: 1, title: "A later version", body: "Not the reviewed body"});
  const replay = await send();
  assert.equal(replay.data.id, first.id);
  assert.equal((await send({client_key: "unused-studio-group-key"})).data.error.code, "studio_reference_changed");
  const start = {action: "start", attempt: 1, claim_id: "c7fe0015-624c-4326-afdc-303943909a26", source_revision: 1};
  const canRead = {...start, accept_studio_reference: true, accept_group_text_turn:true};
  const jobPath = (message: any) => `/v1/ot/agent-reply-jobs/${message.reply_jobs[0].id}`;
  const finish = (message: any) => ({
    reply_to: message.id, agent_ref: "review", mode: "mention", body: "Reviewed result",
    job_id: message.reply_jobs[0].id, attempt: 1, claim_id: start.claim_id,
  });
  assert.equal((await observer.call("POST", jobPath(first), canRead)).status, 404);
  assert.equal((await worker.call("POST", jobPath(first), start)).status, 409);
  assert.equal((await worker.call("POST", room + "/agent-messages", {
    reply_to: first.id, agent_ref: "review", body: "Unclaimed attempt",
  })).status, 409);
  assert.equal((await observer.call("POST", room + "/agent-messages", {
    reply_to: first.id, agent_ref: "auto", mode: "auto", body: "Unselected attempt",
  })).status, 409);
  const claim = await worker.ok("POST", jobPath(first), canRead);
  assert.deepEqual(claim, {ok: true, group_text_only:true, studio_reference: {...request.studio_reference, title, excerpt, truncated: true}});
  assert.deepEqual(await worker.ok("POST", jobPath(first), canRead), claim);
  assert.equal((await worker.call("POST", jobPath(first), {action:"pass", attempt:1, claim_id:start.claim_id})).status, 409);
  const completed = await worker.ok("POST", room + "/agent-messages", finish(first));
  await worker.ok("POST", jobPath(running), canRead);
  const progress = {attempt: 1, claim_id: start.claim_id, revision: 1, text: "Temporary draft"};
  await worker.ok("POST", jobPath(running) + "/progress", progress);
  assert.ok((await observer.ok("GET", progressList)).items.some((item: any) => item.text === progress.text));

  await owner.ok("DELETE", docPath, {revision: 2});
  assert.equal((await send()).data.id, first.id);
  assert.equal((await worker.ok("POST", room + "/agent-messages", finish(first))).id, completed.id);
  assert.deepEqual((await observer.ok("GET", progressList)).items, []);
  for (const message of [running, queued]) {
    assert.deepEqual(await worker.ok("POST", jobPath(message), canRead), {ok: true, studio_reference_unavailable: true});
    assert.equal((await worker.call("POST", jobPath(message) + "/progress", {...progress, revision: 2})).status, 409);
    assert.equal((await worker.call("POST", room + "/agent-messages", finish(message))).status, 409);
  }
  assert.equal((await sender.call("POST", room + `/messages/${running.id}/agent-retry`, {
    job_id: running.reply_jobs[0].id,
  })).data.error.code, "studio_reference_unavailable");
  assert.equal((await send({client_key: "deleted-studio-group-key"})).data.error.code, "studio_reference_unavailable");

  const {document: again} = await owner.ok("POST", documents(team.workspace_id), {
    title: "Still present", body: "Membership check", client_key: "second-studio-group-doc",
  });
  const revoked = (await send({client_key: "studio-group-source-004", studio_reference: {document_id: again.id, revision: 1}})).data;
  await worker.ok("POST", jobPath(revoked), canRead);
  const authorMembership = `/v1/ot/teams/${team.id}/members/${sender.handle}`;
  await owner.ok("PATCH", authorMembership, {suspended: true});
  assert.equal((await sender.call("POST", room + "/messages", request)).status, 404);
  assert.deepEqual(await worker.ok("POST", jobPath(revoked), canRead), {ok: true, studio_reference_unavailable: true});
  await owner.ok("PATCH", authorMembership, {suspended: false});
  assert.equal((await worker.call("POST", room + "/agent-messages", finish(revoked))).status, 409);

  const pruned = (await send({client_key: "studio-group-source-005", studio_reference: {document_id: again.id, revision: 1}})).data;
  const currentDoc = documents(team.workspace_id) + "/" + again.id;
  for (let revision = 1; revision <= 30; revision++) {
    await owner.ok("PUT", currentDoc, {revision, title: again.title, body: `Saved version ${revision + 1}`});
  }
  assert.equal((await owner.call("GET", currentDoc + "/versions/1")).status, 404);
  assert.deepEqual(await worker.ok("POST", jobPath(pruned), canRead), {ok: true, studio_reference_unavailable: true});
});

test("attachment search is newest-first, case-insensitive and scoped to readable files", async () => {
  const author = await home(S.base, "search-file-author");
  const reader = await home(S.base, "search-file-reader");
  const outsider = await home(S.base, "search-file-outsider");
  const team = await teamOf(author, reader, outsider);
  const otherTeam = await teamOf(reader, author);
  const {workspaces} = await reader.ok("GET", "/v1/ot/workspaces");
  const workspace = workspaces.find((row: any) => row.id === team.id).workspace_id;
  const otherWorkspace = workspaces.find((row: any) => row.id === otherTeam.id).workspace_id;
  const group = await author.ok("POST", "/v1/ot/conversations", {
    kind: "group", title: "Search these attachments", team_id: team.id, members: [reader.handle],
    agents: [{agent_ref: "attachment_helper", name: "Attachment helper"}],
  });
  const room = `/v1/ot/conversations/${group.id}`;
  const scoped = `/v1/ot/workspaces/${workspace}/conversations/${group.id}`;
  const postFile = (title: string) => author.ok("POST", room + "/messages", {
    workspace, body: "A body with different searchable words",
    attachment: {title, mime: "text/plain", data: Buffer.from("Draft").toString("base64")},
  });
  const older = await postFile("RÉSUMÉ plan.txt");
  const photo = await author.ok("POST", room + "/messages", {workspace, attachment: {
    title: "Résumé picture.png", mime: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh28AAAAASUVORK5CYII=",
  }});
  const hidden = await postFile("Résumé personal.txt");
  const retracted = await postFile("Résumé obsolete.txt");
  const latest = await postFile("Résumé 100%.txt");
  await reader.ok("POST", `/v1/ot/messages/${hidden.id}/hide`, {conversation_id: group.id});
  await author.ok("DELETE", `/v1/ot/messages/${retracted.id}`);

  const files = scoped + "/attachments?kind=file";
  const term = "&q=" + encodeURIComponent("résumé");
  const row = (message: any) => ({message_id: message.id, created_at: message.created_at, attachment: message.attachment});
  const first = await reader.ok("GET", files + term + "&limit=1");
  assert.deepEqual(first.items, [row(latest)]);
  assert.equal(typeof first.next_cursor, "string");
  assert.deepEqual(await reader.ok("GET", files + term + "&limit=1&cursor=" + first.next_cursor), {
    items: [row(older)], next_cursor: null,
  });
  assert.deepEqual(await reader.ok("GET", files + "&q=%25"), {items: [row(latest)], next_cursor: null});
  assert.deepEqual(await reader.ok("GET", files + "&q=searchable"), {items: [], next_cursor: null});
  assert.deepEqual(await reader.ok("GET", scoped + "/attachments?kind=photo&q="), {items: [row(photo)], next_cursor: null});
  assert.deepEqual((await author.ok("GET", files)).items.map((item: any) => item.message_id), [latest.id, hidden.id, older.id]);
  assert.equal((await reader.ok("GET", `${scoped}/messages/${latest.id}/file`)).title, latest.attachment.title);
  S.platform.db.prepare("UPDATE ot_message_attachments SET sealed=? WHERE message_id=?").run(Buffer.from("unreadable"), latest.id);
  assert.deepEqual(await reader.ok("GET", files + "&q=%25"), {items: [row(latest)], next_cursor: null});

  assert.equal((await outsider.call("GET", files)).status, 404);
  assert.equal((await reader.call("GET", files.replace(workspace, otherWorkspace))).status, 404);
  assert.equal((await reader.call("GET", room + "/attachments?kind=file")).status, 404);
  assert.equal((await reader.call("GET", files + "&cursor=bad")).status, 400);
  assert.equal((await reader.call("GET", files + "&kind=photo")).status, 400);
  for (const limit of ["0", "51", "1e1"]) assert.equal((await reader.call("GET", files + "&limit=" + limit)).status, 400);

  const dm = await author.ok("POST", "/v1/ot/conversations", {kind: "dm", peer: reader.handle});
  const direct = `/v1/ot/conversations/${dm.id}`;
  const dmFile = await author.ok("POST", direct + "/messages", {
    direct: true, attachment: {title: "DM note.txt", mime: "text/plain", data: Buffer.from("DM").toString("base64")},
  });
  assert.deepEqual(await reader.ok("GET", direct + "/attachments?kind=file"), {items: [row(dmFile)], next_cursor: null});
  const teamDm = `/v1/ot/workspaces/${workspace}/conversations/${dm.id}/attachments?kind=file`;
  assert.deepEqual(await reader.ok("GET", teamDm), {items: [row(dmFile)], next_cursor: null});
  assert.equal((await outsider.call("GET", direct + "/attachments?kind=file")).status, 404);

  await author.ok("DELETE", `${room}/members/${reader.handle}`);
  assert.equal((await reader.call("GET", files)).status, 404);
});

test("shared resource search preserves immutable revisions and metadata across scoped forwarding", async () => {
  const [author, relay, recipient] = await Promise.all([
    home(S.base, "resource-author"), home(S.base, "resource-relay"), home(S.base, "resource-recipient"),
  ]);
  const team = await teamOf(author, relay, recipient);
  const workspace = (await relay.ok("GET", "/v1/ot/workspaces")).workspaces.find((row:any) => row.id === team.id).workspace_id;
  const source = await author.ok("POST", "/v1/ot/conversations", {kind:"group", title:"Resource source",
    team_id:team.id, members:[relay.handle]});
  const target = await relay.ok("POST", "/v1/ot/conversations", {kind:"group", title:"Resource target",
    team_id:team.id, members:[recipient.handle]});
  const room = `/v1/ot/conversations/${source.id}`;
  const scoped = (id: string) => `/v1/ot/workspaces/${workspace}/conversations/${id}`;
  const resources = (id: string) => scoped(id) + "/attachments?kind=resource";
  const bytes = Buffer.from("The fourth revision").toString("base64");
  const original = {kind:"document", title:"RÉSUMÉ  /  计划", revision:4};
  const newRevision = {kind:"document", title:"Résumé  /  更新", revision:5};
  const upload = {title:"export-v4.txt", mime:"text/plain", data:bytes};
  await author.ok("POST", room + "/messages", {workspace, attachment:{...upload,title:"Résumé only an upload.txt"}});
  const first = await author.ok("POST", room + "/messages", {workspace, client_key:"resource-version-four",
    body:"Original caption", attachment:{...upload,resource:original}});
  const replay = await author.ok("POST", room + "/messages", {workspace, client_key:"resource-version-four",
    attachment:{...upload,resource:newRevision}});
  assert.equal(replay.id, first.id);
  assert.deepEqual(replay.attachment, first.attachment);
  await author.ok("PATCH", `/v1/ot/messages/${first.id}`, {body:"Edited caption"});
  const second = await author.ok("POST", room + "/messages", {workspace, attachment:{...upload,title:"export-v5.txt",
    data:Buffer.from("The fifth revision").toString("base64"),resource:newRevision}});
  const pictureResource = {kind:"media", title:"Resource picture", revision:1};
  const photo = await author.ok("POST", room + "/messages", {workspace, attachment:{title:"picture-v1.png", mime:"image/png",
    data:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh28AAAAASUVORK5CYII=", resource:pictureResource}});

  const term = "&q=" + encodeURIComponent("résumé");
  const row = (message: any) => ({message_id:message.id, created_at:message.created_at, attachment:message.attachment});
  const resourcePage = await relay.ok("GET", resources(source.id) + term + "&limit=1");
  assert.deepEqual(resourcePage.items, [row(second)]);
  assert.deepEqual(await relay.ok("GET", resources(source.id) + term + "&limit=1&cursor=" + resourcePage.next_cursor),
    {items:[row(first)],next_cursor:null});
  assert.deepEqual(first.attachment, {title:upload.title, mime:upload.mime, bytes:Buffer.from(bytes,"base64").length,resource:original});
  assert.deepEqual(await relay.ok("GET", resources(source.id) + "&q=export"), {items:[],next_cursor:null});
  assert.deepEqual(await relay.ok("GET", scoped(source.id) + "/attachments?kind=photo"), {items:[row(photo)],next_cursor:null});
  assert.equal((await relay.ok("GET", scoped(source.id) + "/attachments?kind=file")).items.length, 3);
  assert.equal((await recipient.call("GET", resources(source.id))).status, 404);

  for (const resource of [null, {...original,kind:"unknown"}, {...original,title:"x".repeat(81)}, {...original,revision:0},
    {...original,revision:"4"}, {...original,artifact_id:"private-artifact-id"}, {...original,workspace_id:workspace}]) {
    assert.equal((await author.call("POST", room + "/messages", {workspace, attachment:{...upload,resource}})).status, 400);
  }

  const forwarding = {workspace, target_conversation_id:target.id, message_ids:[first.id], request_key:"forward-resource"};
  await relay.ok("POST", room + "/forward", forwarding);
  await relay.ok("POST", room + "/forward", forwarding);
  const reference = {workspace, attachment_from:{conversation_id:source.id,message_id:first.id}};
  const copied = await relay.ok("POST", `/v1/ot/conversations/${target.id}/messages`, reference);
  const targetRows = (await recipient.ok("GET", resources(target.id))).items;
  assert.equal(targetRows.length, 2);
  assert.equal(targetRows[0].message_id, copied.id);
  for (const item of targetRows) {
    assert.notEqual(item.message_id, first.id);
    assert.deepEqual(item.attachment, first.attachment);
    assert.deepEqual(await recipient.ok("GET", `${scoped(target.id)}/messages/${item.message_id}/file`), upload);
  }
  assert.equal((await recipient.call("POST", `/v1/ot/conversations/${target.id}/messages`, reference)).status, 404);
  await relay.ok("POST", `/v1/ot/messages/${second.id}/hide`, {conversation_id:source.id});
  assert.deepEqual((await relay.ok("GET", resources(source.id) + term)).items, [row(first)]);
  await author.ok("DELETE", `/v1/ot/messages/${first.id}`);
  assert.deepEqual((await relay.ok("GET", resources(source.id) + term)).items, []);
  assert.equal((await relay.call("POST", room + "/forward", {...forwarding,request_key:"retracted-resource"})).status, 409);

  S.platform.db.prepare("UPDATE ot_message_attachments SET sealed=? WHERE message_id=?").run(Buffer.from("unreadable"), copied.id);
  assert.deepEqual((await recipient.ok("GET", resources(target.id))).items, targetRows);
});

test("group translation sources require membership, exclude own media and check the exact revision", async () => {
  const reader = await home(S.base, "translation-reader");
  const author = await home(S.base, "translation-author");
  const outsider = await home(S.base, "translation-outsider");
  const team = await teamOf(reader, author, outsider);
  const {workspaces} = await reader.ok("GET", "/v1/ot/workspaces");
  const workspace = workspaces.find((row: any) => row.id === team.id).workspace_id;
  const conv = await reader.ok("POST", "/v1/ot/conversations", {
    kind: "group", title: "Translations", team_id: team.id, members: [author.handle],
  });
  const post = `/v1/ot/conversations/${conv.id}/messages`;
  const own = await reader.ok("POST", post, {body:"My text"});
  const first = await author.ok("POST", post, {body:"Visible text"});
  const file = await author.ok("POST", post, {
    workspace, attachment:{title:"data.txt",mime:"text/plain",data:Buffer.from("File contents").toString("base64")},
  });
  const source = `/v1/ot/workspaces/${workspace}/conversations/${conv.id}/translation-sources`;
  const refs = {items:[own,first,file].map(row => ({id:row.id,revision:row.revision}))};
  assert.deepEqual((await reader.ok("POST", source, refs)).sources, [{id:first.id,revision:first.revision,body:"Visible text"}]);
  assert.equal((await outsider.call("POST", source, refs)).status,404);
  const edited = await author.ok("PATCH", "/v1/ot/messages/"+first.id, {body:"Edited text"});
  assert.deepEqual((await reader.ok("POST", source, refs)).sources, []);
  assert.equal((await reader.ok("POST", source, {items:[{id:first.id,revision:edited.revision}]})).sources[0].body,"Edited text");
  await author.ok("DELETE", "/v1/ot/messages/"+first.id);
  assert.deepEqual((await reader.ok("POST", source, {items:[{id:first.id,revision:edited.revision}]})).sources, []);
});
