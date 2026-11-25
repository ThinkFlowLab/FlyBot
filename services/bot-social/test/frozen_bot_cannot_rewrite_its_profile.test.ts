/**
 * A Bot's profile is its outward face: the relationship card other homes read carries the display name, the look
 * and the one-line description, and a waiting room renders the look from the Bot's live row. Writing them is
 * therefore that Bot's outward act even though its owner types it — the same question the room line door already
 * answers. The profile door was the one write that still answered 200, wrote the row and audited a successful
 * `bot.profile_updated` while the identity was frozen, so a stopped Bot's owner could put new words in front of
 * every peer while the same Bot could not write a line.
 *
 * The guard belongs after the request has been validated and before the transaction that writes name, card and
 * look together: a stopped identity is refused for all four fields, and clearing a field is a write as well. The
 * door keeps its own order — a body with no field or an over-long card still answers its 400 first. The pre-freeze
 * words stay on the peer's card until the owner resumes the Bot.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { friends, ownerWithBot, startServer } from "./helpers.js";

async function req(base: string, method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}

type S = Awaited<ReturnType<typeof startServer>>;
type Who = Awaited<ReturnType<typeof ownerWithBot>>;

const patchProfile = (s: S, who: Who, body: Record<string, unknown>) => req(s.base, "PATCH", `/v1/bots/${who.bot.id}/profile`, who.owner.token, body);
const stopBot = (s: S, who: Who) => req(s.base, "POST", "/v1/emergency-stop", who.owner.token, { bot_id: who.bot.id });
const resumeBot = (s: S, who: Who) => req(s.base, "POST", `/v1/bots/${who.bot.id}/resume`, who.owner.token, {});

/** The four columns the profile door writes, read straight from the row. */
function row(s: S, who: Who) {
  return s.platform.db.prepare("SELECT status, display_name, description, avatar, color FROM bots WHERE id = ?").get(who.bot.id) as any;
}
function profileAudits(s: S, who: Who) {
  return (s.platform.audit.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'bot.profile_updated' AND subject = ?").get(who.bot.id) as any).n as number;
}
/** What the other side reads on its relationship card: the Bot as `botCard`, description included. */
async function peerCard(viewer: Who, peer: Who) {
  const listed = await viewer.owner.req("GET", "/v1/relationships");
  const rel = listed.relationships.find((r: any) => r.peer?.bot_id === peer.bot.id);
  assert.ok(rel, "the two homes stay in a relationship");
  return rel.peer;
}

/** Two owners in an accepted relationship: the shorter chain to the peer's own card, no room needed. */
async function pair(t: any) {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  return { s, A, B };
}

const BEFORE = { display_name: "Desk", description: "CARD BEFORE THE STOP", avatar: "star", color: "#112233" };

test("a stopped Bot cannot rewrite the profile its peer reads", async (t) => {
  const { s, A, B } = await pair(t);
  assert.equal((await patchProfile(s, A, BEFORE)).status, 200);
  assert.equal((await stopBot(s, A)).body.status, "frozen");
  const auditsBefore = profileAudits(s, A);

  const refused: any = await patchProfile(s, A, { display_name: "Frozen Desk", description: "FROZEN WORDS IN THE ROSTER", avatar: "moon", color: "#ff0000" });
  assert.equal(refused.status, 403, "a stopped identity is not answered with a rewritten card");
  assert.equal(refused.body.error?.code, "bot_frozen", "the refusal names the stop");

  const after = row(s, A);
  assert.equal(after.status, "frozen");
  assert.equal(after.display_name, BEFORE.display_name, "the name every peer reads is untouched");
  assert.equal(after.description, BEFORE.description, "the one-line card is untouched");
  assert.equal(after.avatar, BEFORE.avatar, "the look is untouched");
  assert.equal(after.color, BEFORE.color);
  assert.equal(profileAudits(s, A), auditsBefore, "no successful profile audit entry is written for a refused write");

  const seen: any = await peerCard(B, A);
  assert.equal(seen.description, BEFORE.description, "the peer still reads the words from before the stop");
  assert.equal(seen.display_name, BEFORE.display_name);

  // The frozen home already disappears from the active-only remote list; that reader is not part of this fix and
  // must keep its own answer.
  const remote = await B.owner.req("GET", "/v1/remote-bots");
  assert.equal(remote.bots.some((b: any) => b.bot_id === A.bot.id), false);
});

test("clearing a field is a write too, so it is refused while stopped", async (t) => {
  const { s, A, B } = await pair(t);
  assert.equal((await patchProfile(s, A, BEFORE)).status, 200);
  assert.equal((await stopBot(s, A)).body.status, "frozen");
  const auditsBefore = profileAudits(s, A);

  // The door keeps its order: the request is still validated before the stop is named, exactly as on an active Bot.
  assert.equal((await patchProfile(s, A, {})).status, 400, "a body with no field is still the same 400");
  const over: any = await patchProfile(s, A, { description: "z".repeat(281) });
  assert.equal(over.status, 400, "an over-long card is still the same 400");
  assert.equal(over.body.error?.code, "invalid_description");

  for (const body of [{ description: null }, { description: "   " }, { avatar: null, color: null }]) {
    const refused: any = await patchProfile(s, A, body);
    assert.equal(refused.status, 403, JSON.stringify(body));
    assert.equal(refused.body.error?.code, "bot_frozen");
  }
  const after = row(s, A);
  assert.equal(after.description, BEFORE.description, "the card a peer already read is not wiped");
  assert.equal(after.avatar, BEFORE.avatar);
  assert.equal(after.color, BEFORE.color);
  assert.equal(profileAudits(s, A), auditsBefore);
  assert.equal((await peerCard(B, A)).description, BEFORE.description);
});

test("resuming the Bot reopens the same door", async (t) => {
  const { s, A } = await pair(t);
  assert.equal((await patchProfile(s, A, BEFORE)).status, 200);
  assert.equal((await stopBot(s, A)).body.status, "frozen");
  assert.equal((await patchProfile(s, A, { description: "NOT YET" })).status, 403, "still stopped");
  assert.equal(row(s, A).description, BEFORE.description);

  assert.equal((await resumeBot(s, A)).body.status, "active");
  const auditsBefore = profileAudits(s, A);
  const allowed: any = await patchProfile(s, A, { description: "AFTER THE RESUME", display_name: "Back Desk" });
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  assert.equal(allowed.body.description, "AFTER THE RESUME");
  const after = row(s, A);
  assert.equal(after.description, "AFTER THE RESUME");
  assert.equal(after.display_name, "Back Desk");
  assert.equal(profileAudits(s, A), auditsBefore + 1, "the door audits its writes again");
});

test("control: an active Bot still edits every profile field, and the peer reads it", async (t) => {
  const { s, A, B } = await pair(t);
  const auditsBefore = profileAudits(s, A);
  const put: any = await patchProfile(s, A, { display_name: "Active Desk", description: "OPEN CARD", avatar: "moon", color: "#ff8800" });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const after = row(s, A);
  assert.equal(after.status, "active");
  assert.equal(after.display_name, "Active Desk");
  assert.equal(after.description, "OPEN CARD");
  assert.equal(after.avatar, "moon");
  assert.equal(after.color, "#ff8800");
  assert.equal(profileAudits(s, A), auditsBefore + 1, "an active write is audited exactly once");
  const seen: any = await peerCard(B, A);
  assert.equal(seen.description, "OPEN CARD", "an active edit reaches the peer, which is what the refusal protects");

  // The unknown-Bot answer keeps its own order: 404 for a Bot that does not exist, 403 only for one that is not
  // active. Both are pins on the guard's position, not new behaviour.
  const missing = await req(s.base, "PATCH", "/v1/bots/bot_does_not_exist/profile", A.owner.token, { description: "x" });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error?.code, "bot_not_found");
});

