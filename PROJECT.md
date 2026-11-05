# FlyBot — Project State

#2483 controller-loss recovery joins a resource-side settled stop receipt with exact process exit, or existing durable host exit evidence. Reconcile worker and lease together; physical exit grants no Task completion or next-role decision.

#2483 restart recovery notifies the resident Chief through existing durable inspection requests. Current exit/retirement facts wake judgement; Chief chooses recovery and unknown exits remain held. Endpoint tests alone do not prove this notification chain.

#2483: Developer Git mutation rights follow its bound isolated resource clone, independently of App credentials. Shared host Git metadata and read-only role policies keep their existing boundaries.

#2483 dispatch/input follow-up keeps waits attributable and declarations explicit: no acceptance across unhandled batches, no stale notification/decision replay, no automatic role or human escalation.

#2483: refused durable reads retain current in-memory Task/Session references and prohibit writes. Read-only verification reports metadata; write readiness is separate from process liveness. Recovery remains Chief judgement.

#2413: provider-confirmed merge and durable Chief handoff use separate existing Effects. Recovery never repeats merge to notify, never accepts a Task; current Chief facts and exact candidate/authority remain required.


#2378 reuses role Apps for bounded PR/CI reads and hash-verified host logs in Reviewer scratch; absence or incomplete pages are not verification success.

#2393 keeps Chief execution faults on their Run, preserves business evidence and returns per-Task/current-snapshot correction; Agent chooses recovery through existing capabilities.


#2375 adds explicit exit-proven claim retirement through existing pools/Effects; preserve drafts, pending results and unknown writes. No cancellation or automatic routing.

#2377 makes successor baseline choice explicit and durable; preserve cancelled history, Task-role context and draft lineage without inventing PR or test evidence.

The single page that says what this project is, who decides what, and what automation must never
do. Operational rules live in [AGENTS.md](AGENTS.md) and [CONTRIBUTING.md](CONTRIBUTING.md);
architecture lives in [docs/architecture.md](docs/architecture.md) and
[docs/subsystems/](docs/subsystems/README.md). This page links them and does not repeat them.

Current stage and priorities: [ROADMAP.md](ROADMAP.md). How decisions are made:
[docs/governance.md](docs/governance.md). Dated decisions: [decisions/](decisions/README.md).

## Runtime and recovery contracts

Earlier implementation checkpoints are [preserved verbatim](docs/history/2026-11-05-controller-exit-memory-checkpoints.md).
Current resource profile identity, Task-role context, CLI/configuration validation and
owned pre-spawn reservations remain binding. Unknown worker/preparation exit keeps
occupancy; dependency readiness and exact-candidate test evidence remain separate.
Apps require explicit installations and scoped credentials with no Owner fallback;
SDK candidate/PR adoption, App Review, host merge and Chief acceptance remain distinct.
Recovery/correction reuses original queues and schedules, preserves drafts and current
rights, and never chooses automatic business escalation. All canonical subsystem
contracts remain active. No live task/config/credential change or deployment is implied.

## Established backend foundations

Dated agent-connection, personal-agent and backend-convergence implementation
checkpoints are [preserved verbatim](docs/history/2026-11-04-agent-foundation-checkpoints.md).
Current authority, same-principal inbox/receipt, public OpenAPI and native/external
agent contracts remain in their subsystem pages; source/fixture results do not
complete live App/provider/release/multi-repository/UI acceptance or authorize deployment.

## Fork Project State — 2026-10-31

Earlier source snapshot/deployment checkpoints are [preserved verbatim](docs/history/2026-11-04-recovery-source-checkpoints.md). Current interfaces follow the README and subsystem contracts. Keep original frontend Task40/PR48 and healthy schedules; this backend work is direct-session source delivery without deployment.

## Historical upstream Project State

Historical upstream mission, named roles and resource inventory are [preserved verbatim](docs/history/2026-11-03-upstream-project-inventory.md). Current fork ownership and capabilities follow the active state and dated decisions above. The governing and automation boundaries below remain active.

## Governing boundaries

Who decides what is written in [docs/governance.md](docs/governance.md), in the operational wording
this repository uses today. In short:

- **The owner** decides the mission, the governance policy, the roles and their membership, the
  autonomy boundaries, the security surface, and any matter reserved in that page.
- **A human maintainer** concludes major decisions, records a verdict, and can challenge any
  classification.
- **Chief** classifies decisions, routes work, records outcomes, and escalates what it may not
  conclude. A classification is a routing label, never an authorization.
- **A routine Bot** concludes only ordinary work inside its routine, through the gates in
  [AGENTS.md](AGENTS.md).

### What automation may never do

