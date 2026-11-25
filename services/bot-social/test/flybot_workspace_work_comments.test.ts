import assert from "node:assert/strict";
import { test } from "node:test";
import { bulkAuth, startServer } from "./helpers.js";
import { home } from "./flybot_workspace_helpers.js";

test("published work comments persist, deduplicate concurrent delivery, allow replies and support moderation", async t => {
  const service = await startServer(bulkAuth);
  t.after(service.stop);
  const author = await home(service.base, "workauthor");
  const commenter = await home(service.base, "commenter");
  const reader = await home(service.base, "commentreader");
  const slug = "work-discussion";
  const path = `/v1/ot/discover/${slug}/comments`;
  const guest = `${service.base}/w/${slug}`;
  const listing = await author.ok("PUT", "/v1/ot/listings", {
    kind: "work", ref: "discussion_fixture", slug, title: "讨论验收",
  });
  assert.equal(listing.comment_count, 0);
  assert.equal((await fetch(service.base + path)).status, 401);
  assert.deepEqual(await commenter.ok("GET", path), {items: [], cursor: null, comment_count: 0});
  assert.equal((await commenter.call("POST", path, {body: "  ", client_key: "empty"})).status, 400);
  assert.equal((await commenter.call("POST", path, {body: "没有重试标识"})).status, 400);

  const submitted = {body: "第一条 <script>示例</script>", client_key: "comment-unique"};
  const responses = await Promise.all([
    commenter.call("POST", path, submitted), commenter.call("POST", path, submitted),
  ]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 201]);
  const saved = responses.find(r => r.status === 201)!.data;
  assert.equal(saved.replayed, undefined);
  const replay = responses.find(r => r.status === 200)!.data;
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.comment, saved.comment);
  assert.equal(saved.comment_count, 1);
  const root = saved.comment.id;
  assert.match(root, /^otwc_/);
  assert.equal(saved.comment.body, submitted.body);
  assert.equal(saved.comment.parent_id, null);
  assert.equal(saved.comment.mine, true);
  assert.equal(saved.comment.can_remove, true);
  assert.deepEqual(Object.keys(saved.comment.author).sort(), ["handle", "name"]);
  assert.equal(saved.comment.author.handle, commenter.handle);
  assert.equal(saved.comment.client_key, undefined);
  assert.equal((await commenter.call("POST", path, {...submitted, body: "reuse key"})).status, 409);

  const reply = {body: "回复记录", parent_id: root, client_key: "reply-unique"};
  const replied = await author.ok("POST", path, reply);
  assert.equal(replied.comment_count, 2);
  assert.equal(replied.comment.parent_id, root);
  assert.equal(replied.parent_reply_count, 1);
  const replyReplay = await author.call("POST", path, reply);
  assert.equal(replyReplay.status, 200);
  assert.equal(replyReplay.data.parent_reply_count, 1);
  assert.equal((await reader.call("POST", path, {
    body: "不能再嵌套", parent_id: replied.comment.id, client_key: "nested",
  })).status, 400);
  assert.deepEqual((await reader.ok("GET", path + "?parent_id=" + root)).items.map((row: any) => row.body), ["回复记录"]);
  const timeline = await reader.ok("GET", path);
  assert.equal(timeline.items[0].reply_count, 1);
  assert.equal(timeline.items[0].mine, false);
  assert.equal(timeline.items[0].can_remove, false);
  assert.equal((await author.ok("GET", path)).items[0].can_remove, true);

  const like = path + "/" + root + "/like";
  assert.equal((await reader.call("POST", like, {enabled: "true"})).status, 400);
  assert.equal((await reader.ok("POST", like, {enabled: true})).comment.likes, 1);
  assert.equal((await reader.ok("POST", like, {enabled: true})).comment.likes, 1);
  assert.equal((await commenter.ok("GET", path)).items[0].liked, false);
  assert.equal((await reader.ok("GET", path)).items[0].liked, true);
  assert.equal((await reader.ok("POST", like, {enabled: false})).comment.likes, 0);
  await reader.ok("POST", like, {enabled: true});

  const guestList = await fetch(guest + "/comments");
  assert.equal(guestList.headers.get("cache-control"), "no-store");
  const guestData: any = await guestList.json();
  assert.equal(guestData.comment_count, 2);
  assert.equal(guestData.items[0].mine, undefined);
  assert.equal(guestData.items[0].can_remove, undefined);
  assert.equal(guestData.items[0].liked, undefined);
  assert.equal(guestData.items[0].likes, 1);
  const guestPage = await fetch(guest);
  assert.equal(guestPage.headers.get("cache-control"), "no-store");
  const html = await guestPage.text();
  assert.match(html, /第一条 &lt;script&gt;示例&lt;\/script&gt;/);
  assert.match(html, /href="\/login#work-comments=work-discussion"/);
  assert.doesNotMatch(html, /第一条 <script>/);
  const feed = await reader.ok("GET", "/v1/ot/discover?kind=work&q=讨论");
  assert.equal(feed.items[0].comment_count, 2);

  const remove = path + "/" + root + "/remove";
  assert.equal((await reader.call("POST", remove, {})).status, 403);
  assert.equal((await author.ok("POST", remove, {})).comment_count, 1);
  assert.equal((await author.ok("POST", remove, {})).comment_count, 1);
  const retained = (await reader.ok("GET", path)).items[0];
  assert.deepEqual([retained.removed, retained.author, retained.body, retained.reply_count, retained.likes], [true, null, "", 1, 0]);
  const replyToRemovedRoot = await author.call("POST", path, reply);
  assert.equal(replyToRemovedRoot.status, 200);
  assert.equal(replyToRemovedRoot.data.comment.id, replied.comment.id);
  assert.equal(replyToRemovedRoot.data.parent_reply_count, 1);
  assert.equal((await reader.call("POST", like, {enabled: true})).status, 404);
  assert.equal((await reader.call("POST", path, {body: "追加", parent_id: root, client_key: "removed-root"})).status, 404);
  assert.equal((await author.ok("POST", path + "/" + replied.comment.id + "/remove", {})).comment_count, 0);
  assert.deepEqual(await reader.ok("GET", path), {items: [], cursor: null, comment_count: 0});
  assert.equal((await reader.call("GET", path + "?parent_id=" + root)).status, 404);

  await author.ok("DELETE", "/v1/ot/listings/" + listing.id);
  assert.equal((await fetch(guest + "/comments")).status, 404);
  assert.equal((await author.call("GET", path)).status, 404);
  assert.equal((await author.call("POST", path, {body: "unlisted", client_key: "unlisted"})).status, 404);
});

