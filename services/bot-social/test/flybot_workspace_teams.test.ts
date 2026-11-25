// FlyBot teams, members, invites, join requests and directory on Bot Social, driven with the
// FlyBot home connector token exactly as each user's DS-Bot plugin does. Fixture accounts only.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { bulkAuth, startServer } from "./helpers.js";
import { home } from "./flybot_workspace_helpers.js";

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(bulkAuth); });
after(async () => { await S.stop(); });

test("profile comes from the FlyBot home; no token is refused", async () => {
  const A = await home(S.base, "ann");
  assert.match(A.handle, /\.home$/);
  const p = await A.ok("PUT", "/v1/ot/profile", { display_name: "Ann", bio: "hi" });
  assert.equal(p.display_name, "Ann");
  assert.equal((await fetch(S.base + "/v1/ot/teams")).status, 401);
});

test("team creation rolls back when the retry receipt cannot be written", async () => {
  const owner = await home(S.base, "receipt-owner");
  const path = "/v1/ot/workspaces";
  const draft = {name: "Retryable team", slug: "retryable-team", idempotency_key: "test-team-creation-receipt"};
  S.platform.db.exec(`CREATE TRIGGER fixture_reject_workspace_receipt
    BEFORE INSERT ON ot_workspace_requests
    BEGIN SELECT RAISE(ABORT, 'fixture disabled creation receipt'); END`);
  try {
    assert.equal((await owner.call("POST", path, draft)).status, 500);
    assert.deepEqual((await owner.ok("GET", path)).workspaces, []);
  } finally {
    S.platform.db.exec("DROP TRIGGER fixture_reject_workspace_receipt");
  }
  const created = await owner.ok("POST", path, draft);
  const recovered = await owner.ok("POST", path, draft);
  assert.equal(recovered.workspace_id, created.workspace_id);
  assert.equal((await owner.ok("GET", path)).workspaces.length, 1);
});

test("team lifecycle: create, invite, accept, roles, suspend, leave", async () => {
  const A = await home(S.base, "owner");
  const B = await home(S.base, "bea");
  const C = await home(S.base, "cid");
  const team = await A.ok("POST", "/v1/ot/teams", { name: "Content Studio", slug: `studio-${Date.now() % 100000}`, summary: "we write" });
  assert.equal(team.role, "owner");
  assert.equal((await B.call("GET", `/v1/ot/teams/${team.id}`)).status, 404, "non-member learns nothing");
  assert.equal((await B.call("POST", `/v1/ot/teams/${team.id}/invites`, {})).status, 404);

  const { code, invite } = await A.ok("POST", `/v1/ot/teams/${team.id}/invites`, { role: "member", max_uses: 2 });
  assert.equal(typeof code, "string");
  assert.equal(invite.code, undefined);
  const preview = await B.ok("POST", "/v1/ot/invites/preview", { code });
  assert.equal(preview.team.name, "Content Studio");
  assert.equal((await B.ok("POST", "/v1/ot/invites/accept", { code })).status, "member");
  assert.equal((await B.ok("POST", "/v1/ot/invites/accept", { code })).status, "member", "idempotent");
  assert.equal((await B.ok("GET", "/v1/ot/teams")).teams.length, 1);

  const members = await A.ok("GET", `/v1/ot/teams/${team.id}/members`);
  assert.deepEqual(members.members.map((m: any) => m.role), ["owner", "member"]);
  assert.equal((await B.call("PATCH", `/v1/ot/teams/${team.id}/members/${A.handle}`, { role: "member" })).status, 403);
  await A.ok("PATCH", `/v1/ot/teams/${team.id}/members/${B.handle}`, { role: "admin" });
  // admin invites C, then may suspend C (a member) but not change roles
  const second = await B.ok("POST", `/v1/ot/teams/${team.id}/invites`, {});
  await C.ok("POST", "/v1/ot/invites/accept", { code: second.code });
  assert.equal((await B.call("PATCH", `/v1/ot/teams/${team.id}/members/${C.handle}`, { role: "admin" })).status, 403);
  await B.ok("PATCH", `/v1/ot/teams/${team.id}/members/${C.handle}`, { suspended: true });
  assert.equal((await C.call("GET", `/v1/ot/teams/${team.id}`)).status, 404, "suspended member loses access");
  await A.ok("PATCH", `/v1/ot/teams/${team.id}/members/${C.handle}`, { suspended: false });
  assert.equal((await C.call("GET", `/v1/ot/teams/${team.id}`)).status, 200);
  assert.equal((await A.call("DELETE", `/v1/ot/teams/${team.id}/members/${A.handle}`)).status, 409, "owner cannot leave");
  await C.ok("DELETE", `/v1/ot/teams/${team.id}/members/${C.handle}`);
  assert.equal((await C.ok("GET", "/v1/ot/teams")).teams.length, 0);

  // freeze, revoke and use limits
  const inv = await A.ok("POST", `/v1/ot/teams/${team.id}/invites`, { max_uses: 1 });
  await A.ok("PATCH", `/v1/ot/teams/${team.id}/invites/${inv.invite.id}`, { frozen: true });
  assert.equal((await C.call("POST", "/v1/ot/invites/accept", { code: inv.code })).status, 410);
  await A.ok("PATCH", `/v1/ot/teams/${team.id}/invites/${inv.invite.id}`, { frozen: false });
  const direct = await C.ok("POST", "/v1/ot/invites/accept", { code: inv.code });
  assert.equal(direct.workspace_id, team.workspace_id);
  assert.equal(direct.role, "member");
  assert.deepEqual(await C.ok("POST", "/v1/ot/invites/accept", { code: inv.code }), direct);
  const D = await home(S.base, "dee");
  assert.equal((await D.call("POST", "/v1/ot/invites/accept", { code: inv.code })).status, 410, "used up");
  const receipt = await C.ok("POST", "/v1/ot/invites/preview", { code: inv.code });
  assert.equal(receipt.usable, false);
  assert.equal(receipt.membership, "member");
  assert.equal(receipt.workspace_id, undefined, "an unbound team has no workspace to expose");
  const stranger = await D.ok("POST", "/v1/ot/invites/preview", { code: inv.code });
  assert.equal(stranger.membership, undefined);
  assert.equal(stranger.workspace_id, undefined);
  await A.ok("PATCH", `/v1/ot/teams/${team.id}/members/${C.handle}`, { suspended: true });
  const suspended = await C.ok("POST", "/v1/ot/invites/preview", { code: inv.code });
  assert.equal(suspended.membership, "suspended");
  assert.equal(suspended.workspace_id, undefined);
  assert.equal((await D.call("POST", "/v1/ot/invites/accept", { code: "x".repeat(32) })).status, 404);
});

