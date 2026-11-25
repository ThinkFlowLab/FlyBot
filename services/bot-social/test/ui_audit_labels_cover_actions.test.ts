// The audit page prints `AUDIT_LABEL[action]` and falls back to the raw identifier when the action has no sentence
// ("Unknown actions fall back to the raw name"). That fallback was meant for actions the console has never heard of,
// but `audit.append` writes fourteen more actions today and thirteen of them are readable by an owner: every face-room
// join and creation, the room invite links, the local (home) room links, a message that could not be delivered, the
// owner's own logout, and the line the console sends when the owner types a message themselves. Those rows render as
// `You · <code>owner.logout</code>` instead of a sentence, which is the one thing the page exists to avoid.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { friends, startServer } from "./helpers.js";
import { loadConsole } from "./ui_helpers.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Actions `audit.append` writes that an owner can read, and that the label map has no sentence for.
 *  `platform.started` is written with no owner, so no audit page ever lists it and it is not in this set. */
const WITHOUT_SENTENCE = [
  "face_room.created",
  "face_room.joined",
  "face_room.invite_minted",
  "face_room.invite_revoked",
  "face_room.lead_changed",
  "local_room.invite_minted",
  "local_room.invite_claimed",
  "local_room.invite_released",
  "local_room.invite_revoked",
  "local_room.claim_ended",
  "message.not_delivered",
  "owner.logout",
  "owner_typed_message_delivered",
];

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

/** The collapsed sentence of each row, in page order (newest first): the first `<div>` inside `div.grow`. */
const collapsedLines = (html: string) =>
  [...html.matchAll(/<div class="grow"><div>(.*?)<\/div>/g)]
    .map((m) => m[1].replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&"));

async function req(base: string, method: string, path: string, token: string | undefined, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}

test("every audit action an owner can read has a sentence", () => {
  const { AUDIT_LABEL } = loadConsole(["AUDIT_LABEL"]);
  const missing = WITHOUT_SENTENCE.filter((a) => !AUDIT_LABEL[a]);
  assert.deepEqual(missing, [], `these actions still read as a raw identifier on the audit page: ${missing.join(", ")}`);
});

test("the rows a normal session writes read as sentences, not raw identifiers", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);

  // The owner types a line themselves (the chat box in the console goes through this door).
  s.platform.enableCustody({ kind: "owner", ownerId: A.owner_id }, A.bot.id, { private_key_pem: A.kp.privateKeyPem });
  const typed = await A.owner.req("POST", `/v1/homes/${A.bot.id}/send`, { from_bot_id: A.bot.id, to: B.bot.id, text: "hello from the owner", typed_by_owner: true });
  assert.equal(typed.message.status, "delivered");

  // A face-to-face room: A creates it by entering the code, B joins the same code.
  const joined = await req(s.base, "POST", "/v1/face-rooms/join", A.owner.token, { code: "424242", bots: [A.bot.id] });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  const joinedB = await req(s.base, "POST", "/v1/face-rooms/join", B.owner.token, { code: "424242", bots: [B.bot.id] });
  assert.equal(joinedB.status, 200, JSON.stringify(joinedB.body));

  // The console's Log out is the same request, and the owner then signs back in.
  const me = await A.owner.req("GET", "/v1/me");
  const out = await req(s.base, "POST", "/v1/auth/logout", A.owner.token);
  assert.equal(out.status, 200, JSON.stringify(out.body));
  const back = await req(s.base, "POST", "/v1/auth/login", undefined, { username: me.username, password: "secret-pw" });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  const token = back.body.owner_token as string;

  const page = await req(s.base, "GET", "/v1/audit-events?limit=1000", token);
  assert.equal(page.status, 200, JSON.stringify(page.body));
  const events = (page.body.events as any[]).slice().reverse(); // the page renders newest first
  const meNow = await req(s.base, "GET", "/v1/me", token);
  const lines = collapsedLines(await loadAuditPage(s.base, token)(meNow.body));
  assert.equal(lines.length, events.length, "every row on the page has a collapsed line");

  const raw = events.map((e, i) => [e.action, lines[i]] as const).filter(([action, line]) => String(line).includes(action));
  assert.deepEqual(raw, [], `rows still show the raw action: ${JSON.stringify(raw)}`);

  const byAction = (action: string) => lines[events.findIndex((e: any) => e.action === action)];
  assert.match(byAction("owner_typed_message_delivered"), /typed a message/, "the owner's own line reads as what it was");
  assert.match(byAction("owner.logout"), /signed out/, "the console's Log out reads as signing out");
  assert.match(byAction("face_room.created"), /face-to-face room/, "opening a room reads as opening a room");
  assert.match(byAction("face_room.joined"), /join/, "a room join reads as a join");
});
