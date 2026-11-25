/**
 * `extend` is the door that turns a paused chat back into a running one, and it tells both Bots `conversation.resumed`
 * under `trust: "platform"` — the platform saying the pair may talk again. So a stopped (`frozen`) or removed
 * (`revoked`) Bot must not pull its own paused chat back into service through its owner: the stop holds the pair
 * paused, and only `resumeBot` (or re-adding a removed member) lets the owner extend again.
 *
 * The door names no Bot, so the one it speaks for is the chat's Bot that belongs to the calling owner. A self-chat
 * (both Bots this owner's) is let through: with no single speaker there is nothing to gate, and its resume reaches
 * only this owner's own Bots and console.
 *
 * The control tests below are the behaviour that must survive the guard: a healthy peer still extends the shared
 * paused chat, the same owner's other healthy Bot still extends its own chat, and after `resumeBot` the stopped side
 * extends its chat again.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { OwnerClient } from "../src/client.js";
import { approveAll, bulkAuth, expectApiError, ownerWithBot, startServer } from "./helpers.js";

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(bulkAuth); });
after(async () => { await S.stop(); });

const row = (cid: string) =>
  S.platform.db.prepare("SELECT status, outcome, summary, expires_at FROM conversations WHERE id = ?").get(cid) as any;
const maxSeq = (botId: string) =>
  (S.platform.db.prepare("SELECT COALESCE(MAX(seq), 0) m FROM events WHERE bot_id = ?").get(botId) as any).m as number;
const resumedEvents = (botId: string, since: number) =>
  (S.platform.db.prepare("SELECT seq, type, data FROM events WHERE bot_id = ? AND seq > ? ORDER BY seq").all(botId, since) as any[])
    .filter((r) => r.type === "conversation.resumed")
    .map((r) => ({ seq: r.seq as number, ...JSON.parse(r.data) }));
const extendAudits = (cid: string) =>
  (S.platform.audit.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE subject = ? AND action = ?").get(cid, "conversation.extended") as any).n as number;

/** An owner who owns a FlyBot home, with the web session token the console's extend door uses. */
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

/** A home member with one live chat with a fresh peer: the shape the console's extend door works on. */
async function chatWithPeer(ownerId: string, homeId: string, owner: OwnerClient, memberName: string, peerName: string) {
  const member = S.platform.addHomeMember({ kind: "owner", ownerId }, homeId, { name: memberName, display_name: memberName });
  const peer = await ownerWithBot(S.base, peerName);
  const rel = S.platform.requestRelationship({ kind: "owner", ownerId },
    { from_bot_id: member.bot_id, target_handle: peer.handle, message: "hi", requested_capabilities: ["chat.public"] });
  S.platform.consent({ kind: "owner", ownerId: peer.owner_id }, rel.relationship_id, { decision: "accept", grant_capabilities: [] });
  const sent = await owner.req("POST", `/v1/homes/${homeId}/send`, { from_bot_id: member.bot_id, to: peer.bot.id, text: "before the stop" });
  // The console's line waits for the owner's approval; settle it so every fixture starts from a chat that is truly open.
  await approveAll(owner);
  return { member, peer, cid: sent.conversation_id as string };
}

test("the owner of a frozen Bot cannot revive its paused chat", async () => {
  const { ownerId, homeId, owner } = await homeOwner("FrozenExtend");
  const { member, peer, cid } = await chatWithPeer(ownerId, homeId, owner, "stopped", "frozenextendpeer");

  await owner.req("POST", "/v1/emergency-stop", { bot_id: member.bot_id });
  assert.equal(row(cid).status, "paused_stop", "the stop pauses the chat instead of closing it");
  const before = row(cid);
  const memberSeq = maxSeq(member.bot_id);
  const peerSeq = maxSeq(peer.bot.id);
  const audits = extendAudits(cid);

  await expectApiError(owner.req("POST", `/v1/conversations/${cid}/extend`, {}), 403, "bot_frozen");

  assert.deepEqual(row(cid), before, "the refused extend writes nothing: the row keeps its state, outcome, summary and clock");
  assert.equal(maxSeq(member.bot_id), memberSeq, "the stopped Bot's own queue is untouched");
  assert.equal(maxSeq(peer.bot.id), peerSeq, "the peer is told nothing");
  assert.equal(resumedEvents(peer.bot.id, peerSeq).length, 0, "no conversation.resumed reaches the peer");
  assert.equal(extendAudits(cid), audits, "no extend is written to the audit");
  const memberView: any = await owner.req("GET", `/v1/conversations/${cid}`);
  assert.equal(memberView.status, "paused_stop", "the stopped side's console still reads paused");
  const peerView: any = await peer.owner.req("GET", `/v1/conversations/${cid}`);
  assert.equal(peerView.status, "paused_stop", "the peer's console still reads paused");
});

