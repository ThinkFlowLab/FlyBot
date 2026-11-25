// Owner console (public/ui.js): a GitHub sign-in/link reason reaches the login page it lands on (#76).
// The browser comes back to #/login?oauth=… whether or not a session token is still around, so both entries are
// covered: the plain login page and the one reached after an expired token is refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const uiSrc = () => readFileSync(join(here, "..", "public", "ui.js"), "utf8");

/** The few DOM properties public/ui.js touches while it paints the login card; nothing here parses HTML. */
function fakeElement() {
  const e: any = {
    innerHTML: "", textContent: "", value: "", disabled: false, autocomplete: "", className: "",
    dataset: {}, style: {}, classList: { toggle() {}, add() {}, remove() {} },
    setAttribute() {}, removeAttribute() {}, getAttribute: () => null,
    appendChild() {}, remove() {}, closest: () => e,
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
  };
  return e;
}

/** Run ui.js in a sandbox with one fake #root and a stub fetch, and hand back the bindings the test needs. */
function load(hash: string, opts: { token?: string } = {}) {
  const src = uiSrc();
  assert.match(src, /\nboot\(\);\s*$/, "ui.js should end with boot();");
  const body = src.replace(/\nboot\(\);\s*$/, "\n;globalThis.__ui = { render, boot, route, LOGIN_MSG };\n");
  const nodes = new Map<string, any>();
  const node = (sel: string) => { if (!nodes.has(sel)) nodes.set(sel, fakeElement()); return nodes.get(sel); };
  const store = new Map<string, string>();
  if (opts.token) store.set("bs_owner_token", opts.token);
  const ctx: any = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, String(v)),
      removeItem: (k: string) => store.delete(k),
    },
    window: { addEventListener() {} },
    document: {
      querySelector: (sel: string) => (sel.startsWith("meta[") ? null : node(sel)),
      querySelectorAll: () => [],
      createElement: () => fakeElement(),
      activeElement: null,
    },
    location: { hash, origin: "https://example.test" },
    history: { replaceState() {} },
    // An expired session: /v1/me answers 401 with no body, which is what the console calls "signed_out".
    fetch: async () => ({ status: 401, ok: false, json: async () => ({}) }),
    setInterval() {}, setTimeout, clearTimeout, URLSearchParams, Intl, Date, console,
    navigator: { clipboard: { writeText: async () => {} } }, prompt: () => null,
  };
  vm.runInNewContext(body, ctx);
  return { ...ctx.__ui, root: node("#root") };
}

/** The login card's own alert slot: `<div id="lerr">` holds at most one role="alert" sentence. */
function noticeOf(html: string) {
  const m = /<div id="lerr">([\s\S]*?)<\/div>/.exec(html);
  assert.ok(m, "the login page keeps a #lerr alert slot");
  return m[1];
}
const textOf = (inner: string) => inner.replace(/<[^>]*>/g, "")
  .replace(/&#39;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").trim();

test("a GitHub link failure lands on the login page: not_linked", async () => {
  const ui = load("#/login?oauth=not_linked");
  await ui.render();
  const notice = noticeOf(ui.root.innerHTML);
  assert.match(notice, /role="alert"/, "the reason is announced, not only painted");
  assert.equal(textOf(notice), "That GitHub account is not connected to any account here. Sign in with your password, then connect GitHub from this card.");
  // The client-side JSON is embedded in the public file: one copy, shared with the toast on the signed-in home page.
  const src = uiSrc();
  assert.equal((src.match(/That GitHub account is not connected to any account here\./g) || []).length, 1, "one copy of the not_linked sentence");
});

test("an expired token does not replace the GitHub reason with 'signed out': cancelled", async () => {
  const ui = load("#/login?oauth=cancelled", { token: "otk_expired" });
  await ui.boot("load");
  const notice = noticeOf(ui.root.innerHTML);
  assert.equal(textOf(notice), "GitHub connection cancelled");
  assert.ok(!ui.root.innerHTML.includes("You were signed out"), "the signed-out sentence must not sit next to a GitHub reason");
});

test("a provider outage is named on the login page too: provider_unavailable", async () => {
  const ui = load("#/login?oauth=provider_unavailable");
  await ui.render();
  const notice = noticeOf(ui.root.innerHTML);
  assert.equal(textOf(notice), "GitHub is not answering; try again in a minute");
  const src = uiSrc();
  assert.equal((src.match(/GitHub is not answering; try again in a minute/g) || []).length, 1, "one copy of the provider_unavailable sentence");
});

test("the login page without ?oauth= shows no notice, and a bare expired session still says signed out", async () => {
  const plain = load("#/login");
  await plain.render();
  assert.equal(textOf(noticeOf(plain.root.innerHTML)), "", "no reason, no notice");

  const expired = load("#/login", { token: "otk_expired" });
  await expired.boot("load");
  assert.equal(textOf(noticeOf(expired.root.innerHTML)), "You were signed out. Please sign in again.");
});
