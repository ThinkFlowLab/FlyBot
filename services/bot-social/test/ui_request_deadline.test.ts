import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { ownerWithBot, startServer } from "./helpers.js";

// An incoming friend request lapses after 7 days (`src/policy.ts`), and the API sends `expires_at` on both ends
// (`listRelationships` and `friendsOverview`). The sent card prints it (`Sent … · expires …`), but the card an
// owner is asked to accept never did, so the recipient could not tell how long a request had left. This pins the
// deadline on the incoming card, on the home page and on the friends page, which share `requestCard`.

const here = dirname(fileURLToPath(import.meta.url));
const pub = (f: string) => readFileSync(join(here, "..", "public", f), "utf8");

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(); });
after(async () => { await S.stop(); });

const req = async (method: string, path: string, token: string, body?: unknown) => {
  const r = await fetch(S.base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
};

/** A and B with A's request pending on B's consent (the shape an owner sees as "incoming"). */
async function pendingRequest() {
  const A = await ownerWithBot(S.base, "reqdl-a");
  const B = await ownerWithBot(S.base, "reqdl-b");
  const created = await req("POST", "/v1/relationships", A.owner.token, { from_bot_id: A.bot.id, target_handle: B.handle, message: "hi", requested_capabilities: ["chat.public"] });
  assert.ok(created.status === 200 || created.status === 201, `request created (${created.status})`);
  return { A, B, created: created.body };
}

/** Load public/ui.js without boot(), signed in as one owner, with fetch pointed at the test server. */
function loadConsole({ token, hash }: { token: string; hash: string }) {
  const src = pub("ui.js").replace(/\nboot\(\);\s*$/, "\n;globalThis.__ui = { PAGES, route, requestCard, fmt, location };\n");
  const store = new Map<string, string>([["bs_owner_token", token]]);
  const ctx: any = {
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, String(v)), removeItem: (k: string) => store.delete(k) },
    window: { addEventListener() {} },
    document: { querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, createElement: () => ({ setAttribute() {}, appendChild() {}, style: {}, classList: { add() {}, remove() {} } }) },
    location: { hash, origin: "https://example.test", reload() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: (path: string, init?: any) => fetch(S.base + path, init),
    setInterval() {}, setTimeout, clearTimeout, URLSearchParams, Intl, Date, console, confirm: () => true, prompt: () => null,
  };
  vm.runInNewContext(src, ctx);
  return ctx.__ui;
}

test("an incoming friend request names the deadline it lapses at", async () => {
  const { B } = await pendingRequest();
  const rels = (await req("GET", "/v1/relationships", B.owner.token)).body.relationships as any[];
  const incoming = rels.find((x) => x.status === "pending_target" && x.direction === "incoming");
  assert.ok(incoming, "B sees A's request as incoming");
  assert.ok(incoming.expires_at, "the API sends the deadline on an incoming request");

  const c = loadConsole({ token: B.owner.token, hash: "#/" });
  const html = c.requestCard(incoming);
  assert.match(html, /expires/, "the incoming card names the deadline");
  assert.ok(html.includes(c.fmt(incoming.expires_at)), `the incoming card prints the deadline ${incoming.expires_at}`);
});

test("the sent card already names the deadline", async () => {
  const { A } = await pendingRequest();
  const c = loadConsole({ token: A.owner.token, hash: "#/friends" });
  const view = { innerHTML: "", querySelector: () => null, querySelectorAll: () => [] };
  await c.PAGES.friends(view);
  assert.match(view.innerHTML, /Sent .*· expires/, "the sent card has always shown its deadline");
});

test("the friends page shows the deadline on an incoming request too", async () => {
  const { B } = await pendingRequest();
  const overview = (await req("GET", "/v1/friends-overview", B.owner.token)).body;
  const item = (overview.pending_incoming as any[]).find((x) => x.status === "pending_target");
  assert.ok(item, "the overview lists the incoming request");
  assert.ok(item.expires_at, "the overview item carries the deadline");

  const c = loadConsole({ token: B.owner.token, hash: "#/friends" });
  const view = { innerHTML: "", querySelector: () => null, querySelectorAll: () => [] };
  await c.PAGES.friends(view);
  const incoming = view.innerHTML.slice(view.innerHTML.indexOf("Incoming requests"));
  assert.ok(incoming.includes(c.fmt(item.expires_at)), `the friends page prints the deadline ${item.expires_at}`);
});

test("an old card with no deadline prints no expires clause", () => {
  const c = loadConsole({ token: "unused", hash: "#/" });
  const html = c.requestCard({
    relationship_id: "rel_old",
    peer: { display_name: "B", handle: "@b", owner_display_name: "B owner" },
    created_at: new Date().toISOString(),
    requested_capabilities: [],
    offered_capabilities: [],
  });
  assert.match(html, /owner B owner/, "the card still renders");
  assert.doesNotMatch(html, /expires/i, "a card without expires_at prints no deadline clause");
});
