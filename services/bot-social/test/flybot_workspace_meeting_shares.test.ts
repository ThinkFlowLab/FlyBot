import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { bulkAuth, startServer } from "./helpers.js";
import { home } from "./flybot_workspace_helpers.js";
import { Platform } from "../src/platform.js";
import { OtContext } from "../src/flybot-workspace/core.js";
import { migrateMeetingShareAudience } from "../src/flybot-workspace/meeting-shares.js";

type Home = Awaited<ReturnType<typeof home>>;
const ROOT = "/v1/ot";
const SOURCE = "a".repeat(32);
const INBOX = ROOT + "/notifications";
let server: Awaited<ReturnType<typeof startServer>>;
before(async () => { server = await startServer(bulkAuth); });
after(async () => { await server.stop(); });

async function member(name: string) {
  const client = await home(server.base, name);
  const profile = await client.ok("GET", ROOT + "/me");
  return { ...client, id: profile.owner_id as string, name: profile.display_name as string };
}

async function contacts(a: Home, b: Home) {
  const request = await a.ok("POST", ROOT + "/contacts", { handle: b.handle });
  await b.ok("POST", ROOT + "/contacts/" + request.id, { action: "accept" });
  return request.id;
}

function sharing(conversationId: string, ...recipientIds: string[]) {
  return {
    conversation_id: conversationId, recipient_ids: recipientIds, source_id: SOURCE,
    revision: 1, title: "Launch notes", started_at: 1719879200, summary: "The launch is ready.\nNext step follows.",
    action_items: [{ text: "Confirm launch", owner: "On-call", done: true }, { text: "Check tickets", owner: "", done: false }],
    client_key: "meeting-share-example-001",
  };
}

function recipients(scope: string, conversationId: string) {
  return scope + "/meeting-share-recipients?conversation_id=" + conversationId;
}

async function team(owner: Home, key: string, ...members: Home[]) {
  const row = await owner.ok("POST", ROOT + "/workspaces", { idempotency_key: key, name: "Review team" });
  for (const teammate of members) {
    const { code } = await owner.ok("POST", ROOT + "/teams/" + row.id + "/invites", {});
    await teammate.ok("POST", ROOT + "/invites/accept", { code });
  }
  return row;
}

type Notice = { id: string; seq: number; kind: string; data: Record<string, unknown>; read: boolean };
function meetingNotices(page: { notifications: Notice[] }) {
  return page.notifications.filter(row => row.kind === "meeting.shared");
}

