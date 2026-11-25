import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { bulkAuth, startServer } from "./helpers.js";
import { home } from "./flybot_workspace_helpers.js";

let server: Awaited<ReturnType<typeof startServer>>;
before(async () => { server = await startServer(bulkAuth); });
after(async () => { await server.stop(); });

const notifications = "/v1/ot/notifications";
const conversations = "/v1/ot/conversations";
const file = {title:"brief-v1.txt", mime:"text/plain", data:Buffer.from("Private receipt content").toString("base64")};
const resource = {...file, resource:{title:"Launch brief", kind:"document", revision:1}};
type Notice = {id: string; kind: string; read: boolean; data: Record<string, unknown>};

test("work inbox reads and marks only directly shared resources and public works", async () => {
  const [sender, reader, stranger] = await Promise.all([
    home(server.base, "work-sender"), home(server.base, "work-reader"), home(server.base, "work-outsider"),
  ]);
  const senderProfile = await sender.ok("GET", "/v1/ot/me");
  const contact = await sender.ok("POST", "/v1/ot/contacts", {handle:reader.handle});
  await reader.ok("POST", "/v1/ot/contacts/" + contact.id, {action:"accept"});
  const conversation = await sender.ok("POST", conversations, {kind:"dm", peer:reader.handle});
  const messages = `${conversations}/${conversation.id}/messages`;
  await sender.ok("POST", messages, {direct:true, attachment:file});
  const shared = {direct:true, attachment:resource, client_key:"one-work-notification"};
  const first = await sender.ok("POST", messages, shared);
  assert.equal((await sender.ok("POST", messages, shared)).id, first.id);
  assert.equal((await stranger.call("POST", messages, shared)).status, 404);

  await reader.ok("POST", "/v1/ot/follows", {handle:sender.handle});
  const published = await sender.ok("PUT", "/v1/ot/listings", {
    kind:"work", ref:"public-work-one", slug:"space-public-work-test", title:"Public work",
  });
  await sender.ok("PUT", "/v1/ot/listings", {
    kind:"agent", ref:"public-agent-one", slug:"space-public-agent-test", title:"Public agent",
  });
  const inbox = notifications + "?personal=1&kind=work";
  const received = await reader.ok("GET", inbox);
  assert.equal(received.unread, 2);
  assert.equal(received.notifications.length, 2);
  const artifact = (received.notifications as Notice[]).find(notice => notice.kind === "artifact.shared");
  assert.ok(artifact);
  assert.deepEqual(artifact.data, {
    conversation_id:conversation.id, message_id:first.id, title:"Launch brief", actor_username:senderProfile.display_name,
  });
  assert.equal(received.notifications.find((notice:Notice) => notice.kind === "discover.published").data.listing_id, published.id);
  assert.equal((await stranger.ok("GET", notifications + "?kind=work")).unread, 0);
  assert.equal((await sender.ok("GET", notifications + "?kind=work")).unread, 0);
  assert.equal((await stranger.call("POST", notifications + "/read", {notification_id:artifact.id, kind:"work"})).status, 404);
  assert.equal((await reader.call("GET", inbox + "&kind=work")).status, 400);
  const everything = await reader.ok("GET", notifications + "?personal=1");
  const agent = (everything.notifications as Notice[]).find(notice => notice.data.listing_kind === "agent");
  assert.ok(agent);
  assert.equal((await reader.call("POST", notifications + "/read", {notification_id:agent.id, kind:"work"})).status, 404);
  assert.deepEqual(await reader.ok("POST", notifications + "/read", {
    notification_id:artifact.id, personal:true, kind:"work",
  }), {marked:1, unread:1});
  assert.deepEqual(await reader.ok("POST", notifications + "/read", {all:true, personal:true, kind:"work"}), {marked:1, unread:0});
  const later = await reader.ok("GET", notifications + "?personal=1");
  assert.equal(later.notifications.find((notice:Notice) => notice.id === agent.id).read, false);

  assert.equal((await reader.ok("GET", `${messages}/${first.id}/file`)).data, file.data);
  await sender.ok("DELETE", "/v1/ot/messages/" + first.id);
  assert.equal((await reader.ok("GET", inbox)).notifications.some((notice:Notice) => notice.id === artifact.id), false);
  assert.equal((await reader.call("GET", `${messages}/${first.id}/file`)).status, 404);
  assert.equal((await reader.call("POST", notifications + "/read", {notification_id:artifact.id, kind:"work"})).status, 404);
  const next = await sender.ok("POST", messages, {direct:true, attachment:resource});
  assert.ok((await reader.ok("GET", inbox)).notifications.some((notice:Notice) => notice.data.message_id === next.id));
  await reader.ok("POST", "/v1/ot/contacts/" + contact.id, {action:"remove"});
  assert.equal((await reader.ok("GET", inbox)).notifications.some((notice:Notice) => notice.data.message_id === next.id), false);
});