These hold for every Bot and every routine, whatever the CI state, the label or a chat message says:

1. **No production deploy** of Bot Social, and no change to the owner's own local instances, without
   the owner's explicit yes.
2. **No secrets** — never write, print, log or commit an API key, token, cookie or `DSH_HOME`
   contents. A withheld key is read from `DSH_SECRETS_WITHHELD` by name only.
3. **No touching the owner's DSH data** — never point a test or a run at `~/.dsh` or at a DSH the
   owner is using; the test bench keeps its own `.dsh-test-<name>/`.
4. **Never patch DSH** and never depend on files inside a DSH install. Build on the documented
   plugin APIs or stop and say what is missing.
5. **Never bypass a gate** — no admin merge, no force-push of `main`, no bypass of a required check,
   no change to a ruleset or to branch protection, and never remove a pull request the owner put in
   the merge queue.
6. **Never lift `hold`.** Only a person sets the label and only a person removes it.
7. **No version or changelog edits outside the release routine** — `CHANGELOG.md` and
   `core/package.json` belong to the daily release, not to a feature pull request.
8. **No issue on someone else's upstream**, and no design proposal filed as an issue: a proposal
   goes to the owner, who decides whether it becomes work.
9. **Never write a verdict on a change the same Bot implemented**, and never record a second
   conclusion at one tip to win a disagreement.
10. **Never edit another writer's text to change what it said** — a correction is a new comment, a
    new decision record or a `Correction from <Bot>:` line.

Changes to this page, to `ROADMAP.md`, to `docs/governance.md` or to `AGENTS.md` are **major**
decisions, concluded as [docs/governance.md](docs/governance.md) requires and recorded in
[`decisions/`](decisions/README.md).

M5/M6 implementation and dated live-acceptance evidence are
[preserved verbatim](docs/history/2026-11-04-m5-m6-implementation-evidence.md).
Those snapshots do not establish current-source or current-UI acceptance. Keep
explicit credentials private, unchanged Control Plane reuse, current authorization,
independent same-SHA verification and separate real-provider/deployment boundaries.

Earlier M7.2/M7.3 implementation-status checkpoints are retained verbatim in
[the historical record](docs/history/2026-11-03-completed-m7-checkpoints.md). Current
resource/Harness contracts and authorized acceptance boundaries remain below.

M7.4/M7.5 implementation checkpoints are [archived verbatim](docs/history/2026-11-03-completed-m7-checkpoints.md). Private credentials, revocation, exit proof, same-SHA verification and outstanding mixed-Harness/resource acceptance remain required.

### Historical Codex acceptance

The explicitly authorized 2026-11-01 Codex demonstration and its scope are retained
in [the dated record](docs/history/2026-11-04-agent-foundation-checkpoints.md).
It grants no new deployment, App installation or personal credential authority.

### Collaboration contract and earlier validation

Native multi-Bot UI, per-Bot handoff pools and complete pinned role conventions remain required. Ordinary Chief questions are conversations; safe/watch delegation uses current human permissions. Chief inspection uses the original DSH scheduled-task service with editable cadence/content/thresholds (the current template defaults to30 minutes), never a hardcoded framework workflow. Code changes retain required memory/tests/architecture evidence. Earlier R1–R7 implementation and runtime validation are [preserved verbatim](docs/history/2026-11-03-collaboration-repair-evidence.md). Current acceptance follows the convergence records above; no new deployment, Control Plane change or interruption of healthy frontend work is authorized.

### Collaboration execution invariants and historical evidence

Keep scoped Project/room role conversations and original native UI components;
private user material stays private. The dispatcher uses actual native activity,
not stored Bot existence. Chief inspection is a configured schedule; ordinary
questions do not create Tasks. Source admission, rework, scratch/workspace cleanup
and recovery require matching confirmed worker/lease exit. Unknown occupancy stays
held. Audited Chief intervention may reset a bounded routing epoch, preserving
history and global quotas. Preserve unsealed drafts and original Task/PR identity;
reuse verified PR bindings and pinned target/source ancestry, never replace a PR
or silently retarget recorded execution. Complete role rules and knowledge remain
available under explicit budgets; release only truly unbound failed preparations.
Safe-mode proposals require explicit requester approval; watch uses current grants.

Dated candidates, environment probes, schedule observations and historical check
counts are retained in [the implementation archive](docs/history/2026-11-02-collaboration-implementation.md).
Their results are not evidence for the current source or Owner visual acceptance.

### Current UI compatibility requirements