test("finished invite-link call shares survive room cleanup and reach only selected attendees", async () => {
  const [author, reader, unselected, previewOnly] = await Promise.all([
    member("call-notes-author"), member("call-notes-reader"), member("call-notes-unselected"), member("call-notes-preview"),
  ]);
  const calls = ROOT + "/meeting-calls";
  const started = await author.ok("POST", calls + "/create", { title: "Standalone notes", peer_id: "noteshare-host-peer" });
  for (const [participant, peer] of [[reader, "noteshare-reader-peer"], [unselected, "noteshare-other-peer"]] as const) {
    await participant.ok("POST", calls + "/join", { code: started.meeting.code, peer_id: peer });
  }
  await previewOnly.ok("POST", calls + "/preview", { code: started.meeting.code });
  const select = ROOT + "/meeting-share-recipients?call_id=" + started.call.id;
  assert.equal((await author.call("GET", select)).status, 409);
  assert.equal((await previewOnly.call("GET", select)).status, 404);
  await author.ok("POST", calls + "/end", {call_id: started.call.id, peer_id: started.peer_id});
  assert.deepEqual((await author.ok("GET", select)).items.map((row: {id: string}) => row.id).sort(),
    [reader.id, unselected.id].sort());
  assert.equal((await previewOnly.call("GET", select)).status, 404);
  assert.deepEqual((await author.ok("GET", ROOT + "/conversations")).conversations, []);
  const {conversation_id: _, ...notes} = sharing("unused", reader.id);
  const payload = { ...notes, call_id: started.call.id };
  const shares = ROOT + "/meeting-shares";
  assert.equal((await previewOnly.call("POST", shares, payload)).status, 404);
  assert.equal((await author.call("POST", shares, { ...payload, recipient_ids: [previewOnly.id] })).status, 404);
  assert.equal((await author.call("POST", shares, { ...payload, conversation_id: "unused" })).status, 400);
  const { meeting } = await author.ok("POST", shares, payload);
  assert.deepEqual((await author.ok("POST", shares, payload)), {meeting, replayed: true});
  assert.deepEqual((await reader.ok("GET", shares)).items.map((row: {id: string}) => row.id), [meeting.id]);
  assert.deepEqual((await reader.ok("GET", shares + "/" + meeting.id)).meeting, meeting);
  assert.deepEqual(meetingNotices(await reader.ok("GET", INBOX + "?personal=1")).map(row => row.data.share_id), [meeting.id]);
  assert.equal("transcript" in meeting || "attendees" in meeting, false);
  for (const noAccess of [unselected, previewOnly]) {
    assert.deepEqual(await noAccess.ok("GET", shares), {items: [], cursor: null});
    assert.equal((await noAccess.call("GET", shares + "/" + meeting.id)).status, 404);
    assert.deepEqual(meetingNotices(await noAccess.ok("GET", INBOX)), []);
  }
  await author.ok("POST", shares + "/" + meeting.id + "/revoke", {});
  assert.equal((await reader.call("GET", shares + "/" + meeting.id)).status, 404);
  assert.deepEqual(meetingNotices(await reader.ok("GET", INBOX)), []);
});

test("meeting audience migration preserves existing receipts and their cursor counter", () => {
  const platform = new Platform();
  try {
    const ot = new OtContext(platform);
    ot.db.exec(`
      CREATE TABLE ot_conversations(id TEXT PRIMARY KEY);
      CREATE TABLE ot_call_records(id TEXT PRIMARY KEY);
      CREATE TABLE ot_meeting_shares (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, workspace_id TEXT,
        conversation_id TEXT NOT NULL REFERENCES ot_conversations(id) ON DELETE CASCADE,
        sender_id TEXT NOT NULL, source_id TEXT NOT NULL, client_key TEXT NOT NULL, request_hash TEXT NOT NULL,
        revision INTEGER NOT NULL, title TEXT NOT NULL, started_at INTEGER NOT NULL,
        organizer TEXT NOT NULL, summary TEXT NOT NULL, action_items TEXT NOT NULL,
        action_count INTEGER NOT NULL, done_count INTEGER NOT NULL, created INTEGER NOT NULL, revoked_at INTEGER,
        UNIQUE (sender_id, client_key)
      );
      CREATE TABLE ot_meeting_share_recipients (
        share_id TEXT NOT NULL REFERENCES ot_meeting_shares(id) ON DELETE CASCADE,
        recipient_id TEXT NOT NULL, display_name TEXT NOT NULL, PRIMARY KEY (share_id, recipient_id)
      );
      INSERT INTO ot_conversations VALUES ('existing-conversation');
      INSERT INTO ot_meeting_shares VALUES
        (13,'existing-share',NULL,'existing-conversation','owner','note','key','hash',2,'Title',1,'Host','Notes','[]',0,0,2,NULL);
      INSERT INTO ot_meeting_share_recipients VALUES ('existing-share','reader','Reader');
      UPDATE sqlite_sequence SET seq=15 WHERE name='ot_meeting_shares';
    `);
    const oldShare = ot.get("SELECT * FROM ot_meeting_shares");
    const oldAudience = ot.get("SELECT * FROM ot_meeting_share_recipients");
    migrateMeetingShareAudience(ot);
    migrateMeetingShareAudience(ot);
    assert.deepEqual(ot.get("SELECT * FROM ot_meeting_shares"), {...oldShare, call_id: null});
    assert.deepEqual(ot.get("SELECT * FROM ot_meeting_share_recipients"), oldAudience);
    assert.deepEqual(ot.get("SELECT seq FROM sqlite_sequence WHERE name='ot_meeting_shares'"), {seq:15});
    assert.deepEqual(ot.all("PRAGMA foreign_key_check"), []);
    ot.run("DELETE FROM ot_conversations WHERE id='existing-conversation'");
    assert.equal(ot.get("SELECT * FROM ot_meeting_shares"), undefined);
    assert.equal(ot.get("SELECT * FROM ot_meeting_share_recipients"), undefined);
  } finally { platform.close(); }
});

