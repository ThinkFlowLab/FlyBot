/**
 * A chat's closing summary is peer content: the close door writes it onto the row and sends it to both Bots inside
 * `conversation.closed`'s `untrusted_content` — so a stopped (`frozen`) or removed (`revoked`) Bot must not write
 * one. The door names no Bot; the one it speaks for is the Bot of this chat that belongs to the closing owner.
 *
 * The two control tests below are the behaviour that must survive the guard: the peer of a stopped Bot still ends
 * the chat (the stop pauses it, it does not strand it), and the same owner's other, healthy Bot in another chat
 * still closes with a summary.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { OwnerClient } from "../src/client.js";
import { expectApiError, friends, ownerWithBot, startServer } from "./helpers.js";

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(); });
after(async () => { await S.stop(); });

const row = (cid: string) =>
  S.platform.db.prepare("SELECT status, outcome, summary FROM conversations WHERE id = ?").get(cid) as any;
const maxSeq = (botId: string) =>
  (S.platform.db.prepare("SELECT COALESCE(MAX(seq), 0) m FROM events WHERE bot_id = ?").get(botId) as any).m as number;
const closedEvents = (botId: string, since: number) =>
  (S.platform.db.prepare("SELECT seq, type, data FROM events WHERE bot_id = ? AND seq > ? ORDER BY seq").all(botId, since) as any[])
    .filter((r) => r.type === "conversation.closed")
    .map((r) => ({ seq: r.seq as number, ...JSON.parse(r.data) }));

/** An owner who owns a FlyBot home, with the web session token the console's close door uses. */
async function homeOwner(name: string) {
  const a = S.platform.onboardFlybot({ display_name: name });
  const r = await fetch(`${S.base}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: a.username, password: a.generated_password }),
  });
  assert.equal(r.status, 200, "the onboarded owner can log in");
  const { owner_token } = await r.json() as any;
  return { ownerId: a.owner_id, homeId: a.home.bot_id as string, owner: new OwnerClient(S.base, owner_token) };
}

test("the owner of a frozen Bot cannot write the chat's closing summary", async () => {
  const { A, B } = await friends(S.base);
  const conv = await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "before the stop" });
  const cid = conv.conversation_id as string;

  await A.owner.req("POST", "/v1/emergency-stop", { bot_id: A.bot.id });
  assert.equal(row(cid).status, "paused_stop", "the stop pauses the chat instead of closing it");
  const aSeq = maxSeq(A.bot.id);
  const bSeq = maxSeq(B.bot.id);

  await expectApiError(
    A.owner.req("POST", `/v1/conversations/${cid}/close`, { outcome: "agreed", summary: "a line written after the stop" }),
    403, "bot_frozen");

  assert.deepEqual(row(cid), { status: "paused_stop", outcome: null, summary: null }, "the refused close writes nothing");
  assert.equal(maxSeq(A.bot.id), aSeq, "the stopped Bot's own queue is untouched");
  assert.equal(maxSeq(B.bot.id), bSeq, "the peer is told nothing");
  assert.equal(closedEvents(B.bot.id, bSeq).length, 0, "no conversation.closed reaches the peer");
  const bView = await B.owner.req("GET", `/v1/conversations/${cid}`);
  assert.equal(bView.summary ?? null, null, "the peer's console still reads no summary");
  const aView = await A.owner.req("GET", `/v1/conversations/${cid}`);
  assert.equal(aView.summary ?? null, null, "the stopped Bot's owner reads no summary either");
});

test("the owner of a removed Bot cannot write it either", async () => {
  const { ownerId, homeId, owner } = await homeOwner("RemovedClose");
  const member = S.platform.addHomeMember({ kind: "owner", ownerId }, homeId, { name: "writer", display_name: "Writer" });
  const B = await ownerWithBot(S.base, "removedclosepeer");
  const req = S.platform.requestRelationship({ kind: "owner", ownerId },
    { from_bot_id: member.bot_id, target_handle: B.handle, message: "hi", requested_capabilities: ["chat.public"] });
  S.platform.consent({ kind: "owner", ownerId: B.owner_id }, req.relationship_id, { decision: "accept", grant_capabilities: [] });
  const sent = await owner.req("POST", `/v1/homes/${homeId}/send`, { from_bot_id: member.bot_id, to: B.bot.id, text: "one line" });
  const cid = sent.conversation_id as string;
  S.platform.removeHomeMember({ kind: "owner", ownerId }, homeId, member.bot_id);
  assert.equal(S.platform.bot(member.bot_id).status, "revoked");
  const before = row(cid);
  const bSeq = maxSeq(B.bot.id);

  await expectApiError(
    owner.req("POST", `/v1/conversations/${cid}/close`, { outcome: "abandoned", summary: "a line written after the removal" }),
    403, "bot_revoked");

  assert.deepEqual(row(cid), before, "the refused close writes nothing");
  assert.equal(maxSeq(B.bot.id), bSeq, "the peer is told nothing");
  assert.equal(closedEvents(B.bot.id, bSeq).length, 0, "no conversation.closed reaches the peer");
  const bView = await B.owner.req("GET", `/v1/conversations/${cid}`);
  assert.equal(bView.summary ?? null, null, "the peer's console still reads no summary");
});

test("control: the healthy peer still ends the paused chat and its summary is what the stopped side reads", async () => {
  const { A, B } = await friends(S.base);
  const conv = await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "before the stop" });
  const cid = conv.conversation_id as string;
  await A.owner.req("POST", "/v1/emergency-stop", { bot_id: A.bot.id });
  assert.equal(row(cid).status, "paused_stop");
  const aSeq = maxSeq(A.bot.id);
  const bSeq = maxSeq(B.bot.id);
  const summary = "the peer ends the chat while the other Bot is stopped";

  const closed = await B.owner.req("POST", `/v1/conversations/${cid}/close`, { outcome: "agreed", summary });
  assert.equal(closed.status, "closed");
  assert.equal(closed.outcome, "agreed");
  assert.deepEqual(row(cid), { status: "closed", outcome: "agreed", summary }, "the peer's close still lands");

  const aTold = closedEvents(A.bot.id, aSeq);
  const bTold = closedEvents(B.bot.id, bSeq);
  assert.equal(aTold.length, 1, "the stopped Bot's queue gets one conversation.closed");
  assert.equal(bTold.length, 1, "the closing side gets one too");
  for (const e of [...aTold, ...bTold]) {
    assert.equal(e.outcome, "agreed");
    assert.equal(e.trust, "peer_untrusted");
    assert.equal(e.untrusted_content?.summary, summary, "the peer's summary travels as peer content");
  }
  const aView = await A.owner.req("GET", `/v1/conversations/${cid}`);
  assert.equal(aView.status, "closed");
  assert.equal(aView.summary, summary, "the stopped side's console reads the peer's text");
});

test("control: the same owner's other, healthy Bot still closes its own chat with a summary", async () => {
  const { ownerId, homeId, owner } = await homeOwner("HealthyClose");
  const healthy = S.platform.addHomeMember({ kind: "owner", ownerId }, homeId, { name: "healthy", display_name: "Healthy" });
  const B = await ownerWithBot(S.base, "healthyclosepeer");
  const rel = S.platform.requestRelationship({ kind: "owner", ownerId },
    { from_bot_id: healthy.bot_id, target_handle: B.handle, message: "hi", requested_capabilities: ["chat.public"] });
  S.platform.consent({ kind: "owner", ownerId: B.owner_id }, rel.relationship_id, { decision: "accept", grant_capabilities: [] });
  const conv = await owner.req("POST", `/v1/homes/${homeId}/send`, { from_bot_id: healthy.bot_id, to: B.bot.id, text: "hello" });
  const cid = conv.conversation_id as string;
  const summary = "the owner's healthy Bot closes its own chat";

  const closed = await owner.req("POST", `/v1/conversations/${cid}/close`, { outcome: "declined", summary });
  assert.equal(closed.status, "closed");
  assert.deepEqual(row(cid), { status: "closed", outcome: "declined", summary }, "the healthy Bot's close is not blocked");
});
