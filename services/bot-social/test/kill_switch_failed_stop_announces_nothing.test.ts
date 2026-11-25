/**
 * A stop that fails must not tell the other Bot that it paused anything.
 *
 * The chats are paused through `pauseConversation`, which writes the status, one `conversation.paused` entry and
 * one event to each end. `emit` defers its push to the commit only while it runs inside `atomically`; inside a
 * plain `db.transaction` the push leaves at once, so a later throw in the same transaction takes the rows back and
 * leaves the other Bot notified about a pause that never happened -- an event id that names no row in `events`.
 *
 * The failure is a real call on the stop's own path, not a crafted branch: a card owned by the Bot being stopped
 * makes `emergencyStop` sweep it through `cancelPendingFor`, and here that sweep throws, as a database error there
 * would. A clean stop is pinned by `kill_switch_pauses_its_chats.test.ts`; this case pins the reverse.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { bulkAuth, expectApiError, friends, startServer } from "./helpers.js";

const count = (db: any, sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as any).n as number;

test("a stop that rolls back posts no pause and leaves no trace of one", async (t) => {
  const posts: string[] = [];
  const sink = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => { posts.push(body); res.writeHead(200, { "content-type": "application/json" }).end("{}"); });
  });
  await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", () => resolve()));
  const port = (sink.address() as any).port;

  const s = await startServer({ ...bulkAuth, webhooks: { debounceMs: 0 } });
  t.after(async () => { await s.stop(); await new Promise<void>((r) => sink.close(() => r())); });

  const { A, B } = await friends(s.base);
  const conv1 = (await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "A started" })).conversation_id;
  const conv2 = (await B.bot.startConversation(A.bot.id, { type: "general_chat", summary: "B started" })).conversation_id;
  // The other end's Bot is watched where a real owner watches it: a local webhook sink. It is hung after the two
  // rows exist, so the only POST it can receive is one the stop itself queues.
  await B.owner.req("PUT", `/v1/bots/${B.bot.id}/webhook`, { url: `http://127.0.0.1:${port}/hook` });

  // The stop's own sweep refuses, after the pause loop and still inside the one transaction.
  const platform: any = s.platform;
  const realCancel = platform.cancelPendingFor;
  platform.cancelPendingFor = () => { throw new Error("fixture: the sweep refuses this stop"); };
  t.after(() => { platform.cancelPendingFor = realCancel; });

  await expectApiError(A.owner.req("POST", "/v1/emergency-stop", { bot_id: A.bot.id }), 500);

  // Let a push that was queued before the rollback leave, so a leak has every chance to show up.
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(posts.length, 0, `a stop that rolled back posted ${posts.length} webhook(s) to the other Bot`);

  // Nothing of the pause survives, on either side of the transaction.
  assert.equal(count(s.platform.db, "SELECT COUNT(*) n FROM events WHERE type = 'conversation.paused'"), 0, "no pause event row");
  assert.equal(count(s.platform.audit.db, "SELECT COUNT(*) n FROM audit_events WHERE action = 'conversation.paused'"), 0, "no pause audit entry");
  for (const cid of [conv1, conv2]) {
    assert.equal((s.platform.db.prepare("SELECT status FROM conversations WHERE id = ?").get(cid) as any).status, "open", `${cid} is still open`);
  }
  assert.equal((s.platform.db.prepare("SELECT status FROM bots WHERE id = ?").get(A.bot.id) as any).status, "active", "the Bot is still active");
});
