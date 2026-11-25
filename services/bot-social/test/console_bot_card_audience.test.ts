// The card an owner writes on My Bots is shown wherever someone first meets the Bot: its invite link answers
// WITHOUT a login and carries the card, and a pending friend request shows it too. The console label said
// "Card friends see", which promises a narrower audience than the platform gives. The copy must name what a
// stranger with the link can read; the behaviour itself is not changed here.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { ownerWithBot, startServer } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));

const req = async (base: string, method: string, path: string, token?: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
};

/** The console with fetch pointed at the test server, without boot(); renders My Bots. */
function loadBotsPage(base: string, token: string) {
  const src = readFileSync(join(here, "..", "public", "ui.js"), "utf8").replace(/\nboot\(\);\s*$/, "\n;globalThis.__ui = { PAGES };\n");
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

/** The card block of one Bot, so a match elsewhere on the page cannot stand in for the label or the empty state. */
const cardBlock = (html: string, botId: string) => {
  const at = html.indexOf(`bdesc-${botId}`);
  assert.ok(at >= 0, "the page has the card field");
  const from = html.lastIndexOf('<div class="field"', at);
  return html.slice(from, html.indexOf("</div></div>", at) + 12);
};

test("My Bots names every reader of the card, and a stranger with the invite link reads it", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "aud");
  const render = loadBotsPage(s.base, A.owner.token);

  // No card yet: the empty state must not promise the card to friends only.
  const empty = cardBlock(await render(), A.bot.id);
  assert.doesNotMatch(empty, /Card friends see/, "the label cannot name friends as the audience");
  assert.doesNotMatch(empty, /friends see just the name and handle/, "the empty state cannot name friends as the audience");
  assert.match(empty, /invite link/i, "the label or empty state names the invite link");
  assert.match(empty, /friend request/i, "the label or empty state names friend requests");

  // With a card written, the same page keeps naming both readers and shows the length.
  const CARD = "Summarises the pair inbox each morning.";
  assert.equal((await req(s.base, "PATCH", `/v1/bots/${A.bot.id}/profile`, A.owner.token, { description: CARD })).status, 200);
  const filled = cardBlock(await render(), A.bot.id);
  assert.doesNotMatch(filled, /Card friends see/);
  assert.match(filled, /invite link/i);
  assert.match(filled, /friend request/i);
  assert.ok(filled.includes(`${CARD.length}/280`), "the filled state still shows the length");

  // The audience the copy now names: an anonymous GET with the code reads the card, before any login or friendship.
  const made = await req(s.base, "POST", "/v1/invites", A.owner.token, { bot_id: A.bot.id, offered_capabilities: ["chat.public"], max_uses: 1, expires_in_hours: 24 });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const anon = await req(s.base, "GET", `/v1/invites/${made.body.code}`);
  assert.equal(anon.status, 200, JSON.stringify(anon.body));
  assert.equal(anon.body.inviter.description, CARD, "anyone holding the link reads the card");
});
