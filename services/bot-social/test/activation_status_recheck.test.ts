import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { expectApiError, ownerWithBot, startServer } from "./helpers.js";

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(); });
after(async () => { await S.stop(); });

const activeGrants = (relId: string) => (S.platform.db.prepare("SELECT COUNT(*) n FROM grants WHERE relationship_id = ? AND status = 'active'").get(relId) as any).n as number;
const relStatus = (relId: string) => (S.platform.db.prepare("SELECT status FROM relationships WHERE id = ?").get(relId) as any).status;
const pendingApprovals = async (owner: any) => (await owner.req("GET", "/v1/approvals?status=pending")).approvals as any[];
const decide = (owner: any, approvalId: string, decision = "approved") => owner.req("POST", `/v1/approvals/${approvalId}/decision`, { decision });

/** A bot-side join that is already waiting for its own owner: the residual is that this approval can arrive after
 *  one of the two Bots was stopped. */
async function botJoinPending(name: string) {
  const A = await ownerWithBot(S.base, `${name}a`);
  const B = await ownerWithBot(S.base, `${name}b`);
  const inv = await A.owner.req("POST", "/v1/invites", { bot_id: A.bot.id });
  const j = await B.bot.signed(`/v1/invites/${inv.code}/join`, "invite.join", { code: inv.code });
  assert.equal(j.status, "pending_requester_owner");
  assert.ok((await pendingApprovals(B.owner)).some((a) => a.approval_id === j.approval_id), "the joiner's owner has a pending card");
  return { A, B, relId: j.relationship_id as string, approvalId: j.approval_id as string };
}

describe("P25 residual: an approval that arrives after a stop must not activate the pair", () => {
  test("(a) the inviter frozen after the join: 403, no grant, the card stays pending", async () => {
    const { A, B, relId, approvalId } = await botJoinPending("p25r1");
    await A.owner.req("POST", "/v1/emergency-stop", { bot_id: A.bot.id });
    await expectApiError(decide(B.owner, approvalId), 403, "bot_frozen");
    assert.equal(activeGrants(relId), 0, "no grant is written");
    assert.notEqual(relStatus(relId), "active", "the relationship does not become a friendship");
    assert.ok((await pendingApprovals(B.owner)).some((a) => a.approval_id === approvalId), "the card is still decidable after a resume");
  });

  test("(b) the joiner frozen after the join is refused the same way", async () => {
    const { B, relId, approvalId } = await botJoinPending("p25r2");
    S.platform.db.prepare("UPDATE bots SET status = 'frozen' WHERE id = ?").run(B.bot.id);
    await expectApiError(decide(B.owner, approvalId), 403, "bot_frozen");
    assert.equal(activeGrants(relId), 0);
    assert.notEqual(relStatus(relId), "active");
  });

  test("(c) after a resume the same card can be approved", async () => {
    const { A, B, relId, approvalId } = await botJoinPending("p25r3");
    await A.owner.req("POST", "/v1/emergency-stop", { bot_id: A.bot.id });
    await expectApiError(decide(B.owner, approvalId), 403, "bot_frozen");
    await A.owner.req("POST", `/v1/bots/${A.bot.id}/resume`);
    const done = await decide(B.owner, approvalId);
    assert.equal(done.status, "active");
    assert.ok(activeGrants(relId) > 0, "the resumed pair gets its grants");
  });

  test("(d) the control: both Bots active, the approval still activates with grants", async () => {
    const { B, relId, approvalId } = await botJoinPending("p25r4");
    const done = await decide(B.owner, approvalId);
    assert.equal(done.status, "active");
    assert.ok(activeGrants(relId) > 0);
  });
});
