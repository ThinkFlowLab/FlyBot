// Team-run snapshots shared with a team on Bot Social. Fixture homes only; no real people.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { bulkAuth, startServer } from "./helpers.js";
import { home } from "./flybot_workspace_helpers.js";

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(bulkAuth); });
after(async () => { await S.stop(); });

test("a teammate can read a shared run snapshot; outsiders and non-owners cannot unshare", async () => {
  const A = await home(S.base, "owner");
  const B = await home(S.base, "mate");
  const X = await home(S.base, "outsider");
  const team = await A.ok("POST", "/v1/ot/workspaces", { name: "Share team", idempotency_key: "fixture-share-snapshot-workspace" });
  const { code } = await A.ok("POST", `/v1/ot/teams/${team.id}/invites`, {});
  await B.ok("POST", "/v1/ot/invites/accept", { code });
  const shared = await A.ok("PUT", `/v1/ot/teams/${team.id}/shared-runs`, {
    run_ref: "b".repeat(32), title: "Q3 plan", goal: "write the plan", status: "succeeded",
    snapshot: { progress: { succeeded: 2, total: 2 }, steps: [{ position: 0, agent_name: "Writer", instruction: "SECRET", status: "succeeded", output: "draft ok", error_code: "x" }] },
  });
  assert.equal(shared.snapshot.steps[0].output, "draft ok");
  assert.equal(shared.snapshot.steps[0].instruction, undefined);
  assert.equal(shared.snapshot.steps[0].error_code, undefined);
  assert.equal((await B.ok("GET", `/v1/ot/teams/${team.id}/shared-runs`)).runs.length, 1);
  const summary = (await B.ok("GET", `/v1/ot/teams/${team.id}/shared-runs?summary=1`)).runs[0];
  assert.equal(summary.id, shared.id);
  assert.equal(summary.goal, undefined);
  assert.equal(summary.snapshot, undefined);
  const notices = await B.ok("GET", `/v1/ot/notifications?workspace_id=${team.workspace_id}`);
  assert.ok(notices.notifications.some((n: any) => n.kind === "team.run_shared" && n.data.title === "Q3 plan"
    && n.data.workspace_id === team.workspace_id));
  assert.equal((await X.call("GET", `/v1/ot/teams/${team.id}/shared-runs`)).status, 404);
  assert.equal((await B.call("DELETE", `/v1/ot/teams/${team.id}/shared-runs/${shared.id}`)).status, 403);
  await A.ok("DELETE", `/v1/ot/teams/${team.id}/shared-runs/${shared.id}`);
  assert.equal((await B.ok("GET", `/v1/ot/teams/${team.id}/shared-runs`)).runs.length, 0);
});