test("team ownership transfers atomically to an active member, then the former owner can leave", async () => {
  const [owner, successor, other] = await Promise.all([
    home(S.base, "transfer-owner"), home(S.base, "transfer-successor"), home(S.base, "transfer-other"),
  ]);
  const team = await owner.ok("POST", "/v1/ot/workspaces", {name: "Ownership handoff", idempotency_key: "test-ownership-handoff"});
  const path = `/v1/ot/teams/${team.id}`;
  const member = (person: typeof owner) => path + "/members/" + person.handle;
  const transfer = (person: typeof owner) => member(person) + "/transfer-ownership";
  await owner.ok("POST", path + "/members", {handle: successor.handle, role: "admin"});
  assert.equal((await successor.call("POST", transfer(owner), {})).status, 403);
  assert.equal((await other.call("POST", transfer(successor), {})).status, 404);
  assert.equal((await owner.call("POST", transfer(other), {})).status, 404);
  await owner.ok("PATCH", member(successor), {suspended: true});
  assert.equal((await owner.call("POST", transfer(successor), {})).data.error.code, "member_suspended");
  await owner.ok("PATCH", member(successor), {suspended: false});
  const adminInvite = await owner.ok("POST", path + "/invites", {role: "admin"});
  const memberInvite = await owner.ok("POST", path + "/invites", {role: "member"});

  S.platform.db.exec(`CREATE TRIGGER fixture_reject_ownership_transfer
    BEFORE INSERT ON ot_notifications WHEN NEW.kind='team.owner_transferred'
    BEGIN SELECT RAISE(ABORT, 'fixture disabled notification'); END`);
  try {
    assert.equal((await owner.call("POST", transfer(successor), {})).status, 500);
    assert.equal((await owner.ok("GET", path)).role, "owner");
    assert.equal((await successor.ok("GET", path)).role, "admin");
    assert.equal((await other.ok("POST", "/v1/ot/invites/preview", {code: adminInvite.code})).usable, true);
  } finally {
    S.platform.db.exec("DROP TRIGGER fixture_reject_ownership_transfer");
  }

  assert.deepEqual(await owner.ok("POST", transfer(successor), {}), {transferred: true});
  assert.equal((await owner.call("POST", transfer(successor), {})).status, 403);
  assert.equal((await owner.ok("GET", path)).role, "member");
  assert.equal((await successor.ok("GET", path)).owner.handle, successor.handle);
  const roster = (await successor.ok("GET", path + "/members")).members;
  assert.deepEqual(roster.map((row: any) => [row.handle, row.role]), [[successor.handle, "owner"], [owner.handle, "member"]]);
  assert.equal((await other.call("POST", "/v1/ot/invites/accept", {code: adminInvite.code})).status, 410);
  assert.equal((await other.ok("POST", "/v1/ot/invites/accept", {code: memberInvite.code})).status, "member");
  assert.equal((await successor.call("DELETE", member(successor))).status, 409);
  await owner.ok("DELETE", member(owner));
  assert.equal((await owner.call("GET", path)).status, 404);
  assert.equal((await successor.ok("GET", "/v1/ot/teams/by-workspace/" + team.workspace_id)).role, "owner");
});

