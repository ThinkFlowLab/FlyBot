import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// The server has minted and revoked room invite tickets since #39 and the public /r/:ticket landing page has always
// worked, but the console called neither route: from the interface a two-person room could not grow. The room page
// now mints a link for the room on an open room, shows it with Copy, and revokes it from the same place; a refusal
// (not the lead, room ended) is shown as the server words it instead of being swallowed.

const here = dirname(fileURLToPath(import.meta.url));
const UI = readFileSync(join(here, "..", "public", "ui.js"), "utf8");
const MINTED = { room_id: "frm_1", ticket: "tkt-abc", url: "https://example.test/r/tkt-abc", expires_at: "2026-11-04T19:10:00.000Z" };

type Call = { method: string; path: string; body: unknown };

function node() {
  return {
    innerHTML: "", value: "", disabled: false, onclick: null as any, style: {}, dataset: {},
    classList: { add() {}, remove() {}, contains: () => false },
    appendChild() {}, setAttribute() {}, removeAttribute() {}, addEventListener() {},
    querySelector: () => null, querySelectorAll: () => [], closest: () => null,
  };
}

/** public/ui.js loaded as a console signed in as one owner, with a recorded fetch and the nodes the room page binds. */
function consoleFor(respond: (c: Call) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  const nodes = new Map<string, any>();
  const at = (id: string) => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  let copied: string[] = [];
  const ctx: any = {
    localStorage: { getItem: (k: string) => (k === "bs_owner_token" ? "owner-token" : null), setItem() {}, removeItem() {} },
    window: { addEventListener() {} },
    document: {
      querySelector: (sel: string) => (typeof sel === "string" && sel.startsWith("#") ? at(sel.slice(1)) : null),
      querySelectorAll: () => [],
      getElementById: (id: string) => at(id),
      createElement: () => node(),
    },
    location: { hash: "#/rooms/frm_1", origin: "https://example.test", reload() {} },
    navigator: { clipboard: { writeText: async (t: string) => { copied.push(t); } } },
    confirm: () => true, prompt: () => null,
    setInterval() {}, setTimeout, clearTimeout, URLSearchParams, Intl, Date, console,
    fetch: async (path: string, init?: any) => {
      const call = { method: init?.method ?? "GET", path, body: init?.body ? JSON.parse(init.body) : undefined };
      calls.push(call);
      const { status, body } = respond(call);
      return { status, ok: status >= 200 && status < 300, json: async () => body };
    },
  };
  vm.runInNewContext(UI.replace(/\nboot\(\);\s*$/, "\n;globalThis.__ui = { PAGES };\n"), ctx);
  return { ui: ctx.__ui, calls, nodes, copied: () => copied };
}

const roomView = (status: string) => ({
  room_id: "frm_1", status, expires_at: status === "candidate" ? "2026-11-04T19:40:00.000Z" : null,
  started_at: null, closed_at: null, created_by: { owner_name: "Alice" }, created_by_me: true,
  lead_bot_handle: null, effective_lead_bot_handle: null,
  members: [{ bot_id: "bot_a", handle: "alice.bot", display_name: "Alice bot", owner_name: "Alice", label: "member", role: null }],
  event_cursor: 0, events: [],
});

const listOne = (status: string) => ({ rooms: [{ room_id: "frm_1", status, expires_at: null, started_at: null, member_count: 1, my_bots: [{ handle: "alice.bot", display_name: "Alice bot" }] }] });

test("an open room offers the invite button; a room still waiting does not", async () => {
  const open = consoleFor((c) => (c.path === "/v1/face-rooms" ? { status: 200, body: listOne("open") } : { status: 200, body: roomView("open") }));
  const page = { innerHTML: "" };
  await open.ui.PAGES.rooms(page);
  assert.match(page.innerHTML, /id="room-invite"/, "an open room can grow from the console");
  assert.match(page.innerHTML, /Invite into this room/);

  const waiting = consoleFor((c) => (c.path === "/v1/face-rooms" ? { status: 200, body: listOne("candidate") } : { status: 200, body: roomView("candidate") }));
  const waitingPage = { innerHTML: "" };
  await waiting.ui.PAGES.rooms(waitingPage);
  assert.doesNotMatch(waitingPage.innerHTML, /id="room-invite"/, "a room that has not started has nothing to invite into yet");
});

test("one click mints one link, Copy takes it, Revoke kills it — one request each", async () => {
  const ctl = consoleFor((call) => {
    if (call.path === "/v1/face-rooms") return { status: 200, body: listOne("open") };
    if (call.path === "/v1/face-rooms/frm_1") return { status: 200, body: roomView("open") };
    if (call.path === "/v1/face-rooms/frm_1/invites" && call.method === "POST") return { status: 201, body: MINTED };
    if (call.path === "/v1/face-rooms/frm_1/invites/tkt-abc" && call.method === "DELETE") return { status: 204, body: {} };
    return { status: 404, body: { error: { code: "not_found", message: "no such route" } } };
  });
  const page = { innerHTML: "" };
  await ctl.ui.PAGES.rooms(page);

  const mint = ctl.nodes.get("room-invite");
  assert.ok(mint && typeof mint.onclick === "function", "the button is bound");
  await mint.onclick();

  const posts = ctl.calls.filter((c) => c.method === "POST" && c.path === "/v1/face-rooms/frm_1/invites");
  assert.equal(posts.length, 1, "one click is one mint, not two");
  const out = ctl.nodes.get("room-invite-out");
  assert.match(out.innerHTML, new RegExp(MINTED.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the link is shown");
  assert.match(out.innerHTML, /id="room-invite-url"/);
  assert.match(out.innerHTML, /readonly/, "the link is read-only");

  await ctl.nodes.get("room-invite-copy").onclick();
  assert.deepEqual(ctl.copied(), [MINTED.url], "Copy hands the owner exactly the link, once");

  await ctl.nodes.get("room-invite-revoke").onclick();
  const deletes = ctl.calls.filter((c) => c.method === "DELETE");
  assert.equal(deletes.length, 1, "one click is one revoke");
  assert.equal(deletes[0].path, "/v1/face-rooms/frm_1/invites/tkt-abc");
  assert.doesNotMatch(out.innerHTML, /id="room-invite-url"/, "the dead link is taken off the page");
});

test("a refusal is shown in the server's words and leaves no link behind", async () => {
  const message = "only the room lead may mint an invite";
  const ctl = consoleFor((call) => {
    if (call.path === "/v1/face-rooms") return { status: 200, body: listOne("open") };
    if (call.path === "/v1/face-rooms/frm_1") return { status: 200, body: roomView("open") };
    if (call.path === "/v1/face-rooms/frm_1/invites") return { status: 403, body: { error: { code: "not_lead", message } } };
    return { status: 404, body: { error: { code: "not_found", message: "no such route" } } };
  });
  const page = { innerHTML: "" };
  await ctl.ui.PAGES.rooms(page);
  await ctl.nodes.get("room-invite").onclick();

  const out = ctl.nodes.get("room-invite-out");
  assert.match(out.innerHTML, /only the room lead may mint an invite/i, "the server's sentence reaches the owner (the console sentence-cases it)");
  assert.doesNotMatch(out.innerHTML, /id="room-invite-url"/, "a refused mint shows no link");
  assert.equal(ctl.nodes.get("room-invite").disabled, false, "the button can be tried again");
});
