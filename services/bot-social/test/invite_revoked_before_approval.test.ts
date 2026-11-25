import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { expectApiError, ownerWithBot, startServer } from "./helpers.js";

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(); });
after(async () => { await S.stop(); });

const stored = (id: string) => (S.platform.db.prepare("SELECT status, uses FROM invites WHERE id = ?").get(id) as any);
const inList = async (owner: any, id: string) => ((await owner.req("GET", "/v1/invites")).invites as any[]).find((i) => i.invite_id === id);
const cardOf = async (owner: any, id: string) => ((await owner.req("GET", "/v1/approvals?status=all")).approvals as any[]).find((a) => a.approval_id === id);
const relCount = (botId: string) => (S.platform.db.prepare("SELECT COUNT(*) AS c FROM relationships WHERE requester_bot = ? OR target_bot = ?").get(botId, botId) as any).c;

async function botInvite(A: any) {
  const inv: any = await A.bot.signed("/v1/invites", "invite.create", { offered_capabilities: ["chat.public"] });
  assert.equal(inv.status, "pending_owner");
  assert.ok(inv.approval_id, "a Bot-created invite carries its owner approval");
  return inv;
}

describe("a revoked Bot-created invite is not reopened by its still-pending approval card", () => {
  test("(a) revoke then approve: the decision is refused, the link stays dead, and the join writes nothing", async () => {
    const A = await ownerWithBot(S.base, "qra"); const B = await ownerWithBot(S.base, "qrb");
    const inv = await botInvite(A);
    await A.owner.req("DELETE", `/v1/invites/${inv.invite_id}`);
    assert.equal(stored(inv.invite_id).status, "revoked");

    // The owner's approval decision arrives after the revoke (stale card, another tab, or a retry).
    await expectApiError(A.owner.req("POST", `/v1/approvals/${inv.approval_id}/decision`, { decision: "approved" }), 409, "invalid_state");

    assert.equal(stored(inv.invite_id).status, "revoked", "the stored row is the witness: a refusal must not write 'active'");
    assert.equal((await inList(A.owner, inv.invite_id)).status, "revoked", "owner invite list");
    const pub: any = await (await fetch(`${S.base}/v1/invites/${inv.code}`)).json();
    assert.equal(pub.status, "revoked", "public invite preview");

    const err: any = await expectApiError(B.owner.req("POST", `/v1/invites/${inv.code}/join`, { from_bot_id: B.bot.id }), 410, "invite_unavailable");
    assert.equal(err.body?.error?.invite_status, "revoked");
    assert.equal(relCount(B.bot.id), 0, "a refused join leaves no relationship behind");
    assert.equal(stored(inv.invite_id).uses, 0, "a refused join spends no use");
  });

  test("(b) revoking the link settles its card instead of leaving a pending card that can only be refused", async () => {
    const A = await ownerWithBot(S.base, "qrc");
    const inv = await botInvite(A);
    await A.owner.req("DELETE", `/v1/invites/${inv.invite_id}`);

    const pending = ((await A.owner.req("GET", "/v1/approvals?status=pending")).approvals as any[]).map((a) => a.approval_id);
    assert.ok(!pending.includes(inv.approval_id), "a card whose subject was revoked is not offered as pending");
    const c = await cardOf(A.owner, inv.approval_id);
    assert.equal(c.status, "cancelled");
    assert.match(String(c.decision), /revok/i, "the record says why it can no longer be approved");
  });

  test("(c) control: a live Bot-created invite still turns active on approval and joins", async () => {
    const A = await ownerWithBot(S.base, "qrd"); const B = await ownerWithBot(S.base, "qre");
    const inv = await botInvite(A);
    await A.owner.req("POST", `/v1/approvals/${inv.approval_id}/decision`, { decision: "approved" });
    assert.equal((await inList(A.owner, inv.invite_id)).status, "active");
    const j: any = await B.owner.req("POST", `/v1/invites/${inv.code}/join`, { from_bot_id: B.bot.id });
    assert.equal(j.status, "active");
    assert.equal(relCount(B.bot.id), 1);
  });
});
