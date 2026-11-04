# Role GitHub Apps (#2365)

This is opt-in on `delivery/ai-centric-development-service`. Existing gh-cli and
host-published deliveries keep their original behavior when role App mode is absent.
Personal agents' explicitly personal GitHub operations keep their separate user authorization.
No App is registered/installed and no running instance is migrated by installing this code.

## Configure once

1. A human/operator installs **different Dev and Reviewer Apps** on the permitted
   repository. Provision their existing named `projectGithubConnections` with
   explicit `projectIds`/`repositories`, App/installation IDs and a host-only key file.
2. Add the following to the existing private host plugin configuration, alongside
   the repository's workDir/allowedPaths/testCommand configuration. Replace every
   example ID; do not put private key bytes or Tokens into configuration.
3. Upgrade each selected resource's pinned FlyBot runtime with this change. Keep
   its normal Codex/Claude login/model configuration; App credentials do not log
   into the model SDK. Run the existing resource/runtime readiness checks.

```json
{
  "projectGithubConnections": {
    "dev-app": {
      "credential": "github-app", "appId": 101, "installationId": 1001,
      "privateKeyFile": "/private/flybot-dev.pem",
      "projectIds": ["PROJECT_ID"], "repositories": ["org/repo"]
    },
    "review-app": {
      "credential": "github-app", "appId": 102, "installationId": 1002,
      "privateKeyFile": "/private/flybot-review.pem",
      "projectIds": ["PROJECT_ID"], "repositories": ["org/repo"]
    }
  },
  "projectRepositories": {
    "org/repo": {
      "roleGithub": {
        "enabled": true, "revision": 1, "branches": ["delivery-base"],
        "roles": {
          "developer": { "connectionId": "dev-app" },
          "reviewer": { "connectionId": "review-app" }
        }
      }
    }
  }
}
```

The selected Project base must be explicitly in `branches`. Increment `revision`
when changing bindings/policy. Configuration changes fence existing grants and
pending artifact adoption; do not change bindings mid-delivery without reconciliation.
Custom logical roles can bind by role name, falling back to their policyRole.
Dev/Reviewer require explicit App connections; unassigned Tester/Chief get no
GitHub credentials. Query `github.connection` to see configured roles and
`identityReuse`; this is configuration metadata, not an installation health check.
Different installations/Tokens for **one App** still share an identity and cannot
supply independent approval.

Also configure/select the existing **host merge connection as an App**, using
[GitHub automation](github-automation.md). A Dev App cannot silently replace the
selected merger, and role App mode refuses a gh-cli merger fallback. Configure
repository/base/check policy using the existing
[controlled merge contract](subsystems/project-delivery.md). The merge connection
must have the permissions its original operations need. No merge is enabled by
merely setting `roleGithub.enabled`.

| Role | Issued installation Token permissions | Permitted normal commands |
| --- | --- | --- |
| Developer | contents:write, pull_requests:write | local commit; exact branch push; create/update original Draft PR |
| Reviewer | contents:read, pull_requests:write, checks:read | read candidate and submit actual exact-SHA Review |
| Tester, optional | contents:read, pull_requests:read, checks:write | read; candidate check-run with scope hash as external_id |
| Chief, optional | contents:read, pull_requests:read, checks:read | read observations; merge stays with host policy |

The provider verifies current installation, repository, permissions and App Bot
login, then issues a single-repository Token valid for roughly one hour. GitHub's
implicit metadata permission applies. A key must meet the existing owned regular
file/mode0600/RSA requirements; it never goes to an execution resource.

## Resource requirements and authentication

Linux local and Docker execution require Node, Git, **gh**, `mkfifo`, and HTTPS
connectivity to github.com/api.github.com. The host must reach GitHub for issuance.
No global `gh auth login`, Owner PAT, App private key copy or persistent authenticated
remote URL is required. Codex's role profile allows only those two outbound GitHub
domains; private FIFO files have explicit scoped filesystem access, without a Unix
socket/network permission expansion. Ordinary roles retain their prior profile.

The original worker protocol carries bounded credential requests/replies outside
SDK prompts/events. A per-execution private directory and FIFO deliver credentials
in memory/kernel pipes to resource-local git/gh wrappers. Empty request files and
metadata contain no Token. The helper verifies HTTPS host and repository path.
Only a gh child receives temporary `GH_TOKEN`; git uses the scoped credential helper.
Git author/committer use the verified App Bot login and public Bot-ID noreply email.
Normal host tests never receive this role environment. Native roles use the same
issuer and wrappers through the original shellEnv contribution; saved Owner secrets
are withheld with `NAME:project-role-app` during that App-bound native execution.
Personal Chief, personal Bots and group chats retain their existing secret policy.

Each request rechecks current Task/Attempt/claim/generation, physical worker,
resource/lease, connection revision and current installation. The original provider
handles cached Tokens, coalesced refresh and key rotation. End/cancel/stop/revocation
or an inactive/unknown worker stops new grants. Released executions remove owned
private runtime directories. Host restart does not reconstruct an active credential
issuer; recovery must establish current execution/exit authority first. A remote
process or already-issued Token may survive until expiry: `expiresAt` is retained,
**not** presented as proof of immediate GitHub revocation or remote cleanup.

