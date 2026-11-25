import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import Database from "better-sqlite3";
import { bulkAuth, startServer } from "./helpers.js";
import { home } from "./flybot_workspace_helpers.js";

const profile = "/v1/ot/profile/social";
let time = new Date("2026-11-21T01:00:00Z").getTime();
let server: Awaited<ReturnType<typeof startServer>>;
let directory: string;
before(async () => {
  directory = mkdtempSync(join(tmpdir(), "ot-profile-social-"));
  const dbPath = join(directory, "social.db");
  const legacy = new Database(dbPath);
  legacy.exec(`CREATE TABLE ot_follows (
    follower_id TEXT NOT NULL, creator_id TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY (follower_id, creator_id), CHECK (follower_id <> creator_id));
    INSERT INTO ot_follows VALUES ('legacy-follower', 'legacy-creator', 1000)`);
  legacy.close();
  server = await startServer({...bulkAuth, dbPath, now: () => time});
});
after(async () => {
  await server?.stop();
  rmSync(directory, {recursive: true, force: true});
});

test("follow pages are account-scoped, searchable and stable across same-time edges", async () => {
  const reader = await home(server.base, "profile-reader");
  const composer = await home(server.base, "profile-composer");
  const editor = await home(server.base, "profile-editor");
  const stranger = await home(server.base, "profile-stranger");
  const {owner_id} = await composer.ok("GET", "/v1/ot/me");
  const platformId = "7a".repeat(16);
  server.platform.db.prepare("UPDATE ot_profiles SET platform_user_id=? WHERE owner_id=?").run(platformId, owner_id);
  await composer.ok("PUT", "/v1/ot/profile", {display_name: "Émilie Studio", bio: "Composes music"});
  await editor.ok("PUT", "/v1/ot/profile", {display_name: "中文 Studio"});
  await reader.ok("POST", "/v1/ot/follows", {handle: composer.handle});
  await reader.ok("POST", "/v1/ot/follows", {handle: editor.handle});
  await composer.ok("POST", "/v1/ot/follows", {handle: reader.handle});
  await stranger.ok("POST", "/v1/ot/follows", {handle: reader.handle});

  const response = await fetch(server.base + profile);
  assert.equal(response.status, 401);
  assert.deepEqual(await reader.ok("GET", profile + "?view=counts"), {
    following: 2, followers: 2, likes_received: 0, collections_received: 0,
  });
  assert.deepEqual(await stranger.ok("GET", profile + "?view=counts"), {
    following: 1, followers: 0, likes_received: 0, collections_received: 0,
  });
  assert.equal((await reader.call("GET", profile + "?view=counts&handle=" + composer.handle)).status, 400);
  assert.equal((await reader.call("GET", profile + "?view=followers&view=following")).status, 400);
  assert.equal((await reader.call("GET", profile + "?view=following&cursor=bad")).status, 400);

  const outgoing = profile + "?view=following&q=studio&limit=1";
  const first = await reader.ok("GET", outgoing);
  assert.deepEqual(first.items, [{handle: editor.handle, display_name: "中文 Studio", bio: "", following: true}]);
  assert.ok(first.next_cursor);
  const next = "&cursor=" + encodeURIComponent(first.next_cursor);
  const second = await reader.ok("GET", outgoing + next);
  assert.deepEqual(second, {items: [
    {handle: composer.handle, display_name: "Émilie Studio", bio: "Composes music", following: true},
  ], next_cursor: null});
  assert.doesNotMatch(JSON.stringify(second), new RegExp(`${platformId}|${owner_id}`));
  assert.equal((await stranger.call("GET", outgoing + next)).status, 400);
  assert.equal((await reader.call("GET", profile + "?view=following&q=other" + next)).status, 400);
  assert.equal((await reader.call("GET", profile + "?view=followers&q=studio" + next)).status, 400);

  const byName = await reader.ok("GET", profile + "?view=following&q=" + encodeURIComponent("ÉMILIE"));
  assert.deepEqual(byName.items, second.items);
  const byHandle = await reader.ok("GET", profile + "?view=following&q=" + encodeURIComponent("@" + composer.handle.toUpperCase()));
  assert.deepEqual(byHandle.items, second.items);
  const incoming = await reader.ok("GET", profile + "?view=followers");
  assert.deepEqual(incoming.items.map(({handle, following}: {handle: string; following: boolean}) => [handle, following]),
    [[stranger.handle, false], [composer.handle, true]]);
  await reader.ok("POST", "/v1/ot/follows", {handle: editor.handle, on: false});
  assert.equal((await reader.ok("GET", profile + "?view=counts")).following, 1);
  assert.deepEqual(await reader.ok("GET", outgoing + next), second, "an anchor can disappear without losing the next row");
});

