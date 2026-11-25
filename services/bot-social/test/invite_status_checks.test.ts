import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { bulkAuth, expectApiError, friends, ownerWithBot, startServer } from "./helpers.js";

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(bulkAuth); });
after(async () => { await S.stop(); });

const invitesOf = async (owner: any) => (await owner.req("GET", "/v1/invites")).invites as any[];
const usesOf = (inviteId: string) => (S.platform.db.prepare("SELECT uses FROM invites WHERE id = ?").get(inviteId) as any).uses;
const botStatus = (botId: string) => (S.platform.db.prepare("SELECT status FROM bots WHERE id = ?").get(botId) as any).status;
const setStatus = (botId: string, status: string) => S.platform.db.prepare("UPDATE bots SET status = ? WHERE id = ?").run(status, botId);
const setType = (botId: string, type: string) => S.platform.db.prepare("UPDATE bots SET integration_type = ? WHERE id = ?").run(type, botId);
const freeze = (owner: any, botId: string) => owner.req("POST", "/v1/emergency-stop", { bot_id: botId });
const relsWith = (botId: string) => (S.platform.db.prepare("SELECT COUNT(*) n FROM relationships WHERE (requester_bot = ? OR target_bot = ?) AND status != 'room'").get(botId, botId) as any).n as number;
const activeGrants = (relId: string) => (S.platform.db.prepare("SELECT COUNT(*) n FROM grants WHERE relationship_id = ? AND status = 'active'").get(relId) as any).n as number;

/** An owner with an older FlyBot home and a newer member Bot. */
async function homeAndMember(name: string) {
  const A = await ownerWithBot(S.base, name);
  const member = await A.owner.req("POST", "/v1/bots", { handle: `${name}-member.bot`, display_name: "Member" });
  setType(A.bot.id, "flybot-home");
  setType(member.bot_id as string, "flybot-member");
  return { ...A, memberId: member.bot_id as string, memberHandle: "@" + String(member.handle).replace(/^@/, "") };
}

