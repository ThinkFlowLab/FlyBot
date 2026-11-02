---
subsystem: project-domain
owned_paths:
  - core/src/host/project-domain.js
  - core/src/host/project-service.js
  - core/src/host/project-lifecycle.js
  - core/test/project-lifecycle.test.js
  - core/src/shared/project-policy.js
  - core/test/project-domain.test.js
---

# Project domain (fork M1)

Project is the durable unit of work. Bot/room bindings choose the default Project for
new work; moving a Bot or editing a workflow cannot move an existing Task or Run.
The implementation stays in the FlyBot process and its locked state.json store.
Control-plane source, tables and deployment configuration are unchanged.

M2 extends the human access/API contract through [Project access](project-access.md).
Its explicitly configured path supersedes M1's primary-owner-only read limitation;
M1 ownership, migration and lifecycle invariants still apply.

## Boundaries

`store.js` owns locking, durable snapshots, identity migration and load/refresh.
`project-service.js` owns the existing Project management/memory API and lifecycle
orchestration. `project-domain.js` owns ownership, execution context, migration and
Workspace metadata. `projectRepository(state)` reads tables at call time so refresh
cannot leave a captured stale table. `shared/project-policy.js` holds the existing
human Owner/Maintainer/Member policy; AI labels such as Chief/Dev/Reviewer are not
human permissions. Existing `rt.createProject`/`bindProject` aliases remain compatible.

## Records and relationships

| Record | M1 contract | Later milestone |
| --- | --- | --- |
| Project | Stable id, repository/defaultBranch, owner IDs, active/archived; deleted tombstone in projectArchive | M2 project policies/quotas |
| Membership | Existing project.roles + owner IDs reference host human members; policy is separate from Bot.role | M2 explicit membership and platform subject mapping |
| AgentDefinition | Existing Bot persona/tools/skills are reusable definitions; bindings are routing defaults | M4 public/private definitions and instances |
| Task | Direct immutable projectId (including explicit null), requesterId from actor, parent/rework references | M3 implementation and acceptance evidence |
| WorkflowDefinition | Existing plugin graph/template, optional default projectId | M3 project execution policy |
| Run / Attempt | Each run id is one execution attempt; direct projectId snapshot in plugin and canonical projectExecutions, taskId when host Task exists | M3 attempt lineage, worktree and durable dispatch protocol |
| WorkerLease | Existing claim worker maps carry the Task's projectId; lease expiry/retry never moves the Task | M3 physical isolated workspaces |
| Workspace | projectWorkspaces has immutable id/projectId/path, kind=reference; records a directory reference only | M3 allocate worktree, isolation, release/cleanup |
| Evidence | Existing Task result/audit and Run history retain their original projectId references | M3 typed artifacts/test/PR/review evidence |
| Private assistant | Existing per-Project/per-owner assistant memory; deleted through existing privacy cleanup | M4 separate shared and private agents |

No microservice, scheduler, second Task store, physical Workspace allocation, new
control-plane schema, or completed shared authorization is claimed by M1.

## Migration

Additive state.json v2 migration runs on load/refresh and is saved by the existing
store migration path. Task fields already present, including null, are not re-inferred.
A legacy room binding takes precedence over its carrier Bot; parent/rework and explicit
run bindings add candidates. One known candidate becomes projectId. Conflicting,
missing or absent candidates leave projectId=null and projectResolution containing the
reason and sorted candidate IDs. No Task/result/audit is dropped. Legacy projectRuns
bindings are copied into direct execution records; the old map remains a compatibility
projection. Unbinding that map does not erase the execution's ownership history.

Workflow provider registration explicitly imports legacy run/task links and persists
any changed resolution. Every run reference is considered, including multiple runs for
one Task. It merges the original recorded candidates, not the Bot's current binding.
Board/detail reads do not migrate or write. Unresolvable plugin Runs receive explicit
null and an unresolved reason; a known host run record or saved Task supplies the ID.
A current graph binding is never used to guess an old Run's Project.

Use the upgraded FlyBot for homes migrated by M1. The additive v2 format cannot force
older FlyBot binaries to honor the new ownership fields. Back up the home before
upgrading; rollback code and its matching pre-upgrade data together.

## Lifecycle

- Archive preserves existing work/history and permits existing Runs to report terminal
  state. New Tasks, new Run attempts, new Workspaces and rework creation are refused.
- Delete refuses unfinished Tasks or queued/running/paused canonical Runs or unresolved legacy Runs. It retires
  the existing assistant/Chief and clears mutable bindings/private memory as before,
  but preserves a Project tombstone, Task/Run/Workspace projectId and existing evidence.
  A reference Workspace is historical metadata; deletion never removes its directory.
- Removing a host member refuses Project owners and unfinished requesters. A successful
  removal revokes sessions and removes human role memberships; history keeps IDs.
- Task/Run projectId cannot be changed through updates or rebinding. A Run cannot attach
  a foreign Task/Workspace or swap its task/workspace reference. New work derives its
  context from the host Task and checks archived status before ephemeral Bot creation.

## API and frontend contract