test("profile feeds paginate by activity, keep reactions private and remove unpublished content immediately", async () => {
  const author = await home(server.base, "profile-author");
  const visitor = await home(server.base, "profile-visitor");
  const stranger = await home(server.base, "reaction-stranger");
  const who = await author.ok("GET", "/v1/ot/me");
  const platformId = "b9".repeat(16);
  server.platform.db.prepare("UPDATE ot_profiles SET platform_user_id=? WHERE owner_id=?").run(platformId, who.owner_id);
  const works = await Promise.all(["field-notes", "design-guide", "project-map"].map(slug =>
    author.ok("PUT", "/v1/ot/listings", {
      kind: "work", slug: "profile-" + slug, ref: "local-ref-" + slug, title: slug, summary: "Read the overview",
      snapshot: "Snapshot excluded from profile feeds",
    })));
  const bot = await author.ok("PUT", "/v1/ot/listings", {
    kind: "agent", slug: "profile-assistant", ref: "private-assistant-id", title: "Assistant",
  });
  const action = (actor: typeof visitor, id: string, kind: "like" | "collect", on = true) =>
    actor.ok("POST", `/v1/ot/listings/${id}/${kind}`, {on});
  const [first, second, third] = works;
  await action(visitor, first.id, "like");
  await action(visitor, second.id, "like");
  await action(visitor, third.id, "like");
  time += 100;
  await action(visitor, bot.id, "collect");
  await action(visitor, first.id, "collect");
  await action(author, first.id, "like");
  await action(author, first.id, "collect");
  await action(stranger, second.id, "collect");
  assert.deepEqual(await author.ok("GET", profile), {
    following: 0, followers: 0, likes_received: 3, collections_received: 3,
  });

  const sorted = works.map(work => work.id).sort().reverse();
  const published = await author.ok("GET", profile + "?view=published&limit=1");
  assert.deepEqual(published.items.map((work: {id: string}) => work.id), sorted.slice(0, 1));
  assert.ok(published.next_cursor);
  const remaining = await author.ok("GET", profile + "?view=published&limit=2&cursor=" + published.next_cursor);
  assert.deepEqual(remaining.items.map((work: {id: string}) => work.id), sorted.slice(1));
  assert.equal(remaining.next_cursor, null);
  assert.deepEqual(await visitor.ok("GET", profile + "?view=published"), {items: [], next_cursor: null});

  const firstPage = await visitor.ok("GET", profile + "?view=liked&limit=1");
  assert.ok(firstPage.next_cursor);
  const [card] = firstPage.items;
  assert.equal(card.id, sorted[0]);
  assert.equal(card.liked, true);
  assert.deepEqual(card.creator, {handle: who.handle, display_name: who.display_name, bio: ""});
  assert.doesNotMatch(JSON.stringify(card), new RegExp(`${platformId}|${who.owner_id}|local-ref-|Snapshot excluded`));
  assert.match(card.path, /^\/w\/profile-/);
  assert.equal((await visitor.call("GET", profile + "?view=collected&cursor=" + firstPage.next_cursor)).status, 400);
  assert.equal((await stranger.call("GET", profile + "?view=liked&cursor=" + firstPage.next_cursor)).status, 400);
  assert.deepEqual(await stranger.ok("GET", profile + "?view=liked"), {items: [], next_cursor: null});
  await author.ok("DELETE", "/v1/ot/listings/" + sorted[1]);
  const nextPage = await visitor.ok("GET", profile + "?view=liked&limit=1&cursor=" + firstPage.next_cursor);
  assert.deepEqual(nextPage.items.map((work: {id: string}) => work.id), sorted.slice(2));
  assert.equal(nextPage.next_cursor, null);
  await action(visitor, bot.id, "collect", false);
  const saved = await visitor.ok("GET", profile + "?view=collected");
  assert.deepEqual(saved.items.map((work: {id: string}) => work.id), first.id === sorted[1] ? [] : [first.id]);
  assert.equal((await author.ok("GET", profile)).likes_received, 2);
});

