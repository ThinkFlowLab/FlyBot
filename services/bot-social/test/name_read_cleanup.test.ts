import assert from "node:assert/strict";
import { test } from "node:test";
import { friends, ownerWithBot, startServer } from "./helpers.js";

// A display name is peer-written data (#106): cleaned on write, and cleaned again on read, because a row
// written before that check — or by any older writer — can still hold control characters, U+2028, a leading
// `@`, a lone surrogate or more than 60 code points. The friend overview and the face-room snapshots are the
// projections other Bots actually read, so they must use the same `peerDisplayName` rule as `publicBot`.
// A name is a single-line label and is not fenced; only the note beside it is.

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const DIRTY = "Ann\0\x07\u2028 Marie\nSmith"; // controls and U+2028 are separators, then whitespace collapses
const CLEAN = "Ann Marie Smith";
const ROOM = "session-3f2a9c1e-6b7d-4e1a-9f0c-2d4b6a8c0e12";

async function req(base: string, method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  const json = text ? JSON.parse(text) : {};
  return { status: r.status, body: json.error ? json.error : json };
}
const ownerTok = (o: { owner: { token: string } }) => o.owner.token;
const setName = (s: any, table: "bots" | "owners" | "face_room_members", column: string, value: string, where: string, ...args: unknown[]) =>
  s.platform.db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${where}`).run(value, ...args);
const joinRoom = (base: string, o: { owner: { token: string }; bot: { id: string } }, code: string) =>
  req(base, "POST", "/v1/face-rooms/join", ownerTok(o), { code, bots: [o.bot.id] });

test("friendsOverview cleans bot and owner names a legacy row still holds", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  setName(s, "bots", "display_name", DIRTY, "id = ?", A.bot.id);
  setName(s, "owners", "display_name", "@boss", "id = ?", A.owner_id);

  const r = await req(s.base, "GET", `/v1/friends-overview?bot_id=${A.bot.id}`, ownerTok(A));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const listed = r.body.bots.find((b: any) => b.bot_id === A.bot.id);
  assert.equal(listed.display_name, CLEAN, "the owner's bot list cleans the name the row holds");
  assert.equal(r.body.bot.display_name, CLEAN, "the selected bot card cleans it too");
  assert.equal(r.body.bot.owner_display_name, "boss", "the owner label loses its leading @ on read");

  // The rest of the #106 rule, asserted where a reader meets it.
  const cases: [string, string][] = [
    ["A\x01B", "A B"], // a control character is a separator, not something to delete inside a word
    ["🐳".repeat(61), "🐳".repeat(60)], // the cap counts code points, so a pair is never cut in half
    ["x".repeat(70), "x".repeat(70 - 10)],
  ];
  for (const [stored, shown] of cases) {
    setName(s, "bots", "display_name", stored, "id = ?", A.bot.id);
    const view = await req(s.base, "GET", `/v1/friends-overview?bot_id=${A.bot.id}`, ownerTok(A));
    assert.equal(view.body.bot.display_name, shown, `stored ${JSON.stringify(stored)}`);
    assert.equal(CONTROL.test(view.body.bot.display_name), false);
    assert.equal(LONE.test(view.body.bot.display_name), false);
  }
});

test("friendsOverview cleans a friend's names with the same rule", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const f = await friends(s.base);
  setName(s, "bots", "display_name", DIRTY, "id = ?", f.B.bot.id);
  setName(s, "owners", "display_name", "@boss", "id = ?", f.B.owner_id);
  const view = await req(s.base, "GET", `/v1/friends-overview?bot_id=${f.A.bot.id}`, ownerTok(f.A));
  assert.equal(view.status, 200, JSON.stringify(view.body));
  assert.equal(view.body.friends[0].peer.display_name, CLEAN);
  assert.equal(view.body.friends[0].peer.owner_display_name, "boss");
});

test("a face-room snapshot cleans legacy member and creator names", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const j = await joinRoom(s.base, A, "313131");
  assert.equal(j.status, 200, JSON.stringify(j.body));
  const roomId = j.body.room_id as string;
  setName(s, "face_room_members", "display_name", DIRTY, "room_id = ? AND bot_id = ?", roomId, A.bot.id);
  setName(s, "face_room_members", "owner_name", "@boss", "room_id = ? AND bot_id = ?", roomId, A.bot.id);
  setName(s, "owners", "display_name", "A\x01B", "id = ?", A.owner_id);

  const r = await req(s.base, "GET", `/v1/face-rooms/${roomId}`, ownerTok(A));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const me = r.body.members.find((m: any) => m.handle === A.handle);
  assert.equal(me.display_name, CLEAN);
  assert.equal(me.owner_name, "boss");
  assert.equal(me.label, `${CLEAN} · boss`);
  assert.equal(r.body.created_by.owner_name, "A B", "the creator label is read from the owner row, cleaned");

  // The same roster via the #106 cap: 61 code points in, 60 shown, no cut surrogate.
  setName(s, "face_room_members", "display_name", "🐳".repeat(61), "room_id = ? AND bot_id = ?", roomId, A.bot.id);
  const again = await req(s.base, "GET", `/v1/face-rooms/${roomId}`, ownerTok(A));
  assert.equal(again.body.members.find((m: any) => m.handle === A.handle).display_name, "🐳".repeat(60));
});

test("a face-room invite preview names its lead from a cleaned member row", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const j = await joinRoom(s.base, A, "323232");
  assert.equal(j.status, 200, JSON.stringify(j.body));
  const roomId = j.body.room_id as string;
  setName(s, "face_room_members", "display_name", DIRTY, "room_id = ? AND bot_id = ?", roomId, A.bot.id);
  setName(s, "face_room_members", "owner_name", "@boss", "room_id = ? AND bot_id = ?", roomId, A.bot.id);

  const mint = await req(s.base, "POST", `/v1/face-rooms/${roomId}/invites`, ownerTok(A));
  assert.equal(mint.status, 201, JSON.stringify(mint.body));
  const preview = await req(s.base, "GET", `/v1/face-rooms/invites/${mint.body.ticket}`);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.lead.display_name, CLEAN);
  assert.equal(preview.body.lead.owner_name, "boss");
  // Cleaning a name must not reshape the payload: the preview has always answered with these three keys only.
  assert.deepEqual(Object.keys(preview.body.lead).sort(), ["display_name", "handle", "owner_name"]);
});

test("a local-room invite names its lead and its claim members from cleaned rows", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  setName(s, "bots", "display_name", DIRTY, "id = ?", A.bot.id);
  setName(s, "owners", "display_name", "@boss", "id = ?", A.owner_id);
  const mint = await req(s.base, "POST", "/v1/local-room-invites", ownerTok(A), { room_id: ROOM, bot_id: A.bot.id });
  assert.equal(mint.status, 201, JSON.stringify(mint.body));
  const ticket = encodeURIComponent(mint.body.ticket as string);

  const preview = await req(s.base, "GET", `/v1/local-room-invites/${ticket}`);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.lead.display_name, CLEAN);
  assert.equal(preview.body.lead.owner_name, "boss");

  setName(s, "bots", "display_name", "A\x01B", "id = ?", B.bot.id);
  const claim = await req(s.base, "POST", `/v1/local-room-invites/${ticket}/claim`, ownerTok(B), { bots: [B.bot.id] });
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  const mine = await req(s.base, "GET", `/v1/local-room-invites/${ticket}`, ownerTok(A));
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.equal(mine.body.claimers[0].members[0].display_name, "A B", "the seats the inviting home shows carry cleaned labels");
});

test("the room list shows a caller's own seat with a cleaned name", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const j = await joinRoom(s.base, A, "333333");
  assert.equal(j.status, 200, JSON.stringify(j.body));
  const roomId = j.body.room_id as string;
  setName(s, "face_room_members", "display_name", DIRTY, "room_id = ? AND bot_id = ?", roomId, A.bot.id);
  const r = await req(s.base, "GET", "/v1/face-rooms", ownerTok(A));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const room = r.body.rooms.find((x: any) => x.room_id === roomId);
  assert.equal(room.my_bots.find((b: any) => b.handle === A.handle).display_name, CLEAN);
});
