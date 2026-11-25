// Bot Social console search: the owner console could only reach a chat or a room by scrolling a long list. The
// sidebar search finds one by its title face — a chat's peer handle/display name, a room's note and the handles of
// the Bots seated in it — and opens it. Message bodies are never read (no line of a chat, no line said in a room),
// and the hits are the lists' own set: a closed chat, and a room that closed or that the caller left, are not
// results. `q` is trimmed and must be 2–100 characters.
import assert from "node:assert/strict";
import { test } from "node:test";
import { friends, ownerWithBot, startServer } from "./helpers.js";
import { loadConsole, pub } from "./ui_helpers.js";

async function req(base: string, method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}
type Who = Awaited<ReturnType<typeof ownerWithBot>>;
const find = (base: string, o: Who, q: string) => req(base, "GET", `/v1/search?q=${encodeURIComponent(q)}`, o.owner.token);
const joinRoom = (base: string, o: Who, code: string) => req(base, "POST", "/v1/face-rooms/join", o.owner.token, { code, bots: [o.bot.id] });
const leaveRoom = (base: string, o: Who, roomId: string) => req(base, "POST", `/v1/face-rooms/${roomId}/leave`, o.owner.token, {});
const bare = (handle: string) => handle.replace(/^@/, "");

test("a chat is found by the peer's handle, case-insensitively, and the hit opens that conversation", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const conv = await B.bot.startConversation(A.bot.id, { type: "general_chat", summary: "Planning the week" });
  const hit = await find(s.base, A, bare(B.handle).toUpperCase());
  assert.equal(hit.status, 200);
  assert.equal(hit.body.query, bare(B.handle).toUpperCase());
  assert.equal(hit.body.chats.length, 1);
  assert.equal(hit.body.chats[0].conversation_id, conv.conversation_id);
  assert.equal(hit.body.chats[0].peer.handle, B.handle);
  assert.ok(String(hit.body.chats[0].peer.display_name).length > 0, "the hit names the peer as a card does");
  assert.equal(hit.body.rooms.length, 0);
  // The same thread read from the other side names the other peer, never the searcher's own Bot.
  const fromB = await find(s.base, B, bare(A.handle));
  assert.equal(fromB.body.chats[0].conversation_id, conv.conversation_id);
  assert.equal(fromB.body.chats[0].peer.handle, A.handle);
  // The console turns a hit into a link that opens the thread.
  const { searchHits, searchResultsHtml } = loadConsole(["searchHits", "searchResultsHtml"]);
  assert.equal(searchHits(hit.body)[0].href, `#/chat/${conv.conversation_id}`);
  assert.match(searchResultsHtml(hit.body), new RegExp(`href="#/chat/${conv.conversation_id}"`));
});

test("a room is found by its note and by a seated Bot's handle", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const a = await joinRoom(s.base, A, "717171");
  assert.equal(a.status, 200);
  const roomId = a.body.room_id as string;
  assert.equal((await joinRoom(s.base, B, "717171")).status, 200);
  const note = "Saturday planning: two Bots draft, owners approve.";
  assert.equal((await req(s.base, "POST", `/v1/face-rooms/${roomId}/note`, A.owner.token, { note })).status, 200);
  const byNote = await find(s.base, B, "saturday PLANNING");
  assert.equal(byNote.status, 200);
  assert.equal(byNote.body.chats.length, 0);
  assert.equal(byNote.body.rooms.length, 1);
  assert.equal(byNote.body.rooms[0].room_id, roomId);
  assert.equal(byNote.body.rooms[0].note, note);
  assert.equal(byNote.body.rooms[0].member_count, 2);
  assert.deepEqual(byNote.body.rooms[0].members.map((m: any) => m.handle).sort(), [A.handle, B.handle].sort());
  const byMember = await find(s.base, A, bare(B.handle));
  assert.equal(byMember.body.rooms[0].room_id, roomId);
  const { searchHits } = loadConsole(["searchHits"]);
  assert.equal(searchHits(byNote.body).find((h: any) => h.type === "room").href, `#/rooms/${roomId}`);
});

