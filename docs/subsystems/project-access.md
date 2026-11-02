---
subsystem: project-access
owned_paths:
  - core/src/host/project-access.js
  - core/src/host/platform-identity.js
  - core/test/project-access.test.js
  - core/test/platform-identity.test.js
---

# Shared Project access (fork M2)

R6 `project-queue-retry {queueId}` passes through the restricted gateway and HTTP
dispatcher to scheduler authorization. It requires current Owner/Maintainer
run-control permission on the queue's Project, then independently validates the
original initiating human before requeueing the same request. Body identity and
management of another Project grant no recovery authority. Read-only/query agents
gain no access to this operation.


M2 is an explicitly configured Project workbench path. It reuses unchanged
control-plane `/api/auth/login`, `/api/auth/session`, `/api/auth/logout` and account
administration. FlyBot owns the subject adapter, Project roles/invites/policy and
scoped Workflow gateway. It does not alter platform source, schema, host manager,
launch-token routing, cookie domain, deployment or upgrade configuration.

## Configuration and identity

The `bot` Cordis entry may configure:

```yaml
config:
  projectWorkbench: true
  controlPlane:
    origin: https://panel.example.com
    ownerSubject: explicitly-provisioned-platform-user-id
```

`origin` must be HTTPS (loopback HTTP is accepted for the disposable demo), with no
path, query, credentials or fragment. `ownerSubject` is operator provisioning, never
first-login inference. Its verified subject binds to owner-1. Other subjects map to
stable issuer-scoped IDs; the platform admin role does not grant any Project role.
`projectWorkbench: true` without controlPlane supports existing local identities for
isolated tests; the complete shared demo configures the platform adapter.

`platform-login {email,password}` forwards only those credentials to the existing
platform login API and returns an opaque FlyBot member session. Accounts and platform
invitations remain managed by control-plane. Passwords and raw platform Cookie/CSRF
values stay in memory, never state.json or application output. Each channel request
validates the upstream session again with a five-second timeout and redirects disabled;
a failed/expired/suspended/mismatched subject fails closed. Session cookie refresh is
kept only in memory. No positive authentication cache exists. Restart deliberately
requires login again; subject mappings and Project memberships persist.

`auth-revoke` also calls existing platform logout and revokes the local session even
if the platform is unavailable. Local account invitation/redemption/removal APIs are
blocked with platform identity configured; there is no local-token fallback.
Credentials use the existing DSH authenticated same-origin channel, whose transport
admission is still required. No cross-subdomain cookie sharing is introduced.

## Human operation matrix

| Operation | Owner | Maintainer | Member | Nonmember |
| --- | --- | --- | --- | --- |
| Project, board, detail, members, scoped Workflow state | yes | yes | yes | denied |
| Create active Project Task | yes | yes | yes | denied |
| Update/cancel/request input/report own Task | yes | yes | own request only | denied |
| Update another member's Task, accept/send back delivery | yes | yes | denied | denied |
| Start a Run | yes | yes | own Task only | denied |
| Pause/resume/reset Run | yes | yes | denied | denied |
| Configure graph/model/concurrency/Workspace reference/quota | yes | yes | denied | denied |
| Invite/remove Member | yes | yes | denied | denied |
| Remove Maintainer, assign role, archive/delete/bind Project | yes | denied | denied | denied |
| Leave Project | owner cannot leave | yes | yes | denied |
| Legacy private memory/team details | primary owner only | denied | denied | denied |

Roles are the human `project.roles` policy, never Bot.role, body userId/memberId/role,
or platform account role. Human identities are derived from the authenticated session.
New shared Tasks cannot clear projectId to escape later revocation. Public/individual
agent privacy and delegated authority are extended by M4; M2 does not expose private
Chief/assistant chats to other members.

Project invites are random, hash-only, single-use, expire after 24 hours and grant
Member to the authenticated joiner. They cannot create a platform account or grant
Owner. Outstanding invites also require their issuer to retain invite authority.
Membership/role changes take effect on the next request, including a stale
page or cached actor. Removing/leaving revokes unused invites issued by that member.
Admitted project work continues under project authority; its requester/evidence remain
attributed. Removal does not silently cancel or reattribute a running task. Owner and
Maintainer may control it. Removed members cannot start or read work. Host member
removal still follows M1's anti-orphan rules; platform account suspension is handled by
the existing platform session API and management endpoints.

## Workflow execution boundary

