// P1 (#197): an invite-based auto-accept stores its actor with provenance — `owner:own_x(invite:inv_y)` — and the audit
// page compared that whole string to me.owner_id, so the owner who wrote the record was rendered as "Another owner".
// The stored actor must not change (the hash-chained log, exports and existing rows depend on it); only the console's
// parsing does.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { ownerWithBot, startServer } from "./helpers.js";
import { loadConsole } from "./ui_helpers.js";

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

test("the audit page credits an invite-based auto-accept to the owner who wrote it", async () => {
  const { base, stop } = await startServer();
  try {
    const inviter = await ownerWithBot(base, "auditinv");
    const joiner = await ownerWithBot(base, "auditjoin");
    const inv = await inviter.owner.req("POST", "/v1/invites", { bot_id: inviter.bot.id, max_uses: 1, expires_in_hours: 72 });
    const joined = await joiner.owner.req("POST", `/v1/invites/${inv.code}/join`, { from_bot_id: joiner.bot.id });
    assert.equal(joined.status, "active", JSON.stringify(joined));

    // The server keeps the provenance suffix on the actor; that is the input the console has to parse.
    const audit = await inviter.owner.req("GET", "/v1/audit-events?limit=1000");
    const accepted = audit.events.find((e: any) => e.action === "relationship.accepted");
    const granted = audit.events.filter((e: any) => e.action === "grant.created");
    assert.ok(accepted, "the join writes relationship.accepted");
    assert.match(accepted.actor, /^owner:[^():]+\(invite:inv_[^)]+\)$/, `actor keeps its invite provenance, got ${accepted.actor}`);
    assert.ok(granted.length > 0, "the join writes grant.created rows");
    const inviterGrants = granted.filter((e: any) => e.actor === accepted.actor);
    assert.ok(inviterGrants.length > 0, `the inviter's own grants carry the invite actor, got ${granted.map((e: any) => e.actor).join(", ")}`);

    const me = await inviter.owner.req("GET", "/v1/me");
    const html = await loadAuditPage(base, inviter.owner.token)(me);

    assert.match(html, /You accepted a friend request/, "the inviter's own consent is credited to them");
    assert.doesNotMatch(html, /Another owner accepted a friend request/, "the inviter is not rendered as another owner");
    assert.equal((html.match(/You granted a capability/g) || []).length, inviterGrants.length, "every grant the inviter wrote is credited to them");
    assert.match(html, /You granted a capability/, "the grants written by the join are credited to them too");
  } finally { await stop(); }
});

test("auditActor parses an invite actor to a bare owner id, and still tags an assistant-written one", () => {
  const ui = loadConsole(["auditLine", "setMe: (m) => (me = m)"]);
  ui.setMe({ owner_id: "own_1", bots: [] });
  assert.equal(ui.auditLine({ actor: "owner:own_1(invite:inv_1)", action: "relationship.accepted" }), "You accepted a friend request");
  assert.equal(ui.auditLine({ actor: "owner:own_1(invite:inv_1)", action: "grant.created" }), "You granted a capability");
  assert.equal(ui.auditLine({ actor: "owner:own_1(invite:inv_1):mcp", action: "grant.created" }), "You (through your assistant) granted a capability");
  assert.equal(ui.auditLine({ actor: "owner:own_2(invite:inv_1)", action: "relationship.accepted" }), "Another owner accepted a friend request");
  assert.equal(ui.auditLine({ actor: "owner:own_1", action: "relationship.accepted" }), "You accepted a friend request");
});
