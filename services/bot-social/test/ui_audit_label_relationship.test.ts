// P1 (#201): `AUDIT_LABEL` had no sentence for `relationship.revoked` or `relationship.blocked`, so the two events
// that end a friendship fell through the raw-action fallback (`public/ui.js:667`) and rendered as
// `You · relationship.revoked` — the audit page's least informative row for its most consequential action.
// The server writes those names from `endRelationship` (`src/platform.ts:1805`); the console only needs the labels.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { friends, startServer } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));

/** public/ui.js in a sandbox without boot(): PAGES.audit with fetch and the login token pointed at the test server. */
function loadAuditPage(base: string, token: string) {
  const src = readFileSync(join(here, "..", "public", "ui.js"), "utf8")
    .replace(/\nboot\(\);\s*$/, "\n;globalThis.__ui = { PAGES, setMe: (m) => (me = m) };\n");
  const ctx: any = {
    localStorage: { getItem: (k: string) => (k === "bs_owner_token" ? token : null), setItem() {}, removeItem() {} },
    window: { addEventListener() {} },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    location: { hash: "#/audit", origin: "https://example.test" },
    fetch: (path: string, init?: any) => fetch(base + path, init),
    setInterval() {}, setTimeout, clearTimeout, URLSearchParams, Intl, Date, console,
  };
  vm.runInNewContext(src, ctx);
  return async (me: unknown) => {
    ctx.__ui.setMe(me);
    const v: any = { innerHTML: "" };
    await ctx.__ui.PAGES.audit(v);
    return v.innerHTML as string;
  };
}

test("the audit page names a revoked and a blocked friendship instead of the raw action", async () => {
  const { base, stop } = await startServer();
  try {
    // Revoked: the owner removes the friendship.
    const first = await friends(base);
    const removed = await first.A.owner.req("DELETE", `/v1/relationships/${first.relId}`);
    assert.equal(removed.status, "revoked", JSON.stringify(removed));
    const revokeAudit = await first.A.owner.req("GET", "/v1/audit-events?limit=1000");
    assert.ok(revokeAudit.events.some((e: any) => e.action === "relationship.revoked"), "removing a friendship writes relationship.revoked");

    const mine = await loadAuditPage(base, first.A.owner.token)(await first.A.owner.req("GET", "/v1/me"));
    assert.match(mine, /You revoked a friendship/, "the remover reads a sentence, not the raw action");
    assert.doesNotMatch(mine, /· <code>relationship\.revoked<\/code>/, "the fallback must not render the raw action as the sentence");

    const peer = await loadAuditPage(base, first.B.owner.token)(await first.B.owner.req("GET", "/v1/me"));
    assert.match(peer, /Another owner revoked a friendship/, "the peer reads the same sentence, attributed to the owner who wrote it");

    // Blocked: the same page for the other ending.
    const second = await friends(base);
    const blocked = await second.A.owner.req("POST", "/v1/blocks", { relationship_id: second.relId });
    assert.equal(blocked.status, "blocked", JSON.stringify(blocked));
    const blockAudit = await second.A.owner.req("GET", "/v1/audit-events?limit=1000");
    assert.ok(blockAudit.events.some((e: any) => e.action === "relationship.blocked"), "blocking a friendship writes relationship.blocked");

    const blockedPage = await loadAuditPage(base, second.A.owner.token)(await second.A.owner.req("GET", "/v1/me"));
    assert.match(blockedPage, /You blocked a friendship/, "the blocker reads a sentence, not the raw action");
    assert.doesNotMatch(blockedPage, /· <code>relationship\.blocked<\/code>/, "the fallback must not render the raw action as the sentence");
  } finally { await stop(); }
});