test("comment cursors are stable across same-time inserts and removal, and replies cannot cross works", async t => {
  const service = await startServer({...bulkAuth, now: () => 1795212000000});
  t.after(service.stop);
  const author = await home(service.base, "pageauthor");
  const reader = await home(service.base, "pagereader");
  const path = "/v1/ot/discover/comments-paging/comments";
  const other = "/v1/ot/discover/comments-other/comments";
  await author.ok("PUT", "/v1/ot/listings", {kind: "work", ref: "page_work", slug: "comments-paging", title: "分页"});
  await author.ok("PUT", "/v1/ot/listings", {kind: "work", ref: "other_work", slug: "comments-other", title: "其他"});
  await author.ok("PUT", "/v1/ot/listings", {kind: "agent", ref: "agent_work", slug: "comments-agent", title: "智能体"});
  assert.equal((await reader.call("GET", "/v1/ot/discover/comments-agent/comments")).status, 404);

  const ids = [];
  for (let i = 0; i < 3; i++) {
    const {comment} = await reader.ok("POST", path, {body: `第 ${i + 1} 条`, client_key: `root-${i + 1}`});
    ids.push(comment.id as string);
  }
  const expected = ids.sort().reverse();
  const top = await reader.ok("GET", path + "?limit=1");
  assert.equal(top.items[0].id, expected[0]);
  assert.equal(typeof top.cursor, "string");
  await reader.ok("POST", path + "/" + top.items[0].id + "/remove", {});
  const next = await reader.ok("GET", path + "?limit=1&cursor=" + encodeURIComponent(top.cursor));
  assert.equal(next.items[0].id, expected[1]);
  const last = await reader.ok("GET", path + "?limit=1&cursor=" + encodeURIComponent(next.cursor));
  assert.equal(last.items[0].id, expected[2]);
  assert.equal(last.cursor, null);
  assert.equal(last.comment_count, 2);

  assert.equal((await reader.call("GET", path + "?cursor=bad")).status, 400);
  assert.equal((await reader.call("GET", path + "?limit=1&limit=2")).status, 400);
  assert.equal((await reader.call("GET", other + "?parent_id=" + expected[1])).status, 404);
  assert.equal((await reader.call("POST", other, {body: "错误的归属", parent_id: expected[1], client_key: "other"})).status, 404);
  const replies = [];
  for (let i = 0; i < 3; i++) {
    const {comment} = await reader.ok("POST", path, {body: `回复 ${i + 1}`, parent_id: expected[1], client_key: `reply-${i + 1}`});
    replies.push(comment.id as string);
  }
  const replyPath = path + "?limit=1&parent_id=" + expected[1];
  const page = await reader.ok("GET", replyPath);
  const pageTwo = await reader.ok("GET", replyPath + "&cursor=" + encodeURIComponent(page.cursor));
  assert.deepEqual([page.items[0].id, pageTwo.items[0].id], replies.sort().slice(0, 2));
});
