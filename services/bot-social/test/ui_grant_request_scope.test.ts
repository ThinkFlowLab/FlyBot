// P1: the approval card for a `grant_request` rendered the capability and the requester's reason, but never the
// `scope` the Bot asked for — and that scope is exactly what Approve writes into the grant
// (`src/platform.ts:2362`: `body.edited_params?.scope ?? req.scope`). The card is the owner's only look at it before
// the decision. Worse, the console's own grant picker labels free/busy " (14 days · working hours)"
// (`public/ui.js:352`), so a plain "Free/busy" pill reads as that default while the approval grants the requested
// window, hours and all. The scope is already on the card payload (`src/platform.ts:2297`); only the rendering drops it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { friends, startServer } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));

/** public/ui.js in a sandbox without boot(): the home page (which renders pending approvals) against the test server. */
function loadHomePage(base: string, token: string) {
  const src = readFileSync(join(here, "..", "public", "ui.js"), "utf8")
    .replace(/\nboot\(\);\s*$/, "\n;globalThis.__ui = { PAGES, setMe: (m) => (me = m) };\n");
  const ctx: any = {
    localStorage: { getItem: (k: string) => (k === "bs_owner_token" ? token : null), setItem() {}, removeItem() {} },
    window: { addEventListener() {} },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    location: { hash: "#/", origin: "https://example.test" },
    fetch: (path: string, init?: any) => fetch(base + path, init),
    setInterval() {}, setTimeout, clearTimeout, URLSearchParams, Intl, Date, console,
  };
  vm.runInNewContext(src, ctx);
  return async (me: unknown) => {
    ctx.__ui.setMe(me);
    const v: any = { innerHTML: "", querySelector: () => null, querySelectorAll: () => [] };
    await ctx.__ui.PAGES[""](v);
    return v.innerHTML as string;
  };
}

test("the approval card shows the free/busy scope the grant request asks for", async () => {
  const { base, stop } = await startServer();
  try {
    const { A, B, relId } = await friends(base);
    const req = await A.bot.signed("/v1/grant-requests", "grant.request", {
      relationship_id: relId, capability: "calendar.freebusy.read", scope: { window_days: 365, hours: "00:00-23:59" }, reason: "planning the offsite",
    });
    assert.equal(req.status, "pending_owner_approval", JSON.stringify(req));

    // The scope is already on the card the peer owner reads; only the rendering dropped it.
    const pending = (await B.owner.req("GET", "/v1/approvals?status=pending")).approvals;
    const card = pending.find((a: any) => a.approval_id === req.approval_id);
    assert.ok(card, "the grant request is a pending approval for the peer owner");
    assert.deepEqual(card.grant_request.scope, { window_days: 365, hours: "00:00-23:59" }, "the card payload carries the requested scope");

    const html = await loadHomePage(base, B.owner.token)(await B.owner.req("GET", "/v1/me"));
    assert.match(html, /Free\/busy/, "the card names the capability");
    assert.match(html, /365 days/, "the card shows the requested window");
    assert.match(html, /00:00-23:59/, "the card shows the requested hours");

    // Approve through the same route the card's button uses, then read the stored grant: the card must describe
    // the grant that was actually written, not a different one.
    const decided = await B.owner.req("POST", `/v1/approvals/${req.approval_id}/decision`, { decision: "approved" });
    assert.equal(decided.decision, "approved");
    const row = (await B.owner.req("GET", "/v1/relationships")).relationships.find((r: any) => r.relationship_id === relId);
    const granted = row.capabilities.peer_on_me.find((g: any) => g.capability === "calendar.freebusy.read");
    assert.deepEqual(granted?.scope, { window_days: 365, hours: "00:00-23:59" }, "Approve writes the scope the card showed");

    // Control: an omitted scope is not the console's 14-day default — it is the unrestricted grant, and the card
    // must say that instead of borrowing another request's numbers.
    const second = await friends(base);
    const plain = await second.A.bot.signed("/v1/grant-requests", "grant.request", { relationship_id: second.relId, capability: "calendar.freebusy.read" });
    const plainCard = (await second.B.owner.req("GET", "/v1/approvals?status=pending")).approvals.find((a: any) => a.approval_id === plain.approval_id);
    assert.deepEqual(plainCard.grant_request.scope, {}, "an omitted scope is stored empty");
    const plainHtml = await loadHomePage(base, second.B.owner.token)(await second.B.owner.req("GET", "/v1/me"));
    assert.doesNotMatch(plainHtml, /365 days/, "a default-scope card must not show another request's window");
    assert.match(plainHtml, /no day limit/, "an empty scope says the grant has no window limit");
    assert.match(plainHtml, /any hour/, "an empty scope says the grant has no hour rule");
  } finally { await stop(); }
});