test("received action pages include only pending assignments on still-visible receipts", async () => {
  const [author, reader, unselected] = await Promise.all([
    member("inbox-author"), member("inbox-reader"), member("inbox-unselected"),
  ]);
  await contacts(author, reader);
  await contacts(author, unselected);
  const group = await author.ok("POST", ROOT + "/conversations", {kind:"group", account_group:true,
    title:"Shared actions", members:[reader.handle, unselected.handle]});
  const shares = ROOT + "/meeting-shares";
  const older = await author.ok("POST", shares, {
    ...sharing(group.id, reader.id), client_key:"received-inbox-old",
    action_items:[{text:"Other receipt task", owner:"inbox-reader"}],
  });
  const recent = await author.ok("POST", shares, {
    ...sharing(group.id, reader.id), client_key:"received-inbox-new",
    action_items:[
      {text:"Another owner", owner:"inbox-unselected"},
      {text:"Follow up with partner", owner:"Inbox-Reader", due_date:"2032-02-29"},
      {text:"Already done", owner:"inbox-reader", done:true},
      {text:"Verify proof", owner:"inbox-reader"},
    ],
  });
  const path = shares + "?view=actions&owner=inbox-reader&limit=1";
  const first = await reader.ok("GET", path);
  assert.equal(first.cursor, recent.meeting.id + ".1");
  assert.deepEqual(first.items, [{share_id:recent.meeting.id, meeting_title:recent.meeting.title,
    revision:1, organizer:author.name, action_index:1, text:"Follow up with partner",
    due_date:"2032-02-29", owner:"Inbox-Reader"}]);
  const second = await reader.ok("GET", path + "&cursor=" + first.cursor);
  assert.equal(second.items[0].action_index, 3);
  assert.equal(second.cursor, recent.meeting.id + ".3");
  assert.deepEqual(await unselected.ok("GET", path), {items:[], cursor:null});
  assert.deepEqual(await unselected.ok("GET", path + "&cursor=" + first.cursor), {items:[], cursor:null});
  assert.equal((await reader.call("GET", path + "&sent=1")).status, 400);
  assert.equal((await reader.call("GET", path + "&owner=someone-else")).status, 400);
  await author.ok("POST", shares + "/" + recent.meeting.id + "/revoke", {});
  const remaining = await reader.ok("GET", path + "&cursor=" + second.cursor);
  assert.deepEqual(remaining.items.map((row: {share_id:string}) => row.share_id), [older.meeting.id]);
  assert.equal(remaining.cursor, null);
});

