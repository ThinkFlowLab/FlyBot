import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { ownerWithBot, startServer } from "./helpers.js";

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(); });
after(async () => { await S.stop(); });

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const expireApprovalRow = (approvalId: string) => S.platform.db.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?").run(ago(1000), approvalId);
const expireInviteRow = (inviteId: string) => S.platform.db.prepare("UPDATE invites SET expires_at = ? WHERE id = ?").run(ago(1000), inviteId);
const storedInviteStatus = (inviteId: string) => (S.platform.db.prepare("SELECT status FROM invites WHERE id = ?").get(inviteId) as any)?.status;
const approvalStatus = (approvalId: string) => (S.platform.db.prepare("SELECT status FROM approvals WHERE id = ?").get(approvalId) as any)?.status;
const inviteEvents = async (bot: any) => (await bot.events()).events.filter((e: any) => e.event_type === "approval.decided" && e.kind === "invite");
const inviteInList = async (owner: any, inviteId: string) => ((await owner.req("GET", "/v1/invites")).invites as any[]).find((i) => i.invite_id === inviteId);

async function botInvite(A: any, offered: string[] = ["chat.public"]) {
  const inv: any = await A.bot.signed("/v1/invites", "invite.create", { offered_capabilities: offered });
  assert.equal(inv.status, "pending_owner", "a bot-created invite waits for its owner");
  assert.ok(inv.approval_id);
  return inv;
}

describe("a pending invite approval expires instead of stranding the invite (P11)", () => {
  test("(a) the approval expiring expires the invite in both views, refuses the decision and the join, and tells the Bot once", async () => {
    const A = await ownerWithBot(S.base, "ivx"); const B = await ownerWithBot(S.base, "ivy");
    const inv = await botInvite(A);
    expireApprovalRow(inv.approval_id);

    // Any read of the approval list runs the platform's stale sweep; that sweep is what must reach the invite.
    const cards = (await A.owner.req("GET", "/v1/approvals?status=all")).approvals as any[];
    assert.equal(cards.find((c) => c.approval_id === inv.approval_id).status, "expired");

    // Two views: the owner's invite list and the public preview. The stored row is the third witness.
    assert.equal((await inviteInList(A.owner, inv.invite_id)).status, "expired", "owner invite list");
    const pub: any = await (await fetch(`${S.base}/v1/invites/${inv.code}`)).json();
    assert.equal(pub.status, "expired", "public invite preview");
    assert.equal(storedInviteStatus(inv.invite_id), "expired", "invites.status is swept too, not only the read-side rendering");

    // No decision is possible any more, and the joining side is told expired rather than pending_owner.
    await assert.rejects(A.owner.req("POST", `/v1/approvals/${inv.approval_id}/decision`, { decision: "approved" }),
      (e: any) => e.status === 409 && e.code === "invalid_state" && /expired/.test(e.message));
    await assert.rejects(B.bot.signed(`/v1/invites/${inv.code}/join`, "invite.join", { code: inv.code }),
      (e: any) => e.status === 410 && e.code === "invite_unavailable" && e.body?.error?.invite_status === "expired");

    // The Bot that created it learns the outcome exactly once.
    const evs = await inviteEvents(A.bot);
    assert.equal(evs.length, 1, "one approval.decided carries the expiry");
    assert.equal(evs[0].decision, "expired");
    assert.equal(evs[0].invite_id, inv.invite_id);
    assert.equal(evs[0].approval_id, inv.approval_id);

    // Idempotent: another sweep, and even the invite's own 72h passing, changes nothing and emits nothing more.
    expireInviteRow(inv.invite_id);
    await A.owner.req("GET", "/v1/approvals?status=all");
    await A.owner.req("GET", "/v1/invites");
    assert.equal((await inviteInList(A.owner, inv.invite_id)).status, "expired");
    assert.equal((await inviteEvents(A.bot)).length, 1, "no duplicate expiry event");
    assert.equal(approvalStatus(inv.approval_id), "expired");
  });

  test("(b) a stuck pending_owner invite past its own expires_at reads expired even before any approval sweep", async () => {
    const A = await ownerWithBot(S.base, "ivz");
    const inv = await botInvite(A);
    expireInviteRow(inv.invite_id);
    // Nothing has swept approvals here: the invite row still says pending_owner, its own clock says expired.
    assert.equal(storedInviteStatus(inv.invite_id), "pending_owner");
    assert.equal((await inviteInList(A.owner, inv.invite_id)).status, "expired");
    const pub: any = await (await fetch(`${S.base}/v1/invites/${inv.code}`)).json();
    assert.equal(pub.status, "expired");
  });

  test("(c) revoked, rejected and used are not reopened by the clock, and live invites stay active and approvable", async () => {
    const A = await ownerWithBot(S.base, "iwa"); const B = await ownerWithBot(S.base, "iwb"); const C = await ownerWithBot(S.base, "iwc");

    // revoked: approved, then revoked, then its own clock passes — still revoked.
    const rv = await botInvite(A);
    await A.owner.req("POST", `/v1/approvals/${rv.approval_id}/decision`, { decision: "approved" });
    await A.owner.req("DELETE", `/v1/invites/${rv.invite_id}`);
    expireInviteRow(rv.invite_id);
    assert.equal((await inviteInList(A.owner, rv.invite_id)).status, "revoked");

    // rejected: the owner says no, then the clock passes — still rejected.
    const rj = await botInvite(A);
    await A.owner.req("POST", `/v1/approvals/${rj.approval_id}/decision`, { decision: "rejected" });
    expireInviteRow(rj.invite_id);
    assert.equal((await inviteInList(A.owner, rj.invite_id)).status, "rejected");

    // used: a 1-use owner invite, consumed, still reads used while its clock is valid.
    const us: any = await A.owner.req("POST", "/v1/invites", { bot_id: A.bot.id, max_uses: 1 });
    await B.owner.req("POST", `/v1/invites/${us.code}/join`, { from_bot_id: B.bot.id });
    assert.equal((await inviteInList(A.owner, us.invite_id)).status, "used");

    // live: a fresh owner invite still reads active and still joins.
    const live: any = await A.owner.req("POST", "/v1/invites", { bot_id: A.bot.id });
    assert.equal((await inviteInList(A.owner, live.invite_id)).status, "active");
    assert.equal((await C.owner.req("POST", `/v1/invites/${live.code}/join`, { from_bot_id: C.bot.id })).status, "active");

    // live and approvable: a fresh bot invite still turns active when the owner approves it.
    const ok = await botInvite(A);
    await A.owner.req("POST", `/v1/approvals/${ok.approval_id}/decision`, { decision: "approved" });
    assert.equal((await inviteInList(A.owner, ok.invite_id)).status, "active");
  });
});
