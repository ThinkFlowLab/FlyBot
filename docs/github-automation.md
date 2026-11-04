# Project GitHub automation

FlyBot supports `gh-cli` and GitHub App installation credentials through the same
host brokers, Effects, candidate checks and recovery records. Personal comments
and personal reads retain independent user credentials. Installing FlyBot enables
neither external writes nor a GitHub App. No ambient/Owner credential fallback exists.

## Operator provisioning

Existing `projectRepositories["org/repo"].github` settings continue to work:

```json
{"credential":"gh-cli","configDir":"/private/project-gh","login":"automation-login"}
```

An App can be provisioned in that same private operator configuration location,
or as a named connection that human project managers can select:

```json
{
  "projectGithubConnections": {
    "team-app": {
      "credential": "github-app",
      "appId": 12345,
      "installationId": 67890,
      "privateKeyFile": "/private/flybot-app.pem",
      "projectIds": ["PROJECT_ID"],
      "repositories": ["org/repo"]
    }
  }
}
```

IDs are positive integers. The RSA private key must be at least 2048 bits, in an
absolute, current-service-user-owned regular file, mode0600, at most16KiB; symlinks
are refused. Store it outside repositories/workspaces and grant the service only
the required access. App registration, installation approval, repository scope and
key rotation are operator/human actions; neither model nor FBA Token can perform them.
The App slug is verified through the installation and recorded as `slug[bot]`;
optional `login` pins that expected login. Multiple projects may share an App,
but each connection must explicitly list each permitted project and repository.
App IDs are identities, not secrets; keys/JWTs/installation Tokens remain private.

Required repository permissions depend on the operation:

| Broker operation | Token permissions |
| --- | --- |
| Select/verify connection; Release observation | contents:read |
| Push candidate and create/reuse PR | contents:write, pull_requests:write |
| Read PR/publication upstream | contents:read, pull_requests:read |
| List issues / issue thread | issues:read |
| List/read PR, Reviews | pull_requests:read |
| Read PR checks | pull_requests:read, checks:read |
| Pull thread including comments, Reviews, checks | pull_requests:read, issues:read, checks:read |
| Explicit Release publication | contents:write |

GitHub's implicit metadata permission also applies. Grant only operations the
project needs. Workflow-file updates may require GitHub permissions beyond this
first provider's fixed operations; such writes fail closed rather than escalating.

## Human selection through the existing service

Use the normal login and `/api/bot` `project-development` transport documented in
[API reference](development-service-api.md). Query `github.connection` with optional
`repository` (default project repository). It reports non-sensitive connection
options, selected revision and configuration status; it does not perform a probe.
An Owner/Maintainer personally selects an already provisioned connection:

```json
{"version":"project-development/v1","kind":"command","name":"github.connection.configure","projectId":"PROJECT_ID","requestId":"select-team-app-1","payload":{"connectionId":"team-app","expectedRevision":0}}
```

The command verifies the installation/login using a read-only operation, rechecks
human authority and project/repository binding, and commits the selection with
original Effects and a normal command receipt. Repeat identical requests with the
same ID after a lost response; a later selection requires the returned revision.
`connectionId:null` explicitly disables project automation for that repository;
it never falls back to the legacy profile. Bots, including full-watch agents and
Chief, cannot select, replace or expand credentials. Normal bot operation still
uses their current Project/Task rights. There is no new control-plane/UI requirement.

Legacy repository settings apply only until a human makes an explicit selection.
One Project may have different selected connections for associated repositories.
Changing an installation/App identity requires human verification again. Removing
an allowed project/repository, disabling the connection, or disabling automation
immediately causes subsequent broker operations to refuse.

## Token lifecycle and failures

The host signs RS256 JWTs (iat60s in the past; exp9min in the future), verifies the
current repository installation, App ID, installation ID, suspension, account and
operation permissions, and requests a Token restricted to that single repository
and required permissions. Installation authentication never uses `/user`.

Tokens stay in a bounded in-process cache, refresh60s before expiry, and merge
concurrent refreshes. They are never persisted. Restart remints; rotating the
private key changes the cache key while retaining the logical operation identity.
Token formats containing dots are supported. Every operation verifies the current
installation even on a cache hit. Authentication refusals invalidate cached Tokens;
no external write is automatically retried under another credential.

Status distinguishes configured settings from per-operation verification. On an
installation/key/scope failure, an authorized human checks `github.connection` and
the operator repairs the installation, permissions or private file. Re-verify a
changed connection with a new command/revision. Do not replace an unresolved PR or
Release intent with a new request ID: inspect its original Effect/receipt and
external object first. An identity change stops the old operation for reconciliation.

## Identity, audit and recovery

Publication pins the logical provider, installation/profile, repository and human
selection revision before external I/O. Token refresh and same-App key rotation do
not change that identity. Provider/installation changes cancel old work without
silently rewriting its PR or discarding candidate/test/Review evidence. Existing
PR branch/head/upstream/ancestry checks, unknown-result reconciliation and Release
submission fencing remain authoritative. No merge or repository gate is bypassed.

PR receipts include provider/login, App/installation IDs, credential fingerprint,
repository, Task/Attempt/candidate SHA, initiator and host publication role. Release
records retain authorizing human/agent, Task/Attempt, pinned SHA and typed external
identity proof. Reads report the actual selected identity. No audit field contains
credentials. Current personal comment audit retains its independent user identity.

Host-created local/resource Git commits keep `FlyBot project automation
<flybot-project@localhost>` as author/committer. Push, PR and Release identity is the
verified gh login or installation bot; these are separate facts. One App is one
GitHub identity, regardless of FlyBot Dev/Reviewer/Tester roles. It does not supply
independent GitHub approvals or waive FlyBot role Review, Chief adjudication or
repository protection.

## Validation scope

Regression coverage uses real RSA JWT verification, isolated private key files,
local Git pushes and deterministic GitHub responses. Both providers exercise
publication/read/reuse/lost-response contracts. Real FlyBot runtime receipts and
restart preserve selections without persisting credentials. This is not an actual
GitHub App installation/write acceptance: that requires separately authorized test
App/repository resources. Existing operator credentials and live services are untouched.

References: [JWT authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app),
[installation Tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).

## Reviewed host merge (#2331)

The same selected gh-cli/App publisher now supports configured merge, with no
ambient/Owner fallback or role credential injection. Draft ready, checks, queue and
observed merge remain separate. See [policy, permissions and recovery](project-merge.md).