test("personal receipts save distinct immutable versions, page privately and revoke by author", async () => {
  const [author, reader, unselected, outsider] = await Promise.all([
    member("note-author"), member("note-reader"), member("note-unselected"), member("note-outsider"),
  ]);
  await contacts(author, reader);
  await contacts(author, unselected);
  const group = await author.ok("POST", ROOT + "/conversations", { kind: "group", account_group: true,
    title: "Launch team", members: [reader.handle, unselected.handle] });
  const selector = recipients(ROOT, group.id);
  const shares = ROOT + "/meeting-shares";
  assert.deepEqual((await author.ok("GET", selector)).items, [
    { id: reader.id, name: reader.name }, { id: unselected.id, name: unselected.name },
  ]);
  assert.equal((await outsider.call("GET", selector)).status, 404);
  const originalPayload = sharing(group.id, reader.id);
  const payload = {...originalPayload, action_items: originalPayload.action_items.map((item,index) =>
    index ? item : {...item, due_date: "2032-02-29"})};
  assert.equal((await author.call("POST", shares, { ...payload, recipient_ids: [reader.id, outsider.id] })).status, 404);
  assert.equal((await author.call("POST", shares, { ...payload, recipient_ids: [reader.handle] })).status, 404);
  assert.equal((await author.call("POST", shares, { ...payload, recipient_ids: [author.id] })).status, 404);
  assert.equal((await author.call("POST", shares, { ...payload, transcript: "private" })).status, 400);
  assert.equal((await author.call("POST", shares, { ...payload, live_code: "private" })).status, 400);
  assert.equal((await author.call("POST", shares, { ...payload, action_items: [{ text: "task", done: "true" }] })).status, 400);
  assert.equal((await author.call("POST", shares, { ...payload, action_items: [{ text: "task", due_date: "2031-02-29" }] })).status, 400);
  assert.equal((await author.call("POST", shares, { ...payload, action_items: [{ text: "task", transcript: "private" }] })).status, 400);
  assert.deepEqual(await reader.ok("GET", shares), { items: [], cursor: null });

  const responses = await Promise.all([author.call("POST", shares, payload), author.call("POST", shares, payload)]);
  const original = responses.find(response => response.status === 201);
  const replay = responses.find(response => response.status === 200);
  assert.ok(original);
  assert.deepEqual(replay?.data, { ...original.data, replayed: true });
  const first = original.data.meeting;
  assert.match(first.id, /^[0-9a-f]{32}$/);
  assert.deepEqual(first, {
    id: first.id, title: payload.title, revision: 1, started_at: payload.started_at, created: first.created,
    organizer: author.name, action_count: 2, done_count: 1, shared: true, summary: payload.summary, action_items: payload.action_items,
  });
  assert.ok(Math.abs(first.created - Math.floor(Date.now() / 1000)) <= 5);
  assert.equal((await author.call("POST", shares, { ...payload, summary: "different" })).status, 409);
  const second = (await author.ok("POST", shares, { ...payload, revision: 2, summary: "Updated", client_key: "meeting-share-example-002" })).meeting;
  assert.notEqual(second.id, first.id);
  const outgoing = await author.ok("GET", shares + "?source_id=" + SOURCE);
  assert.deepEqual(outgoing.items.map((row: any) => [row.id, row.recipients]), [
    [second.id, [reader.name]], [first.id, [reader.name]],
  ]);
  const sentPage = await author.ok("GET", shares + "?sent=1&limit=1");
  assert.deepEqual(sentPage, { items: [outgoing.items[0]], cursor: second.id });
  assert.deepEqual(await author.ok("GET", shares + "?sent=1&limit=1&cursor=" + sentPage.cursor),
    { items: [outgoing.items[1]], cursor: null });
  assert.deepEqual(await reader.ok("GET", shares + "?sent=1"), { items: [], cursor: null });
  assert.deepEqual(await outsider.ok("GET", shares + "?sent=1&cursor=" + sentPage.cursor), { items: [], cursor: null });
  assert.equal((await author.call("GET", shares + "?sent=1&source_id=" + SOURCE)).status, 400);
  assert.deepEqual(await author.ok("GET", shares), { items: [], cursor: null });
  assert.deepEqual(await reader.ok("GET", shares + "?source_id=" + SOURCE), { items: [], cursor: null });
  const page = await reader.ok("GET", shares + "?limit=1");
  assert.equal(page.cursor, second.id);
  assert.deepEqual(page.items, [
    { id: second.id, title: payload.title, revision: 2, started_at: payload.started_at, created: second.created,
      organizer: author.name, action_count: 2, done_count: 1, shared: true },
  ]);
  assert.deepEqual(await reader.ok("GET", shares + "/" + first.id), { meeting: first, received: true });
  assert.deepEqual(await author.ok("GET", shares + "/" + first.id), { meeting: first, received: false });
  assert.deepEqual(await unselected.ok("GET", shares), { items: [], cursor: null });
  assert.equal((await unselected.call("GET", shares + "/" + first.id)).status, 404);
  assert.equal((await outsider.call("GET", shares + "/" + first.id)).status, 404);
  assert.equal((await reader.call("POST", shares + "/" + second.id + "/revoke", {})).status, 404);
  const anonymous = await fetch(server.base + shares + "/" + first.id);
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get("cache-control") ?? "", /no-store/);
  assert.deepEqual(await author.ok("POST", shares + "/" + second.id + "/revoke", {}), { revoked: true });
  assert.deepEqual(await author.ok("POST", shares + "/" + second.id + "/revoke", {}), { revoked: true });
  assert.equal((await reader.call("GET", shares + "/" + second.id)).status, 404);
  const afterRevokedCursor = await reader.ok("GET", shares + "?limit=1&cursor=" + page.cursor);
  assert.deepEqual(afterRevokedCursor.items.map((row: any) => row.id), [first.id]);
  assert.equal(afterRevokedCursor.cursor, null);
  await author.ok("DELETE", ROOT + "/conversations/" + group.id + "/members/" + reader.handle);
  assert.deepEqual(await reader.ok("GET", shares), { items: [], cursor: null });
  assert.equal((await reader.call("GET", shares + "/" + first.id)).status, 404);
  assert.deepEqual(await author.ok("GET", shares + "?sent=1"), { items: [outgoing.items[1]], cursor: null });
  assert.deepEqual(await author.ok("POST", shares + "/" + first.id + "/revoke", {}), { revoked: true });
  assert.deepEqual(await author.ok("GET", shares + "?sent=1"), { items: [], cursor: null });
  const messages = server.platform.db.prepare<[string], { n: number }>(
    "SELECT COUNT(*) AS n FROM ot_messages WHERE conversation_id=?").get(group.id);
  assert.equal(messages?.n, 0);
});

