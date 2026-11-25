// #206: the Friends page History card labelled an ended friendship "Friends since <date>", and that date was the moment it
// ended: `friendsOverview` takes `connected_at` from the row's `updated_at` for active, revoked and blocked rows
// (src/platform.ts), and public/ui.js printed "Friends since" whenever `connected_at` was set. A friend removed a
// second ago therefore read "Removed · Friends since <that second>".
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { ownerWithBot, startServer } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));

/** public/ui.js in a sandbox without boot(): PAGES.friends with fetch and the login token pointed at the test server. */
function loadFriendsPage(base: string, token: string) {
  const src = readFileSync(join(here, "..", "public", "ui.js"), "utf8")
    .replace(/\nboot\(\);\s*$/, "\n;globalThis.__ui = { PAGES };\n");
  const ctx: any = {
    localStorage: { getItem: (k: string) => (k === "bs_owner_token" ? token : null), setItem() {}, removeItem() {} },
    window: { addEventListener() {} },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    location: { hash: "#/friends", origin: "https://example.test" },
    fetch: (path: string, init?: any) => fetch(base + path, init),
    setInterval() {}, setTimeout, clearTimeout, URLSearchParams, Intl, Date, console,
  };
  vm.runInNewContext(src, ctx);
  return async () => {
    const v: any = { innerHTML: "", querySelector: () => null, querySelectorAll: () => [] };
    await ctx.__ui.PAGES.friends(v);
    return v.innerHTML as string;
  };
}

/** One relationship's whole card, as PAGES.friends renders it (friends grid and History grid share friendCard). */
function card(html: string, relId: string) {
  const hit = html.split('<div class="card" data-rel="').find((p) => p.startsWith(relId));
  assert.ok(hit, `no card for ${relId}`);
  return hit as string;
}

/** The card's date, formatted the way ui.js' fmt() formats it in this process's zone. */
const fmtUi = (iso: string) => new Intl.DateTimeFormat("en-GB", {
  hour12: false, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
}).format(new Date(iso));

test("the History card names when a friendship ended instead of claiming 'Friends since'", async () => {
  const { base, stop } = await startServer();
  try {
    const A = await ownerWithBot(base, "hista");
    const B = await ownerWithBot(base, "histb");
    const C = await ownerWithBot(base, "histc");
    const befriend = async (peer: Awaited<ReturnType<typeof ownerWithBot>>) => {
      const rel = await A.owner.req("POST", "/v1/relationships", { from_bot_id: A.bot.id, target_handle: peer.handle, message: "hi" });
      await peer.owner.req("POST", `/v1/relationships/${rel.relationship_id}/consent`, { decision: "accept", grant_capabilities: [] });
      return rel.relationship_id as string;
    };
    const relB = await befriend(B); // A removes this friendship
    const relC = await befriend(C); // A blocks this one

    const started = await A.owner.req("GET", `/v1/friends-overview?bot_id=${A.bot.id}`);
    const activeB = started.friends.find((f: any) => f.relationship_id === relB);
    assert.ok(activeB?.connected_at, "an active friendship carries a connected_at");

    // Control: while both are friends the card still says when the friendship started.
    const beforeHtml = await loadFriendsPage(base, A.owner.token)();
    const activeCard = card(beforeHtml, relB);
    assert.match(activeCard, /<div class="kv"><span>Friends since<\/span>/, "the active card keeps its 'Friends since' label");
    assert.ok(activeCard.includes(fmtUi(activeB.connected_at)), "the active card shows when the friendship started");

    // End them at least a second later, so "connected_at" on the history row cannot be the start time by accident.
    await new Promise((r) => setTimeout(r, 1100));
    await A.owner.req("DELETE", `/v1/relationships/${relB}`);
    await A.owner.req("POST", "/v1/blocks", { relationship_id: relC });

    const ended = await A.owner.req("GET", `/v1/friends-overview?bot_id=${A.bot.id}`);
    const removed = ended.others.find((f: any) => f.relationship_id === relB);
    const blocked = ended.others.find((f: any) => f.relationship_id === relC);
    assert.equal(removed?.status, "revoked", JSON.stringify(ended.others));
    assert.equal(blocked?.status, "blocked", JSON.stringify(ended.others));
    assert.ok(Date.parse(removed.connected_at) - Date.parse(activeB.connected_at) >= 1000,
      `the removal (${removed.connected_at}) is later than the start (${activeB.connected_at})`);

    const html = await loadFriendsPage(base, A.owner.token)();

    const removedCard = card(html, relB);
    assert.doesNotMatch(removedCard, /Friends since/, "a removed friendship did not start when it was removed");
    assert.match(removedCard, /<div class="kv"><span>Removed<\/span><span>/, "the removed card labels its date as the removal");
    assert.ok(removedCard.includes(fmtUi(removed.connected_at)), `the removed card shows the removal time ${removed.connected_at}`);

    const blockedCard = card(html, relC);
    assert.doesNotMatch(blockedCard, /Friends since/, "a blocked friendship did not start when it was blocked");
    assert.match(blockedCard, /<div class="kv"><span>Blocked<\/span><span>/, "the blocked card labels its date as the block");
    assert.ok(blockedCard.includes(fmtUi(blocked.connected_at)), `the blocked card shows the block time ${blocked.connected_at}`);
  } finally { await stop(); }
});
