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

Project convergence #2171 now adds explicit repository associations and non-destructive Owner double-confirmed closure on the delivery branch. It preserves unfinished Task records and memory; runtime source migration and new behavior are not deployed. Role-governance and remaining convergence issues remain active.

## Fork Project State — 2026-10-31

### Backend delivery branch — 2026-11-02

`delivery/ai-centric-development-service` packages the complete S1–S6 backend at1811e3b8f,
including verified-exit, approved integration and Chief/SDK recovery fixes. Its root
README documents existing-service authentication, direct v1/legacy HTTP usage,
explicit task publication/start, isolated source demo setup and evidence limits.
This is a documentation/branch handoff, not another service listener, schema change,
main merge, runtime rollout or takeover of original frontend Task40/PR48.
No deployment credentials or operator private files are included.

### Service recovery acceptance — S6 / issue55, 2026-11-02

The final stage composes the verified S5 service with the native frontend candidate
from original Task40/PR48, preserving both source histories. An operator CLI repeats
isolated real-store/Git/controlled-adapter recovery scenarios; it never injects
production faults or represents mocks as vendor execution. Real GitHub feedback
has automatically reached the original Task's actual Codex Developer, with explicit
read/handled receipts and downstream Tester handoff, without manual relay/new Task.
Matching candidate test/Review/PR and Chief decisions remain separately recorded.
See [runbook](docs/service-recovery-demo.md). Integration/real UI screenshots and
#41's remaining visual/dual-mode matrix are not established by this CLI.

### Trusted execution boundary — S5 / issue54, 2026-11-02

The compatible profile explicitly supports trusted private execution on one
dedicated service account, without mandatory per-Bot users/containers. A new
read-only execution.boundary query reports current human rights/delegation, exact
credential selection, authorized resources and honest preflight/isolation limits.
Unknown profiles refuse repository/resource admission; watch grants never elevate
current Project rights. No live account, credential or sandbox change is made.
See [decision](decisions/2026-11-02-trusted-execution-service.md) and
[boundary architecture](docs/subsystems/project-execution-boundary.md).
Private-memory APIs, resource/lease/generation/confirmed-exit/workspace coordination,
same-candidate tests/Review and Chief adjudication remain mandatory.

### GitHub feedback subscriptions — S4 / issue53, 2026-11-02

Source/Thread/TaskSubscription now feeds the existing durable inbox through scoped
GitHub reads and configurable native schedules. Stable revisions, cursor replay,
atomic event/input/Effect persistence and current-Task routing preserve Bot handoff
choice. Old-SHA checks/Review and remote closure never grant current evidence or
local closure. Default activation keeps earlier discussion as context, explicit
history backfill is available; stopped/context Tasks never wake. Long feedback is
retained losslessly in bounded parts, and unsubmitted Review drafts are excluded.
See [Source architecture](docs/subsystems/project-sources.md). Source tests and a
real UID998 scoped GitHub read are recorded; complete live feedback/handoff
acceptance remains separate until actually run.

Browser-offline polling uses a host-only current-principal Project read port,
not a browser-session bypass flag. Repository identity is captured before async
credential lookup; in-flight changes refuse rather than borrowing another scope.

S1/S2/S3 and the #60 host-seal compatibility repair are deployed together at
e20262ed, with4384 full checks and actual three-account authorization probes.
Original frontend Task40/PR48 resumed through Chief and sealed a new candidate;
the native Tester handoff is active, not final UI acceptance. Current backend
development remains in the foreground session, without frontend Task replacement.

### Approved integration sealing — issue60, 2026-11-02

S3/PR61 is verified (4374 tests and exact-source real Codex inbox→Chief-pool
acceptance), pending compatible rollout with S2. The autonomous frontend exposed a
separate host preparation gap: an approved operator merge remained staged while
SDK shared-ref writes were correctly denied; host sealing only recognized the
published upstream and attempted a soft reset during that extra merge.

