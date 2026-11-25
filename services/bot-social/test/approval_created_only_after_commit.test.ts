import assert from "node:assert/strict";
import { test } from "node:test";
import { friends, inDays, startServer } from "./helpers.js";

/**
 * #511: a draft that cannot write its `actions` row still announced the card. The card and the row are one write, but
 * the announcement (`approval.created`) is queued by `notifyOwnerOfApproval` through `emit` while the transaction is
 * still open, and the push queue lives in memory — so a refused insert rolled the rows back and the push went out
 * anyway, naming an `approval_id` / `event_id` that are in no table. The owner's Bot is told about a card the owner's
 * own list cannot show.
 *
 * Both tests drive the real server: a Bot whose owner named it the notification outlet, a well-formed `calendar.book`
 * draft, and (in the refused case) a `BEFORE INSERT` trigger on `actions` standing in for any write the store will not
 * take.
 */

const meetingIntent = () => ({ type: "schedule_meeting", summary: "sync", params: { duration_minutes: 30, window: { start: inDays(1, 0), end: inDays(5, 23) } } });

type Call = { url: string; headers: Record<string, string>; body: string };
const createdItems = (calls: Call[]) => calls
  .map((c) => JSON.parse(c.body))
  .flatMap((b: any) => b.items ?? [])
  .filter((i: any) => i.type === "approval.created");
const count = (s: any, sql: string, ...args: unknown[]) => (s.platform.db.prepare(sql).get(...args) as any).n as number;

/** Record every push the platform schedules itself; no flush is forced and no page is opened. */
async function setup() {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: any) => {
    calls.push({ url, headers: init.headers, body: init.body });
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  const s = await startServer({ fetchImpl, webhooks: { debounceMs: 30, retryBaseMs: 5 } });
  return { ...s, calls };
}

/** Owner turns one of their own Bots into the outlet: existing webhook + existing PATCH /v1/me. */
async function designate(owner: any, botId: string) {
  await owner.req("PUT", `/v1/bots/${botId}/webhook`, { url: "https://owner-notify.test/hook" });
  return owner.req("PATCH", "/v1/me", { notify_bot_id: botId });
}

test("a draft whose actions row is refused queues and delivers no approval.created", async (t) => {
  const s = await setup();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  await designate(A.owner, A.bot.id);
  const cid = (await A.bot.startConversation(B.bot.id, meetingIntent())).conversation_id as string;
  const before = {
    approvals: count(s, "SELECT COUNT(*) n FROM approvals WHERE owner_id = ?", A.owner_id),
    actions: count(s, "SELECT COUNT(*) n FROM actions WHERE conversation_id = ?", cid),
    events: count(s, "SELECT COUNT(*) n FROM events WHERE bot_id = ?", A.bot.id),
  };

  // The one statement the store refuses. Everything before it — the card, its notification row, the event — succeeds.
  s.platform.db.exec("CREATE TRIGGER refuse_action_insert BEFORE INSERT ON actions BEGIN SELECT RAISE(ABORT, 'store refused the actions write'); END");

  await assert.rejects(
    A.bot.draftAction(cid, "calendar.book", { title: "Sync", start: inDays(1, 10), end: inDays(1, 11), attendees: [B.bot.id] }, "plan the week"),
    (e: any) => {
      assert.ok(e.status >= 400, `a refused actions write must fail the draft, not answer ${e.status}`);
      return true;
    },
  );
  // Longer than the push debounce, so a card announcement queued by the failed draft would already be on the wire.
  await new Promise((r) => setTimeout(r, 250));

  assert.deepEqual(
    {
      approvals: count(s, "SELECT COUNT(*) n FROM approvals WHERE owner_id = ?", A.owner_id),
      actions: count(s, "SELECT COUNT(*) n FROM actions WHERE conversation_id = ?", cid),
      events: count(s, "SELECT COUNT(*) n FROM events WHERE bot_id = ?", A.bot.id),
    },
    before,
    "the refused draft leaves no approval, action or event row",
  );
  assert.equal(createdItems(s.calls).length, 0, "the owner's Bot was told about a card that was never stored");
  const queue: any = await A.owner.req("GET", "/v1/approvals");
  assert.equal(queue.approvals.length, 0, "the owner's list still reads and shows no card");
});

test("a stored draft queues exactly one approval.created and the card's list opens it", async (t) => {
  const s = await setup();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  await designate(A.owner, A.bot.id);
  const cid = (await A.bot.startConversation(B.bot.id, meetingIntent())).conversation_id as string;

  const d: any = await A.bot.draftAction(cid, "calendar.book", { title: "Sync", start: inDays(1, 10), end: inDays(1, 11), attendees: [B.bot.id] }, "plan the week");
  assert.equal(d.status, "pending_approval");

  const end = Date.now() + 3000;
  while (Date.now() < end && !createdItems(s.calls).length) await new Promise((r) => setTimeout(r, 20));
  const items = createdItems(s.calls);
  assert.equal(items.length, 1, "exactly one approval.created push");
  assert.equal(items[0].approval.approval_id, d.approval_id);

  const queue: any = await A.owner.req("GET", "/v1/approvals");
  assert.equal(queue.approvals.length, 1, "the owner's list shows the card the announcement named");
  assert.equal(queue.approvals[0].approval_id, d.approval_id);

  const ev = s.platform.db.prepare("SELECT data FROM events WHERE bot_id = ? AND type = 'approval.created'").all(A.bot.id) as { data: string }[];
  assert.equal(ev.length, 1, "exactly one approval.created event in the Bot's queue");
  assert.equal(JSON.parse(ev[0].data).approval_id, d.approval_id, "the event names the card the owner's list shows");
  assert.equal(count(s, "SELECT COUNT(*) n FROM webhook_deliveries WHERE bot_id = ? AND status = 'delivered'", A.bot.id) >= 1, true, "the push left once");
});