test("approval invites and the team directory queue join requests for owners and admins", async () => {
  const A = await home(S.base, "lead");
  const B = await home(S.base, "joiner");
  const team = await A.ok("POST", "/v1/ot/workspaces", {
    name: "Open Research Guild", slug: "open-research-guild", idempotency_key: "team-directory-approval-test",
  });
  const inv = await A.ok("POST", `/v1/ot/teams/${team.id}/invites`, { requires_approval: true, max_uses: 1 });
  const pending = await B.ok("POST", "/v1/ot/invites/accept", { code: inv.code });
  assert.equal(pending.status, "pending");
  assert.deepEqual(await B.ok("POST", "/v1/ot/invites/accept", { code: inv.code }), pending);
  const preview = await B.ok("POST", "/v1/ot/invites/preview", { code: inv.code });
  assert.equal(preview.usable, false);
  assert.equal(preview.membership, "pending");
  assert.equal(preview.workspace_id, undefined);
  const notes = await A.ok("GET", "/v1/ot/notifications");
  assert.ok(notes.notifications.some((x: any) => x.kind === "team.join_request" && x.data.member.handle === B.handle));
  const queue = await A.ok("GET", `/v1/ot/teams/${team.id}/join-requests`);
  assert.equal(queue.requests.length, 1);
  await A.ok("POST", `/v1/ot/teams/${team.id}/join-requests/${queue.requests[0].id}`, { decision: "reject" });
  assert.equal((await A.call("POST", `/v1/ot/teams/${team.id}/join-requests/${queue.requests[0].id}`, { decision: "approve" })).status, 409);
  assert.equal((await B.ok("GET", "/v1/ot/teams")).teams.length, 0);

  // directory
  const C = await home(S.base, "seeker");
  assert.equal((await C.ok("GET", "/v1/ot/directory?q=guild")).teams.length, 0, "unlisted teams are hidden");
  await A.ok("PUT", `/v1/ot/teams/${team.id}/listing`, { listed: true, summary: "papers and reading group" });
  const found = await C.ok("GET", "/v1/ot/directory?q=reading");
  assert.equal(found.teams.length, 1);
  assert.equal(found.teams[0].membership, null);
  assert.equal(found.teams[0].workspace_id, undefined);
  assert.equal((await C.ok("POST", `/v1/ot/directory/${team.id}/join`)).status, "pending");
  assert.equal((await C.ok("GET", "/v1/ot/directory?q=guild")).teams[0].membership, "pending");
  const q2 = await A.ok("GET", `/v1/ot/teams/${team.id}/join-requests`);
  await A.ok("POST", `/v1/ot/teams/${team.id}/join-requests/${q2.requests[0].id}`, { decision: "approve" });
  const joined = (await C.ok("GET", "/v1/ot/directory?q=guild")).teams[0];
  assert.equal(joined.membership, "member");
  assert.equal(joined.workspace_id, team.workspace_id);
  await A.ok("PATCH", `/v1/ot/teams/${team.id}/members/${C.handle}`, { suspended: true });
  const suspended = (await C.ok("GET", "/v1/ot/directory?q=guild")).teams[0];
  assert.equal(suspended.membership, "suspended");
  assert.equal(suspended.workspace_id, undefined);
  await A.ok("PATCH", `/v1/ot/teams/${team.id}/members/${C.handle}`, { suspended: false });
  const cn = await C.ok("GET", "/v1/ot/notifications");
  assert.ok(cn.notifications.some((x: any) => x.kind === "team.join_decided" && x.data.decision === "approve"));
  await C.ok("POST", "/v1/ot/notifications/read", { up_to: cn.notifications.at(-1).seq });
  assert.equal((await C.ok("GET", "/v1/ot/notifications")).unread, 0);
  await A.ok("PUT", `/v1/ot/teams/${team.id}/listing`, { listed: false });
  assert.equal((await C.call("POST", `/v1/ot/directory/${team.id}/join`)).status, 404);
  await A.ok("DELETE", `/v1/ot/teams/${team.id}`);
  assert.equal((await C.ok("GET", "/v1/ot/teams")).teams.length, 0);
});