Frontend Task40/PR48 remains its original continuation; backend work does not take
it over or deploy it. Reuse original FlyBot conversation rendering, identity/parent
trees, personal Chief/Bots, native groups and shared rooms. Preserve scoped public
persona/memory inspection, earlier-part history paging, Markdown/math attachments,
composer, tools, approvals and stop/continue. Project rooms do not substitute for
native personal/group compatibility; partial restored components are not full parity.
Keep failed/blocked work visible, load Settings only when needed, coalesce route
loads and preserve current scoped polling/history. Native script budget is4.6MB;
same-origin math assets must respect CSP. Actual desktop/narrow/weak-network,
three-account screenshots and Owner visual acceptance remain separate evidence.

Chief may inspect one explicitly authorized Task without admitting foreign IDs or
dropping policy. Basic CI is the Owner-authorized default; extended browser/runtime
checks remain explicit. Publication recovery reuses original sealed evidence and
verified bindings; it is not overall Task acceptance. Resource views retain current
and unknown leases while digesting only proven released history. Dated UI drafts,
asset measurements and test reports remain in [the archive](docs/history/2026-11-02-collaboration-implementation.md).

### Task-scoped SDK context and resident Chief memory — 2026-11-01
The original implementation checkpoint is [preserved verbatim](docs/history/2026-11-04-context-implementation-checkpoint.md). Current contracts and acceptance follow.

Keep Chief durable memory and one logical Session per Task/role. SDKs retain their
supported persistence/compaction; FlyBot keeps bounded facts and exact binding/exit
proof, without a second model-history compactor. Rework resumes original context;
incompatible binding requires explicit recovery. Native continuation now has actual
DSH deterministic single-resource return/context coverage. Historical deployment and
probe details, including their original limitations, remain in
[execution history](docs/history/2026-11-03-execution-evidence.md#task-scoped-sdk-context-and-resident-chief-memory--2026-11-01).

### Task40 service integration history

Earlier S1 integration evidence is [archived verbatim](docs/history/2026-11-03-service-integration.md). Original frontend Task40/PR48 remains separate work: preserve its original UI/functions and healthy execution; backend source convergence does not authorize merge, deployment or UI takeover.

### Publish the service snapshot in the upstream repository — 2026-11-02

The owner explicitly requested pushing the delivered service to a new branch in
ThinkFlowLab/FlyBot. `delivery/ai-centric-development-service` retains db749e4eb
and its verified1811 production baseline; it does not merge or replace current
upstream main3dde8e14. README checkout targets this repository/branch. This is
a snapshot handoff, not a new main-targeting implementation PR or an upstream
compatibility PASS. Runtime/private configuration and the frontend flow are untouched.


### Role, collaboration and context convergence

Dated #2184/#2175/#2177 implementation checkpoints are [preserved verbatim](docs/history/2026-11-04-role-convergence-checkpoints.md).
Current contracts remain active: one logical Session per Task/role; pinned persona,
resource/profile and current delegation; actual exit before restoring context;
consultation distinct from durable initiative handoff; private user context is not
published automatically. Memory is bounded guidance, not authority or delivery
proof. Preserve immutable source/history pages, verified evidence and independent
acceptance; historical fixtures do not establish live-provider or UI completion.
See [agents](docs/subsystems/project-agents.md), [Harness](docs/subsystems/project-harness.md)
and the Project memory/context contracts for the current implementation.

### Completed backend convergence checkpoints

Implementation and validation notes for #2179/#2182/#2185/#2186/#2189 are
[preserved verbatim](docs/history/2026-11-04-project-convergence-checkpoints.md).
Current contracts remain: Chief admits versioned Tasks; dependencies retain their
outcome revisions; transactional storage saves facts and Effects together; scoped
receipts/events do not grant authority. Preserve original Bot/group history ACLs,
cutover identities, unknown-exit barriers and private-context publication approval.
Original host/service deployment and real-provider acceptance remain separate.
See canonical Task, storage, service, compatibility and deployment documentation.

### Current delivery guarantees

Tasks pin their associated repository and approved role/requirements revisions;
repository-free decisions do not invent code or tests. Release publication needs
explicit authority, observed Effects and Chief closure. Large histories use bounded
hash-bound pages. Missing runner/dependencies are environment failures, not assertion
failures. Receipts use same-context bounded correction and never acknowledge stale
inputs. Recovery preserves exact exit proof, candidate/Session/history and permits
evidence-supported verification continuation. Reviewer approve, host merge, signed
forge review, release/deployment and Chief acceptance remain distinct. Operations
consultation uses scoped personal agents; watch grants no host privileges.

Detailed dated implementation checkpoints are [preserved verbatim](docs/history/2026-11-04-reliability-memory-checkpoints.md); current contracts remain in the owned subsystem docs.
