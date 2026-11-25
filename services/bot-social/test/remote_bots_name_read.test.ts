import assert from "node:assert/strict";
import { test } from "node:test";
import { friends, startServer } from "./helpers.js";

// `GET /v1/remote-bots` is the read surface an owner's console uses for "Bots other owners have shared with me".
// It projects the granted Bot, its owner and its home straight from the row, so a legacy row written before #106
// (the write-side name check) reaches the console raw: control characters, U+2028, a leading `@`, a lone surrogate
// or a name longer than 60 code points. Every other read surface (the friend overview, a face-room snapshot, the
// public Bot card) cleans a name with `peerBotName` / `peerOwnerName`; this one must read the same value, or the
// same Bot is shown under two different labels depending on which page the owner happens to open.
// The assertion is on the response field, not on the helper: a reader is what has to be clean.

const DIRTY_BOT = "Evil\u2028@Alice\u0007Name"; // U+2028 and controls are separators, `@` is dropped
const CLEAN_BOT = "Evil Alice Name";
const DIRTY_OWNER = "@boss\u0001"; // the owner label loses its leading `@` too
const CLEAN_OWNER = "boss";

async function req(base: string, method: string, path: string, token?: string) {
  const r = await fetch(base + path, { method, headers: token ? { authorization: `Bearer ${token}` } : {} });
  const text = await r.text();
  const json = text ? JSON.parse(text) : {};
  return { status: r.status, body: json.error ? json.error : json };
}
const setName = (s: any, table: "bots" | "owners", column: string, value: string, where: string, ...args: unknown[]) =>
  s.platform.db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${where}`).run(value, ...args);

test("GET /v1/remote-bots cleans the names a legacy bot, owner and home row still hold", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const f = await friends(s.base);
  // A holds a grant on B's bot, so B's bot and its home are what A's console lists as remote.
  setName(s, "bots", "display_name", DIRTY_BOT, "id = ?", f.B.bot.id);
  setName(s, "owners", "display_name", DIRTY_OWNER, "id = ?", f.B.owner_id);
  const homeId = s.platform.homeOf(f.B.bot.id);
  setName(s, "bots", "display_name", DIRTY_BOT, "id = ?", homeId);

  const r = await req(s.base, "GET", "/v1/remote-bots", f.A.owner.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const bot = r.body.bots.find((x: any) => x.bot_id === f.B.bot.id);
  assert.ok(bot, "the granted Bot is listed");
  assert.equal(bot.display_name, CLEAN_BOT, "the Bot label is the cleaned one");
  assert.equal(bot.owner_display_name, CLEAN_OWNER, "the owner label is the cleaned one");

  const home = r.body.homes.find((x: any) => x.home.bot_id === homeId);
  assert.ok(home, "the peer home is listed");
  assert.equal(home.home.display_name, CLEAN_BOT, "the home label is cleaned too");
  assert.equal(home.home.owner_display_name, CLEAN_OWNER);
  assert.equal(home.bots[0].display_name, CLEAN_BOT, "and inside the home, the same label");

  // Same Bot, same pair of names, from the surface that already cleans: the two pages may not disagree.
  const overview = await req(s.base, "GET", `/v1/friends-overview?bot_id=${f.A.bot.id}`, f.A.owner.token);
  assert.equal(overview.status, 200, JSON.stringify(overview.body));
  const peer = overview.body.friends.find((x: any) => x.peer.bot_id === f.B.bot.id).peer;
  assert.equal(bot.display_name, peer.display_name, "remote-bots and friends-overview show one Bot label");
  assert.equal(bot.owner_display_name, peer.owner_display_name, "and one owner label");
});

test("GET /v1/remote-bots caps a long name at 60 code points without splitting a pair", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const f = await friends(s.base);
  const long = "🐳".repeat(61);
  setName(s, "bots", "display_name", long, "id = ?", f.B.bot.id);
  setName(s, "owners", "display_name", "o".repeat(70), "id = ?", f.B.owner_id);

  const r = await req(s.base, "GET", "/v1/remote-bots", f.A.owner.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const bot = r.body.bots.find((x: any) => x.bot_id === f.B.bot.id);
  assert.equal(bot.display_name, "🐳".repeat(60), "60 code points, a surrogate pair never cut in half");
  assert.equal([...bot.display_name].length, 60);
  assert.equal(bot.owner_display_name, "o".repeat(60), "the owner label obeys the same cap");
});