Existing `projects`, `project-read`, `project-board`, `project-team` continue to work.
New owner-only endpoints are `project-archive {id}`, `project-workspace-create
{projectId,path}` and `project-detail {id}`. Detail returns Project (including deleted
tombstones), visible Tasks, canonical Runs, reference Workspaces and unresolved
migration rows. Authenticated actor identity is supplied by the host, never body fields.
These endpoints retain the primary-owner gate; M2 will supply a complete permission
matrix before enabling shared writes. Detail is not a multi-user public API yet.

The target navigation is Projects → Project overview/team/tasks/runs/workspaces;
Task detail joins its immutable Project, execution attempts and evidence. Human role
controls and agent role labels are separate. M5 may replace current frontend components
and routes while reusing these read models. No UI redesign is bundled into M1.

The typed plugin seam exposes projects.read/readRun/context/bindRun. Context validates
the saved Task's Project; bindRun accepts optional taskId/workspaceId/status metadata.
Workflow reports terminal states to the host. Reporting uses two existing JSON stores,
not a distributed transaction; M3 must reconcile dispatch/terminal reporting across a
crash. An unexplained active canonical Run deliberately blocks deletion.

## Verification

`core/test/project-domain.test.js` covers rebind/restart, durable/idempotent migration,
conflicts, ownership immutability, archive/delete/history, foreign references, owner
gates and member removal. Existing Project board tests retain visibility and read-only
checks. `plugins/workflow/test/project-domain.test.js` covers graph rebind/restart,
terminal reports, foreign/archived admission before spawn. They run through existing
core/workflow globs in `npm run verify` and the test workflow.

`npm run test:demo:runtime` uses a real pinned DSH with a deterministic model and real
shell tools: it creates a Project Task, rebinds its Bot, verifies the original board,
executes its Workflow, and checks direct ownership plus the canonical terminal report.
It creates disposable data and does not deploy or change control-plane.

## Fork M3 — 2026-10-31

M3 extends reference Workspaces to registered per-role worktrees; canonical Runs retain
Attempt/Workflow/Workspace IDs, each immutable once bound. Project deletion refuses
unfinished delivery Attempts. [Delivery contract](project-delivery.md) adds sealed-commit
evidence and human acceptance without changing Project identity/migration invariants.

## Fork M4 — 2026-10-31

M4 private agent identities remain separate from shared Project records/Task evidence.
Delete blocks new work before asynchronous retirement, clears private agent notes/logs
and retains shared public discussion under the authorized Project tombstone. Legacy
mode behavior remains separate. [Agent lifecycle](project-agents.md).

### M5 workbench integration

The [Project workbench](project-workbench.md) uses this domain through scoped endpoints.
Queue admission rechecks current membership, preserves immutable Task/Run ownership and
allocates worktrees only when quota permits. Explicit stop releases the existing single
Run; orphan Workers retain capacity. Shared Project creation cannot supply filesystem cwd,
and scoped agent/Worker identities cannot move to a different Project.

## Project convergence — issue #2171

Project records now retain description, goal and scope. ProjectRepository association
records are keyed by a stable Project/repository digest; zero or many associations
per Project and the same repository across Projects are supported. Loading migrates
the legacy repository/defaultBranch once, preserving Task/Run ownership and the
legacy execution target. Reads do not create associations. Linking another repository
does not silently switch execution. Unlinking the selected legacy target is refused
while unfinished work depends on it; explicit Task repository selection is a later
Task-contract concern. With no unfinished work it can be removed, including the
last association, without deleting a repository or rewriting existing history.

Authenticated native endpoints: project-repositories (read), project-repository-link
and project-repository-unlink (Owner/Maintainer configure), project-close-request
(Owner/Maintainer suggestion), project-close-prepare and project-close-confirm
(Owner personally). Preparation persists a hashed, owner-bound, expiring challenge
and final record without closing. Confirmation rechecks current membership, principal,
Project basis and challenge, then persists closed status and final record with current
unfinished Task references. A matching owner retry returns the original closure.
Delegated identities cannot confirm. A failed save restores the previous state.

Closure is distinct from legacy archive/delete: it retains the Project, bindings,
private/shared histories and memory, permits authorized reads and refuses further
Project mutations/new work. It does not claim active external workers have exited;
confirmed stop/reconciliation stays in the execution service. It adds no requirement
to finish Tasks before closing. Legacy delete/archive cannot erase or relabel a closed
Project. This stage preserves legacy interfaces; full role-change proposals/approval
and dynamic execution compatibility remain tracked with role/execution convergence.

## Independent personal-agent integration

Load migration also relates legacy private Project agents to independent user identities and participation scopes; it preserves Task/Run and private carrier history. Personal-agent native endpoints enter through the same authenticated service before Project-scoped routing.

## Scoped connection integration

Authenticated internal/external personal agents can suggest closure as their current member without gaining Owner confirmation rights. Suggestions record the stable personalAgentId; safe native private agents use a scoped suggestion tool. This addresses the proxy-suggestion integration from #2171; role proposal/approval remains pending.