describe("P25 invite status checks: a killed Bot, an unnamed invite, and a body that names nothing", () => {
  test("a body that is not a JSON object is refused on both sides, and mints/uses nothing", async () => {
    const A = await ownerWithBot(S.base, "p25a1");
    const B = await ownerWithBot(S.base, "p25a2");
    const before = (await invitesOf(A.owner)).length;
    for (const body of [[], "x", 7, true]) {
      await expectApiError(A.owner.req("POST", "/v1/invites", body), 400, "invalid_request");
    }
    assert.equal((await invitesOf(A.owner)).length, before, "a refused body mints no invite");

    const inv = await A.owner.req("POST", "/v1/invites", { bot_id: A.bot.id });
    for (const body of [[], "x", 7, true]) {
      await expectApiError(B.owner.req("POST", `/v1/invites/${inv.code}/join`, body), 400, "invalid_request");
    }
    assert.equal(usesOf(inv.invite_id), 0, "a refused join spends no use");
    assert.equal(relsWith(A.bot.id), 0, "and creates no relationship");

    // An empty object is a legal body: it takes the documented default instead of being refused.
    const ok = await B.owner.req("POST", `/v1/invites/${inv.code}/join`, {});
    assert.equal(ok.status, "active");
    assert.equal(usesOf(inv.invite_id), 1);
  });

  test("an unnamed invite shares the member Bot, never the FlyBot home Bot, and a home-only account still mints", async () => {
    const A = await homeAndMember("p25b");
    const inv = await A.owner.req("POST", "/v1/invites", {});
    assert.equal(inv.bot.bot_id, A.memberId, "the home Bot is older, but the member Bot is the unnamed default");

    // Chief's compatibility red line: an account that only has its home Bot keeps minting (201).
    const H = await ownerWithBot(S.base, "p25bhome");
    setType(H.bot.id, "flybot-home");
    const homeOnly = await H.owner.req("POST", "/v1/invites", {});
    assert.equal(homeOnly.status, "active");
    assert.equal(homeOnly.bot.bot_id, H.bot.id);
  });

  test("an unnamed invite falls back past a frozen member to the active home, and refuses when nothing is active", async () => {
    const A = await homeAndMember("p25c");
    await freeze(A.owner, A.memberId);
    const inv = await A.owner.req("POST", "/v1/invites", {});
    assert.equal(inv.bot.bot_id, A.bot.id, "the frozen member is skipped for the active home Bot");

    await freeze(A.owner, A.bot.id);
    const refused = await expectApiError(A.owner.req("POST", "/v1/invites", {}), 400, "invalid_request");
    assert.match(String(refused.message), /no active member Bot/, "the refusal says how to proceed");

    // A revoked Bot is not a default either.
    const R = await ownerWithBot(S.base, "p25crev");
    setStatus(R.bot.id, "revoked");
    await expectApiError(R.owner.req("POST", "/v1/invites", {}), 400, "invalid_request");
  });

  test("a named Bot is resolved inside the caller's account and never falls back to the default", async () => {
    const A = await homeAndMember("p25d");
    const B = await ownerWithBot(S.base, "p25dother");

    const byHandle = await A.owner.req("POST", "/v1/invites", { bot_handle: A.memberHandle });
    assert.equal(byHandle.bot.bot_id, A.memberId, "bot_handle names the Bot instead of being ignored");

    // Same Bot by id and by a different-case handle: compared as resolved ids, so it is not a conflict.
    const mixedCase = "@" + A.memberHandle.slice(1).toUpperCase();
    const byMixed = await A.owner.req("POST", "/v1/invites", { bot_id: A.memberId, bot_handle: mixedCase });
    assert.equal(byMixed.bot.bot_id, A.memberId, "the response shows which Bot the link landed on");
    assert.equal(byMixed.bot.handle, A.memberHandle);

    const both = await A.owner.req("POST", "/v1/invites", { bot_id: A.memberId, bot_handle: A.memberHandle });
    assert.equal(both.bot.bot_id, A.memberId, "two names for the same Bot are fine");

    const before = (await invitesOf(A.owner)).length;
    await expectApiError(A.owner.req("POST", "/v1/invites", { bot_handle: "@nobody.bot" }), 404, "bot_not_found");
    await expectApiError(A.owner.req("POST", "/v1/invites", { bot_handle: B.handle }), 404, "bot_not_found");
    await expectApiError(A.owner.req("POST", "/v1/invites", { bot_id: B.bot.id }), 404, "bot_not_found");
    await expectApiError(A.owner.req("POST", "/v1/invites", { bot_id: A.memberId, bot_handle: A.handle }), 400, "invalid_request");
    assert.equal((await invitesOf(A.owner)).length, before, "a refused selector never mints an invite");

    // A named home Bot is allowed, as before.
    const home = await A.owner.req("POST", "/v1/invites", { bot_id: A.bot.id });
    assert.equal(home.bot.bot_id, A.bot.id);
  });

  test("a handle that matches two Bots differing only by case is the platform's 409, not a 400 or 404", async () => {
    const A = await ownerWithBot(S.base, "p25amb");
    const row = S.platform.db.prepare("SELECT * FROM bots WHERE id = ?").get(A.bot.id) as any;
    S.platform.db.prepare("INSERT INTO bots (id, owner_id, handle, display_name, integration_type, webhook_secret, status, created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run("bot_p25_amb", A.owner_id, A.handle.slice(1).toUpperCase(), "Same name", "grok-bot", row.webhook_secret, "active", new Date().toISOString());
    const mixed = "@" + A.handle.slice(1).replace(/^./, (c) => c.toUpperCase());
    await expectApiError(A.owner.req("POST", "/v1/invites", { bot_handle: mixed }), 409, "ambiguous_handle");

    // The join side resolves in the joiner's account, so give B its own case-variant pair.
    const B = await ownerWithBot(S.base, "p25ambjoin");
    const bRow = S.platform.db.prepare("SELECT * FROM bots WHERE id = ?").get(B.bot.id) as any;
    S.platform.db.prepare("INSERT INTO bots (id, owner_id, handle, display_name, integration_type, webhook_secret, status, created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run("bot_p25_amb2", B.owner_id, B.handle.slice(1).toUpperCase(), "Same name", "grok-bot", bRow.webhook_secret, "active", new Date().toISOString());
    const mixedB = "@" + B.handle.slice(1).replace(/^./, (c) => c.toUpperCase());
    const inv = await A.owner.req("POST", "/v1/invites", { bot_id: A.bot.id });
    await expectApiError(B.owner.req("POST", `/v1/invites/${inv.code}/join`, { bot_handle: mixedB }), 409, "ambiguous_handle");
    assert.equal(usesOf(inv.invite_id), 0, "an ambiguous selector spends no use");
  });

  test("a named frozen or revoked Bot is a 403, not a 404 and not a fallback to the default", async () => {
    const A = await homeAndMember("p25e");
    await freeze(A.owner, A.memberId);
    await expectApiError(A.owner.req("POST", "/v1/invites", { bot_id: A.memberId }), 403, "bot_frozen");
    await expectApiError(A.owner.req("POST", "/v1/invites", { bot_handle: A.memberHandle }), 403, "bot_frozen");

    const R = await ownerWithBot(S.base, "p25erev");
    setStatus(R.bot.id, "revoked");
    await expectApiError(R.owner.req("POST", "/v1/invites", { bot_id: R.bot.id }), 403, "bot_revoked");
  });

  test("the join side accepts bot_handle as from_bot_id, resolves it in the caller's account, and refuses conflicts", async () => {
    const A = await ownerWithBot(S.base, "p25j");
    const B = await ownerWithBot(S.base, "p25jtwo");
    const second = await B.owner.req("POST", "/v1/bots", { handle: "p25jtwo-second.bot", display_name: "Second" });
    const secondHandle = "@" + String(second.handle).replace(/^@/, "");
    const inv = await A.owner.req("POST", "/v1/invites", { bot_id: A.bot.id });

    const joined = await B.owner.req("POST", `/v1/invites/${inv.code}/join`, { bot_handle: secondHandle });
    assert.equal(joined.status, "active");
    assert.equal(joined.joined_as.bot_id, second.bot_id, "the join response shows which Bot joined");
    assert.equal(joined.joined_as.handle, secondHandle);
    const rel = S.platform.db.prepare("SELECT requester_bot FROM relationships WHERE id = ?").get(joined.relationship_id) as any;
    assert.equal(rel.requester_bot, second.bot_id, "the named Bot joins, not the oldest default");

    // A second join from the same two Bots is a conflict, not another use.
    const A2 = await ownerWithBot(S.base, "p25j2");
    const inv2 = await A2.owner.req("POST", "/v1/invites", { bot_id: A2.bot.id });
    const uses = usesOf(inv2.invite_id);
    await expectApiError(B.owner.req("POST", `/v1/invites/${inv2.code}/join`, { bot_handle: "@nobody.bot" }), 404, "bot_not_found");
    await expectApiError(B.owner.req("POST", `/v1/invites/${inv2.code}/join`, { bot_handle: A.handle }), 404, "bot_not_found");
    await expectApiError(B.owner.req("POST", `/v1/invites/${inv2.code}/join`, { from_bot_id: B.bot.id, bot_handle: secondHandle }), 400, "invalid_request");
    assert.equal(usesOf(inv2.invite_id), uses, "no refused selector spends a use");
  });

  test("a link minted before the inviter was frozen cannot be joined afterwards, and keeps its use", async () => {
    const A = await ownerWithBot(S.base, "p25f");
    const B = await ownerWithBot(S.base, "p25fjoin");
    const inv = await A.owner.req("POST", "/v1/invites", { bot_id: A.bot.id });
    await freeze(A.owner, A.bot.id);

    await expectApiError(B.owner.req("POST", `/v1/invites/${inv.code}/join`, { from_bot_id: B.bot.id }), 403, "bot_frozen");
    assert.equal(usesOf(inv.invite_id), 0, "the refused join spends no use");
    assert.equal(relsWith(A.bot.id), 0, "and writes no relationship");
    assert.equal((await B.bot.friends()).friends.length, 0);

    const R = await ownerWithBot(S.base, "p25frev");
    const invR = await R.owner.req("POST", "/v1/invites", { bot_id: R.bot.id });
    setStatus(R.bot.id, "revoked");
    await expectApiError(B.owner.req("POST", `/v1/invites/${invR.code}/join`, { from_bot_id: B.bot.id }), 403, "bot_revoked");
    assert.equal(usesOf(invR.invite_id), 0);
  });

  test("a frozen joiner cannot join either, and the refused join spends no use", async () => {
    const A = await ownerWithBot(S.base, "p25g");
    const B = await ownerWithBot(S.base, "p25gjoin");
    const inv = await A.owner.req("POST", "/v1/invites", { bot_id: A.bot.id });
    await freeze(B.owner, B.bot.id);
    await expectApiError(B.owner.req("POST", `/v1/invites/${inv.code}/join`, { from_bot_id: B.bot.id }), 403, "bot_frozen");
    assert.equal(usesOf(inv.invite_id), 0);
  });

  test("the regrant path refuses a frozen pair and writes no grant and no use", async () => {
    const { A, B, relId } = await friends(S.base);
    // Drop the inviter owner's live share of the joiner's Bot, so a fresh join takes the regrant branch.
    S.platform.db.prepare("UPDATE grants SET status = 'revoked', revoked_at = ? WHERE relationship_id = ? AND grantor_owner = ? AND grantee_bot = ? AND room_id IS NULL")
      .run(new Date().toISOString(), relId, A.owner_id, B.bot.id);
    const inv = await A.owner.req("POST", "/v1/invites", { bot_id: A.bot.id });
    const grantsBefore = activeGrants(relId);
    await freeze(A.owner, A.bot.id);

    await expectApiError(B.owner.req("POST", `/v1/invites/${inv.code}/join`, { from_bot_id: B.bot.id }), 403, "bot_frozen");
    assert.equal(usesOf(inv.invite_id), 0, "a refused regrant spends no use");
    assert.equal(activeGrants(relId), grantsBefore, "a refused regrant writes no grant");
    assert.equal((S.platform.db.prepare("SELECT status FROM relationships WHERE id = ?").get(relId) as any).status, "active", "the friendship itself stays as it was");
  });

  test("the join response names the Bot that joined, on the first join and on the regrant path", async () => {
    const A = await ownerWithBot(S.base, "p25i");
    const B = await ownerWithBot(S.base, "p25ijoin");
    const inv = await A.owner.req("POST", "/v1/invites", { bot_id: A.bot.id });
    const j = await B.owner.req("POST", `/v1/invites/${inv.code}/join`, { from_bot_id: B.bot.id });
    assert.equal(j.status, "active");
    assert.equal(j.joined_as.bot_id, B.bot.id, "a first join says which Bot it landed on");
    assert.equal(j.joined_as.handle, B.handle);

    // The regrant path returns its own object; it must carry the same identity.
    const { A: RA, B: RB, relId } = await friends(S.base);
    S.platform.db.prepare("UPDATE grants SET status = 'revoked', revoked_at = ? WHERE relationship_id = ? AND grantor_owner = ? AND grantee_bot = ? AND room_id IS NULL")
      .run(new Date().toISOString(), relId, RA.owner_id, RB.bot.id);
    const inv2 = await RA.owner.req("POST", "/v1/invites", { bot_id: RA.bot.id });
    const re = await RB.owner.req("POST", `/v1/invites/${inv2.code}/join`, { from_bot_id: RB.bot.id });
    assert.equal(re.regranted, true);
    assert.equal(re.joined_as.bot_id, RB.bot.id, "a regrant says which Bot it landed on too");
    assert.equal(re.joined_as.handle, RB.handle);
  });

  test("the control: an explicit active member Bot still mints and joins, with grants ready", async () => {
    const A = await homeAndMember("p25h");
    const B = await ownerWithBot(S.base, "p25hjoin");
    const inv = await A.owner.req("POST", "/v1/invites", { bot_id: A.memberId });
    assert.equal(inv.bot.bot_id, A.memberId);
    const joined = await B.owner.req("POST", `/v1/invites/${inv.code}/join`, { from_bot_id: B.bot.id });
    assert.equal(joined.status, "active");
    assert.equal(joined.grants_ready, true);
    assert.equal(usesOf(inv.invite_id), 1);
    assert.equal((await B.bot.friends()).friends.length, 1);
  });
  test("a link minted before the joiner froze is refused while frozen and works again after Resume", async () => {
    const A = await ownerWithBot(S.base, "p25gz");
    const B = await ownerWithBot(S.base, "p25gzjoin");
    // The inviter mints first, while both Bots are still active.
    const inv = await A.owner.req("POST", "/v1/invites", { bot_id: A.bot.id });
    assert.equal(inv.bot.bot_id, A.bot.id);
    await freeze(B.owner, B.bot.id);

    await expectApiError(B.owner.req("POST", `/v1/invites/${inv.code}/join`, { from_bot_id: B.bot.id }), 403, "bot_frozen");
    assert.equal(usesOf(inv.invite_id), 0, "the refused join spends no use");
    assert.equal(relsWith(B.bot.id), 0, "and writes no relationship for the frozen joiner");
    const grantRows = (S.platform.db.prepare("SELECT COUNT(*) n FROM grants WHERE grantee_bot = ? AND status = 'active'").get(B.bot.id) as any).n;
    assert.equal(grantRows, 0, "and no active grant");

    // Owner-only Resume is never blocked, and the same unexpired link still works afterwards.
    const back = await B.owner.req("POST", `/v1/bots/${B.bot.id}/resume`);
    assert.equal(back.status, "active");
    const joined = await B.owner.req("POST", `/v1/invites/${inv.code}/join`, { from_bot_id: B.bot.id });
    assert.equal(joined.status, "active");
    assert.equal(joined.joined_as.bot_id, B.bot.id);
    assert.equal(usesOf(inv.invite_id), 1);
    assert.equal(relsWith(B.bot.id), 1, "the resumed Bot is a friend now");
    assert.equal((S.platform.db.prepare("SELECT status FROM relationships WHERE id = ?").get(joined.relationship_id) as any).status, "active");
  });
});