test("the owner of a removed Bot cannot revive its chat", async () => {
  const { ownerId, homeId, owner } = await homeOwner("RemovedExtend");
  const { member, peer, cid } = await chatWithPeer(ownerId, homeId, owner, "removed", "removedextendpeer");

  S.platform.removeHomeMember({ kind: "owner", ownerId }, homeId, member.bot_id);
  assert.equal(S.platform.bot(member.bot_id).status, "revoked");
  const before = row(cid);
  const memberSeq = maxSeq(member.bot_id);
  const peerSeq = maxSeq(peer.bot.id);
  const audits = extendAudits(cid);

  await expectApiError(owner.req("POST", `/v1/conversations/${cid}/extend`, {}), 403, "bot_revoked");

  assert.deepEqual(row(cid), before, "the refused extend writes nothing: the row keeps its state, outcome, summary and clock");
  assert.equal(maxSeq(member.bot_id), memberSeq, "the removed Bot's queue is untouched");
  assert.equal(maxSeq(peer.bot.id), peerSeq, "the peer is told nothing");
  assert.equal(resumedEvents(peer.bot.id, peerSeq).length, 0, "no conversation.resumed reaches the peer");
  assert.equal(extendAudits(cid), audits, "no extend is written to the audit");
  const peerView: any = await peer.owner.req("GET", `/v1/conversations/${cid}`);
  assert.equal(peerView.status, before.status, "the peer's console reads the same state as before the refused extend");
});

test("a stopped Bot's second extend is still refused, and the first refusal left nothing behind", async () => {
  const { ownerId, homeId, owner } = await homeOwner("TwiceExtend");
  const { member, peer, cid } = await chatWithPeer(ownerId, homeId, owner, "twice", "twiceextendpeer");

  await owner.req("POST", "/v1/emergency-stop", { bot_id: member.bot_id });
  const before = row(cid);
  const memberSeq = maxSeq(member.bot_id);
  const peerSeq = maxSeq(peer.bot.id);
  const audits = extendAudits(cid);

  await expectApiError(owner.req("POST", `/v1/conversations/${cid}/extend`, {}), 403, "bot_frozen");
  assert.deepEqual(row(cid), before, "the first refusal writes nothing");
  assert.equal(maxSeq(member.bot_id), memberSeq, "the first refusal announces nothing");
  assert.equal(maxSeq(peer.bot.id), peerSeq, "the first refusal tells the peer nothing");
  assert.equal(extendAudits(cid), audits, "the first refusal writes no audit");

  await expectApiError(owner.req("POST", `/v1/conversations/${cid}/extend`, {}), 403, "bot_frozen");
  assert.deepEqual(row(cid), before, "the second refusal writes nothing either");
  assert.equal(maxSeq(member.bot_id), memberSeq, "and still announces nothing");
  assert.equal(maxSeq(peer.bot.id), peerSeq, "and still tells the peer nothing");
  assert.equal(extendAudits(cid), audits, "and still writes no audit");
});

