import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "public", "ui.js"), "utf8")
  .replace(/\nboot\(\);\s*$/, "\n;globalThis.__ui = { PAGES, me: () => me, setMe: (x) => { me = x; } };\n");

const EXPIRED = {
  approval_id: "apr_expired_1",
  kind: "outbound_message",
  status: "expired",
  decision: "expired",
  summary: "Dinner at 8pm?",
  reasons: ["mvp.all_outbound_requires_approval"],
  risk_flags: [],
  bot_id: "bot_a",
  created_at: "2026-10-29T10:00:00.000Z",
  decided_at: "2026-10-29T10:30:00.000Z",
  expires_at: "2026-10-29T10:30:00.000Z",
  message: { message_id: "msg_1", to: { handle: "@bob.bot", display_name: "Bob" }, payload: { text: "Dinner at 8pm?" }, status: "draft" },
};

/** The console with fetch stubbed: pending and cancelled are empty, one approval expired unnoticed. */
function loadConsole(expired: unknown[] = [EXPIRED]) {
  const asked: string[] = [];
  const routes: Record<string, unknown> = {
    "/v1/approvals?status=pending": { approvals: [] },
    "/v1/approvals?status=cancelled": { approvals: [] },
    "/v1/approvals?status=expired": { approvals: expired },
    "/v1/relationships": { relationships: [] },
    "/v1/conversations": { conversations: [] },
    "/v1/bots": { bots: [] },
    // Home also reads the week's face-room digest; this test is about expired cards, so the week is empty.
    "/v1/digest": { digest_version: 1, week: "2026-10-05", period: { start: "2026-10-05T00:00:00.000Z", end: "2026-10-12T00:00:00.000Z" }, rooms: [], counts: { rooms: 0, approved: 0, rejected: 0, cancelled: 0, expired: 0 } },
  };
  const ctx: any = {
    localStorage: { getItem: () => "tkn", setItem() {}, removeItem() {} },
    window: { addEventListener() {} },
    document: { querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, createElement: () => ({ setAttribute() {}, appendChild() {}, style: {}, classList: { add() {}, remove() {} } }) },
    location: { hash: "#/", origin: "https://example.test", reload() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: async (path: string) => {
      asked.push(path);
      if (!(path in routes)) throw new Error(`unexpected request ${path}`);
      return { ok: true, status: 200, json: async () => routes[path] };
    },
    setInterval() {}, setTimeout, clearTimeout, URLSearchParams, Intl, Date, console, confirm: () => true, prompt: () => null,
  };
  vm.runInNewContext(src, ctx);
  ctx.__ui.setMe({ owner_id: "own_1", display_name: "Test Owner", timezone: "UTC", bots: [] });
  return { ui: ctx.__ui, asked };
}

test("an approval that expired is still on the console: the owner sees it did not go out", async () => {
  const { ui, asked } = loadConsole();
  const v = { innerHTML: "", querySelector: () => null, querySelectorAll: () => [] };
  await ui.PAGES[""](v);

  assert.ok(asked.includes("/v1/approvals?status=expired"), "the home reads the expired approvals, not only pending and cancelled");
  assert.match(v.innerHTML, /Expired/, "the home has an Expired section");
  assert.ok(v.innerHTML.includes("Dinner at 8pm?"), "the expired card keeps the draft it would have sent");
  assert.match(v.innerHTML, /Bob/, "the card names where it was going");
  assert.match(v.innerHTML, /@bob\.bot/, "the card names the Bot it would have reached");
  assert.doesNotMatch(v.innerHTML, /data-apr="apr_expired_1"/, "an expired approval has no Approve/Reject buttons");
});

test("an owner with nothing expired sees no Expired section", async () => {
  const { ui } = loadConsole([]);
  const v = { innerHTML: "", querySelector: () => null, querySelectorAll: () => [] };
  await ui.PAGES[""](v);
  assert.doesNotMatch(v.innerHTML, /Expired/, "an empty list adds no heading");
});