test("team scope follows the exact workspace, active team and conversation seats", async () => {
  const [admin, author, reader, unselected] = await Promise.all([
    member("notes-admin"), member("notes-sender"), member("notes-viewer"), member("notes-other"),
  ]);
  const first = await team(admin, "meetings-test-first-team", author, reader, unselected);
  const second = await team(admin, "meetings-test-second-team", author, reader);
  const scope = ROOT + "/workspaces/" + first.workspace_id;
  const wrong = ROOT + "/workspaces/" + second.workspace_id;
  const group = await admin.ok("POST", ROOT + "/conversations", { kind: "group", team_id: first.id,
    title: "Shared notes", members: [author.handle, reader.handle, unselected.handle] });
  const shares = scope + "/meeting-shares";
  const payload = sharing(group.id, reader.id);
  assert.ok((await author.ok("GET", recipients(scope, group.id))).items.some((row: { id: string }) => row.id === reader.id));
  assert.equal((await author.call("GET", recipients(wrong, group.id))).status, 404);
  assert.equal((await author.call("POST", ROOT + "/meeting-shares", payload)).status, 404);
  assert.equal((await author.call("POST", wrong + "/meeting-shares", payload)).status, 404);
  const share = (await author.ok("POST", shares, payload)).meeting;
  assert.equal((await reader.ok("GET", shares + "/" + share.id)).meeting.id, share.id);
  assert.deepEqual((await author.ok("GET", shares + "?sent=1")).items.map((row: {id: string}) => row.id), [share.id]);
  assert.deepEqual(await author.ok("GET", wrong + "/meeting-shares?sent=1"), { items: [], cursor: null });
  assert.deepEqual(await author.ok("GET", ROOT + "/meeting-shares?sent=1"), { items: [], cursor: null });
  assert.deepEqual(await reader.ok("GET", wrong + "/meeting-shares"), { items: [], cursor: null });
  assert.equal((await reader.call("GET", wrong + "/meeting-shares/" + share.id)).status, 404);
  assert.equal((await reader.call("GET", ROOT + "/meeting-shares/" + share.id)).status, 404);
  assert.equal((await author.call("POST", wrong + "/meeting-shares/" + share.id + "/revoke", {})).status, 404);
  const members = ROOT + "/teams/" + first.id + "/members/";
  await admin.ok("PATCH", members + reader.handle, { suspended: true });
  assert.equal((await reader.call("GET", shares + "/" + share.id)).status, 404);
  assert.ok((await author.ok("GET", recipients(scope, group.id))).items.every((row: { id: string }) => row.id !== reader.id));
  await admin.ok("PATCH", members + reader.handle, { suspended: false });
  assert.equal((await reader.ok("GET", shares + "/" + share.id)).meeting.id, share.id);
  await admin.ok("PATCH", members + author.handle, { suspended: true });
  assert.deepEqual(await reader.ok("GET", shares), { items: [], cursor: null });
  assert.equal((await reader.call("GET", shares + "/" + share.id)).status, 404);
  assert.deepEqual(await author.ok("POST", shares + "/" + share.id + "/revoke", {}), { revoked: true });
  await admin.ok("PATCH", members + author.handle, { suspended: false });
  assert.equal((await reader.call("GET", shares + "/" + share.id)).status, 404);
});