test("control: the healthy peer still revives the paused chat, and both sides hear the resume", async () => {
  const { ownerId, homeId, owner } = await homeOwner("PeerExtend");
  const { member, peer, cid } = await chatWithPeer(ownerId, homeId, owner, "peerstopped", "peerextendpeer");

  await owner.req("POST", "/v1/emergency-stop", { bot_id: member.bot_id });
  assert.equal(row(cid).status, "paused_stop");
  const memberSeq = maxSeq(member.bot_id);
  const peerSeq = maxSeq(peer.bot.id);
  const audits = extendAudits(cid);

  const out: any = await peer.owner.req("POST", `/v1/conversations/${cid}/extend`, {});
  assert.equal(out.conversation_id, cid);
  assert.equal(out.status, "open", "the peer's owner still resumes the chat");
  assert.equal(row(cid).status, "open", "and the row follows");
  assert.equal(extendAudits(cid), audits + 1, "the peer's extend is written to the audit");
  const memberTold = resumedEvents(member.bot_id, memberSeq);
  const peerTold = resumedEvents(peer.bot.id, peerSeq);
  assert.equal(memberTold.length, 1, "the stopped side hears one resume");
  assert.equal(peerTold.length, 1, "the extending side hears one too");
  for (const e of [...memberTold, ...peerTold]) assert.equal(e.trust, "platform", "the resume is platform-trusted, not peer text");
});

test("control: the same owner's other, healthy Bot still extends its own chat", async () => {
  const { ownerId, homeId, owner } = await homeOwner("HealthySibling");
  const stopped = S.platform.addHomeMember({ kind: "owner", ownerId }, homeId, { name: "siblingstopped", display_name: "Sibling Stopped" });
  const healthy = S.platform.addHomeMember({ kind: "owner", ownerId }, homeId, { name: "siblinghealthy", display_name: "Sibling Healthy" });
  const peer = await ownerWithBot(S.base, "siblingextendpeer");
  const rel = S.platform.requestRelationship({ kind: "owner", ownerId },
    { from_bot_id: healthy.bot_id, target_handle: peer.handle, message: "hi", requested_capabilities: ["chat.public"] });
  S.platform.consent({ kind: "owner", ownerId: peer.owner_id }, rel.relationship_id, { decision: "accept", grant_capabilities: [] });
  const sent = await owner.req("POST", `/v1/homes/${homeId}/send`, { from_bot_id: healthy.bot_id, to: peer.bot.id, text: "hello" });
  await approveAll(owner);
  const cid = sent.conversation_id as string;

  await owner.req("POST", "/v1/emergency-stop", { bot_id: stopped.bot_id });
  const peerSeq = maxSeq(peer.bot.id);
  const out: any = await owner.req("POST", `/v1/conversations/${cid}/extend`, {});
  assert.equal(out.conversation_id, cid);
  assert.equal(out.status, "open", "the healthy sibling's chat is not blocked by the stopped Bot");
  assert.equal(resumedEvents(peer.bot.id, peerSeq).length, 1, "its peer hears one resume");
});

test("control: after resumeBot the stopped side extends its chat again", async () => {
  const { ownerId, homeId, owner } = await homeOwner("ResumedExtend");
  const { member, peer, cid } = await chatWithPeer(ownerId, homeId, owner, "resumable", "resumeextendpeer");

  await owner.req("POST", "/v1/emergency-stop", { bot_id: member.bot_id });
  assert.equal(row(cid).status, "paused_stop", "the chat stays paused while the Bot is stopped");

  const resumed: any = await owner.req("POST", `/v1/bots/${member.bot_id}/resume`);
  assert.equal(resumed.status, "active");
  assert.equal(row(cid).status, "paused_stop", "resumeBot itself does not revive the chat");
  const memberSeq = maxSeq(member.bot_id);
  const peerSeq = maxSeq(peer.bot.id);

  const out: any = await owner.req("POST", `/v1/conversations/${cid}/extend`, {});
  assert.equal(out.status, "open", "the resumed Bot's owner extends the chat");
  assert.equal(row(cid).status, "open");
  assert.equal(resumedEvents(member.bot_id, memberSeq).length, 1, "the resumed side hears one resume");
  assert.equal(resumedEvents(peer.bot.id, peerSeq).length, 1, "the peer hears one too");
});
