import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { generateEd25519, signEnvelope } from "../src/crypto.js";
import { ownerWithBot, startServer } from "./helpers.js";

// #243: the key card offered only Revoke. Revoking the last usable key took the Bot out of service — every signed
// call answered 401 invalid_signature — and the page had no control that could add a key back, although the server
// has addKey (POST /v1/bots/:id/keys). The card now warns when the key being revoked is the only one that can sign,
// and offers Add key with the server's own validation (400 invalid_public_key, 409 kid_exists) inline.

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "public", "ui.js"), "utf8")
  .replace(/\nboot\(\);\s*$/, "\n;globalThis.__ui = { PAGES };\n");

const req = async (base: string, method: string, path: string, token?: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
};

type Fake = any;
function elem(tag = "div"): Fake {
  const n: Fake = {
    tagName: tag, innerHTML: "", textContent: "", value: "", className: "", style: {}, dataset: {}, attrs: {} as Record<string, string>,
    children: [] as Fake[], onclick: null, disabled: false,
    setAttribute(k: string, v: string) { n.attrs[k] = v; },
    getAttribute(k: string) { return n.attrs[k] ?? null; },
    removeAttribute(k: string) { delete n.attrs[k]; },
    appendChild(c: Fake) { n.children.push(c); return c; },
    remove() { n.removed = true; },
    closest() { return null; },
    querySelector() { return null; },
    focus() { n.focused = true; },
    matches() { return false; },
    classList: { add() {}, remove() {} },
  };
  return n;
}
/** An input inside a `.field` box, which is what fieldErr() writes the inline error into. */
function fieldInput(): Fake {
  const box = elem();
  box.querySelector = (s: string) => (s === ".ferr" ? box.children.find((c: Fake) => c.className === "ferr" && !c.removed) ?? null : null);
  const n = elem("input");
  n.closest = () => box;
  n.parentElement = box;
  return n;
}

const buttonsIn = (html: string, attr: "data-rk" | "data-ak") =>
  [...html.matchAll(new RegExp(`${attr}="([^"]*)"`, "g"))].map((m) => {
    const b = elem("button");
    b.dataset = attr === "data-rk" ? { rk: m[1] } : { ak: m[1] };
    return b;
  });

