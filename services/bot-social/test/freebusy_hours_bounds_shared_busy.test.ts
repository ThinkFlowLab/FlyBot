/**
 * A free/busy grant's `hours` bounds what the peer is told, not only what the console suggests.
 *
 * `calendar.freebusy.read` is the one capability whose implementation reads the grant's `scope`: the query is
 * bounded by `window_days` and by the grantor's daily `hours`. The response already obeyed `window_days` — `window`
 * narrowed to the granted span and anything past it treated as unknown — but the peer's `busy` array was passed
 * through whole, so the other side could read a block at 02:00–03:00 and a block from 08:00–09:30 that crosses the
 * window, while `common_free_suggestions` in the same answer stayed inside 09:00–18:00. One scope field bounded the
 * answer, the other only the suggestions.
 *
 * Each busy block is now cut to the grantor's local `hours`: a block wholly outside is dropped, a crossing block is
 * truncated at the boundary. Dropping a crossing block instead would tell the peer its inside part is free, which is
 * not true; truncating it keeps the part of the block that the grant actually shares. The cut is a daily window
 * only, with no weekday rule (the Monday–Friday filter belongs to the suggestion heuristic, not to the scope), and
 * an `hours` window that ends before it starts shares no busy at all.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { localMinutes } from "../src/time.js";
import { approveAll, friends, inDays, startServer } from "./helpers.js";

const TZ = "Asia/Shanghai";
const OPEN = 9 * 60;
const CLOSE = 18 * 60;
const meetingIntent = () => ({ type: "schedule_meeting", summary: "sync", params: { duration_minutes: 30, window: { start: inDays(1, 0), end: inDays(3, 23) } } });
const queryWindow = () => ({ start: inDays(1, 0), end: inDays(3, 23) });
const addEntry = (owner: any, start: string, end: string, title: string) => owner.req("POST", "/v1/calendar/entries", { start, end, title });

test("a busy block outside the grant's hours is not shared", async () => {
  const { base, stop } = await startServer();
  try {
    const { A, B, relId } = await friends(base, { freebusy: true });
    await addEntry(B.owner, inDays(2, 2), inDays(2, 3), "night work");
    const cid = (await A.bot.startConversation(B.bot.id, meetingIntent())).conversation_id;
    const fb = await A.bot.freebusy(cid, [B.bot.id], queryWindow());
    assert.deepEqual(fb.results[B.bot.id].busy, [], "02:00–03:00 is outside 09:00–18:00 and is not part of the share");

    // A window that ends before it starts names no shareable time: nothing in it is shared, even at 10:00.
    await B.owner.req("POST", `/v1/relationships/${relId}/grants`, { capability: "calendar.freebusy.read", scope: { hours: "18:00-09:00" } });
    await addEntry(B.owner, inDays(2, 10), inDays(2, 11), "inside an inverted window");
    const inverted = await A.bot.freebusy(cid, [B.bot.id], queryWindow());
    assert.deepEqual(inverted.results[B.bot.id].busy, [], "an hours window that ends before it starts shares no busy");
  } finally { await stop(); }
});

test("a block that starts before the hours window is cut at its start", async () => {
  const { base, stop } = await startServer();
  try {
    const { A, B } = await friends(base, { freebusy: true });
    await addEntry(B.owner, inDays(2, 8), inDays(2, 9.5), "early start");
    const cid = (await A.bot.startConversation(B.bot.id, meetingIntent())).conversation_id;
    const fb = await A.bot.freebusy(cid, [B.bot.id], queryWindow());
    assert.deepEqual(fb.results[B.bot.id].busy, [{ start: inDays(2, 9), end: inDays(2, 9.5) }], "08:00–09:30 is shared as 09:00–09:30");
  } finally { await stop(); }
});

test("a block that ends after the hours window is cut at its end", async () => {
  const { base, stop } = await startServer();
  try {
    const { A, B } = await friends(base, { freebusy: true });
    await addEntry(B.owner, inDays(2, 17.5), inDays(2, 19), "late finish");
    const cid = (await A.bot.startConversation(B.bot.id, meetingIntent())).conversation_id;
    const fb = await A.bot.freebusy(cid, [B.bot.id], queryWindow());
    assert.deepEqual(fb.results[B.bot.id].busy, [{ start: inDays(2, 17.5), end: inDays(2, 18) }], "17:30–19:00 is shared as 17:30–18:00");
  } finally { await stop(); }
});

test("a block inside the hours window is returned as it is", async () => {
  const { base, stop } = await startServer();
  try {
    const { A, B } = await friends(base, { freebusy: true });
    await addEntry(B.owner, inDays(2, 10), inDays(2, 11), "mid morning");
    const cid = (await A.bot.startConversation(B.bot.id, meetingIntent())).conversation_id;
    const fb = await A.bot.freebusy(cid, [B.bot.id], queryWindow());
    assert.deepEqual(fb.results[B.bot.id].busy, [{ start: inDays(2, 10), end: inDays(2, 11) }], "a block wholly inside the window keeps both ends");
  } finally { await stop(); }
});

test("the caller's own busy is not narrowed by the peer's hours", async () => {
  const { base, stop } = await startServer();
  try {
    const { A, B } = await friends(base, { freebusy: true });
    await addEntry(A.owner, inDays(2, 2), inDays(2, 3), "own night work");
    const cid = (await A.bot.startConversation(B.bot.id, meetingIntent())).conversation_id;
    const fb = await A.bot.freebusy(cid, ["self"], queryWindow());
    assert.deepEqual(fb.results.self.busy, [{ start: inDays(2, 2), end: inDays(2, 3) }], "self is the caller's own calendar and is never bounded by a grant");
  } finally { await stop(); }
});

test("window_days still narrows the queried window", async () => {
  const { base, stop } = await startServer();
  try {
    const { A, B } = await friends(base, { freebusy: true });
    await addEntry(B.owner, inDays(2, 10), inDays(2, 11), "inside the grant");
    await addEntry(B.owner, inDays(20, 10), inDays(20, 11), "past the grant");
    const cid = (await A.bot.startConversation(B.bot.id, meetingIntent())).conversation_id;
    const fb = await A.bot.freebusy(cid, [B.bot.id], { start: inDays(1, 0), end: inDays(25, 23) });
    const peer = fb.results[B.bot.id];
    assert.equal(peer.window.start, inDays(1, 0), "the requested start is unchanged");
    const days = (Date.parse(peer.window.end) - Date.now()) / 86400e3;
    assert.ok(days > 13.9 && days < 14.1, `window.end is about 14 days out, got ${peer.window.end}`);
    assert.deepEqual(peer.busy, [{ start: inDays(2, 10), end: inDays(2, 11) }], "a block past window_days is not shared");
  } finally { await stop(); }
});

test("suggestions stay inside both owners' hours", async () => {
  const { base, stop } = await startServer();
  try {
    const { A, B } = await friends(base, { freebusy: true });
    await addEntry(B.owner, inDays(2, 10), inDays(2, 11), "busy mid morning");
    const cid = (await A.bot.startConversation(B.bot.id, meetingIntent())).conversation_id;
    const fb = await A.bot.freebusy(cid, [B.bot.id], queryWindow());
    assert.ok(fb.common_free_suggestions.length > 0, "the shared window still has free slots");
    for (const slot of fb.common_free_suggestions) {
      const start = localMinutes(Date.parse(slot.start), TZ);
      assert.ok(start >= OPEN && start + 30 <= CLOSE, `suggestion ${slot.start} is inside 09:00–18:00`);
    }
  } finally { await stop(); }
});

test("an unscoped free/busy grant is returned whole", async () => {
  const { base, stop } = await startServer();
  try {
    const { A, B, relId } = await friends(base);
    await A.bot.requestGrant(relId, "calendar.freebusy.read");
    await approveAll(B.owner);
    await addEntry(B.owner, inDays(2, 2), inDays(2, 3), "night work");
    const cid = (await A.bot.startConversation(B.bot.id, meetingIntent())).conversation_id;
    const fb = await A.bot.freebusy(cid, [B.bot.id], queryWindow());
    assert.deepEqual(fb.results[B.bot.id].busy, [{ start: inDays(2, 2), end: inDays(2, 3) }], "a grant with no hours shares the block as it is");
  } finally { await stop(); }
});

test("a long block is cut to the queried window, not to its own length", async () => {
  const { base, stop } = await startServer();
  try {
    const { A, B } = await friends(base, { freebusy: true });
    // One entry that begins years before the query and ends years after it: the answer may only cover the queried
    // days, one piece per day, rather than one piece per day of the entry's own lifetime.
    await addEntry(B.owner, "2020-01-01T00:00:00.000Z", "2030-01-01T00:00:00.000Z", "a decade-long block");
    const cid = (await A.bot.startConversation(B.bot.id, meetingIntent())).conversation_id;
    const win = queryWindow();
    const fb = await A.bot.freebusy(cid, [B.bot.id], win);
    const busy: { start: string; end: string }[] = fb.results[B.bot.id].busy;
    const ws = Date.parse(win.start), we = Date.parse(win.end);
    assert.ok(busy.length <= 4, `a decade-long block yields at most one piece per queried day, got ${busy.length}`);
    for (const b of busy) {
      const s = Date.parse(b.start), e = Date.parse(b.end);
      assert.ok(s >= ws && e <= we, `${b.start}..${b.end} lies outside the queried window`);
      assert.equal(localMinutes(s, TZ), OPEN, "each piece starts at the grant's opening time");
      assert.equal(localMinutes(e, TZ), CLOSE, "each piece ends at the grant's closing time");
    }
  } finally { await stop(); }
});