test("a room that closed or that the caller left, and a closed chat, are not results", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const a = await joinRoom(s.base, A, "727272");
  const roomId = a.body.room_id as string;
  assert.equal((await joinRoom(s.base, B, "727272")).status, 200);
  assert.equal((await req(s.base, "POST", `/v1/face-rooms/${roomId}/note`, A.owner.token, { note: "Refactor pairing room" })).status, 200);
  // A home that leaves loses the room from its list, so the search must not offer it either.
  assert.equal((await leaveRoom(s.base, A, roomId)).status, 200);
  assert.equal((await find(s.base, A, "Refactor pairing")).body.rooms.length, 0);
  assert.equal((await find(s.base, B, "Refactor pairing")).body.rooms.length, 1);
  // The last home out closes the room: it is gone from the list and from search for everyone.
  assert.equal((await leaveRoom(s.base, B, roomId)).status, 200);
  assert.equal((await req(s.base, "GET", "/v1/face-rooms", B.owner.token)).body.rooms.length, 0);
  assert.equal((await find(s.base, B, "Refactor pairing")).body.rooms.length, 0);
  // A chat that ended stays out of the search: an open thread is a hit, the same thread closed is not.
  const conv = await B.bot.startConversation(A.bot.id, { type: "general_chat", summary: "One thread" });
  assert.equal((await find(s.base, A, bare(B.handle))).body.chats.length, 1);
  assert.equal((await req(s.base, "POST", `/v1/conversations/${conv.conversation_id}/close`, A.owner.token, { outcome: "abandoned" })).status, 200);
  assert.equal((await find(s.base, A, bare(B.handle))).body.chats.length, 0);
});

test("q is trimmed and must be 2-100 characters; a bad q is refused, not a crash", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const missing = await req(s.base, "GET", "/v1/search", A.owner.token);
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, "invalid_query");
  for (const q of ["", " ", "  a  ", "x".repeat(101)]) {
    const r = await req(s.base, "GET", `/v1/search?q=${encodeURIComponent(q)}`, A.owner.token);
    assert.equal(r.status, 400, `q=${JSON.stringify(q)}`);
    assert.equal(r.body.error.code, "invalid_query");
  }
  // The two ends of the window answer a page, empty is fine.
  const short = await req(s.base, "GET", "/v1/search?q=ab", A.owner.token);
  assert.equal(short.status, 200);
  assert.equal(short.body.query, "ab");
  assert.deepEqual(short.body.chats, []);
  assert.deepEqual(short.body.rooms, []);
  assert.equal((await req(s.base, "GET", `/v1/search?q=${"x".repeat(100)}`, A.owner.token)).status, 200);
  // A repeated parameter arrives as an array; it is refused the same way instead of reaching SQLite.
  assert.equal((await req(s.base, "GET", "/v1/search?q=ann&q=ben", A.owner.token)).status, 400);
});

test("a Bot token searches only its own threads and rooms; another owner sees nothing of them", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const conv = await B.bot.startConversation(A.bot.id, { type: "general_chat", summary: "One thread" });
  const C = await ownerWithBot(s.base, "cy");
  const asBotA = await req(s.base, "GET", `/v1/search?q=${encodeURIComponent(bare(B.handle))}`, A.reg.bot_token);
  assert.equal(asBotA.status, 200);
  assert.equal(asBotA.body.chats.length, 1);
  assert.equal(asBotA.body.chats[0].conversation_id, conv.conversation_id);
  assert.equal(asBotA.body.chats[0].peer.handle, B.handle);
  assert.equal((await req(s.base, "GET", `/v1/search?q=${encodeURIComponent(bare(C.handle))}`, A.reg.bot_token)).body.chats.length, 0);
  assert.equal((await req(s.base, "GET", `/v1/search?q=${encodeURIComponent(bare(B.handle))}`, C.reg.bot_token)).body.chats.length, 0);
  assert.equal((await find(s.base, C, bare(B.handle))).body.chats.length, 0);
});