test("only the owner can grant administrator access through an invitation", async () => {
  const [owner, admin, applicant, guest] = await Promise.all([
    home(S.base, "roles-owner"), home(S.base, "roles-admin"), home(S.base, "roles-applicant"), home(S.base, "roles-guest"),
  ]);
  const team = await owner.ok("POST", "/v1/ot/workspaces", {name: "Role boundaries", idempotency_key: "team-role-boundaries"});
  const path = `/v1/ot/teams/${team.id}`;
  await owner.ok("POST", path + "/members", {handle: admin.handle, role: "admin"});
  assert.equal((await admin.call("POST", path + "/invites", {role: "admin"})).status, 403);
  const adminInvite = await owner.ok("POST", path + "/invites", {role: "admin", requires_approval: true});
  assert.equal((await admin.call("PATCH", path + "/invites/" + adminInvite.invite.id, {frozen: true})).status, 403);
  const pending = await applicant.ok("POST", "/v1/ot/invites/accept", {code: adminInvite.code});
  const application = path + "/join-requests/" + pending.request_id;
  assert.equal((await admin.call("POST", application, {decision: "approve"})).status, 403);
  assert.equal((await applicant.call("GET", path)).status, 404);
  await owner.ok("POST", application, {decision: "approve"});
  assert.equal((await applicant.ok("GET", path)).role, "admin");

  const legacy = await owner.ok("POST", path + "/invites", {role: "admin"});
  const adminId = (await admin.ok("GET", "/v1/ot/me")).owner_id;
  // Historical fixture issued while the old role restriction was absent.
  S.platform.db.prepare("UPDATE ot_invites SET created_by=? WHERE id=?").run(adminId, legacy.invite.id);
  assert.equal((await guest.ok("POST", "/v1/ot/invites/preview", {code: legacy.code})).usable, false);
  assert.equal((await guest.call("POST", "/v1/ot/invites/accept", {code: legacy.code})).status, 410);
  assert.equal((await guest.call("GET", path)).status, 404);

  const memberInvite = await admin.ok("POST", path + "/invites", {requires_approval: true});
  const memberRequest = await guest.ok("POST", "/v1/ot/invites/accept", {code: memberInvite.code});
  await admin.ok("POST", path + "/join-requests/" + memberRequest.request_id, {decision: "approve"});
  assert.equal((await guest.ok("GET", path)).role, "member");
});

test("applicants see their canonical workspace and a new application has a distinct decision target", async () => {
  const [owner, applicant, stranger] = await Promise.all([
    home(S.base, "requests-owner"), home(S.base, "requests-applicant"), home(S.base, "requests-stranger"),
  ]);
  const team = await owner.ok("POST", "/v1/ot/workspaces", {name: "Application history", idempotency_key: "team-application-history"});
  const path = `/v1/ot/teams/${team.id}`;
  const invite = await owner.ok("POST", path + "/invites", {requires_approval: true});
  const apply = () => applicant.ok("POST", "/v1/ot/invites/accept", {code: invite.code});
  const requestPath = path + "/join-requests/";
  const minePath = "/v1/ot/join-requests/mine";
  const first = await apply();
  assert.deepEqual(await apply(), first);
  const firstRow = (await applicant.ok("GET", minePath)).requests[0];
  assert.deepEqual([firstRow.id, firstRow.workspace_id, firstRow.team_name, firstRow.status],
    [first.request_id, team.workspace_id, team.name, "pending"]);
  assert.deepEqual((await stranger.ok("GET", minePath)).requests, []);
  await owner.ok("POST", requestPath + first.request_id, {decision: "reject"});
  assert.equal((await applicant.ok("GET", minePath)).requests[0].status, "rejected");

  const second = await apply();
  assert.notEqual(second.request_id, first.request_id);
  assert.equal((await owner.call("POST", requestPath + first.request_id, {decision: "approve"})).status, 404);
  const current = (await applicant.ok("GET", minePath)).requests;
  assert.deepEqual(current.map((row: any) => [row.id, row.status]), [[second.request_id, "pending"]]);
  await owner.ok("POST", requestPath + second.request_id, {decision: "approve"});
  assert.equal((await applicant.ok("GET", `/v1/ot/teams/by-workspace/${team.workspace_id}`)).role, "member");
});

