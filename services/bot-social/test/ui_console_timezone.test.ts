// The console prints every time in the owner's zone, but a new owner is stuck on Asia/Shanghai and the page has
// no control to change it. These tests pin the way out: the browser's zone travels with registration, the signed-in
// sidebar offers a zone picker, and picking one saves it once and re-reads every time in the new zone.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { startServer } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const pub = (f: string) => readFileSync(join(here, "..", "public", f), "utf8");

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(); });
after(async () => { await S.stop(); });

type Rec = { method: string; path: string; body: any };
let calls: Rec[] = [];
let seq = 0;
/** What the browser this console runs in reports; the box running the tests is the browser here. */
const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const newName = () => `tzc${Date.now().toString(36)}${++seq}`;

async function post(path: string, body: unknown) {
  const r = await fetch(S.base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
}
async function meOf(token: string) {
  const r = await fetch(S.base + "/v1/me", { headers: { authorization: `Bearer ${token}` } });
  return { status: r.status, body: (await r.json()) as any };
}

/** A binding the console keeps in a module-level `let`, exposed as a setter for the test. */
const ALIAS: Record<string, string> = { setMe: "(m) => (me = m)" };

/** Load public/ui.js without boot(), with fetch pointed at the test server and every request recorded. */
function loadConsole(names: string[], token: string, hash: string) {
  const exposed = names.map((n) => (ALIAS[n] ? `${n}: ${ALIAS[n]}` : n)).join(", ");
  const src = pub("ui.js").replace(/\nboot\(\);\s*$/, `\n;globalThis.__ui = { ${exposed} };\n`);
  const store = new Map<string, string>(token ? [["bs_owner_token", token]] : []);
  const nodes = new Map<string, any>();
  const node = (k: string) => {
    if (!nodes.has(k)) nodes.set(k, { innerHTML: "", textContent: "", onclick: null, onchange: null, oninput: null, value: "", checked: false, disabled: false, style: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, removeAttribute() {}, appendChild() {}, remove() {}, focus() {} });
    return nodes.get(k);
  };
  const ctx: any = {
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, String(v)), removeItem: (k: string) => store.delete(k) },
    window: { addEventListener() {} },
    document: { querySelector: (s: string) => node(s), querySelectorAll: () => [], getElementById: (s: string) => node(s), createElement: () => node("created") },
    location: { hash, origin: "https://example.test" },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: (path: string, init?: any) => {
      calls.push({ method: (init && init.method) || "GET", path, body: init && init.body ? JSON.parse(init.body) : undefined });
      return fetch(S.base + path, init);
    },
    setInterval() {}, setTimeout, clearTimeout, URLSearchParams, Intl, Date, console, confirm: () => true, prompt: () => null,
  };
  vm.runInNewContext(src, ctx);
  return { ...ctx.__ui, node };
}

test("without a zone in the request a new owner still lands on Asia/Shanghai — today's default", async () => {
  // The witness for the defect: the server only leaves Asia/Shanghai when the caller names a zone, and today's console
  // never names one. This test stays green either side of the fix; it is what says the default is still there.
  const username = newName();
  const reg = await post("/v1/owners", { username, password: "secret-pw" });
  assert.equal(reg.status, 201);
  const me = await meOf(reg.body.owner_token);
  assert.equal(me.body.timezone, "Asia/Shanghai");
});

test("registering from the console sends the browser's zone, so the account is not stuck on Shanghai", async () => {
  const ui = loadConsole(["newOwnerBody"], "", "#/");
  const username = newName();
  const body = ui.newOwnerBody({ username, password: "secret-pw", display_name: "Zoe" });
  assert.deepEqual({ ...body }, { username, password: "secret-pw", display_name: "Zoe", timezone: browserZone });

  const reg = await post("/v1/owners", body);
  assert.equal(reg.status, 201);
  const me = await meOf(reg.body.owner_token);
  assert.equal(me.body.timezone, browserZone, "the owner's zone is the browser's, not the server default");
});

test("the signed-in sidebar offers a time-zone control showing the owner's current zone", async () => {
  const username = newName();
  const reg = await post("/v1/owners", { username, password: "secret-pw" });
  assert.equal(reg.status, 201);
  const token = reg.body.owner_token;
  const me = (await meOf(token)).body;
  assert.equal(me.timezone, "Asia/Shanghai");

  const ui = loadConsole(["shell", "setMe", "setTZ"], token, "#/");
  ui.setMe(me);
  ui.setTZ(me.timezone);
  ui.shell();
  const html = ui.node("#root").innerHTML;
  assert.match(html, /id="tz"/, "the account area carries the picker");
  assert.match(html, /Time zone/);
  assert.match(html, /<option value="Asia\/Shanghai" selected>/, "the picker starts on the owner's zone");
});

test("picking Europe/Berlin saves it exactly once and every time then reads in Berlin", async () => {
  calls = [];
  const username = newName();
  const reg = await post("/v1/owners", { username, password: "secret-pw" });
  assert.equal(reg.status, 201);
  const token = reg.body.owner_token;
  const me = (await meOf(token)).body;

  const ui = loadConsole(["shell", "setMe", "setTZ", "fmt"], token, "#/");
  ui.setMe(me);
  ui.setTZ(me.timezone);
  assert.match(ui.fmt("2026-10-19T00:21:00Z"), /^19\/10, 08:21 GMT\+8$/, "before the change the console reads Shanghai");

  ui.shell();
  const picker = ui.node("#tz");
  assert.equal(typeof picker.onchange, "function", "the picker is wired");
  picker.value = "Europe/Berlin";
  await picker.onchange();

  const patches = calls.filter((c) => c.method === "PATCH" && c.path === "/v1/me");
  assert.equal(patches.length, 1, "exactly one save, not one per keystroke");
  assert.deepEqual(patches[0].body, { timezone: "Europe/Berlin" });
  assert.match(ui.fmt("2026-10-19T00:21:00Z"), /^19\/10, 02:21 (CEST|GMT\+2)$/, "the same instant now reads in Berlin");

  const stored = await meOf(token);
  assert.equal(stored.body.timezone, "Europe/Berlin", "the choice is on the account, not just this page");
});