Use `project-workflow {projectId, operation, ...}`. Supported operations are state,
templates, create, graph, concurrency, set-model, step-timeout, assign, pause, resume,
reset and delete. It reuses the existing workflow plugin service. Project/Task/Run IDs
are checked before dispatch, and Project context/capping Bots are host-derived.
The gateway never opens the existing global plugin write gate. In workbench mode,
unscoped plugin APIs, the second workflow-definition surface and global usage are
denied; the built-in Bot/change projections retain only the caller's own permitted
records. Existing single-human behavior remains when workbench mode is off.

Returned Workflow rows/runs/history/queue/held tasks are filtered to the Project.
Legacy mixed-project transcript/preview rows are not exposed; M3 provides typed Run
logs/evidence. Gateway creation binds the new graph before it may run. Shared Task
writes do not auto-ingest through an unscoped plugin route, and the old run/define
workflow tools direct callers to this gateway. M4 introduces explicit agent authority.

Quota is Project maxConcurrent (1–32, default 2), independent of graph concurrency.
Admissions are serialized; a repeated start returns an already-active Run and a
foreign active Run for the same Task is refused. At capacity M2 returns bot/quota;
M5 adds the visible queue. Node connector declarations are refused until explicit
project credentials are supplied in M4. Ephemeral Bots receive checked execution
Project context and that Project's owner, avoiding the legacy ambiguous-owner fallback
on a two-member runtime. This is automation ownership, not personal GitHub delegation.
Physical code workspace isolation remains M3.

## Verification

`project-access.test.js` covers the matrix, forged identity/AI labels, hash/single-use
invitations, revocation/stale pages, acceptance, null detachment, unscoped read denial,
real service gateway isolation, concurrent quota admission and duplicate starts.
`platform-identity.test.js` covers issuer/subject binding, no persisted credentials,
upstream suspension/logout/substitution, restart login and invalid configuration.
Both use existing core test globs; Workflow regressions retain normal legacy behavior.

Run the actual platform + DSH proof against an unchanged checkout:

```sh
/path/to/platform/python dev/demo/control_plane.py --control-plane /path/to/control-plane --shared-check --port 0
```

It creates private disposable SQLite/accounts, then actual pinned DSH with a deterministic
model and real shell tools. Alice invites Bob, both read the same Task/board, Bob executes
the Project Workflow, removal denies stale Task/detail reads, platform suspension
invalidates the existing session, and logout is refused thereafter. Credentials are
passed to the child over stdin, not command-line arguments or inherited environment.
The CI test job runs this after M0 checks against the same immutable platform source
and asserts the platform worktree remains clean. Actual model/GitHub/browser delivery
acceptance is M3/M6, not a claim of these tests.

## Fork M3 — 2026-10-31

M3 adds project-task-run/detail/accept/reject and project-attempt-log/cleanup under the
same current human membership policy. Fixed-template server creation does not delegate
arbitrary configuration to a Member. Managed delivery graphs cannot be reset/edited;
new retries use new Attempts. [Delivery contract](project-delivery.md) records the exact
evidence gates, operator repository/GitHub provisioning and current validation limits.

## Fork M4 — 2026-10-31

M4 adds agent/knowledge/credential routes with current Project access, own private
identity and live human delegation. Personal GitHub authority cannot come from Project
Owner rank. Member/session revocation cancels agent chat capabilities while preserving
admitted Project code work. [Agent contract](project-agents.md).

### M5 workbench integration

The [Project workbench](project-workbench.md) uses this domain through scoped endpoints.
Queue admission rechecks current membership, preserves immutable Task/Run ownership and
allocates worktrees only when quota permits. Explicit stop releases the existing single
Run; orphan Workers retain capacity. Shared Project creation cannot supply filesystem cwd,
and scoped agent/Worker identities cannot move to a different Project.


### Fork M7.1 — 2026-10-31

M7.1 routes project-role-memory-write through the existing shared gate; current Project configure permission is required. Role memory refs are checked against both Project and role, with no private-agent fallback.


### M7.2 — 2026-10-31

M7.2 project-resource-environment-check requires current Project configure authority and an operator resource grant. This is a fixed bounded runtime probe, not arbitrary command execution; it does not establish SDK authentication.


### M7.3 checkpoint — 2026-10-31

M7.3 project-execution-input revalidates current Task write authority, worker generation and waiting state; permission approvals additionally require configure authority. It cannot select another Project or arbitrary backend Session.


### M7.4 — 2026-10-31