/** The console (public/ui.js) against a real server, with the confirmation recorded instead of auto-accepted. */
async function openBotsPage(base: string, token: string, confirmAnswer = true) {
  const html = elem("main");
  // One set of button objects per rendered page, so the handler PAGES.bots binds is the one the test clicks.
  let cacheHtml = "";
  let cache: { rk: Fake[]; ak: Fake[] } = { rk: [], ak: [] };
  const buttons = () => {
    if (cacheHtml !== html.innerHTML) { cacheHtml = html.innerHTML; cache = { rk: buttonsIn(cacheHtml, "data-rk"), ak: buttonsIn(cacheHtml, "data-ak") }; }
    return cache;
  };
  const view: Fake = {
    get innerHTML() { return html.innerHTML; },
    set innerHTML(v: string) { html.innerHTML = v; },
    querySelectorAll: (s: string) => (s === "[data-rk]" ? buttons().rk : s === "[data-ak]" ? buttons().ak : []),
    querySelector: () => null,
  };
  const dom = new Map<string, Fake>();
  const make = (sel: string) => (sel.startsWith("#ak-") || sel.startsWith("#akv-") ? fieldInput() : elem());
  const document: Fake = {
    querySelector: (s: string) => { if (!dom.has(s)) dom.set(s, s === "#view" ? view : make(s)); return dom.get(s); },
    querySelectorAll: () => [], getElementById: () => null, activeElement: null,
    createElement: (tag: string) => elem(tag),
  };
  const confirms: string[] = [];
  const requests: { method: string; path: string }[] = [];
  const toastEl = elem();
  dom.set("#toast", toastEl);
  const ctx: Fake = {
    localStorage: { getItem: (k: string) => (k === "bs_owner_token" ? token : null), setItem() {}, removeItem() {} },
    window: { addEventListener() {} },
    document,
    location: { hash: "#/bots", origin: "https://example.test", reload() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: (path: string, init?: any) => { requests.push({ method: init?.method || "GET", path }); return fetch(base + path, init); },
    setInterval() {}, setTimeout, clearTimeout, URLSearchParams, Intl, Date, console,
    confirm: (msg: string) => { confirms.push(msg); return confirmAnswer; },
    prompt: () => null,
  };
  vm.runInNewContext(src, ctx);

  const page = {
    confirms, requests, toast: () => toastEl.textContent,
    html: () => html.innerHTML,
    settle: () => new Promise((r) => setTimeout(r, 30)),
    load: async () => { await ctx.__ui.PAGES.bots(view); return page; },
    revoke: (rk: string) => buttons().rk.find((b) => b.dataset.rk === rk) ?? null,
    addKey: () => buttons().ak[0] ?? null,
    set: (sel: string, value: string) => { document.querySelector(sel).value = value; },
    err: (sel: string) => { const input = dom.get(sel); const e = input?.closest()?.querySelector(".ferr"); return e ? e.textContent : null; },
    prefill: (botId: string) => { const m = new RegExp(`id="ak-${botId}" value="([^"]*)"`).exec(html.innerHTML); return m ? m[1] : null; },
  };
  return page.load();
}

const usable = (k: any) => k.status === "active" && (!k.expires_at || Date.parse(k.expires_at) > Date.now());
const keysOf = async (base: string, token: string, botId: string) =>
  (await req(base, "GET", "/v1/me", token)).body.bots.find((b: any) => b.id === botId).keys as any[];

test("revoking the Bot's only usable key names the consequence, and afterwards it cannot sign", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ivy");
  const peer = await ownerWithBot(s.base, "ivy-peer");
  const ownerToken = A.owner.token;
  const kp2 = generateEd25519();
  const added = await req(s.base, "POST", `/v1/bots/${A.bot.id}/keys`, ownerToken, { kid: "k2", value: kp2.publicKey });
  assert.equal(added.status, 201, JSON.stringify(added.body));

  // An earlier key that is still `active` but already past expires_at cannot sign: revoking it is not the last key.
  (s.platform as any).run("UPDATE bot_keys SET expires_at = ? WHERE bot_id = ? AND kid = 'k1'", new Date(Date.now() - 3600e3).toISOString(), A.bot.id);
  const before = await keysOf(s.base, ownerToken, A.bot.id);
  assert.equal(before.find((k) => k.kid === "k1").status, "active");
  assert.ok(!usable(before.find((k) => k.kid === "k1")), "k1 is active but past its expiry, so it cannot sign");
  assert.deepEqual(before.filter(usable).map((k) => k.kid), ["k2"]);

  const page = await openBotsPage(s.base, ownerToken);
  const expired = page.revoke(`${A.bot.id}|k1`);
  assert.ok(expired, "the expired key still offers Revoke");
  await expired.onclick();
  await page.settle();
  assert.equal(page.confirms[0], "Revoke this key? Requests signed with it will be rejected.", "revoking a key that cannot sign keeps today's sentence");
  assert.ok(page.requests.some((r) => r.method === "DELETE" && r.path === `/v1/bots/${A.bot.id}/keys/k1`));

  const last = page.revoke(`${A.bot.id}|k2`);
  assert.ok(last, "the last usable key offers Revoke");
  await last.onclick();
  await page.settle();
  assert.notEqual(page.confirms[1], "Revoke this key? Requests signed with it will be rejected.", "the last usable key is not revoked with the generic sentence");
  assert.match(page.confirms[1], /only usable signing key/i, "the confirmation names the key as the only one that can sign");
  assert.match(page.confirms[1], /cannot sign any request until you add another key/i, "and names the consequence");
  assert.ok(page.requests.some((r) => r.method === "DELETE" && r.path === `/v1/bots/${A.bot.id}/keys/k2`), "the DELETE request is unchanged");

  const after = await keysOf(s.base, ownerToken, A.bot.id);
  assert.equal(after.filter(usable).length, 0, "with both keys gone the Bot has no usable signing key");
  assert.ok(page.addKey(), "and the card offers Add key, so the owner can recover without leaving the console");

  const env = signEnvelope({
    type: "relationship.request", from: A.bot.id, kid: "k2", privateKeyPem: kp2.privateKeyPem,
    payload: { target_handle: peer.handle, message: "signed after revoke", requested_capabilities: [] },
  });
  const refused = await req(s.base, "POST", "/v1/relationships", A.bot.cred.token, env);
  assert.equal(refused.status, 401, JSON.stringify(refused.body));
  assert.equal(refused.body.error.code, "invalid_signature", "the Bot can no longer sign anything");
});