The foreground repair adds manager-only, durable source admission with exact
operator ref/SHA, workspace snapshot and generation fences. Host sealing retains
the staged tree and trusted parents without opening refs to SDKs or claiming test/
Review evidence. Failed/no-op saves cannot authorize a parent. The original
Task40/PR48/Attempt and merge draft stay intact; resume through Chief after verified
service deployment. No backend Bot Task or control-plane/sandbox/credential change.

The first compatible S2/S3/60 rollout passed three-account live reads, but source
admission exposed over-broad historical Chief occupancy. Admission now requires
exit proof for the current Chief claim, every unreleased Project Chief and this
Attempt's workers, without treating unrelated released historical Chief turns as
workspace owners. Their old records remain intact; unknown current exits still block.

### Durable Task inputs — S3 / issue52, 2026-11-02

The service now distinguishes persisted input, durable role inbox, adapter delivery,
SDK output observation, declared reading and validated handling. Current-claim
receipts and bounded same-thread safe turns preserve existing Bot handoff authority.
Chief receipt plans cannot consume inputs on failed decisions; closure and input
handling share the final state commit. New pending feedback, unknown protocols,
revoked source and changed hashes keep their fences. See [input contract](docs/subsystems/project-inputs.md).

S1/PR56 and #57/PR59 are deployed with original UI preserved; S2/PR58 passed4350
checks and fork CI. S3 source/real Codex receipt validation is in progress, not
live delivery or final UI acceptance. The original frontend Task40/PR48 continues
through its own Chief/Dev/Reviewer/Tester flow. No backend development Task,
control-plane edit, merge/queue/release or new per-Bot sandbox is authorized here.

### Verified supervisor exit compatibility — 2026-11-02

Foreground repair #57 unifies workspace and logical Task-role resumption for
host-confirmed SDK exit and prior systemd invocation exit. The latter must match
the exact released worker/lease, generation, role, resource and process scope.
Unknown exits remain blocked; no state or lock deletion is a recovery mechanism.
Task40/PR48 retains its current Attempt and all draft/history records. Verification
and safe-checkpoint deployment precede Chief resumption; no frontend code is edited.

### Direct backend recovery — 2026-11-01

The owner requires backend repairs in the foreground Codex session; do not
dispatch backend development through FlyBot. Existing frontend work is preserved and now continues autonomously while new
backend service work is developed independently (owner update, 2026-11-01). See the
[execution decision](decisions/2026-11-01-direct-backend-recovery.md).
R6 adds coalesced event-driven dispatch, manager-controlled retry of blocked queue
entries under the original requester, and operator-selected workspace preparation
before each pool receiver and after independent test cleanup. Failed allocation,
checkout or context preparation releases only proven unbound reservations and
retains its failure audit. These changes do not imply live UI or R8 acceptance.