test("a platform workspace binds to one team; members can be added by handle", async () => {
  const A = await home(S.base, "ws-owner");
  const B = await home(S.base, "ws-bea");
  const workspace = "c".repeat(32);
  assert.equal((await B.call("POST", "/v1/ot/teams/ensure", { workspace_id: workspace })).status, 409, "a first caller cannot claim another platform workspace");
  assert.equal((await B.call("POST", "/v1/ot/teams", { name: "Claim", workspace_id: workspace })).status, 409);
  const native = await A.ok("POST", "/v1/ot/teams", { name: "Bound Studio" });
  // Trusted migration fixture, never a browser-supplied ownership claim.
  S.platform.db.prepare("UPDATE ot_teams SET workspace_id=? WHERE id=?").run(workspace, native.id);
  const first = await A.ok("POST", "/v1/ot/teams/ensure", { workspace_id: workspace });
  assert.equal(first.workspace_id, workspace);
  assert.equal(first.name, "Bound Studio");
  const again = await A.ok("POST", "/v1/ot/teams/ensure", { workspace_id: workspace });
  assert.equal(again.id, first.id);
  assert.equal((await B.call("POST", "/v1/ot/teams/ensure", { workspace_id: workspace })).status, 404, "non-member cannot claim a bound team");
  const looked = await A.ok("GET", `/v1/ot/teams/by-workspace/${workspace}`);
  assert.equal(looked.id, first.id);
  const added = await A.call("POST", `/v1/ot/teams/${first.id}/members`, { handle: B.handle, role: "member" });
  assert.equal(added.status, 201);
  const members = await A.ok("GET", `/v1/ot/teams/${first.id}/members`);
  assert.ok(members.members.some((m: any) => m.handle === B.handle && m.role === "member"));
  const uid = "d".repeat(32);
  assert.equal((await A.call("PUT", "/v1/ot/profile", { platform_user_id: uid })).status, 409, "a browser cannot claim a platform user id");
  S.platform.db.prepare("UPDATE ot_profiles SET platform_user_id=? WHERE handle=?").run(uid, B.handle.replace(/^@/, ""));
  const profile = await B.ok("PUT", "/v1/ot/profile", { platform_user_id: uid });
  assert.equal(profile.platform_user_id, uid);
  await A.ok("PATCH", `/v1/ot/teams/${first.id}/members/${uid}`, { role: "admin" });
  const after = await A.ok("GET", `/v1/ot/teams/${first.id}/members`);
  assert.equal(after.members.find((m: any) => m.handle === B.handle).role, "admin");
  assert.equal((await A.call("POST", "/v1/ot/teams", { name: "Other", workspace_id: workspace })).status, 409);
});
test("the listed team directory pages stable ties without exposing private workspace IDs", async () => {
  const owner = await home(S.base, "directory-paging-owner");
  const viewer = await home(S.base, "directory-paging-viewer");
  const created = [];
  for (const suffix of ["a", "b", "c", "d"]) {
    const team = await owner.ok("POST", "/v1/ot/workspaces", {
      name: `Catalog cohort ${suffix}`, slug: `catalog-cohort-${suffix}`, idempotency_key: `directory-paging-${suffix}`,
    });
    created.push(team);
    if (suffix !== "d") {
      await owner.ok("PUT", `/v1/ot/teams/${team.id}/listing`, {listed:true, summary:"Searchable cohort"});
    }
  }
  S.platform.db.prepare("UPDATE ot_teams SET updated_at=1 WHERE owner_id=?").run((await owner.ok("GET", "/v1/ot/me")).owner_id);
  const read = "/v1/ot/directory?limit=2&q=Searchable+cohort";
  const expected = created.slice(0, 3).map(team => team.id).sort().reverse();
  const first = await viewer.ok("GET", read);
  assert.deepEqual(first.teams.map((team: {id: string}) => team.id), expected.slice(0, 2));
  assert.ok(first.cursor);
  const page2 = await viewer.ok("GET", `${read}&cursor=${first.cursor}`);
  assert.deepEqual(page2.teams.map((team: {id: string}) => team.id), expected.slice(2));
  assert.equal(page2.cursor, null);
  for (const team of [...first.teams, ...page2.teams]) {
    assert.equal(team.workspace_id, undefined);
    assert.equal(team.membership, null);
  }
  assert.equal((await viewer.call("GET", `/v1/ot/directory?q=different&cursor=${first.cursor}`)).status, 400);
  assert.equal((await viewer.call("GET", `${read}&cursor=invalid`)).status, 400);
  assert.equal((await fetch(S.base + read)).status, 401);

  const joined = await owner.ok("GET", read);
  assert.ok(joined.teams.every((team: {workspace_id: string; membership: string}) =>
    team.membership === "member" && /^[a-f0-9]{32}$/.test(team.workspace_id)));
});