test("ordinary direct shares require current reach and public agent threads cannot receive snapshots", async () => {
  const [author, reader] = await Promise.all([member("direct-note-writer"), member("direct-note-reader")]);
  const contact = await contacts(author, reader);
  const dm = await author.ok("POST", ROOT + "/conversations", { kind: "dm", peer: reader.handle });
  const shares = ROOT + "/meeting-shares";
  assert.deepEqual(await author.ok("GET", recipients(ROOT, dm.id)), { items: [{ id: reader.id, name: reader.name }] });
  const receipt = (await author.ok("POST", shares, sharing(dm.id, reader.id))).meeting;
  assert.equal((await reader.ok("GET", shares)).items[0].id, receipt.id);
  await author.ok("POST", ROOT + "/contacts/" + contact, { action: "remove" });
  assert.equal((await author.call("GET", recipients(ROOT, dm.id))).status, 403);
  assert.equal((await reader.call("GET", shares + "/" + receipt.id)).status, 404);
  assert.deepEqual(await reader.ok("GET", shares), { items: [], cursor: null });

  const workspace = await team(author, "meetings-dm-team", reader);
  const scope = ROOT + "/workspaces/" + workspace.workspace_id;
  const scopedShares = scope + "/meeting-shares";
  const scopedPayload = { ...sharing(dm.id, reader.id), client_key: "meeting-share-scoped-dm" };
  assert.equal((await reader.ok("GET", shares)).items[0].id, receipt.id);
  assert.deepEqual(await author.ok("GET", recipients(scope, dm.id)), { items: [{ id: reader.id, name: reader.name }] });
  const scopedReceipt = (await author.ok("POST", scopedShares, scopedPayload)).meeting;
  assert.equal((await reader.ok("GET", scopedShares)).items[0].id, scopedReceipt.id);
  assert.equal((await reader.call("GET", scopedShares + "/" + receipt.id)).status, 404);
  assert.equal((await reader.call("GET", shares + "/" + scopedReceipt.id)).status, 404);
  await author.ok("DELETE", ROOT + "/teams/" + workspace.id + "/members/" + reader.handle);
  assert.equal((await reader.call("GET", scopedShares + "/" + scopedReceipt.id)).status, 404);
  assert.equal((await author.call("POST", scopedShares, { ...scopedPayload, client_key: "meeting-scoped-dm-removed" })).status, 404);
  assert.equal((await reader.call("GET", shares + "/" + receipt.id)).status, 404);

  const slug = "meeting-share-no-public";
  await author.ok("PUT", ROOT + "/listings", { kind: "agent", ref: "notes_pub", slug, title: "Public agent",
    snapshot: JSON.stringify({ version: 1, instructions: "Help with public notes" }), chat_enabled: true });
  const thread = await reader.ok("POST", ROOT + "/discover/" + slug + "/start");
  assert.equal((await reader.call("GET", recipients(ROOT, thread.conversation_id))).status, 404);
  assert.equal((await reader.call("POST", shares, sharing(thread.conversation_id, author.id))).status, 404);
});

