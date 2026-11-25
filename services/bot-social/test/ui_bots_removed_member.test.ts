import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { startServer } from "./helpers.js";

// A Bot removed from a FlyBot home is `revoked`, not `frozen`: removeHomeMember clears its webhook, revokes its
// tokens, revokes its invites, cancels its drafts, makes it leave its rooms and withdraws its local-room tickets.
// Nothing restores any of that. Yet resumeBot had no status check and My Bots treated every non-active Bot as
// Frozen, so the owner could bring back half an identity: `active` with a fresh token, but no webhook, invites,
// drafts, rooms or seats. The way back for a removed member is addHomeMember, which re-registers it.

const here = dirname(fileURLToPath(import.meta.url));

const req = async (base: string, method: string, path: string, token?: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
};

/** A FlyBot home plus its owner login token (connector tokens are refused on console REST routes). */
async function flyHome(base: string, name: string) {
  const onboard = await req(base, "POST", "/v1/onboard/flybot", undefined, { username: name, password: "secret-pw", display_name: name });
  assert.equal(onboard.status, 201, JSON.stringify(onboard.body));
  const login = await req(base, "POST", "/v1/auth/login", undefined, { username: name, password: "secret-pw" });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return { ownerToken: login.body.owner_token as string, homeId: onboard.body.home.bot_id as string };
}

async function addMember(base: string, token: string, homeId: string, name: string) {
  const r = await req(base, "POST", `/v1/homes/${homeId}/members`, token, { name, display_name: name.toUpperCase() });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.bot_id as string;
}

/** The console (public/ui.js) with fetch pointed at the test server, without boot(). */
function loadBotsPage(base: string, token: string) {
  const src = readFileSync(join(here, "..", "public", "ui.js"), "utf8")
    .replace(/\nboot\(\);\s*$/, "\n;globalThis.__ui = { PAGES };\n");
  const el = () => ({ onclick: null, value: "", innerText: "", closest: () => ({}) });
  const ctx: any = {
    localStorage: { getItem: (k: string) => (k === "bs_owner_token" ? token : null), setItem() {}, removeItem() {} },
    window: { addEventListener() {} },
    document: { querySelector: el, querySelectorAll: () => [], getElementById: () => null, createElement: () => ({ setAttribute() {}, appendChild() {}, style: {}, classList: { add() {}, remove() {} } }) },
    location: { hash: "#/bots", origin: "https://example.test", reload() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: (path: string, init?: any) => fetch(base + path, init),
    setInterval() {}, setTimeout, clearTimeout, URLSearchParams, Intl, Date, console, confirm: () => true, prompt: () => null,
  };
  vm.runInNewContext(src, ctx);
  return async () => {
    const v: any = { innerHTML: "", querySelector: () => null, querySelectorAll: () => [] };
    await ctx.__ui.PAGES.bots(v);
    return v.innerHTML as string;
  };
}

test("a removed Bot cannot be resumed: 403 bot_revoked, no token, and it stays revoked", async () => {
  const { base, stop } = await startServer();
  try {
    const { ownerToken, homeId } = await flyHome(base, "dana");
    const memberId = await addMember(base, ownerToken, homeId, "writer");
    const removed = await req(base, "DELETE", `/v1/homes/${homeId}/members/${memberId}`, ownerToken);
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.equal(removed.body.status, "revoked");

    const resumed = await req(base, "POST", `/v1/bots/${memberId}/resume`, ownerToken);
    assert.equal(resumed.status, 403, `resuming a revoked Bot must be refused, got ${resumed.status} ${JSON.stringify(resumed.body)}`);
    assert.equal(resumed.body.error.code, "bot_revoked");
    assert.equal("bot_token" in resumed.body, false, "no fresh token is minted for a removed identity");

    const me = await req(base, "GET", "/v1/me", ownerToken);
    assert.equal(me.body.bots.find((b: any) => b.id === memberId).status, "revoked", "the identity stays revoked");
    const audit = await req(base, "GET", `/v1/audit-events?subject=${memberId}`, ownerToken);
    assert.equal(audit.body.events.some((e: any) => e.action === "bot.resumed"), false, "no bot.resumed audit is written");
  } finally { await stop(); }
});

test("My Bots shows a removed Bot as Removed without Resume, and a frozen one as Frozen with Resume", async () => {
  const { base, stop } = await startServer();
  try {
    const { ownerToken, homeId } = await flyHome(base, "erin");
    const removedId = await addMember(base, ownerToken, homeId, "ghost");
    const frozenId = await addMember(base, ownerToken, homeId, "paused");
    await req(base, "DELETE", `/v1/homes/${homeId}/members/${removedId}`, ownerToken);
    const stopped = await req(base, "POST", "/v1/emergency-stop", ownerToken, { bot_id: frozenId });
    assert.equal(stopped.status, 200, JSON.stringify(stopped.body));

    const html = await loadBotsPage(base, ownerToken)();
    const cardOf = (id: string) => html.split('<div class="card">').find((c) => c.includes(`data-wh="${id}"`)) ?? "";

    const removedCard = cardOf(removedId);
    assert.ok(removedCard, "the removed Bot still appears in My Bots");
    assert.match(removedCard, />Removed</, "it is labelled Removed");
    assert.doesNotMatch(removedCard, /data-resume/, "and offers no Resume button");

    const frozenCard = cardOf(frozenId);
    assert.match(frozenCard, />Frozen</, "a frozen Bot is still Frozen");
    assert.match(frozenCard, new RegExp(`data-resume="${frozenId}"`), "and still offers Resume");
  } finally { await stop(); }
});

test("a frozen Bot still resumes", async () => {
  const { base, stop } = await startServer();
  try {
    const { ownerToken, homeId } = await flyHome(base, "frank");
    const memberId = await addMember(base, ownerToken, homeId, "sleepy");
    const stopped = await req(base, "POST", "/v1/emergency-stop", ownerToken, { bot_id: memberId });
    assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
    assert.equal(stopped.body.status, "frozen");

    const resumed = await req(base, "POST", `/v1/bots/${memberId}/resume`, ownerToken);
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    assert.equal(resumed.body.status, "active");
    assert.ok(resumed.body.bot_token, "a frozen Bot gets a fresh token back");
  } finally { await stop(); }
});