This is `zy95-12/FlyBot`. Current scope is the [shared-project roadmap](https://github.com/zy95-12/FlyBot/issues/1)
and [fork decision](decisions/2026-10-31-project-first-fork.md). The inherited mission,
people and stage descriptions below are historical upstream context; upstream accounts
are not this fork's decision-makers merely because inherited docs name them.

- Project is the target stable boundary for Task/Run/Workspace ownership. Bots and
  Sessions are replaceable execution/interaction carriers. M1 implements direct ownership and explicit legacy resolution; see [Project domain](docs/subsystems/project-domain.md).
- Reuse control-plane identity, auth, invitation, instance and operations APIs unchanged
  where possible. Put project business logic/adapters in FlyBot; justify a missing API
  separately. The platform PR was withdrawn, not merged.
- Rebuild task navigation and the Project board; current UI/components are not constraints.
- M0 is implemented on [PR #9](https://github.com/zy95-12/FlyBot/pull/9), merged (2026-10-31):
  real DSH/tool execution with a deterministic model, plus a FlyBot-owned HTTP adapter
  exercising unchanged external platform source. This is not real-model PR delivery.
- The baseline identity, scoped Workflow-write and per-run cwd seams are implemented
  through M1–M3; later milestone integration and live acceptance are recorded below.
- Durable repository memory is this page, ROADMAP, LESSONS and dated decisions. Update
  them and matching architecture docs alongside code, with regression coverage in
  verify/CI and tested-SHA evidence. Never edit live DSH/Bot memory for repository decisions.

See [baseline ownership and tests](docs/subsystems/demo-baseline.md).

- M1 implementation ([PR #10](https://github.com/zy95-12/FlyBot/pull/10), complete local verification, awaiting review) adds Project service/policy/repository boundaries, immutable work
  ownership, explicit migration, archive/delete/member-removal rules and an owner-only
  detail API. Workspace records are directory references; M3 supplies worktree isolation.
- The owner authorized continuing M2–M6, one PR per milestone, with memory, architecture
  and tests updated in each. [M1 decision](decisions/2026-10-31-m1-project-ownership.md).

- M2 ([PR #11](https://github.com/zy95-12/FlyBot/pull/11), complete local verification, awaiting review) implements the [shared access contract](docs/subsystems/project-access.md): unchanged
  platform auth API adapter, stable subject mapping, human membership policy/invites,
  immediate revocation and scoped Workflow gateway. It is explicitly configured; worktrees,
  agent delegation/credentials and browser delivery are supplied by M3–M6 below.

- M3 ([PR #13](https://github.com/zy95-12/FlyBot/pull/13), full local verify) implements the [commit-specific delivery contract](docs/subsystems/project-delivery.md)
  on the existing Workflow service: versioned Attempts, real role worktrees/cwd, host test
  evidence, Review/SHA gates and human acceptance. Actual DSH and draft artifact PR #12
  were first exercised with a deterministic model. Integrated real-model/GitHub/browser
  acceptance subsequently passed in M6; [evidence](docs/live-acceptance.md).

- M4 implements [scoped Project agents](docs/subsystems/project-agents.md): fresh public
  Chief, private human/Project identities, separate memory/history/proposals, live delegated
  tool checks, role/skill snapshots and exact GitHub credential scopes. Actual DSH fixture
  validation covers creation/publication/revocation; real-model/browser acceptance
  subsequently passed in M6. Runtime code-worker OS isolation is not claimed by this demo.

- M7 is owner-authorized in [#20](https://github.com/zy95-12/FlyBot/issues/20),
  implemented sequentially as #21–#25, one PR per issue. It explicitly authorizes native,
  Codex SDK and Claude Agent SDK Harness choices; the inherited upstream removal of
  Codex does not govern this fork. Control-plane remains unchanged. M7.1 introduces
  explicit public role memory and bounded hashed execution contexts, durable Chief
  identity/history and per-Attempt temporary Session bindings. M7.2–M7.5 code is on PRs #27–#30: resource leases, SDK Harnesses, Owner setup and
  verified Git handoffs. Authenticated mixed-resource acceptance remains outstanding;
  the later owner-authorized local Codex-only run passed, as recorded below.

### Automatic development service — 2026-11-01

Owner approved [#49–#55](https://github.com/zy95-12/FlyBot/issues/49), sequential
backend issue/PR delivery alongside existing frontend Task40/PR48. S1 ([PR56](https://github.com/zy95-12/FlyBot/pull/56)) implements
one versioned service facade, legacy adapters and a shared derived TaskView;
[contract](docs/subsystems/project-development-service.md),
[decision](decisions/2026-11-01-development-service.md). Durable Effects, input
receipts, external subscriptions, trusted deployment boundaries and recovery
acceptance remain S2–S6. Source checks and staged live rollout are separate;
healthy frontend work and native schedules must not be interrupted for deployment.
The initial673c741b service facade was deployed at a proven idle boundary, with
51 mixed-source UID998 checks and unchanged native UI assets. Live verification
found the old25-Attempt detail response exceeded8MiB. Follow-up b9cceb02 preserves
full history with paged summaries/hash-bound context retrieval: full UID1000
Node24 verify4333 passed,0fail/skip. It was deployed at a tested, released Chief-wait checkpoint. Owner/Maintainer/Member
actual HTTP probes passed, including full-context paging and denied foreign/mutating
requests; the original detail response is now about1.45MiB. Native UI bytes remain
unchanged; frontend integration and final UI acceptance stay with Task40/PR48.

### Durable service actions — S2/#51

S2 stages handoff dispatch and GitHub PR/comment actions with existing state,
requires an actual rename acknowledgement before I/O, and retains bounded retry/
reconciliation receipts across restart. Current principals, claim generations,
worker exit and candidate-specific tests/review remain authoritative. Private
comment bodies are immutable artifact references, not public context or tokens.
[Effect architecture](docs/subsystems/project-effects.md). Source implementation
and fault-injection checks are in progress; no S2 live deployment, real GitHub
outbox acceptance or independent repository review is claimed by those checks.

## Historical upstream Project State

## Mission

FlyBot is a local team of long-lived AI Bots that runs on DeepSeek Harness (DSH), in your own
browser, with your own model keys. One person talks to one Bot — the **Chief** — and the team takes
the request apart and comes back with one answer. The Bots keep their own memory, working folder,
model and schedules between turns, so work outlives a single chat.

The project's mission is to keep that team reliable and inspectable: every Bot acts on evidence,
stays inside its goal, and its result can be checked by a person afterwards. The product is the app
in this repository plus the patches that pin it to upstream `ds-bot`; it is not a hosting service.

`AGENTS.md` states the two halves the code is built from: pristine upstream `ds-bot/` (never edited),
and `core/` — `ds-bot/` plus FlyBot's ordered patches — which is what ships and what the tests run.
The shipped features are the DSH plugin in `core/` and the peer plugins `plugins/social`,
`plugins/tree`, `plugins/timeline` and `plugins/workflow`.

## Owner and maintainer roles

Today the project has one owner and a small number of human maintainers; the Bots work under the
owner's delegation. This is the state of the repository as of 2026-10-29, not the target model of
[#1550](https://github.com/ThinkFlowLab/FlyBot/issues/1550).

| Role | Who | Decides |
| --- | --- | --- |
| **Owner** | Danyang, GitHub [`Birfy`](https://github.com/Birfy) (repository admin) | Mission, governance policy, roles and membership, project Bots, compute and resources, budgets, autonomy boundaries, and every matter reserved to the owner in [docs/governance.md](docs/governance.md) |
| **Maintainer** (human) | People with repository write access — today the owner and [`hsliuustc0106`](https://github.com/hsliuustc0106) | Major decisions under [docs/governance.md](docs/governance.md): roadmap and architecture changes, changes to the governing documents, multi-subsystem contracts. Records a verdict through the review policy, never through an admin merge |
| **Chief** (AI) | The owner's Main Bot, writing as `Birfy` | Plans and routes work, splits a request into role tasks, **classifies** each decision as ordinary / major / severe with its rationale, convenes a discussion when one is needed, and escalates to the owner. Not the ultimate authority and not the owner |
| **Routine Bots** (AI) | `Triage`, `Dev`, `Dev2`–`Dev4`, `Reviewer`, `Reviewer2`, `Release`, `SelfTest`, `Docs`, `Maintainer` — the names in [`writers`](.github/agent/review-policy.json) | Only their routine's job: see [Routines](AGENTS.md#routines). A Bot records a conclusion only where its routine owns that conclusion, and the implementer never writes the verdict on its own change |
| **Contributors** (human) | Anyone who opens an issue or a pull request | Proposals, bug reports, code. No default approval right; a contribution merges only through the gates in [AGENTS.md](AGENTS.md) |

Deliberately **not** claimed here, because it is not shipped: a Maintainer console, a Member role, a
Project Assistant, per-person GitHub attribution for Bots, and the multi-human authority contract in
[docs/subsystems/team.md](docs/subsystems/team.md) (planned; team mode stays disabled until its
authorization gates pass). Every Bot still writes as the one shared `Birfy` identity, so a
`Written-by:` line is a claim the gates can check for presence and name, not a signature.

## Resources covered

- **This repository** — `https://github.com/ThinkFlowLab/FlyBot`, the source of record. `main` is
  the live branch; pull requests merge into it only through the merge queue.
- **Code** — `core/` (shipped plugin, source of truth), `patches/ds-bot/` and `core/client.js`
  (generated from `core/`), `plugins/*` (peer plugins), `scripts/` and `core/scripts/`.
- **Rules and knowledge** — `AGENTS.md` (operating contract), `CONTRIBUTING.md`, `LESSONS.md`
  (observed failures and promotion to standards), `docs/` (architecture, standards, runbooks),
  `decisions/` (dated decisions), `PROJECT.md` and `ROADMAP.md` (this page and the plan).
- **Automation** — `.github/workflows/` and `.github/scripts/` (CI, risk tier, review gate, merge
  gate, enqueue guard), `.github/agent/` (risk rules and the review policy).
- **Authoritative runtime state elsewhere** — GitHub issues, pull requests and CI runs are the
  authority for work state; task boards, approvals and per-Bot memory live in FlyBot's own storage,
  never in this repository. `docs/` pages are informative only where a source above decides
  something.
- **Not in this repository** — the upstream `ds-bot` project (pinned in `ds-bot.pin.json`, read-only
  here) and the self-hosted Bot Social server used by the social plugin. The fork
  `Birfy/FlyBot` is an archive: nothing merges into it.

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


### M7.2 — 2026-10-31

M7.2 adds operator-granted local/Docker execution resources, safe environment observations, candidate pools, sticky resource leases and shared queue capacity accounting. The actual two-runtime probe passed with distinct hostnames/filesystems and confirmed cleanup. SDK authentication and mixed-resource Task delivery remain M7.3–M7.5. See docs/subsystems/project-resources.md.


### M7.3 checkpoint — 2026-10-31

M7.3 work in progress adds pinned official Codex/Claude Agent SDK temporary worker adapters through the existing Workflow seam, explicit per-resource/principal profiles, streamed evidence and exit-confirmed resource release. Chief SDK actions now use a host-validated scoped JSON bridge; cross-resource dispatch remains pending; no full real-SDK acceptance is claimed.


### M7.4 — 2026-10-31

M7.4 adds Owner role/persona/Skills/memory/Harness/model/multiple-resource configuration, bounded connection checks and explicitly granted private target-resource PTYs. Credentials stay in private profiles; generated profiles separate Project/principal/Harness. Actual local and new Docker PTYs, hidden setup, current-session revocation and background cleanup are tested. Real authenticated three-Harness acceptance remains pending dedicated credential/profile selection.


### M7.5 — 2026-10-31

M7.5 implements local/Docker Git workspace handoffs, SHA256 manifests, one final sealed candidate without intermediate worker history, independent host-verifier tests, same-SHA review and sealed SDK event evidence. Browser integration fixes runtime/terminal/input channel routing; callback-aware stop acknowledgement prevents release deadlock. See docs/m7-acceptance.md: positive authenticated three-Harness/two-resource PR acceptance still needs dedicated profiles, so M7 is not declared fully accepted.

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

### Collaboration repairs — 2026-11-01

The owner authorized sequential issues [#34–#41](https://github.com/zy95-12/FlyBot/issues/33), one PR each; see [decision](decisions/2026-11-01-collaboration-repair.md). The target is native multi-Bot reuse, per-Bot pools and enforced handoff, restored role contracts, ordinary Chief conversations, safe/watch delegation and configurable Chief inspection schedules. Public hosting is deferred; control-plane stays unchanged.

R1 (#34) rejects incomplete repository capabilities before workers/workspaces/leases are allocated. Workbench readiness checks Git/runtime/dependency metadata and reports the precise block; this does not claim tests or SDK task delivery have run. Old failed Attempts remain readable. R1 full local verification passed in PR #42; actual shared-service integration remains pending.

R2 (#35) restores complete Dev/Tester/Reviewer conventions, pinned policy-source hashes and final-execution prompt assembly for native and SDK roles. FlyBot code sealing requires memory/tests/architecture evidence; candidate approval explicitly cannot mint a signed forge PASS. Focused tests cover full rules reaching SDK input, required-source failures and tampering. R2 full verification and later backend/dogfood acceptance are tracked separately.


R3 (#36) implements per-logical-Bot pools on existing Task records, atomic claims,
versioned receipts and enforced handoff admission. New shared deliveries default
to dynamic pool dispatch; the legacy DAG is explicit opt-in. Only the receiving
role allocates an execution Session/resource. Candidate returns retain the Task
and create a new Attempt; overall completion waits for Chief judgement. Unit and
SDK contract-process tests cover non-DAG return/rework with one resource. Full
verification, conversation bridging, Chief arbitration/schedules and real shared
service dogfood remain separately tracked acceptance, not implied by these tests.


R4 (#37) adds conversation-only private → Chief → original-chat handoff, isolated
from private memory and other members. Query turns cannot publish or execute a
Task; scoped GitHub reads provide actual repository facts. Impactful Task kinds
persist across proposal publication; workbench status separates publication from
queue/start/execution and Chief wait. Targeted privacy, native/SDK-query, no-Task
and credential/revocation tests pass. Full verification and real shared-service
acceptance remain separate; control-plane and public hosting are unchanged.


R5 (#38) implements safe/private publication proposals and persistent, revocable
watch grants bound to the current human and Project. Browser logout does not
revoke watch authority; account/membership/grant changes do. Scoped actions use
current human rights and retain provenance. The unchanged SQLite platform can
supply fresh account status through a FlyBot-owned read-only operator helper,
without storing browser cookies or admin credentials. Regression tests cover
logout, restart, current rights, revocation, forged status evidence and fresh WAL
reads. Shared-service provisioning and real-model acceptance are still pending.

R6 (#39) adds evidence-gated Chief arbitration, audited intervention and configurable
inspection on original DSH scheduled tasks. The JSON template defaults to 30 minutes;
content, cadence, thresholds and pause/enable are editable. Current configured human
authority and generation fences apply to each effect. Unknown process exits retain
capacity; a verified systemd invocation boundary permits local restart recovery.
Deterministic protocol tests return incomplete coverage to Dev then close the same
Task after a fresh Attempt. Real shared-service Codex/timer acceptance remains #41.

Real shared-service R6 probes passed an actual Codex Chief ordinary inquiry with
zero Tasks and an original DSH 60-second wake after browser logout, then pause/
resume and restoration to 30 minutes. R7 actual Dev requested Chief arbitration;
Chief returned the same Task to Dev with a fresh Attempt. This exposed a concurrent
resource-release reconciliation race, fixed with a red/green regression. Actual
full R7 delivery and persistent 30-minute/restart acceptance remain in progress.

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

Task40 continuation integrates trusted backend `91792c1b` into preserved candidate
`25607404` without committing or publishing. Room-scoped messages/streaming and role
identity are retained alongside Chief retrieval/memory and binding-checked SDK resume.
The inherited changelog failure reproduces (6/7) and the single-entry repair passes
(7/7). Generated patches match canonical core. Direct integration testing requires
DSH's registered loader: plain node cannot resolve `@deepseek-ai/dsh-llm` from the
new scheduled-task module. This is not a passing integration result. Native composer,
tool/approval/stop/stream, personal/group interactions, CSS-load synchronization and
actual deployed three-account/weak-network acceptance remain open.

Follow-up local check used the required harness loader:
`cd core && node --import ./test/harness-resolve.mjs --test test/project-agents.test.js test/project-harness.test.js`
passed 40/40 on the staged merge draft. The earlier plain-node failure was a loader
invocation error, not a missing prepared dependency. Full verify, smoke, independent
Review and deployed acceptance are Not run for this draft.

Task40 adds a CSS/JS readiness barrier (defect tests 0/2 → 2/2) and mounts the scoped
composer from original composer.js for Project agents and personal conversations.
The original dictation hook is reused with disposal; captured chat handles retain
scope revocation. A base-bundle composer test fails because the capability is absent;
current native render/client/asset checks pass 27/27. These are local draft checks,
not host full verification, independent Review or deployed three-account acceptance.

The room composer now shares that native mount and existing registered-document
IDs, while personal groups restrict mention choices to their visible members.
Actual native workText labels render scoped live tool names. Final focused UI
checks pass 33/33. Full verify was attempted during editing and is not valid final
verification; a later process-control/result request was refused by sandbox
loopback policy. Request actual configured host verification through Tester, then
return this partial implementation to Developer for remaining tool-result,
approval, personal live/stop and full interaction work. Do not close Task40.

Task40 continuation at base cbcad4c4 adds actual native question/approval/stop/continue
controls, original group MemberWork controls, bounded redacted tool results and current
own-chat streaming. Existing original components are reused; standing grants and raw
owner APIs are not exposed. SDK permission/message inputs now use the same original
approval/composer components with existing host worker-generation/current-rights gates.
The new personal HTTP capability test failed at base (1/2) before implementation and
passed afterward; additional boundary tests cover foreign approvals/workers, retired
handles, hidden turns, historical parts and stale questions. Host full verification,
independent Review and deployed three-account/weak-network screenshots remain required.

The continuation also restores answerable group question/approval cards through
original handlers, exposing only public question fields rather than replyTo/origin.
Group member-stop tests use actual native membership and reject another owner's Bot.
Final local interaction checks, build/patch/lint results and outstanding host/browser
validation are reported at handoff; no candidate recommendation closes this Task.

Task40 host verification at `33e482d6` reported four failures in install, secrets
and usage suites. All four reproduced locally (28/32). The personal stream observer
was also installed in legacy mode, shifting the established listener order used by
those protocol tests. Register it only for explicit shared-workbench mode; keep its
purpose/Session guards. The new mode-boundary regression fails without that fix;
affected suites plus personal-workbench coverage now pass 38/38. Final host full
verification and independent Review remain required; no deployed acceptance is claimed.

Review return at `846378bf` reproduced current-part navigation leaving the live
conversation read-only; picker and explicit current-part links now normalize to the
live route (defect regression red→green). Human Markdown/mentions reuse original
PersonMessage. Attachment-only messages, scoped image preview/file download and
native file/image sends use public DSH attachment/Agent APIs with current-user checks.
The new human/attachment render test fails against the base bundle and passes on the
working build. Boundary tests cover foreign IDs, batch validation, historical reads,
revocation during admission and late download callbacks. Final host verification,
independent Review and real-service screenshots/weak-network acceptance remain open.

Review return at `bde2cf7c` reproduced native composer remount/focus loss on same-route
refresh. The mounted regression now uses bounded boolean DOM-identity diagnostics
(the former object diff exhausted memory before reporting failure) and reproduces
red at that source. Native roots now update in place within the same scoped route and
source, retaining input, cursor and focus; navigation/revocation still dispose them.
Mounted personal/public/private/room regressions cover retained sends and scope teardown.
No resource limit was raised. Exact-candidate host verification, independent Review
and deployed three-account/weak-network/screenshot acceptance remain separate gates.

### Service and native compatibility invariants

The shared service retains legacy delivery/Chief/schedule/delegation entrypoints,
native personal/room/attachment paths and retained roots. Live status must use actual
native activity. A completed Chief deferral is waiting-human, not an active execution
claim. SDK-owned jobs accept only their fenced SDK callback, including the window
before worker registration; dormant native events cannot consume them.

Preserve SDK failure attribution and accept historical exit only with matching
worker/generation/Project/Attempt/role/resource and released worker/lease proofs.
Interruptions may resume the same allocated pre-candidate Attempt only after all
registered occupancy releases, preserving clean/dirty drafts and admitted integration
sources. Explicit returns/rework retain their own isolation. Operator dependency
migration uses the complete deployed graph, proves release first, backs up untracked
caches outside the checkout and preserves HEAD/index/status and source identity.

API guides distinguish derived views, stored lifecycle, actual evidence, fixtures,
ordinary consultation and impactful Tasks. Historical candidate SHAs and reports
remain in [the archive](docs/history/2026-11-02-collaboration-implementation.md);
neither prior-parent verification nor a document update is current integration,
deployment, independent Review or Owner acceptance.

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
reports native Task-role continuation as pending; no new real-provider validation,
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