M7.4 routes runtime-check and terminal open/poll/input/resize/close through existing live Project identity. Member removal closes matching terminals immediately; task execution authority remains separate. A terminal needs resource admin in addition to configure.


### M7.5 — 2026-10-31

M7.5 adds actual HTTP-channel routing regression for environment/runtime/terminal/input endpoints. They must call projectEndpoint and its live configure/admin/Task guards, not workbenchEndpoint read models. The two-account browser reproduces Member terminal denial and actual Owner PTY operations.


Repair R3 (#36): `project-task-pools {projectId}` returns current Project-member-visible queues per logical Bot. Claim and execution results revalidate the initiating human against current Task/Project authority; role names are not authorization. Task completion in pool mode requires Chief arbitration. See [pool contract](project-pools.md).


Repair R4 (#37): `project-chief-question` and `project-github-read`
are membership-guarded workbench endpoints. The host derives inquiry return
identity and repository scope. Model-supplied Project/member/URL fields cannot
select another conversation, credential or repository. See [GitHub reads](project-github-read.md).


Repair R5 (#38): `project-agent-mode` is human-only, scoped to the
current account and Project. Watch actors carry a bound grant/generation checked
at every Project boundary. Membership removal revokes grants and stops affected
claims. Scoped GitHub and runtime setup accept validated persistent actors, without
falling back to another browser or credential. See [delegation contract](project-delegations.md).

Repair R6 Chief job actors must validate a private active-job token, current
configured policy revision and configuring human's current account/Project rights.
A Chief role name alone grants no access. New control endpoints remain Project scoped.

Authenticated HTTP route regressions cover every R3–R6 collaboration endpoint
and reject a nonmember at the real Project boundary, beyond direct service tests.

R7 room list/create/read/message/document/stop and agent-stop endpoints pass the actual
channel dispatcher and restricted gateway into current Project membership checks.
Restricted rooms additionally require an explicit participant; document IDs are scoped
to that room. No primary-owner or ambient raw Session bypass exists. SDK resource read
models hide workers bound to rooms the caller cannot read.

Chief inspection may explicitly select one existing Task in its authorized Project. The host validates Project configuration authority and Task ownership before using the existing scoped snapshot mechanism. Other-Project/missing Tasks are rejected; unscoped inspection is unchanged. This reduces unrelated facts without dropping policy/knowledge or raising context limits.

Board reads may request `project-detail {view: summary}`. The same Project/member policy runs first; the response contains Project/permissions and card fields only, omitting Task results/claim contexts and Run/Workspace history. Full detail remains unchanged.

## Development service compatibility (S1)

Versioned project-development requests and legacy delivery/queue/Chief/delegation endpoints now enter the shared application facade after authentication. Both retain current Project/action checks; unsupported versions, wrong operation kinds, foreign targets and stale admission preconditions are refused. Task detail adds the same derived view used by the workbench. See [service contract](project-development-service.md).

## Durable effects and outbox (S2)

The versioned service exposes scoped effects status and manager retry. Legacy personal comment writes now enter the same service facade; current Project, own personal credential and safe/watch authority remain mandatory. No generic effect enqueue or raw event authority is exposed to HTTP. See [effect contract](project-effects.md).


## Durable Task inbox integration (S3)

S3 exposes input.publish/inputs only through the existing authenticated versioned service. Member removal permanently invalidates that source’s pending inputs; regrant cannot consume or revive them. No caller can supply source/recipient/claim or raw read receipts. See [Task inputs](project-inputs.md).

Task40 room/conversation-stop routes remain in the Project-scoped fallback after the
S1 facade has selected its owned operations. Shared-mode admission recognizes both
vocabularies, without opening either in legacy mode or bypassing downstream member/
action checks. The public development facade retains legacy Chief/schedule/delegation
handlers; integration does not reinstall earlier direct handlers ahead of it.

## Project convergence integration

Project convergence #2171 adds closed as a read-only lifecycle: authorized members retain history/final-record reads; create, configure, run and acceptance permissions are refused. Scoped Project reads include goal/scope, repository associations and the public closure record, excluding confirmation secrets.

## Independent personal-agent integration

Independent personal-agent endpoints enforce their own current-user ownership and current membership on join/default selection. Watch grant validation also checks a linked carrier participation so retirement cannot keep using delegated rights.

## Scoped connection integration

Agent connection authority intersects current human Project role, explicit credential scopes, active participation and the existing safe/watch mandate. Scope filtering applies to Project listings and reads, not only commands; body identity and default routing do not grant rights.