test("control: a stopped Bot's sibling is unaffected", async (t) => {
  const { s, A } = await pair(t);
  const sibling = await A.owner.req("POST", "/v1/bots", { handle: A.handle.replace(/^@/, "").replace(/\.bot$/, "") + "-two.bot", display_name: "Second" });
  assert.equal((await stopBot(s, A)).body.status, "frozen");

  const ok = await req(s.base, "PATCH", `/v1/bots/${sibling.bot_id}/profile`, A.owner.token, { description: "SIBLING CARD" });
  assert.equal(ok.status, 200, "the guard reads the status of the Bot being written, not the owner's other Bots");
  assert.equal((s.platform.db.prepare("SELECT description FROM bots WHERE id = ?").get(sibling.bot_id) as any).description, "SIBLING CARD");
  assert.equal(row(s, A).description, null, "the stopped Bot's own row is still untouched");
});

test("a removed identity is refused by name", async (t) => {
  const { s, A } = await pair(t);
  assert.equal((await patchProfile(s, A, BEFORE)).status, 200);
  const auditsBefore = profileAudits(s, A);
  // A removed home member is `revoked`; the row keeps its seat on older builds, so the door must name the removal
  // instead of treating the identity as an editable one.
  s.platform.db.prepare("UPDATE bots SET status = 'revoked' WHERE id = ?").run(A.bot.id);

  const refused: any = await patchProfile(s, A, { description: "REVOKED WORDS", display_name: "Gone Desk" });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error?.code, "bot_revoked", "the refusal names the removal");
  const after = row(s, A);
  assert.equal(after.status, "revoked");
  assert.equal(after.description, BEFORE.description);
  assert.equal(after.display_name, BEFORE.display_name);
  assert.equal(profileAudits(s, A), auditsBefore);
});
