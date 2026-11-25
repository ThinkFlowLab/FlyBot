import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { bulkAuth, friends, startServer } from "./helpers.js";

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(bulkAuth); });
after(async () => { await S.stop(); });

const intent = () => ({ type: "schedule_meeting", summary: "sync", params: {} });

/** The chat's own clock ran out but nothing has touched it yet: the row is still whatever `status` says. */
const lapse = (cid: string, status = "open") => S.platform.db.prepare(
  "UPDATE conversations SET status = ?, outcome = NULL, expires_at = ?, updated_at = ? WHERE id = ?",
).run(status, new Date(Date.now() - 5 * 60e3).toISOString(), new Date().toISOString(), cid);

/** A chat whose clock has not run out, parked in the given state. */
const parkUntilLater = (cid: string, status: string) => S.platform.db.prepare(
  "UPDATE conversations SET status = ?, outcome = NULL, expires_at = ? WHERE id = ?",
).run(status, new Date(Date.now() + 3600e3).toISOString(), cid);

const row = (cid: string) => S.platform.db.prepare("SELECT status, outcome FROM conversations WHERE id = ?").get(cid) as any;
const auditCount = (cid: string, action: string) => (S.platform.audit.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE subject = ? AND action = ?").get(cid, action) as any).n as number;
const resumedEvents = async (bot: any, cid: string) => (await bot.events()).events.filter((e: any) => e.event_type === "conversation.resumed" && e.conversation_id === cid);

describe("a chat whose 72-hour clock ran out reads as closed everywhere, and extend does not revive it", () => {
  test("(1) the list reports closed/expired and after reading, the row is still untouched", async () => {
    const { A, B } = await friends(S.base);
    const cid = (await A.bot.startConversation(B.bot.id, intent())).conversation_id as string;
    lapse(cid);

    const list: any = await A.owner.req("GET", "/v1/conversations");
    const listed = list.conversations.find((c: any) => c.conversation_id === cid);
    assert.equal(listed.status, "closed", "a lapsed chat is not open on the list");
    assert.equal(listed.outcome, "expired");
    assert.equal("expires_at" in listed, false, "the list response gains no new field");

    const after = row(cid);
    assert.equal(after.status, "open", "the read is computed, not written: GET leaves the row alone");
    assert.equal(after.outcome, null);
  });

  test("(2) the conversation view reports the same state to both sides", async () => {
    const { A, B } = await friends(S.base);
    const cid = (await A.bot.startConversation(B.bot.id, intent())).conversation_id as string;
    lapse(cid);

    const asOwner: any = await A.owner.req("GET", `/v1/conversations/${cid}`);
    assert.equal(asOwner.status, "closed");
    assert.equal(asOwner.outcome, "expired");

    const asBot: any = await A.bot.getConversation(cid);
    assert.equal(asBot.status, "closed", "the bot's own view agrees with the owner's");
    assert.equal(asBot.outcome, "expired");
    assert.equal(row(cid).status, "open", "and neither read wrote the row");
  });

  test("(3) the friends overview reports the lapsed chat as the closed last conversation", async () => {
    const { A, B, relId } = await friends(S.base);
    const cid = (await A.bot.startConversation(B.bot.id, intent())).conversation_id as string;
    lapse(cid);

    const ov: any = await A.owner.req("GET", `/v1/friends-overview?bot_id=${A.bot.id}`);
    const item = ov.friends.find((f: any) => f.relationship_id === relId);
    assert.ok(item, "the friendship is on the overview");
    assert.equal(item.last_conversation.conversation_id, cid);
    assert.equal(item.last_conversation.status, "closed", "a console must not show a lapsed chat as Active");
    assert.equal(item.last_conversation.outcome, "expired");
    assert.equal(row(cid).status, "open", "the overview is a read: it writes nothing");
  });

  test("(4) extend on a lapsed chat is refused as a closed chat, and announces nothing", async () => {
    const { A, B } = await friends(S.base);
    const cid = (await A.bot.startConversation(B.bot.id, intent())).conversation_id as string;
    lapse(cid);

    let err: any = null;
    try { await A.owner.req("POST", `/v1/conversations/${cid}/extend`, {}); } catch (e: any) { err = e; }
    assert.ok(err, "extending a lapsed chat must not answer 200");
    assert.equal(err.status, 409);
    assert.equal(err.code, "invalid_state", "the same code a closed chat already gives");
    assert.match(String(err.message), /conversation is closed \(expired\)/, "and it says why");

    assert.equal((await resumedEvents(A.bot, cid)).length, 0, "the owner is not told the chat resumed");
    assert.equal((await resumedEvents(B.bot, cid)).length, 0, "nor is the peer");
    assert.equal(auditCount(cid, "conversation.extended"), 0, "and no extend is written to the audit");
    const persisted = row(cid);
    assert.equal(persisted.status, "closed", "the refused POST may settle the row it touched");
    assert.equal(persisted.outcome, "expired");
  });

  test("(5) control: a message drafted into a lapsed chat is still refused, and the view then agrees", async () => {
    const { A, B } = await friends(S.base);
    const cid = (await A.bot.startConversation(B.bot.id, intent())).conversation_id as string;
    lapse(cid);

    let err: any = null;
    try { await A.bot.draftMessage(cid, { text: "are you there" }); } catch (e: any) { err = e; }
    assert.equal(err?.status, 409);
    assert.equal(err?.code, "conversation_closed", "the write path keeps its own refusal");

    const view: any = await A.bot.getConversation(cid);
    assert.equal(view.status, "closed");
    assert.equal(view.outcome, "expired");
  });

  test("(6) control: a live chat still extends, from open and from every paused state", async () => {
    const { A, B } = await friends(S.base);
    for (const status of ["open", "awaiting_approval", "paused_limit", "paused_loop", "paused_stop"]) {
      const cid = (await A.bot.startConversation(B.bot.id, intent())).conversation_id as string;
      parkUntilLater(cid, status);
      const before = auditCount(cid, "conversation.extended");

      const out: any = await A.owner.req("POST", `/v1/conversations/${cid}/extend`, {});
      assert.equal(out.conversation_id, cid);
      assert.equal(out.status, "open", `${status} still resumes to open`);
      assert.notEqual(row(cid).status, "closed", `${status} must not be closed by an extend`);
      assert.equal(auditCount(cid, "conversation.extended"), before + 1, `${status} still writes the extend`);
      assert.equal((await resumedEvents(A.bot, cid)).length, 1, `${status} still announces the resume`);
    }
  });
});