test("only the title face is searched: a chat summary or a message body is not a hit", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const conv = await B.bot.startConversation(A.bot.id, { type: "general_chat", summary: "Pineapple harvest" });
  await B.bot.draftMessage(conv.conversation_id, { text: "the pineapple is ripe" });
  const hit = await find(s.base, A, "pineapple");
  assert.equal(hit.status, 200);
  assert.equal(hit.body.chats.length, 0, "a summary or a line said in the thread is not searched");
  assert.equal(hit.body.rooms.length, 0);
});

test("at most 20 chats come back, newest activity first", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const ids: string[] = [];
  for (let i = 0; i < 21; i++) {
    const c = await B.bot.startConversation(A.bot.id, { type: "general_chat", summary: `thread ${i}` });
    ids.push(c.conversation_id as string);
    await new Promise((r) => setTimeout(r, 3));
  }
  const page = await find(s.base, A, bare(B.handle));
  assert.equal(page.body.chats.length, 20);
  assert.equal(page.body.chats[0].conversation_id, ids[20], "the newest thread is first");
  assert.ok(page.body.chats.every((c: any, i: number) => i === 0 || c.updated_at <= page.body.chats[i - 1].updated_at), "ordered by recent activity");
  assert.ok(!page.body.chats.some((c: any) => c.conversation_id === ids[0]), "the oldest thread is outside the page");
});

test("the sidebar carries the search box, its gate and an empty state", () => {
  assert.match(pub("ui.js"), /id="side-search"/);
  const { searchTermError, searchResultsHtml } = loadConsole(["searchTermError", "searchResultsHtml"]);
  assert.equal(searchTermError(""), "");
  assert.equal(searchTermError(" a "), "Type at least 2 characters.");
  assert.equal(searchTermError("x".repeat(101)), "Type at most 100 characters.");
  assert.equal(searchTermError("ann"), "");
  assert.match(searchResultsHtml({ chats: [], rooms: [] }), /No matches/);
});

test("a chat past its 72-hour window is not a result, and the chat page already calls it closed", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  // Two threads between the same pair: one still inside its window, one whose clock has run out.
  const live = await B.bot.startConversation(A.bot.id, { type: "general_chat", summary: "still open" });
  const lapsed = await B.bot.startConversation(A.bot.id, { type: "general_chat", summary: "ran out" });
  s.platform.db.prepare("UPDATE conversations SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), lapsed.conversation_id);

  // The chat page settles the clock on read: the same thread reads closed / expired, and the row is not touched.
  const read = await req(s.base, "GET", `/v1/conversations/${lapsed.conversation_id}`, A.owner.token);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  const conv = read.body.conversation ?? read.body;
  assert.equal(conv.status, "closed");
  assert.equal(conv.outcome, "expired");
  const row = s.platform.db.prepare("SELECT status FROM conversations WHERE id = ?").get(lapsed.conversation_id) as any;
  assert.equal(row.status, "open", "the expiry is a read rule, not a writer");

  // Owner query: only the live thread, and it keeps its status field.
  const owner = await find(s.base, A, bare(B.handle));
  assert.deepEqual(owner.body.chats.map((c: any) => c.conversation_id), [live.conversation_id]);
  assert.equal(owner.body.chats[0].status, "open");

  // The Bot-token query answers the same set as the owner query.
  const asBot = await req(s.base, "GET", `/v1/search?q=${encodeURIComponent(bare(B.handle))}`, A.reg.bot_token);
  assert.equal(asBot.status, 200);
  assert.deepEqual(asBot.body.chats.map((c: any) => c.conversation_id), [live.conversation_id]);
});
