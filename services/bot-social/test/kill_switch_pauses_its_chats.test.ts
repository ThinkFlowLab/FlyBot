/**
 * The kill switch pauses chats through the door that announces them.
 *
 * `pauseConversation` is the one place a chat becomes paused: it writes the status, one `conversation.paused`
 * audit entry naming the status and the reason, and one event to each end so both Bots learn why their chat
 * stopped. `POST /v1/emergency-stop` reached around it with a bare UPDATE, so the chats it paused moved to
 * `paused_stop` with no audit entry and no event: the peer's Bot kept its token, saw nothing, and only found out
 * on its next draft (`409 conversation_paused`). The state change is real either way, so the silent half is the
 * defect -- the same shape as the silent expiry/cancellation fixes.
 *
 * The reverse controls pin the boundary: a repeated stop announces nothing twice (the chat is already
 * `paused_stop`), a chat paused for another reason is moved to `paused_stop` and announced once because its
 * status really changes, and a closed chat is left alone.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { friends, startServer } from "./helpers.js";

const pausedAudit = (s: any, cid: string) =>
  s.platform.audit.db.prepare("SELECT actor, owners, data FROM audit_events WHERE action = 'conversation.paused' AND subject = ? ORDER BY seq").all(cid) as any[];
const pausedEvents = (s: any, botId: string, cid: string) =>
  (s.platform.db.prepare("SELECT data FROM events WHERE bot_id = ? AND type = 'conversation.paused' ORDER BY created_at, rowid").all(botId) as any[])
    .map((e) => JSON.parse(e.data))
    .filter((d) => d.conversation_id === cid);
const convStatus = async (owner: any, cid: string) => (await owner.req("GET", `/v1/conversations/${cid}`)).status;
const stopRow = (s: any, botId: string) =>
  s.platform.audit.db.prepare("SELECT actor, owners, data FROM audit_events WHERE action = 'bot.emergency_stop' AND subject = ? ORDER BY seq").all(botId) as any[];

test("a kill switch pauses its chats through the door that announces them", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  // One chat A started (with a card waiting, so it is `awaiting_approval`), one B started (plain `open`).
  const conv1 = (await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "A started" })).conversation_id;
  const draft = await A.bot.draftMessage(conv1, { text: "a line waiting for the owner" });
  assert.equal(draft.status, "pending_approval");
  const conv2 = (await B.bot.startConversation(A.bot.id, { type: "general_chat", summary: "B started" })).conversation_id;
  assert.equal(await convStatus(A.owner, conv1), "awaiting_approval");
  assert.equal(await convStatus(A.owner, conv2), "open");
  assert.equal(pausedAudit(s, conv1).length, 0);

  const stop: any = await A.owner.req("POST", "/v1/emergency-stop", { bot_id: A.bot.id });
  assert.equal(stop.status, "frozen");

  // The state the kill switch always wrote is unchanged: every chat of the frozen Bot is paused.
  assert.equal(await convStatus(A.owner, conv1), "paused_stop");
  assert.equal(await convStatus(B.owner, conv2), "paused_stop");

  // What was missing: the pause carries the audit entry and the event the pause door writes, once per chat.
  for (const cid of [conv1, conv2]) {
    const rows = pausedAudit(s, cid);
    assert.equal(rows.length, 1, `one pause entry for ${cid}, saw ${rows.length}`);
    assert.equal(rows[0].actor, "platform", "the pause is the platform's, as every other paused chat records it");
    const data = JSON.parse(rows[0].data);
    assert.equal(data.status, "paused_stop");
    assert.equal(data.reason, "emergency_stop", "the entry names why the chat stopped");
    assert.equal(data.turn_count, 0);
    assert.equal(JSON.parse(rows[0].owners).length, 2, "both owners see the entry");

    for (const bot of [A.bot, B.bot]) {
      const ev = pausedEvents(s, bot.id, cid);
      assert.equal(ev.length, 1, `${bot.id === A.bot.id ? "the frozen" : "the peer"} Bot hears the pause of ${cid}`);
      assert.deepEqual(ev[0], { conversation_id: cid, status: "paused_stop", reason: "emergency_stop", trust: "platform" });
    }
  }

  // The stop's own audit row keeps its shape: no new action name, still an empty body.
  const stopRows = stopRow(s, A.bot.id);
  assert.equal(stopRows.length, 1);
  assert.equal(stopRows[0].actor, `owner:${A.owner_id}`);
  assert.deepEqual(JSON.parse(stopRows[0].data), {});

  // The peer's Bot keeps its token, so the pause is what refuses it -- and now it was told why.
  let refusal: any = null;
  try { await B.bot.draftMessage(conv2, { text: "still there?" }); } catch (e: any) { refusal = e; }
  assert.equal(refusal?.status, 409);
  assert.equal(refusal?.code, "conversation_paused");
});

test("a repeated stop does not announce the same pause twice", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const cid = (await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "stop me twice" })).conversation_id;

  await A.owner.req("POST", "/v1/emergency-stop", { bot_id: A.bot.id });
  const first = { audit: pausedAudit(s, cid).length, a: pausedEvents(s, A.bot.id, cid).length, b: pausedEvents(s, B.bot.id, cid).length };
  assert.deepEqual(first, { audit: 1, a: 1, b: 1 });

  const again: any = await A.owner.req("POST", "/v1/emergency-stop", { bot_id: A.bot.id });
  assert.equal(again.status, "frozen");
  assert.equal(await convStatus(A.owner, cid), "paused_stop");
  // `paused_stop` to `paused_stop` is not a new pause: no second entry, no second event.
  assert.deepEqual(
    { audit: pausedAudit(s, cid).length, a: pausedEvents(s, A.bot.id, cid).length, b: pausedEvents(s, B.bot.id, cid).length },
    { audit: 1, a: 1, b: 1 },
  );
});

test("a chat paused for another reason is moved and announced once", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const cid = (await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "already paused" })).conversation_id;
  s.platform.db.prepare("UPDATE conversations SET status = 'paused_loop', updated_at = ? WHERE id = ?").run(new Date().toISOString(), cid);

  await A.owner.req("POST", "/v1/emergency-stop", { bot_id: A.bot.id });

  assert.equal(await convStatus(A.owner, cid), "paused_stop");
  const rows = pausedAudit(s, cid);
  assert.equal(rows.length, 1, "the reason changed, so the pause is recorded once");
  assert.equal(JSON.parse(rows[0].data).reason, "emergency_stop");
  for (const bot of [A.bot, B.bot]) assert.equal(pausedEvents(s, bot.id, cid).length, 1);
});

test("a closed chat is left alone by the stop", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const cid = (await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "already closed" })).conversation_id;
  assert.equal(((await A.owner.req("POST", `/v1/conversations/${cid}/close`, { outcome: "abandoned" })) as any).status, "closed");
  assert.equal(await convStatus(A.owner, cid), "closed");

  await A.owner.req("POST", "/v1/emergency-stop", { bot_id: A.bot.id });

  assert.equal(await convStatus(A.owner, cid), "closed");
  assert.equal(pausedAudit(s, cid).length, 0);
  for (const bot of [A.bot, B.bot]) assert.equal(pausedEvents(s, bot.id, cid).length, 0);
});