test("meeting invitations notify chosen accounts once and inbox ordering preserves the legacy cursor", async () => {
  const [author, reader, second, unselected] = await Promise.all([
    member("inbox-note-author"), member("inbox-note-reader"), member("inbox-note-second"), member("inbox-note-unselected"),
  ]);
  for (const recipient of [reader, second, unselected]) await contacts(author, recipient);
  const group = await author.ok("POST", ROOT + "/conversations", { kind: "group", account_group: true,
    title: "Personal notes inbox", members: [reader.handle, second.handle, unselected.handle] });
  const shares = ROOT + "/meeting-shares";
  const workspace = await team(author, "note-inbox-other-workspace", reader);
  const before = await reader.ok("POST", INBOX + "/read", { all: true, personal: true });
  assert.equal(before.unread, 0);
  const firstPayload = sharing(group.id, reader.id, second.id);
  const first = (await author.ok("POST", shares, firstPayload)).meeting;
  const replay = await author.call("POST", shares, { ...firstPayload, recipient_ids: [second.id, reader.id] });
  assert.equal(replay.status, 200);
  assert.equal(replay.data.meeting.id, first.id);
  const newer = (await author.ok("POST", shares, { ...sharing(group.id, reader.id), client_key: "notes-inbox-newer",
    revision: 2, title: "Newer notes" })).meeting;

  const legacy = await reader.ok("GET", INBOX + "?personal=1");
  const [oldNotice, newNotice] = meetingNotices(legacy);
  assert.equal(meetingNotices(legacy).length, 2);
  assert.ok(oldNotice.seq < newNotice.seq);
  assert.deepEqual(oldNotice.data, { share_id: first.id, title: first.title, organizer: first.organizer });
  assert.deepEqual(newNotice.data, { share_id: newer.id, title: newer.title, organizer: newer.organizer });
  assert.deepEqual(meetingNotices(await second.ok("GET", INBOX)).map(row => row.data.share_id), [first.id]);
  assert.deepEqual(meetingNotices(await unselected.ok("GET", INBOX)), []);
  assert.deepEqual(meetingNotices(await author.ok("GET", INBOX)), []);
  const latest = await reader.ok("GET", INBOX + "?personal=1&latest=1&unread=1&limit=1");
  assert.equal(latest.unread, 2);
  assert.deepEqual(latest.notifications.map((row: Notice) => row.id), [newNotice.id]);
  const paged = await reader.ok("GET", INBOX + "?personal=1&after=" + oldNotice.seq);
  assert.deepEqual(paged.notifications.map((row: Notice) => row.id), [newNotice.id]);
  assert.equal((await reader.call("GET", INBOX + "?latest=1&latest=1")).status, 400);
  assert.equal((await reader.call("GET", INBOX + "?latest=only")).status, 400);
  assert.deepEqual(meetingNotices(await reader.ok("GET", INBOX + "?workspace_id=" + workspace.workspace_id)), []);
  assert.equal((await reader.call("POST", INBOX + "/read", { notification_id: oldNotice.id,
    workspace_id: workspace.workspace_id })).status, 404);
  assert.equal((await unselected.call("POST", INBOX + "/read", { notification_id: oldNotice.id })).status, 404);
  assert.deepEqual(await reader.ok("POST", INBOX + "/read", { notification_id: oldNotice.id, personal: true }),
    { unread: 1, marked: 1 });
  assert.equal(meetingNotices(await reader.ok("GET", INBOX + "?personal=1&unread=1"))[0].id, newNotice.id);

  await author.ok("POST", shares + "/" + newer.id + "/revoke", {});
  assert.equal((await reader.ok("GET", INBOX + "?personal=1")).unread, 0);
  assert.equal((await reader.call("POST", INBOX + "/read", { notification_id: newNotice.id, personal: true })).status, 404);
  await author.ok("DELETE", ROOT + "/conversations/" + group.id + "/members/" + reader.handle);
  assert.deepEqual(meetingNotices(await reader.ok("GET", INBOX)), []);
  assert.equal((await reader.call("POST", INBOX + "/read", { notification_id: oldNotice.id })).status, 404);
  const hidden = server.platform.db.prepare<[string], { read_at: number | null }>(
    "SELECT read_at FROM ot_notifications WHERE id=?").get(newNotice.id);
  await reader.ok("POST", INBOX + "/read", { up_to: newNotice.seq });
  assert.equal(hidden?.read_at, null);
  assert.equal(server.platform.db.prepare<[string], { read_at: number | null }>(
    "SELECT read_at FROM ot_notifications WHERE id=?").get(newNotice.id)?.read_at, null);
});