These are credential and workflow boundaries inside the existing trusted executor
model, not isolation against hostile code sharing the same OS identity. A process
that deliberately bypasses wrappers or exfiltrates its own credential cannot be
made absolutely harmless by output redaction. Installation Tokens constrain
repository/permissions, **not branches**. Apply real repository branch protection,
App permissions and resource access policy; never rely on wrapper validation as a
GitHub branch-scoped Token or assume App installation bypasses required checks.

## Development and evidence

The original role prompt supplies repository, controlled branch/base, publication
marker, PR binding and candidate facts. Developer uses commands of this form:

```bash
git add -- <changed-files>
git commit -m 'Implement the accepted Task'
git push https://github.com/org/repo.git HEAD:refs/heads/flybot/<original-branch>
gh pr create --draft --base delivery-base --head flybot/<original-branch> --title 'Task change' --body-file /path/to/body
```

Include the supplied `<!-- flybot-delivery:PROJECT_ID:TASK_ID -->` marker in the PR
body. Rework updates the **same PR**, rather than creating a PR for every Attempt.
The wrapper checks remote PRs before create, reuses a matching lost-create result,
and refuses ambiguous, closed, wrong-head/base or foreign-creator matches.

Before host adoption, the SDK must commit and leave a clean worktree. The original
`github.candidate` Effect independently checks actual Git ancestry, allowed paths,
verified App author **and committer** for new first-parent commits, current execution
proof, requirements and GitHub PR repo/head/base/SHA/creator/marker. Existing human
history is not rewritten. The host retains the SDK commit SHA; it does not reseal
a different SHA after a PR exists. Actual host tests then execute against that SHA.

Reviewer uses `gh pr review NUMBER --approve --body-file /path/to/review` or
`--request-changes`. The wrapper pins the exact candidate commit and stamps the
original Task-role Session marker; retries query actual Reviews first. Host adoption
requires an actual submitted, matching-SHA/matching-Session Review from the configured
Reviewer App, distinct from the Dev App. A model's approve string is insufficient.
Actual Review, role output, independent signed forge Review PASS, CI/check result,
provider-confirmed merge and Chief Task acceptance remain separate facts. App Review
does not forge a contributor pipeline PASS or close a Task.

## Observe and recover through the existing API

Use the standard service login and `project-development` envelopes from
[API reference](development-service-api.md) / [OpenAPI](openapi/flybot.openapi.json).
No public credential-issuance endpoint is exposed.

- `github.connection`: safe role binding status/revision and identity reuse warning.
- `task` / `tasks`: physical execution `githubAccess` contains identity,
  scope hash, status, renewal flag and expiry; no key, Token, FIFO or private path.
- `task.detail`: Attempt PR creator/merger identities, `sdkPublication` and original
  `sdkCandidateEffect` reference. `attempt.context` pages `sdkPublication`,
  `publicationRecoveries` and original `evidence` with hash-bound cursors.
- `effects` / `effect.retry`: original candidate/publication/merge Effects and receipts.

For a PR created before the host recorded its candidate, an authorized manager
(or currently delegated watch agent with the manager's rights) can reconcile:

```json
{
  "version": "project-development/v1",
  "kind": "command",
  "name": "attempt.publication-retry",
  "projectId": "PROJECT_ID",
  "requestId": "recover-original-sdk-candidate",
  "payload": { "attemptId": "ATTEMPT_ID", "phase": "candidate" }
}
```

Wrap this v1 value as `{"endpoint":"project-development","payload": <value>}`
for HTTP, or use `backend.mjs command attempt.publication-retry` with the same
Project/request ID and JSON payload.
The original Dev workspace/Session and execution evidence must remain available;
all workers/leases must have confirmed release, and current requirements/claim and
remote PR facts must match. A failed candidate Effect needs an explicit authorized
`effect.retry` first. Recovery queries actual remote state before any repeated write,
never edits Attempt JSON, creates another PR, bypasses tests or adopts a forged URL.
Omit `phase` for the existing **reviewed-publication** retry, which still requires
matching tests/Review and an existing PR binding. Preserve history and use normal
successor Attempt rework when a formal candidate changes.

## Validation boundary

Unit/integration tests use real local Git with deterministic App/GitHub responses.
The opt-in `core/test/project-role-github-sdk.test.js` exercises the installed actual
Codex SDK/CLI and sandbox with a local Responses fixture, both locally and in Docker;
its credential and gh responses are fixtures. This is distinct from real App writes.
Live acceptance needs separately authorized installed Dev/Reviewer Apps and a test
repository: verify actual push, Draft PR, exact-SHA Review/check and controlled merge,
then compare creator/author/committer/reviewer/merger and host evidence. Until those
resources are supplied, do not report real GitHub App acceptance as complete.