test("team work notices only reach active conversation members and respect later loss of access", async () => {
  const [owner, reader, suspended, teammate] = await Promise.all([
    home(server.base, "space-owner"), home(server.base, "space-reader"),
    home(server.base, "space-suspended"), home(server.base, "space-teammate"),
  ]);
  const team = await owner.ok("POST", "/v1/ot/teams", {name:"Space notice team"});
  for (const member of [reader, suspended, teammate]) {
    const invite = await owner.ok("POST", `/v1/ot/teams/${team.id}/invites`, {});
    await member.ok("POST", "/v1/ot/invites/accept", {code:invite.code});
  }
  const workspace = (await owner.ok("GET", "/v1/ot/workspaces")).workspaces[0].workspace_id;
  const room = await owner.ok("POST", conversations, {
    kind:"group", title:"Document review", team_id:team.id, members:[reader.handle, suspended.handle],
  });
  const change = `/v1/ot/teams/${team.id}/members/${suspended.handle}`;
  const roomPath = conversations + "/" + room.id;
  const send = () => owner.ok("POST", roomPath + "/messages", {workspace, attachment:resource});
  const inbox = notifications + "?kind=work&workspace_id=" + workspace;
  await owner.ok("PATCH", change, {suspended:true});
  const first = await send();
  const readerNotice = (await reader.ok("GET", inbox)).notifications[0] as Notice;
  assert.equal(readerNotice.data.message_id, first.id);
  assert.equal(readerNotice.data.team_id, team.id);
  assert.equal((await teammate.ok("GET", inbox)).unread, 0);
  assert.equal((await reader.ok("GET", notifications + "?kind=work&personal=1")).unread, 0);
  assert.equal((await suspended.call("GET", inbox)).status, 404);
  await owner.ok("PATCH", change, {suspended:false});
  assert.equal((await suspended.ok("GET", inbox)).unread, 0, "no suppressed notices appear when reactivated");

  const second = await send();
  const notices = (await suspended.ok("GET", inbox)).notifications as Notice[];
  assert.deepEqual(notices.map(n => n.data.message_id), [second.id]);
  await reader.ok("POST", `/v1/ot/messages/${first.id}/hide`, {conversation_id:room.id});
  assert.deepEqual((await reader.ok("GET", inbox)).notifications.map((n:Notice) => n.data.message_id), [second.id]);
  await owner.ok("DELETE", roomPath + "/members/" + suspended.handle);
  assert.equal((await suspended.ok("GET", inbox)).unread, 0);
  assert.equal((await suspended.call("POST", notifications + "/read", {notification_id:notices[0].id, kind:"work"})).status, 404);
  assert.equal((await reader.ok("GET", inbox)).unread, 1);
  await owner.ok("PATCH", `/v1/ot/teams/${team.id}/members/${reader.handle}`, {suspended:true});
  assert.equal((await reader.ok("GET", notifications + "?kind=work")).unread, 0);
});

test("excluded kinds do not occupy pages or inflate unread counts, and following notices keep their own meaning", async () => {
  const [sender, reader, follower] = await Promise.all([
    home(server.base, "mute-work-sender"), home(server.base, "mute-reader"), home(server.base, "mute-follower"),
  ]);
  const recipient = await reader.ok("GET", "/v1/ot/me");
  const contact = await sender.ok("POST", "/v1/ot/contacts", {handle:reader.handle});
  await reader.ok("POST", "/v1/ot/contacts/" + contact.id, {action:"accept"});
  const conversation = await sender.ok("POST", conversations, {kind:"dm", peer:reader.handle});
  await sender.ok("POST", `${conversations}/${conversation.id}/messages`, {direct:true, attachment:resource});
  await reader.ok("POST", "/v1/ot/follows", {handle:sender.handle});
  await sender.ok("PUT", "/v1/ot/listings", {
    kind:"work", ref:"mute-test-work", slug:"mute-test-published-work", title:"Published work",
  });
  await follower.ok("POST", "/v1/ot/follows", {handle:reader.handle});

  const insert = server.platform.db.prepare(
    "INSERT INTO ot_notifications(id,owner_id,kind,data,created_at) VALUES(?,?,'messenger.mention','{}',?)");
  server.platform.db.transaction(() => {
    for (let index = 0; index < 205; index++) insert.run("mute-mention-" + index, recipient.owner_id, Date.now());
  })();

  const exclude = "messenger.mention,artifact.shared,artifact";
  const scoped = notifications + "?personal=1&exclude=" + encodeURIComponent(exclude);
  const first = await reader.ok("GET", scoped + "&limit=1&unread=1");
  assert.equal(first.notifications[0].kind, "discover.published");
  assert.equal(first.unread, 2, "unread is for the whole visible scope even when a page contains one row");
  assert.equal(first.exclude, exclude);
  const second = await reader.ok("GET", scoped + "&limit=1&unread=1&after=" + first.notifications[0].seq);
  assert.equal(second.notifications[0].kind, "follow.new");
  assert.equal(second.unread, 2, "the unread badge counts independently of the page cursor");
  const work = await reader.ok("GET", scoped + "&kind=work");
  assert.deepEqual(work.notifications.map((item:Notice) => item.kind), ["discover.published"]);
  assert.equal(work.unread, 1);
  assert.equal((await reader.call("GET", scoped + "&exclude=messenger.mention")).status, 400);
  assert.equal((await reader.call("GET", notifications + "?exclude=follow.new")).status, 400);

  assert.equal((await reader.call("POST", notifications + "/read", {
    personal:true, notification_id:"mute-mention-0", exclude,
  })).status, 404);
  assert.deepEqual(await reader.ok("POST", notifications + "/read", {personal:true, all:true, exclude}),
    {marked:2, unread:0, exclude});
  const visibleAgain = await reader.ok("GET", notifications + "?personal=1&unread=1");
  assert.equal(visibleAgain.unread, 206, "muting and marking other categories do not mark the hidden rows read");
  assert.equal(visibleAgain.notifications[0].kind, "artifact.shared");
});