test("work notifications default to on for old follows and disabling them leaves the follow intact", async () => {
  const preference = "/v1/ot/follows/notifications";
  const oldFollow = server.platform.db.prepare("SELECT work_notices FROM ot_follows WHERE follower_id='legacy-follower'").get();
  assert.deepEqual(oldFollow, {work_notices: 1});
  const creator = await home(server.base, "notice-creator");
  const follower = await home(server.base, "notice-reader");
  const stranger = await home(server.base, "notice-stranger");
  const page = profile + "?view=work-notices";
  assert.deepEqual(await follower.ok("GET", page), {items: [], next_cursor: null});
  await follower.ok("POST", "/v1/ot/follows", {handle: creator.handle});
  assert.deepEqual(await follower.ok("GET", page), {items: [
    {handle: creator.handle, display_name: (await creator.ok("GET", "/v1/ot/me")).display_name, bio: "", enabled: true},
  ], next_cursor: null});
  assert.equal((await stranger.call("POST", preference, {handle: creator.handle, enabled: false})).status, 404);
  assert.equal((await follower.call("POST", preference, {handle: creator.handle, enabled: "false"})).status, 400);
  assert.equal((await follower.call("POST", preference, {handle: creator.handle, enabled: false, owner: stranger.handle})).status, 400);
  assert.deepEqual(await follower.ok("POST", preference, {handle: creator.handle, enabled: false}), {enabled: false});
  await follower.ok("POST", "/v1/ot/follows", {handle: creator.handle});
  assert.equal((await follower.ok("GET", page)).items[0].enabled, false, "a repeated follow preserves preferences");
  assert.equal((await follower.ok("GET", profile + "?view=counts")).following, 1);
  assert.equal((await follower.ok("GET", page + "&q=" + encodeURIComponent(creator.handle))).items.length, 1);
  const publish = (kind: "agent" | "work", slug: string) =>
    creator.ok("PUT", "/v1/ot/listings", {kind, title: slug, slug, ref: slug});
  const workWhileMuted = await publish("work", "notice-muted-work");
  const agentWhileMuted = await publish("agent", "notice-muted-agent");
  const publications = async () => (await follower.ok("GET", "/v1/ot/notifications")).notifications
    .filter((notice: {kind: string}) => notice.kind === "discover.published")
    .map((notice: {data: {listing_id: string}}) => notice.data.listing_id);
  assert.deepEqual(await publications(), [agentWhileMuted.id]);
  await follower.ok("POST", preference, {handle: creator.handle, enabled: true});
  const workWhileEnabled = await publish("work", "notice-enabled-work");
  assert.deepEqual(new Set(await publications()), new Set([agentWhileMuted.id, workWhileEnabled.id]));
  assert.ok(!(await publications()).includes(workWhileMuted.id));
  await follower.ok("POST", "/v1/ot/follows", {handle: creator.handle, on: false});
  assert.deepEqual(await follower.ok("GET", page), {items: [], next_cursor: null});
});
