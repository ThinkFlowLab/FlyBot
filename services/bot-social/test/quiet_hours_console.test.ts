// Quiet hours from the console: the account area's two clock inputs are saved one at a time today, but the server
// takes both ends or neither (`updateSettings`, src/platform.ts:1003-1017). So picking 22:00 first sends
// {quiet_start:"22:00", quiet_end:null} → 400 and the inputs roll back (the window can never be created), and
// clearing one end of a stored window is refused the same way (the window can never be turned off). Only editing
// one end of an existing window works, because then both inputs happen to be filled.
//
// These tests pin the console side only; the server stays unchanged. They record what the console actually sends
// (the fetch stub in the vm sandbox), because the server refuses a half window: a console that toasts "saved" while
// sending a refused PATCH is still broken.
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
/** The PATCHes to /v1/me, the only calls about the quiet window; a successful save also re-renders, whose GETs are
 *  not this test's business. */
const mePatches = () => calls.filter((c) => c.method === "PATCH" && c.path === "/v1/me");
let seq = 0;
const newName = () => `qhc${Date.now().toString(36)}${++seq}`;

async function post(path: string, body: unknown) {
  const r = await fetch(S.base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
}
async function patch(token: string, body: unknown) {
  const r = await fetch(S.base + "/v1/me", { method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
}
async function meOf(token: string) {
  const r = await fetch(S.base + "/v1/me", { headers: { authorization: `Bearer ${token}` } });
  return { status: r.status, body: (await r.json()) as any };
}

/** A binding the console keeps in a module-level `let`, exposed as a setter for the test. */
const ALIAS: Record<string, string> = { setMe: "(m) => (me = m)", setTZ: "(z) => (TZ = z)" };

/** Load public/ui.js without boot(), with fetch pointed at the test server and every request recorded.
 *  `holdPatch` keeps the platform's answer to the off PATCH pending until the test calls `releasePatch()`; that is
 *  how a test watches what the click reports while the save is genuinely still in flight. `refusePatch` makes that
 *  held answer a 4xx. */
function loadConsole(names: string[], token: string, hash: string, opts: { holdPatch?: boolean; refusePatch?: boolean } = {}) {
  const exposed = names.map((n) => (ALIAS[n] ? `${n}: ${ALIAS[n]}` : n)).join(", ");
  const src = pub("ui.js").replace(/\nboot\(\);\s*$/, `\n;globalThis.__ui = { ${exposed} };\n`);
  const store = new Map<string, string>(token ? [["bs_owner_token", token]] : []);
  let release!: () => void;
  const held = opts.holdPatch ? new Promise<void>((resolve) => { release = resolve; }) : null;
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
    fetch: async (path: string, init?: any) => {
      const method = (init && init.method) || "GET";
      calls.push({ method, path, body: init && init.body ? JSON.parse(init.body) : undefined });
      if (held && method === "PATCH" && path === "/v1/me") {
        // The request is recorded above, but the platform has not answered. Holding here (not a fixed sleep) keeps
        // the save in flight for as long as the test needs, so a click that reports done now is reporting early.
        await held;
        if (opts.refusePatch) return { ok: false, status: 400, json: async () => ({ error: { code: "invalid_request", message: "refused" } }) };
      }
      return fetch(S.base + path, init);
    },
    setInterval() {}, setTimeout, clearTimeout, URLSearchParams, Intl, Date, console, confirm: () => true, prompt: () => null,
  };
  vm.runInNewContext(src, ctx);
  return { ...ctx.__ui, node, releasePatch: () => { if (release) release(); } };
}

/** An owner whose stored quiet window is `start`–`end` (both null = off). */
async function ownerWithWindow(start: string | null, end: string | null) {
  const username = newName();
  const reg = await post("/v1/owners", { username, password: "secret-pw" });
  assert.equal(reg.status, 201);
  const token = reg.body.owner_token as string;
  if (start !== null || end !== null) assert.equal((await patch(token, { quiet_start: start, quiet_end: end })).status, 200);
  const me = (await meOf(token)).body;
  assert.equal(me.quiet_start, start);
  assert.equal(me.quiet_end, end);
  return { token, me };
}

test("a new quiet window is saved in one PATCH that carries both ends", async () => {
  const { token, me } = await ownerWithWindow(null, null);
  const ui = loadConsole(["shell", "setMe", "setTZ"], token, "#/");
  ui.setMe(me);
  ui.setTZ("Asia/Shanghai");
  ui.shell();

  const qstart = ui.node("#qstart"), qend = ui.node("#qend");
  assert.equal(typeof qstart.onchange, "function", "the clock inputs are wired");
  qstart.value = "22:00"; qend.value = "";
  calls = [];
  await qstart.onchange();
  assert.deepEqual(mePatches(), [], "one clock alone is not a window; nothing may be sent");
  assert.match(ui.node("#root").innerHTML, /id="qhint"/, "the account area carries a hint line for a half window");
  assert.match(ui.node("#qhint").textContent, /both/i, "the console names the missing end");

  qend.value = "07:00";
  await qend.onchange();
  assert.deepEqual(mePatches(), [{ method: "PATCH", path: "/v1/me", body: { quiet_start: "22:00", quiet_end: "07:00" } }], "one save, both ends");
  const after = await meOf(token);
  assert.equal(after.body.quiet_start, "22:00");
  assert.equal(after.body.quiet_end, "07:00");
});

test("quiet hours are turned off from the console in one PATCH carrying both null ends", async () => {
  const { token, me } = await ownerWithWindow("22:00", "07:00");
  const ui = loadConsole(["shell", "setMe", "setTZ"], token, "#/");
  ui.setMe(me);
  ui.setTZ("Asia/Shanghai");
  ui.shell();

  // The sandbox does not parse the rendered HTML, so the stored window is put into the inputs by hand here; a real
  // page shows 22:00 / 07:00 in them (tzControl prefills from me).
  const qstart = ui.node("#qstart"), qend = ui.node("#qend");
  qstart.value = "22:00"; qend.value = "07:00";

  // Clearing one end is not a window: it must not become a PATCH the server refuses.
  qstart.value = "";
  calls = [];
  await qstart.onchange();
  assert.deepEqual(mePatches(), [], "a half window never leaves the console");
  assert.match(ui.node("#root").innerHTML, /id="qoff"/, "a stored window offers an explicit off");
  assert.match(ui.node("#qhint").textContent, /both/i);

  const off = ui.node("#qoff");
  assert.equal(typeof off.onclick, "function", "the off control is wired");
  await off.onclick({ preventDefault() {} });
  assert.deepEqual(mePatches(), [{ method: "PATCH", path: "/v1/me", body: { quiet_start: null, quiet_end: null } }], "off is both ends null in one save");
  const after = await meOf(token);
  assert.equal(after.body.quiet_start, null);
  assert.equal(after.body.quiet_end, null);
  assert.equal(ui.node("#qstart").value, "");
  assert.equal(ui.node("#qend").value, "");
});

test("control: the server takes both ends or both null, and refuses one end alone", async () => {
  const username = newName();
  const reg = await post("/v1/owners", { username, password: "secret-pw" });
  assert.equal(reg.status, 201);
  const token = reg.body.owner_token as string;

  const set = await patch(token, { quiet_start: "22:00", quiet_end: "07:00" });
  assert.equal(set.status, 200, "both ends is a window");
  assert.equal(set.body.quiet_start, "22:00");
  assert.equal(set.body.quiet_end, "07:00");

  const clear = await patch(token, { quiet_start: null, quiet_end: null });
  assert.equal(clear.status, 200, "both null turns it off");
  assert.equal(clear.body.quiet_start, null);
  assert.equal(clear.body.quiet_end, null);

  assert.equal((await patch(token, { quiet_start: "22:00", quiet_end: null })).status, 400, "a half window is refused, not stored");
  assert.equal((await patch(token, { quiet_start: "22:00" })).status, 400, "one key alone is refused too");
  const still = await meOf(token);
  assert.equal(still.body.quiet_start, null, "a refused patch writes nothing");
  assert.equal(still.body.quiet_end, null);
});

test("a Turn off click reports done only after the save it starts has settled", async () => {
  const { token, me } = await ownerWithWindow("22:00", "07:00");
  const ui = loadConsole(["shell", "setMe", "setTZ"], token, "#/", { holdPatch: true });
  ui.setMe(me);
  ui.setTZ("Asia/Shanghai");
  ui.shell();
  ui.node("#qstart").value = "22:00";
  ui.node("#qend").value = "07:00";
  calls = [];

  // The platform holds its answer to the off PATCH. The click may only report done once that answer is in: a caller
  // that awaits the click is waiting on this save, not on a no-op (the shape of :134).
  const r: any = ui.node("#qoff").onclick({ preventDefault() {} });
  const returnsSave = !!r && typeof r.then === "function";
  if (returnsSave) ui.releasePatch();
  await (returnsSave ? r : Promise.resolve());

  // The first read in the same turn the caller's await returns: "done" must mean landed, not started.
  assert.deepEqual(mePatches(), [{ method: "PATCH", path: "/v1/me", body: { quiet_start: null, quiet_end: null } }], "off is one save, both ends null");
  const after = await meOf(token);
  const savedBeforeReturn = after.body.quiet_start === null && after.body.quiet_end === null;

  // The same round trip, refused: when the click reports done the existing toast is already up, so the owner sees
  // the failure inside the action they took -- and the stored window is untouched.
  const refused = await ownerWithWindow("22:00", "07:00");
  const ui2 = loadConsole(["shell", "setMe", "setTZ"], refused.token, "#/", { holdPatch: true, refusePatch: true });
  ui2.setMe(refused.me);
  ui2.setTZ("Asia/Shanghai");
  ui2.shell();
  ui2.node("#qstart").value = "22:00";
  ui2.node("#qend").value = "07:00";
  calls = [];
  const r2: any = ui2.node("#qoff").onclick({ preventDefault() {} });
  const returnsRefusedSave = !!r2 && typeof r2.then === "function";
  if (returnsRefusedSave) ui2.releasePatch();
  await (returnsRefusedSave ? r2 : Promise.resolve());
  const toastedAtSettle = /Could not save quiet hours/.test(ui2.node("#toast").textContent);

  assert.deepEqual(
    { returnsSave, savedBeforeReturn, returnsRefusedSave, toastedAtSettle },
    { returnsSave: true, savedBeforeReturn: true, returnsRefusedSave: true, toastedAtSettle: true },
    "the click hands back its save and reports done only once the PATCH has settled (landed, or refused with its toast up)",
  );
  // The refused path's message is the one the console already had; this change must not swallow or replace it.
  assert.match(ui2.node("#toast").textContent, /Could not save quiet hours/, "the existing refusal message still reaches the owner");

  assert.equal(ui2.node("#qstart").value, "22:00", "the inputs are put back to the window still stored");
  assert.equal(ui2.node("#qend").value, "07:00");
  const still = await meOf(refused.token);
  assert.equal(still.body.quiet_start, "22:00", "a refused save writes nothing");
  assert.equal(still.body.quiet_end, "07:00");
});