test("team receipts in an ordinary DM stay in the owning workspace and follow live access", async () => {
  const [owner, author, reader] = await Promise.all([
    member("team-notice-owner"), member("team-notice-author"), member("team-notice-reader"),
  ]);
  const anchor = await team(owner, "meeting-notice-team-one", author, reader);
  const other = await team(owner, "meeting-notice-team-two", author, reader);
  const dm = await author.ok("POST", ROOT + "/conversations", { kind: "dm", peer: reader.handle });
  const scope = ROOT + "/workspaces/" + anchor.workspace_id;
  const teamParams = "?workspace_id=" + anchor.workspace_id;
  await reader.ok("POST", INBOX + "/read", { all: true, workspace_id: anchor.workspace_id });
  const receipt = (await author.ok("POST", scope + "/meeting-shares", sharing(dm.id, reader.id))).meeting;
  const personal = (await author.ok("POST", ROOT + "/meeting-shares", { ...sharing(dm.id, reader.id),
    client_key: "team-notice-personal-version" })).meeting;
  const teamPage = await reader.ok("GET", INBOX + teamParams);
  assert.equal(teamPage.unread, 1);
  const [notice] = meetingNotices(teamPage);
  assert.deepEqual(meetingNotices(teamPage).map(row => row.data), [
    { share_id: receipt.id, title: receipt.title, organizer: receipt.organizer, workspace_id: anchor.workspace_id },
  ]);
  assert.deepEqual(meetingNotices(await reader.ok("GET", INBOX + "?personal=1")).map(row => row.data.share_id), [personal.id]);
  assert.deepEqual(meetingNotices(await reader.ok("GET", INBOX + "?workspace_id=" + other.workspace_id)), []);
  assert.equal((await reader.call("POST", INBOX + "/read", { notification_id: notice.id, personal: true })).status, 404);
  assert.equal((await reader.call("POST", INBOX + "/read", { notification_id: notice.id,
    workspace_id: other.workspace_id })).status, 404);

  const members = ROOT + "/teams/" + anchor.id + "/members/";
  await owner.ok("PATCH", members + author.handle, { suspended: true });
  assert.deepEqual(meetingNotices(await reader.ok("GET", INBOX)).map(row => row.data.share_id), [personal.id]);
  assert.equal(meetingNotices(await reader.ok("GET", INBOX + teamParams + "&unread=1")).length, 0);
  assert.equal((await reader.call("POST", INBOX + "/read", { notification_id: notice.id })).status, 404);
  await owner.ok("PATCH", members + author.handle, { suspended: false });
  assert.equal(meetingNotices(await reader.ok("GET", INBOX + teamParams))[0].id, notice.id);
  await owner.ok("PATCH", members + reader.handle, { suspended: true });
  assert.equal((await reader.call("GET", INBOX + teamParams)).status, 404);
  assert.deepEqual(meetingNotices(await reader.ok("GET", INBOX)).map(row => row.data.share_id), [personal.id]);
  await owner.ok("DELETE", ROOT + "/teams/" + other.id + "/members/" + reader.handle);
  assert.deepEqual(meetingNotices(await reader.ok("GET", INBOX + "?personal=1")), []);
});
