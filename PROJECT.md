# FlyBot — Project State

The single page that says what this project is, who decides what, and what automation must never
do. Operational rules live in [AGENTS.md](AGENTS.md) and [CONTRIBUTING.md](CONTRIBUTING.md);
architecture lives in [docs/architecture.md](docs/architecture.md) and
[docs/subsystems/](docs/subsystems/README.md). This page links them and does not repeat them.

Current stage and priorities: [ROADMAP.md](ROADMAP.md). How decisions are made:
[docs/governance.md](docs/governance.md). Dated decisions: [decisions/](decisions/README.md).

## Agent connection authorization — 2026-11-03

#2183 adds scoped agent credentials over the existing member-session HTTP channel,
reuses per-participation safe/watch grants, and persists Task-origin provenance.
Owner's closure confirmation remains personal; native/external personal agents may
suggest closure without a Task. Real TCP contract tests are separate from actual
provider adapters/login. Full operation receipts/events and transaction migration
remain #2185/#2182; runtime cancellation remains #2184. No live rollout.

## Independent personal-agent foundation — 2026-11-02

#2170 introduces user-owned identities, per-Project participation/default routing,
and migration that retains private carrier IDs, notes, conversations and Sessions.
Leaving/retiring revokes only that agent's grants and preserves private history.
External descriptors remain unverified; authentication/transport and actual provider
acceptance are #2183/#2185, compatibility #2186. This is source work, not live rollout.

## Backend convergence — 2026-11-02

Project convergence #2171 now adds explicit repository associations and non-destructive Owner double-confirmed closure on the delivery branch. It preserves unfinished Task records and memory; runtime source migration and new behavior are not deployed. Chief role proposals now require separate Maintainer/Owner approval with exact-hash/revision fencing and durable Effects proof; retirement preserves Task/Session and room history. Real-provider custom-role execution remains #2184 acceptance, and later convergence issues remain active.

Native execution convergence #2184 now adds matching physical Session bindings and observed
Agent quiescence before Bot removal/resource release. Role retirement/capability changes
cannot restart pinned execution under stale authority. Deterministic runtime acceptance
and real-provider Task loops remain separate; this work is not deployed. Custom-role artifact verification and SDK capability policy now have actual Git/host-test and subprocess contract coverage. Verified supervisor exit now supports native prior-host recovery; unmanaged/unknown exit stays held. Canonical in-flight role/resource revocation now reuses current authority checks and the existing pool stop/scheduler; unknown exit retains capacity. Composed-stack acceptance and real-provider native continuation remain active acceptance. Native activation now requires committed Effects proof and pre-step admission. The actual DSH native return loop now passes with deterministic inference, retained prior conversation and one resource.

## Fork Project State — 2026-10-31

### Backend delivery branch — 2026-11-02

`delivery/ai-centric-development-service` packages the complete S1–S6 backend at1811e3b8f,
including verified-exit, approved integration and Chief/SDK recovery fixes. Its root
README documents existing-service authentication, direct v1/legacy HTTP usage,
explicit task publication/start, isolated source demo setup and evidence limits.
This is a documentation/branch handoff, not another service listener, schema change,
main merge, runtime rollout or takeover of original frontend Task40/PR48.
No deployment credentials or operator private files are included.

### Earlier service implementation evidence

Detailed S1–S6 implementation/recovery history is [archived verbatim](docs/history/2026-11-03-service-integration.md). Existing contracts remain in their subsystem docs. New convergence work is not deployed; preserve healthy frontend Task40/PR48 and native schedules. Backend work remains in this owner-authorized session.

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

- M5 implements the standalone shared Project workbench, restricted gateway, durable
  quota admission and actual acceptance/resource metrics. It reuses unchanged platform
  services and the existing Workflow executor. See [M5 decision](decisions/2026-10-31-m5-project-workbench.md).
  Browser/live-model acceptance is tracked separately in M6; no deployment is implied.

