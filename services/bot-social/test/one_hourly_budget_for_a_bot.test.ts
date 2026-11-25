/**
 * One hourly budget for a Bot, not one per writing door.
 *
 * README says a Bot may draft "60 per hour per bot", and both write doors answer over the limit with
 * `global bot rate limit (60/h)` and `retry_after: 3600`. Each door counts only its own table though: chat drafts
 * count `messages`, face-room drafts count `face_room_drafts`. A Bot can therefore spend 60 chat drafts and then
 * still write 60 room drafts in the same hour — twice the budget the README promises, and every room line fans out
 * to the room's members once it is approved.
 *
 * The budget is now the union of the two tables for the same sender Bot and the same one-hour window. The tables
 * share no rows: delivering a room line updates its `face_room_drafts` row and emits, it never inserts into
 * `messages`, so nothing is counted twice. The per-conversation and per-room minute doors keep their own tables and
 * their own answers; each door keeps the clock it already used.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { expectApiError, friends, startServer } from "./helpers.js";

/** The room doors have their own creation and attempt budgets (three rooms an hour by default): these tests need
 *  many rooms for their drafts, and that has nothing to do with the hourly draft budget they exercise. */
const ROOMS = { faceRooms: { createsPerAccount: 20, createsPerIp: 20, attemptsPerAccount: 40, attemptsPerIp: 40 } };
const PER_MINUTE = 6;

async function req(base: string, method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  const json = text ? JSON.parse(text) : {};
  return { status: r.status, body: json };
}

const chatIntent = () => ({ type: "general_chat", summary: "chat" });
const openConversation = async (from: any, to: any) => (await from.bot.startConversation(to.bot.id, chatIntent())).conversation_id as string;
async function conversations(from: any, to: any, count: number) {
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(await openConversation(from, to));
  return out;
}
async function chatDrafts(from: any, cid: string, count: number) {
  for (let i = 0; i < count; i++) await from.bot.draftMessage(cid, { text: `Update ${i}: the plan for today is ready.` });
}
/** A fresh room with this home's Bot seated. A new code makes a new room. */
async function openRoom(base: string, home: any, code: string) {
  const r = await req(base, "POST", "/v1/face-rooms/join", home.owner.token, { code, bots: [home.bot.id] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.room_id as string;
}
async function openRooms(base: string, home: any, count: number, first: number) {
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(await openRoom(base, home, String(first + i)));
  return out;
}
async function roomDrafts(base: string, home: any, roomId: string, count: number) {
  for (let i = 0; i < count; i++) {
    const r = await req(base, "POST", `/v1/face-rooms/${roomId}/messages`, home.owner.token, { text: `Room update ${i}: the plan for today is ready.` });
    assert.equal(r.status, 202, JSON.stringify(r.body));
  }
}
const roomDraft = (base: string, home: any, roomId: string, text: string) => req(base, "POST", `/v1/face-rooms/${roomId}/messages`, home.owner.token, { text });

test("a Bot's chat drafts alone spend the hourly budget", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  for (const cid of await conversations(A, B, 10)) await chatDrafts(A, cid, PER_MINUTE);
  const extra = await openConversation(A, B);
  const err = await expectApiError(A.bot.draftMessage(extra, { text: "One too many." }), 429, "rate_limited");
  assert.equal(err.body.error.message, "global bot rate limit (60/h)");
  assert.equal(err.body.error.retry_after, 3600);
});

test("a spent chat budget leaves nothing for a room draft", async (t) => {
  const s = await startServer(ROOMS);
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  for (const cid of await conversations(A, B, 10)) await chatDrafts(A, cid, PER_MINUTE);
  const roomId = await openRoom(s.base, A, "710001");
  const r = await roomDraft(s.base, A, roomId, "A room line after a spent chat budget.");
  assert.equal(r.status, 429, JSON.stringify(r.body));
  assert.equal(r.body.error.message, "global bot rate limit (60/h)");
  assert.equal(r.body.error.retry_after, 3600);
});

test("a spent room budget leaves nothing for a chat draft", async (t) => {
  const s = await startServer(ROOMS);
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  for (const roomId of await openRooms(s.base, A, 10, 720000)) await roomDrafts(s.base, A, roomId, PER_MINUTE);
  const cid = await openConversation(A, B);
  const err = await expectApiError(A.bot.draftMessage(cid, { text: "A chat line after a spent room budget." }), 429, "rate_limited");
  assert.equal(err.body.error.message, "global bot rate limit (60/h)");
  assert.equal(err.body.error.retry_after, 3600);
});

test("half of each still adds up to one budget", async (t) => {
  const s = await startServer(ROOMS);
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  for (const cid of await conversations(A, B, 5)) await chatDrafts(A, cid, PER_MINUTE);
  for (const roomId of await openRooms(s.base, A, 5, 730000)) await roomDrafts(s.base, A, roomId, PER_MINUTE);
  const chatErr = await expectApiError(A.bot.draftMessage(await openConversation(A, B), { text: "The sixty-first line." }), 429, "rate_limited");
  assert.equal(chatErr.body.error.message, "global bot rate limit (60/h)");
  const roomErr = await roomDraft(s.base, A, await openRoom(s.base, A, "730999"), "The sixty-first line, in a room.");
  assert.equal(roomErr.status, 429, JSON.stringify(roomErr.body));
  assert.equal(roomErr.body.error.message, "global bot rate limit (60/h)");
});

test("the per-minute doors keep their own answers", async (t) => {
  const s = await startServer(ROOMS);
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const cid = await openConversation(A, B);
  await chatDrafts(A, cid, PER_MINUTE);
  const chatErr = await expectApiError(A.bot.draftMessage(cid, { text: "The seventh line in one conversation." }), 429, "rate_limited");
  assert.equal(chatErr.body.error.message, "per-conversation rate limit (6/min)");
  assert.equal(chatErr.body.error.retry_after, 60);

  const roomId = await openRoom(s.base, A, "740001");
  await roomDrafts(s.base, A, roomId, PER_MINUTE);
  const roomErr = await roomDraft(s.base, A, roomId, "The seventh line in one room.");
  assert.equal(roomErr.status, 429, JSON.stringify(roomErr.body));
  assert.equal(roomErr.body.error.message, "per-room rate limit (6/min)");
  assert.equal(roomErr.body.error.retry_after, 60);
});

test("each Bot spends its own budget", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const convs = await conversations(A, B, 10);
  for (const cid of convs) await chatDrafts(A, cid, PER_MINUTE);
  await expectApiError(A.bot.draftMessage(await openConversation(A, B), { text: "Over the budget." }), 429, "rate_limited");
  const draft = await B.bot.draftMessage(convs[0], { text: "This Bot has its own hour." });
  assert.equal(draft.status, "pending_approval");
});