test("with more than one usable key the sentence and the request are exactly today's", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "jane");
  const ownerToken = A.owner.token;
  const kp2 = generateEd25519();
  assert.equal((await req(s.base, "POST", `/v1/bots/${A.bot.id}/keys`, ownerToken, { kid: "k2", value: kp2.publicKey })).status, 201);
  const keys = await keysOf(s.base, ownerToken, A.bot.id);
  assert.equal(keys.filter(usable).length, 2, "k1 (rotation window) and k2 can both sign");

  const page = await openBotsPage(s.base, ownerToken);
  await page.revoke(`${A.bot.id}|k1`)!.onclick();
  await page.settle();
  assert.equal(page.confirms[0], "Revoke this key? Requests signed with it will be rejected.");
  assert.deepEqual(page.requests.filter((r) => r.method === "DELETE").map((r) => r.path), [`/v1/bots/${A.bot.id}/keys/k1`]);
  assert.equal((await keysOf(s.base, ownerToken, A.bot.id)).find((k: any) => k.kid === "k1").status, "revoked");
});

test("Add key adds a key, prefills a free kid, and says the other keys expire in seven days", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "kate");
  const ownerToken = A.owner.token;
  const kp2 = generateEd25519();

  const page = await openBotsPage(s.base, ownerToken);
  assert.match(page.html(), />Add key</, "the key card offers Add key");
  assert.match(page.html(), /seven more days, then they expire/, "and says what adding it does to the existing keys");
  const prefill = page.prefill(A.bot.id);
  assert.ok(prefill, "the kid field is pre-filled");
  assert.ok(!(await keysOf(s.base, ownerToken, A.bot.id)).some((k: any) => k.kid === prefill), `${prefill} is not an existing kid`);

  page.set(`#ak-${A.bot.id}`, prefill!);
  page.set(`#akv-${A.bot.id}`, kp2.publicKey);
  await page.addKey()!.onclick();
  await page.settle();
  assert.ok(page.requests.some((r) => r.method === "POST" && r.path === `/v1/bots/${A.bot.id}/keys`), "the form reuses POST /v1/bots/:id/keys");

  const keys = await keysOf(s.base, ownerToken, A.bot.id);
  const fresh = keys.find((k: any) => k.kid === prefill);
  assert.ok(fresh && fresh.status === "active", "the new key is active");
  const old = keys.find((k: any) => k.kid === "k1");
  assert.ok(old.expires_at, "the server's rotation window is visible: the old key now has expires_at");
  const days = (Date.parse(old.expires_at) - Date.now()) / 86400e3;
  assert.ok(days > 6.9 && days < 7.1, `the old key expires in seven days, got ${days}`);
});

test("a bad public key and an existing kid show inline errors and write nothing", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "liam");
  const ownerToken = A.owner.token;
  const kp2 = generateEd25519();

  const page = await openBotsPage(s.base, ownerToken);
  page.set(`#ak-${A.bot.id}`, "key_1");
  page.set(`#akv-${A.bot.id}`, "not-a-public-key");
  await page.addKey()!.onclick();
  await page.settle();
  assert.match(page.err(`#akv-${A.bot.id}`) ?? "", /public key is not valid/i, "400 invalid_public_key is shown under the key field");
  assert.equal((await keysOf(s.base, ownerToken, A.bot.id)).length, 1, "and nothing is written");

  page.set(`#akv-${A.bot.id}`, kp2.publicKey);
  page.set(`#ak-${A.bot.id}`, "k1");
  await page.addKey()!.onclick();
  await page.settle();
  assert.match(page.err(`#ak-${A.bot.id}`) ?? "", /already in use/i, "409 kid_exists is shown under the kid field");
  const keys = await keysOf(s.base, ownerToken, A.bot.id);
  assert.equal(keys.length, 1, "no row is added");
  assert.equal(keys[0].expires_at, null, "and the rotation window is not started by the failed add");
});