- M5 ([PR #15](https://github.com/zy95-12/FlyBot/pull/15), full local verify passed) supplies
  the actual shared Project UI/gateway and quota admission. M6 adds a clean two-account
  Chromium/DSH/platform runner and foreground demo launcher, plus the Project Chief
  dispatch fix found through that fresh entry. See [shared demo](docs/shared-demo.md) and
  [M6 decision](decisions/2026-10-31-m6-shared-demo.md). True-model full delivery acceptance
  subsequently passed; see the [live acceptance record](docs/live-acceptance.md). Earlier deterministic evidence remains separately labeled.

- The owner supplied an official DeepSeek credential for live validation. Official model
  catalog, inference and full live browser/GitHub acceptance passed at `f126f8c`.
  Credentials are process-only and are never repository memory. Integration fixes include
  model-visible JSON tool results, same-request Task/proposal deduplication, bounded unique
  carrier names, and propagation of human-return feedback into retry snapshots.

- Real-provider acceptance completed with two platform accounts, real role worktrees,
  independent host tests/Review and GitHub artifact PRs #18/#19, browser return/follow-up/accept,
  failing tests/retry/queue/revocation and cleanup. [Evidence](docs/live-acceptance.md) and
  [owner decision](decisions/2026-10-31-real-provider-acceptance.md). Implementation PR #16
  contains the integration fixes and regressions; review/CI/merge remain separate.


Earlier M7.2/M7.3 implementation-status checkpoints are retained verbatim in
[the historical record](docs/history/2026-11-03-completed-m7-checkpoints.md). Current
resource/Harness contracts and authorized acceptance boundaries remain below.

M7.4/M7.5 implementation checkpoints are [archived verbatim](docs/history/2026-11-03-completed-m7-checkpoints.md). Private credentials, revocation, exit proof, same-SHA verification and outstanding mixed-Harness/resource acceptance remain required.

### M7 Codex-only acceptance authorization — 2026-11-01

The owner authorized existing zy95-12 GitHub and Codex authentication on this machine
for real Codex validation. A private selected profile outside the repository is used;
no auth values, unrelated Codex history or connector configuration are copied into the
repository. The opt-in `--codex-check` exercises the native host/Workflow with real SDK
Chief/Dev/Tester/Reviewer and draft PR evidence. Claude and mixed-resource acceptance
remain separate. No merge or production deployment is authorized by this validation.

The scoped local Codex demonstration passed at clean source `73161f3`: actual Chief,
Dev/Tester/Reviewer, immutable tests, matching-SHA draft PRs #31/#32, requested-test
return/retry/re-review and scripted owner acceptance. Workers/workspaces were released.
[Evidence](dev/demo/evidence/codex-2026-11-01.json) distinguishes this from the outstanding
Claude/mixed-resource/browser/restart criteria and independent repository review.

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
Owner requires a resident Chief with durable Project memory and one logical Session per Task/role. Codex/Claude own their supported conversation persistence and automatic compaction; FlyBot does not inject a second model-history compactor. SDK role rework reuses a confirmed released Task-role cwd/thread under the same principal/resource/profile/model/persona binding, while preserving separate immutable Attempt/claim/log/test/Review evidence. Changed or incompatible bindings expose an explicit context-resume problem and retain history; they cannot silently start a fresh conversation. Chief memory uses the original own-Bot MEMORY.md/topics/journal, never global team or private-user memory. Context admission keeps current bounded facts and hash-bound full source archives for scoped retrieval. Backend changes are foreground work; frontend Task40/PR48 resumes through FlyBot after validation.

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


### Task-role execution convergence — 2026-11-03 (#2184)

Task-role SDK retries retain pinned public persona/skills and the latest observed
backend context across Attempts. Dynamic input is not a definition identity. A
binding incompatibility or unknown old execution fails visibly; no silent fresh
Session or rollback to older context. Definition snapshots are shared by digest,
current rights still revoke execution, failed unused preparations release their
pins, and model input follows a durable-save/cancellation barrier. Existing
Harness/lease/Workflow services remain authoritative. Adapter capability inspection
reports exact native Task-role resume with committed activation/quiescence; actual DSH deterministic return/context coverage is recorded separately from real-provider validation. No
public service protocol, SQL transaction, deployment or frontend change is claimed.


### Collaboration contract convergence — 2026-11-03 (#2175)

Expose durable Task handoffs through one scoped contract projection, with distinct
pending/accepted/processed/revoked/invalidated states, source/target context references,
actual claim/worker binding, initiative fences and predecessor/successor history.
Idempotent trusted offer/accept ports reuse pools; unresolved old writers cannot be
bypassed by Chief rerouting to another resource. Consultation is a separate private
protocol over retained transcripts, without Task creation or initiative transfer.
Chief prefers an active personal agent for user questions: safe answers require user
publication, watch answers use existing inbox rights; only committed Effects may wake
an authorized native watch. External clients have isolated mailboxes, not fabricated
provider sessions. SDK process/HTTP tests and real-provider acceptance remain distinct.
Native restoration/context bounds, transaction events and parent waits stay on their
original dependent issues; no control-plane, deployment or frontend changes.


### Context/memory convergence — 2026-11-03 (#2177)

Unify model/Harness context budgeting and bounded source tools across persistent
Chief and temporary roles. Unknown capacity stays explicit; full rules/current
constraints remain required, retrieval yields before overflow, and native/SDK input
is checked before delivery. Working summaries use original public role-memory
records with exact source/evidence/uncertainty, separate resident Chief topics and
rollback of uncommitted staging. Facts have source/classification/version/archive;
role-authored experience cannot declare facts or overwrite human control. Private
notes retain history under bounded views. Codex tool history has an explicit cap;
SDK compaction remains runtime-managed, without claiming aggregate usage is current
window pressure. No new memory platform, executor or timer. Native Task-role physical
restore2184 and normalized SQL storage2182 remain separate acceptance; real SDK
verification must name exact runtime source hashes, not borrow deterministic tests.

Follow-up #2177: native resident Chief current facts are actual per-turn input with whole-input budget and final authority checks; do not rely on updating cached system prompt metadata. Preserve the original resident Session.

### 2026-11-03 — Project Task contract (#2179)

New shared Tasks have Chief admission and versioned requirements. Existing Task/pool/Effects records carry independent child proposals, a released parent wait and one stable resume Handoff; child failure/cancellation never satisfies a wait. Original parent role context and workspaces are retained. Raw legacy board transitions cannot bypass the new contract, while persisted pre-contract Tasks keep their original semantics. Chief callback, rollback, exit and duplicate-resume tests are distinct from real-provider full child integration acceptance; native restore2184, storage2182 and public event/receipt2185 dependencies remain open. README simplification2189 remains last.

#2179 runtime follow-up: native Chief facts refresh is fixed in original #2177 PR2225 (410127580). The Workflow gateway now enforces Chief admission and excludes Chief control jobs from execution quota. Real DSH queue verification uses actual Chief decisions and an isolated host-verification latch to test queue/revocation without timing assumptions.

#2179 follow-up: Chief dependency waivers/substitutions retain exact outcome versions and explicit judgement evidence. Accepted child code enters the existing durable integration gates before parent execution; source admission is not merging or parent acceptance. Actual Git multi-parent sealing tests use deterministic child acceptance fixtures. Full real-provider parallel collaboration and native physical restoration remain pending.

### 2026-11-03 — Transactional state (#2182)

Opt-in SQL retains the original Store/services and saves domain facts plus Effects atomically. JSON becomes a newer-version migration guard, with verified import/recovery and offline export/rollback; no dual writable snapshots. Histories are normalized and large immutable payloads hash-referenced. Routine state updates/views make no additional model calls or Project-position changes. Full-state hydration/scanning remains; storage growth is distinct from #2177 context budgets. No live migration or provider-loop claim.

### 2026-11-03 — Service contracts (#2185)

The original application service adds private principal-scoped command receipts, bounded Task/Attempt sources, committed snapshots/events and authenticated resumable SSE. Unknown command outcomes are reconciled explicitly, never blindly rerun. Independent personal-agent identity survives carrier/transport rotation. Role acceptance commits before ownership can be replayed. Event receipt grants no role authority; private chat/auth/receipt writes do not affect public Project streams. Existing UI remains; #2186 compatibility and #2189 real deployment/README follow.

Composition checkpoint: current role governance/native exit, bounded context and canonical Task waits now share one execution chain. Native input fences logical role/physical worker separately; Task requirement revision changes stop the old Attempt through existing pool release. Actual composed/native acceptance and remaining API/storage compatibility are still under verification, not deployment.

SQLite composition now has an actual DSH native return probe: canonical Chief intake, persisted activation/exit, original role context and single-resource handoff are read from committed SQL snapshots. Inference remains deterministic; no production migration or full-provider workflow acceptance is claimed.

Service composition adds scoped native execution/exit and current-vs-pinned role metadata, role governance aliases, and bounded per-entity committed snapshots. New projections and final six-case DSH/SQLite validation are under current review; none of this branch is deployed.

### 2026-11-03 — Preserve original capabilities (#2186)

Keep personal Chief/Bots, groups, private memories and original Task/Workflow IDs. Shared Project legacy execution requires an identity-bound committed cutover; new dispatch/tracking cannot bypass Chief admission. Associated original groups retain their own history ACL plus current Project access. JSON version4 fences new contracts across SQLite rollback; code downgrades must not erase receipts. No deployment or UI replacement. See docs/subsystems/project-compatibility.md.

### 2026-11-03 — Persistent deployment and final API docs (#2189)

Use scripts/backend.mjs to initialize/start the original DSH/FlyBot host plus existing restricted HTTP/SSE gateway in a private persistent home. Login and CLI calls reuse native/platform identity; no mock model, sample repository, parallel executor or frontend replacement is packaged. Original guides move to README.native variants. Auth-mode confirms Store writability before readiness. External safe proposal impact/scope must survive publication into canonical requirements (actual production-entry regression). Deployment/restart, deterministic HTTP/DSH tests and real-provider acceptance remain separate evidence.

### Remaining backend convergence — #2292

Task execution pins its associated repository independently of Project defaults; local repository-free decision Tasks preserve normal Sessions/handoff/Chief acceptance without inventing code/tests. Actual Codex validation exposed malformed Chief requirement output: types are now explicit, failed admission is visibly blocked and valid retry retains history. Release Tasks now separate explicit human/watch publication authority, durable external observation and Chief closure; unknown results reconcile without repeated publication. Attempt logs and legacy agent history now return bounded hash-bound pages with lossless source references. Initial execution pins an approved active logical role/capability, catalog revision and Task requirements revision. Default developer remains compatible; a unique custom developer can replace it, while ambiguity needs an explicit target. Chief start Effects, capacity queues and Attempts retain the choice. Catalog/requirements changes block pending work for explicit recovery; active Session conventions remain frozen.
