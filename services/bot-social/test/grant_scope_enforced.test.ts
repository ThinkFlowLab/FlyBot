// #211: a `scope` sent with a capability that never reads it was accepted, stored and audited, but had no effect;
// and scope values that could never be enforced (a malformed `hours`, a negative `window_days`) were stored as-is.
// A non-empty scope is now refused unless the capability's implementation consumes it, its values are validated
// before any grant is written, and the console shows the scope of the grants it lists.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { expectApiError, friends, ownerWithBot, startServer } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));

/** public/ui.js in a sandbox without boot(): one page against the test server. */
function loadPage(name: string, base: string, token: string) {
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
    await ctx.__ui.PAGES[name](v);
    return v.innerHTML as string;
  };
}

test("#211: a scope for a capability that never reads one is refused and nothing is stored", async () => {
  const { base, stop } = await startServer();
  try {
    const { A, B, relId } = await friends(base);
    for (const cap of ["calendar.book", "profile.read", "chat.public"]) {
      const err = await expectApiError(A.bot.requestGrant(relId, cap, { window_days: 1 }), 400, "invalid_request");
      assert.match(err.message, new RegExp(`scope is not supported for ${cap}`));
    }
    // No card was created for the peer owner, so nothing was accepted, stored or put in front of them.
    const cards = (await B.owner.req("GET", "/v1/approvals?status=pending")).approvals.filter((a: any) => a.kind === "grant_request");
    assert.equal(cards.length, 0, "a refused request creates no approval card");
    const rel = (await B.owner.req("GET", "/v1/relationships")).relationships.find((r: any) => r.relationship_id === relId);
    const scoped = rel.capabilities.peer_on_me.filter((g: any) => Object.keys(g.scope ?? {}).length > 0);
    assert.deepEqual(scoped, [], "no grant carries the refused scope");

    // The owner's direct grant route refuses it too, before it can supersede anything.
    await expectApiError(B.owner.req("POST", `/v1/relationships/${relId}/grants`, { capability: "calendar.book", scope: { window_days: 1 } }), 400, "invalid_request");
  } finally { await stop(); }
});

test("#211: free/busy scope values are validated at every route that can write a grant", async () => {
  const { base, stop } = await startServer();
  try {
    const { A, B, relId } = await friends(base);

    // A bot's request: values that the query could not enforce are refused, not stored in a pending card.
    for (const bad of [{ window_days: -1 }, { window_days: 1.5 }, { window_days: "14" }, { hours: "9-11" }, { hours: 900 }]) {
      const err = await expectApiError(A.bot.requestGrant(relId, "calendar.freebusy.read", bad), 400, "invalid_request");
      assert.match(err.message, /window_days|hours/, JSON.stringify(bad));
    }
    const ok = await A.bot.requestGrant(relId, "calendar.freebusy.read", { window_days: 30, hours: "09:00-18:00" });
    const card = (await B.owner.req("GET", "/v1/approvals?status=pending")).approvals.find((a: any) => a.approval_id === ok.approval_id);
    assert.deepEqual(card.grant_request.scope, { window_days: 30, hours: "09:00-18:00" }, "the card carries the accepted scope");

    // An owner's edit at approval time goes through the same guard and leaves the card pending, no grant written.
    await expectApiError(B.owner.req("POST", `/v1/approvals/${ok.approval_id}/decision`, { decision: "approved_with_edits", edited_params: { scope: { hours: "9-11" } } }), 400, "invalid_request");
    const still = (await B.owner.req("GET", "/v1/approvals?status=pending")).approvals.find((a: any) => a.approval_id === ok.approval_id);
    assert.equal(still?.status, "pending");
    const before = (await B.owner.req("GET", "/v1/relationships")).relationships.find((r: any) => r.relationship_id === relId);
    assert.ok(!before.capabilities.peer_on_me.some((g: any) => g.capability === "calendar.freebusy.read"), "a refused edit writes no grant");

    // A plain approval then writes the scope the card showed.
    await B.owner.req("POST", `/v1/approvals/${ok.approval_id}/decision`, { decision: "approved" });
    const after = (await B.owner.req("GET", "/v1/relationships")).relationships.find((r: any) => r.relationship_id === relId);
    const granted = after.capabilities.peer_on_me.find((g: any) => g.capability === "calendar.freebusy.read");
    assert.deepEqual(granted?.scope, { window_days: 30, hours: "09:00-18:00" });

    // The owner's direct grant route validates values before the supersede+insert transaction.
    await expectApiError(B.owner.req("POST", `/v1/relationships/${relId}/grants`, { capability: "calendar.freebusy.read", scope: { window_days: 0 } }), 400, "invalid_request");
    const kept = (await B.owner.req("GET", "/v1/relationships")).relationships.find((r: any) => r.relationship_id === relId);
    assert.deepEqual(kept.capabilities.peer_on_me.find((g: any) => g.capability === "calendar.freebusy.read")?.scope, { window_days: 30, hours: "09:00-18:00" }, "a refused value does not take the live grant down");

    // Consent: a refused grant_capabilities scope leaves the relationship pending and writes nothing.
    const C = await ownerWithBot(base, "carol");
    const D = await ownerWithBot(base, "dave");
    const req = await C.owner.req("POST", "/v1/relationships", { from_bot_id: C.bot.id, target_handle: D.handle, message: "again", requested_capabilities: ["chat.public"] });
    await expectApiError(D.owner.req("POST", `/v1/relationships/${req.relationship_id}/consent`, { decision: "accept", grant_capabilities: [{ capability: "calendar.book", scope: { window_days: 1 } }] }), 400, "invalid_request");
    const pending = (await D.owner.req("GET", "/v1/relationships")).relationships.find((r: any) => r.relationship_id === req.relationship_id);
    assert.equal(pending.status, "pending_target", "a refusal at consent leaves the relationship pending");
    assert.deepEqual(pending.capabilities.peer_on_me, [], "a refusal at consent writes no grant");
    const accepted = await D.owner.req("POST", `/v1/relationships/${req.relationship_id}/consent`, { decision: "accept" });
    assert.equal(accepted.status, "active", "consent still works without the refused scope");
  } finally { await stop(); }
});

test("#211: the console shows the scope of the grants a friendship lists", async () => {
  const { base, stop } = await startServer();
  try {
    const { A } = await friends(base, { freebusy: true });
    const html = await loadPage("friends", base, A.owner.token)(await A.owner.req("GET", "/v1/me"));
    assert.match(html, /Free\/busy/, "the grant is listed");
    assert.match(html, /14 days/, "the stored window is shown next to the grant");
    assert.match(html, /09:00-18:00/, "the stored hours are shown next to the grant");
  } finally { await stop(); }
});
