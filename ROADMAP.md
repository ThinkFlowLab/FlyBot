# FlyBot — Roadmap

## Agent connection authorization — 2026-11-03

#2308 adds one native/external inbox protocol, verified Webhook hints, durable
processing and Chief continuation. Preserve existing personal Chief/group contracts;
do not turn consultations into Tasks or inbox claims into executor identity.
#2311 implements GitHub App credentials alongside gh-cli, scoped human selection and recovery fencing. Deterministic provider/runtime coverage is separate from real App acceptance; no live rollout.

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

Implement the 2026-11-02 convergence issues sequentially: Project boundaries, independent personal agents/authorization, execution and collaboration, context, Task/subtask lifecycle, SQLite/state, unified API/events, compatibility, then #2189 real deployment/README. Each issue has a separate main-repository branch/PR; no automatic merge or production rollout. #2171 includes repository relations, Owner closure and Chief-proposed/Owner-or-Maintainer-approved role governance. Execution integration for custom/retired roles remains in #2184; ancestor changes must propagate through the PR stack before final compatibility acceptance.

Original #2184 follow-up adds native Task-role restoration metadata, cancellation/quiescence
proofs and canonical-pool cwd retention. Custom-role verification now has direct artifact/SDK contract regressions; finish current-rights
in-flight stop/reconcile and real-provider native acceptance before propagating the
execution ancestor through collaboration/context/Task/state/API branches.

## Active fork roadmap — 2026-10-31

The earlier delivery snapshot at1811e3b8f consolidated S1–S6. Current persistent
source deployment and API use follow the root README and #2189. #2300 adds the
machine-readable public OpenAPI contract and third-party onboarding guide, guarded
by source inventory/schema and representative isolated HTTP conformance tests.
Vendor-specific adapters and live external-provider acceptance remain separate.
Backend delivery does not complete original frontend #41 acceptance
or merge staged PRs.

S6/#55 integrates current service stages with original native frontend work and
adds repeatable isolated fault/replay acceptance. Actual PR feedback→original Task→
Codex Dev→Tester has run; final candidate/Review/Chief evidence and compatible UI
rollout are recorded separately. Do not replace #41 or claim its whole visual/
dual-mode matrix from this backend service acceptance.

S5/#54 adds the trusted-private compatibility profile and execution-boundary query,
without per-Bot OS infrastructure or live identity/sandbox migration. Current-role,
safe/watch, private-data and concurrency regression suites guard existing rights.
Exact-head full checks and dedicated-account metadata probes are separate from
S6/#55 integrated GitHub/SDK/recovery/UI acceptance, which remains required.

S4/#53 implements scoped GitHub feedback→existing Task inputs with persistent
revisions, bounded source sweeps and native schedule configuration. Full exact-head
verification, compatible checkpoint rollout and actual GitHub→Bot handoff evidence
must precede delivery claims. S5/#54 trust/capability boundary and S6/#55 integrated
fault/recovery acceptance follow. S1–S3/#60 are deployed; original frontend Task40/
PR48 now advances its new sealed candidate through native Tester/Reviewer roles.

Immediate #60 foreground repair completes approved extra-merge host sealing before
S2/S3 batch rollout and current frontend Attempt resumption. Keep the existing
index/MERGE_HEAD, shared-ref restriction, Task/PR and independent candidate gates.
The first batch is deployed; live source admission found a historical-Chief
scope regression. PR62 includes its real-state reproduction and focused guard
repair before resuming the original frontend Attempt. No full frontend acceptance yet.

Service #49 implementation order: S1/#50 (PR56, deployed), S2/#51 (PR58, verified,
awaiting compatible batch rollout), S3/#52 (PR61,4374 checks and real Codex receipt/pool acceptance verified), then source subscriptions/#53, trusted execution boundary/#54 and
integrated fault/recovery acceptance/#55. #57/PR59 compatibility repair is deployed;
original Chief resumed actual frontend Dev without changing Task40/PR48 ownership.
Each stage keeps memory, architecture and regression evidence with its own PR.

Immediate compatibility repair #57 removes the verified prior-invocation workspace
and Session resumption blocker before continuing service #51–#55. Preserve the
current frontend Task/Attempt/PR and unknown-exit protections.

Current execution order (Owner update, 2026-11-01): keep the existing frontend
#40 Task/PR48 autonomous while implementing backend #49–#55 directly in the
foreground session, in separate issue worktrees and with staged verified rollout.
Do not use FlyBot to assign backend repairs. R6 recovery covers serialized wake
bursts, immediate persisted handoff/Chief events, original-requester queue recovery
and receiving-workspace preparation before inference and host testing. Remaining
live integration, frontend restoration and R8 acceptance retain their existing
issues; no passing unit suite alone completes them.


The owner-approved plan is [fork #1](https://github.com/zy95-12/FlyBot/issues/1), recorded
in [the fork decision](decisions/2026-10-31-project-first-fork.md). Historical upstream
stages below do not restrict the fork's approved Project and frontend refactor.

| Milestone | Deliverable | Status / issue |
| --- | --- | --- |
| M0 | Isolated DSH/tool/cwd/lifecycle and unchanged-platform HTTP checks | Merged PR #9; [#2](https://github.com/zy95-12/FlyBot/issues/2) |
| M1 | Project domain and direct Task/Run/Workspace ownership | PR #10 verified locally, awaiting review; [#3](https://github.com/zy95-12/FlyBot/issues/3) |
| M2 | Shared membership, platform identity adapter and backend authorization | PR #11 verified locally, awaiting review; [#4](https://github.com/zy95-12/FlyBot/issues/4) |
| M3 | Worktree, code/tests/PR/review evidence and human acceptance | PR #13 locally verified; integrated real-provider acceptance passed in M6; [#5](https://github.com/zy95-12/FlyBot/issues/5) |
| M4 | Public project Bots and private user/project agents | PR #14 verified locally, awaiting review; [#6](https://github.com/zy95-12/FlyBot/issues/6) |
| M5 | Rebuild task navigation, Project board, details and resource view | PR #15 locally verified, awaiting review; [#7](https://github.com/zy95-12/FlyBot/issues/7) |
| M6 | Repeatable two-user end-to-end acceptance | PR #16: real-model/GitHub/browser acceptance passed; awaiting review; [#8](https://github.com/zy95-12/FlyBot/issues/8) |

The owner authorized sequential M1–M6 implementation, one PR per milestone. Each PR
updates long-term memory, architecture and tests. Merge status is tracked separately.

Reuse platform services unchanged first; new project logic/adapters belong in FlyBot.
M0's deterministic model and existing shared-write denials do not imply M2/M3 completion.
GPU pools, multi-host scheduling, auto-merge and exact crash resume remain deferred.
The 30–43 person-day estimate is provisional pending interfaces/frontend design.

## Authorized M7 sequence

| Phase | Deliverable | State |
| --- | --- | --- |
| [M7.1 #21](https://github.com/zy95-12/FlyBot/issues/21) | Durable Chief/role memory and temporary Session snapshots | PR #26; full verify and actual DSH context checks passed |
| [M7.2 #22](https://github.com/zy95-12/FlyBot/issues/22) | Execution resource registry, candidate pools and leases | PR #27; full verify + actual local/Docker probe; integration #30 |
| [M7.3 #23](https://github.com/zy95-12/FlyBot/issues/23) | Native/Codex/Claude Agent SDK adapters | Draft PR #28; full verify passed; real authorization acceptance pending |
| [M7.4 #24](https://github.com/zy95-12/FlyBot/issues/24) | Owner configuration, probes and authorized resource terminal | Draft PR #29; full verify + actual PTY checks; browser integration #30 |
| [M7.5 #25](https://github.com/zy95-12/FlyBot/issues/25) | Cross-resource code/evidence transfer and real browser acceptance | Draft PR #30; code/resource/browser checks implemented, authenticated mixed-Harness acceptance pending |

User explicitly authorized sequential implementation and a separate PR for every issue,
including long-term memory, architecture and tests. Merge/deployment is separate.

## Automatic development service sequence

[#49](https://github.com/zy95-12/FlyBot/issues/49) tracks S1 #50 service/TaskView →
S2 #51 durable Effects/outbox → S3 #52 input/role receipts → S4 #53 external
Task subscriptions. S5 #54 trusted deployment/authority follows S1 and applies
throughout; S6 #55 integrated recovery acceptance follows all five. One PR per
implementation issue; no extra tracking-only PR. S1 PR56 has a deployed initial facade (673c741b); long-history follow-up
b9cceb02 passed full4333 verification, deployed at a released checkpoint and
passed three-account scoped HTTP/pagination checks, preserving original UI bytes.
S2/#51 effect/outbox code and fault regressions are implemented; full verification
and source-bound rollout follow before S3 inputs/read receipts.
Independent repository review is not claimed. Original #34–#41 residuals remain.

## Historical upstream roadmap


What the project is doing now, in what order, and what it deliberately is not doing. The plan of
record is the accepted proposal [#1550](https://github.com/ThinkFlowLab/FlyBot/issues/1550)
(approved by the owner on 2026-10-29, recorded in
[decisions/2026-10-29-stage-1-approved.md](decisions/2026-10-29-stage-1-approved.md)). This page
tracks that plan; it does not replace it.

**Active stage: Stage 1 — run FlyBot development as an AI-governed Project (dogfood first).**

## Priorities today

1. **Stage 1 dogfood, in slices.** Prove the governance loop with the Bots, groups, tasks and GitHub
   this repository already has. No new UI and no engine work until Stage 1 is shown to work.
2. **Keep the routine pipeline green and honest.** `tests-ok` green at the tip, the gates in
   [AGENTS.md](AGENTS.md) applied as written, and the daily release published.
3. **Security debt first** among ordinary work: [#9](https://github.com/ThinkFlowLab/FlyBot/issues/9)
   → [#10](https://github.com/ThinkFlowLab/FlyBot/issues/10) →
   [#8](https://github.com/ThinkFlowLab/FlyBot/issues/8).
4. **Lessons become standards.** A failure seen three times is dated in
   [LESSONS.md](LESSONS.md); after at least three days the durable rule is promoted into
   [docs/code-standards.md](docs/code-standards.md) or [AGENTS.md](AGENTS.md).

## Stage 1 — active

**Objective:** prove project governance and decisions with existing Bots, Tasks, groups and GitHub,
before rebuilding the interface or the engine.

| Slice | State | Where |
| --- | --- | --- |
| Publish the minimal Project State (`PROJECT.md`, `ROADMAP.md`, `docs/governance.md`, `decisions/`) | **delivered by [#1680](https://github.com/ThinkFlowLab/FlyBot/issues/1680)** | this page, [PROJECT.md](PROJECT.md), [docs/governance.md](docs/governance.md), [decisions/](decisions/README.md) |
| Chief's severity triage and escalation, in operational wording | open — next | [docs/governance.md](docs/governance.md) describes the target; Chief's routing text and the escalation template are still to be written |
| A recorded disagreement / reclassification case | **recorded by [#1690](https://github.com/ThinkFlowLab/FlyBot/issues/1690)** | [decisions/2026-10-29-stage-1-dogfood.md](decisions/2026-10-29-stage-1-dogfood.md): Triage set `needs-human` on [#1550](https://github.com/ThinkFlowLab/FlyBot/issues/1550) on 2026-10-28; the owner reclassified it on 2026-10-29 and the label came off |
| A recorded major decision taken end-to-end: proposal → Chief classification → maintainer discussion and consensus → archived decision → executable issues | partly demonstrated by [#1550](https://github.com/ThinkFlowLab/FlyBot/issues/1550) itself | [#1550](https://github.com/ThinkFlowLab/FlyBot/issues/1550), [decisions/2026-10-29-stage-1-approved.md](decisions/2026-10-29-stage-1-approved.md) |
| Capture what Chief could automate and what still needed a human | open | to be written into the Stage 1 close-out record |

**Stage 1 acceptance (from [#1550](https://github.com/ThinkFlowLab/FlyBot/issues/1550)):** use a real
major design issue to demonstrate proposal → classification and research → maintainer discussion and
consensus → archived decision → executable issues, including a disagreement or reclassification case.
No pull request for the architecture proposal itself before authorization.

## Stages 2–5 — plan of record, not started

| Stage | Objective | State |
| --- | --- | --- |
| **2. Project as the work and knowledge boundary** | one unified Project view without duplicating task stores; role-aware owner/maintainer/member views; a shared Project State reader; a limited user–project assistant identity | not started; no code |
| **3. Handoff-controlled Workflow and isolated pool workers** | agree the typed Task/Handoff contract; role pools, ephemeral isolated workers, quotas, lease and recovery; strict DAG stays an option | not started; contract not agreed |
| **4. Chief meetings and Project Assistants in live collaboration** | temporary AI/human meetings for unresolved issues, archived decisions with dissent, personalized daily digests | not started |
| **5. RSI / autonomous project evolution** | research placeholder only | **gated**. No development, no agent-queue assignment and no performance claim until a separate proposal defines the optimization objects, evaluation criteria, safety boundaries, experiments and measurable acceptance tests |

Stages 2–4 are implementation direction, not approved work items: each stage becomes work only when
the owner approves its scope and it is split into reviewable issues. Stage 5's gate is unchanged by
Stage 1's approval.

## Not doing now

- No complete new UI for a Project console, and no rewrite of the existing DAG engine.
- No second task board and no new scheduler; existing boards, groups and GitHub stay the only
  stores.
- No knowledge-graph or vector-memory platform.
- No autonomous change of the mission, and no unreviewed expansion of Bot privileges.
- No change to `AGENTS.md` as part of a roadmap edit: the operating contract is linked, not copied
  here.

## How this roadmap changes

Editing this page is a **major** decision: the owner or a human maintainer concludes it, and the
outcome is recorded in [`decisions/`](decisions/README.md) with its evidence, participants and
dissent. A stage moving from "not started" to "active" is itself a decision, not an edit alone.


Completed M7.2–M7.5 implementation checkpoints are retained verbatim in
[the historical record](docs/history/2026-11-03-completed-m7-checkpoints.md). Current
role/resource/Session contracts and outstanding acceptance remain below and in the active roadmap.

### M7 validation update — 2026-11-01

Owner requested Codex-only real acceptance on the current machine using zy95-12 GitHub.
Run the opt-in dedicated-profile SDK/Workflow/PR/return/retry/acceptance path and record
its exact source SHA. Do not block this scoped demonstration on Claude configuration;
keep the broader mixed-Harness/two-resource criteria explicitly outstanding.

Codex-only local demonstration: passed at `73161f3`; real artifact PR #31 returned,
#32 re-tested/re-reviewed and script-accepted at its exact SHA. No merge/deployment.
Broader Claude/mixed-resource/browser-auth/restart checks remain separate future work.

## Owner-authorized collaboration repairs — 2026-11-01

[Tracking #33](https://github.com/zy95-12/FlyBot/issues/33): #34 repository preflight → #35 role contracts → #36 per-Bot pools/handoff → #37 ordinary Chief queries → #38 safe/watch delegation → #39 Chief arbitration/configurable schedules → #40 native UI/multi-Bot reuse → #41 actual shared-service acceptance. Component/UI inventory may proceed alongside its foundations; each implementation has its own PR and tested evidence. Public hosting is deferred. A 30-minute Chief inspection is a configurable scheduled-task default, never framework logic. R1 PR #42 passed full local verification; configured-service acceptance is pending. R2 implements complete role-policy delivery and evidence separation and is under verification. R3 dynamic pool/claim/handoff implementation is under verification, including non-DAG SDK contract-process rework. R4 conversation/query/status repair is under verification; R5 persistent safe/watch delegation is under verification; R6–R8 remain pending; R4 integrates conversation bridging and R6 completes Chief arbitration/configurable schedules. The owner requests backend repairs first, then real human-style assignment through FlyBot to exercise role handoffs and Chief fallback.

R6 implementation checkpoint: Chief now adjudicates completion/uncertainty and may
intervene through audited routes. Inspection reuses original configurable DSH
schedules; there is no Chief cadence in framework timers. After exact-tip full
verification and its own draft PR, upgrade the backed-up shared backend, assign
#40 through actual FlyBot and collect real Codex/handoff/Chief/restart evidence in
#41. Protocol fixtures alone do not satisfy those integration criteria.

Earlier R6/R7 implementation, recovery and frontend checkpoint narratives are
[archived verbatim](docs/history/2026-11-03-collaboration-checkpoints.md).
Current constraints remain: backend changes run in the owner's foreground session;
preserve original frontend Task40/PR48 and its native UI/functions/history; healthy
execution is not interrupted. Only authorized same-Project Chief inspection may
select an existing Task. Keep bounded source-matched failed-test diagnostics and
full redacted logs. Basic CI is the default; heavy browser/runtime/package jobs are
explicit extended checks. No source/fixture test implies independent Review,
deployment or current UI acceptance. Preserve same-Task/PR/candidate ancestry,
actual exit proof, quotas and current rights during recovery. Original native
composer, tools, approvals, stop/continue, personal/group behavior and real desktop/
narrow-screen/weak-network screenshots remain acceptance work; do not mark #40/#41
complete from these historical checkpoints or backend convergence alone.

### Resident Chief and Task-role context — 2026-11-01
Implemented Task-role logical identity, binding-checked SDK resume across rework, retained cwd ownership/cleanup and current candidate inputs. Added original-store Chief topic-memory read/write/replace and same-thread scoped retrieval rounds, plus immutable context archives instead of re-sending unbounded history. Native DSH keeps its original parts/steward/compaction; SDK uses its own runtime compaction. Verification must include real resource-user/runtime continuation and Chief memory before claiming live delivery. Current native workflow carriers remain per execution; their logical Task identity and retrievable facts are retained, not falsely described as SDK backend threads.

Task40 continues with synchronized native CSS/JS loading and a scoped composer
exported from the original composer module, sharing dictation cleanup and captured
chat sends. Focused regression evidence is separate from complete UI acceptance;
rich tool/approval, personal running state and deployed browser acceptance remain open.

Task40 native interaction continuation implements personal questions/one-shot approval,
stop/continue, own-chat streaming, bounded tool output and original group member-work
controls. SDK execution input reuses original approval/composer components. Proceed to
exact-candidate host tests and independent Review; only operator evidence can satisfy
actual deployed three-account/weak-network and visual acceptance.

Task40 host-return repair preserves legacy listener registration while retaining the
explicit shared native stream observer. Reproduced all four reported failures and
added a fail-without-fix mode-boundary regression. Continue through host tests/Review
and operator acceptance on the same Task/PR48.

Task40 review-return continuation repairs live-part navigation and replaces plain human
paragraphs with original person bubbles. Native file/image sends and scoped historical
attachment reads are implemented through public DSH APIs with explicit shared-entry
byte limits. Proceed through host verification/independent Review; operator deployed
three-account, weak-network and screenshot evidence remains separately required.

Task40 refresh repair retains scoped native roots and updates props instead of
unmounting on each poll. Bounded mounted-workbench regressions cover focus, selection,
drafts, sends and teardown for personal/public/private/room views. Continue through
new candidate verification and Review without borrowing earlier candidate evidence.

Task40/PR48 integrates preserved frontend 0e72dc60 with operator backend b920cae8,
including S1 and verified workspace/Session exit proofs. Compact board status
uses the same live-activity evidence as the full S1 view. Integrated focused tests
pass; exact sealed candidate host verification and independent Review come next.
Actual shared-service browser/weak-network/screenshot acceptance stays outstanding.


Issue60 follow-up restores the completed-Chief deferral checkpoint discovered by
real S4 frontend recovery. Keep all exit/lease guards and the current unsealed
Attempt; recovery uses supported admission after a verified service checkpoint.


Delivery documentation follow-up: root README links the operation guide and full
v1 API reference (parameters/results/permissions/replay/errors). Current JSON CLI,
in-process service and incomplete real watch/UI acceptance remain explicit; no
standalone frontend, OpenAPI service or runtime migration is implied.


### Backend convergence #2184 — 2026-11-03

SDK Task-role binding hardening: pinned shared definition snapshots, latest observed
partial-thread recovery, verified legacy-key adoption, durable dispatch intent,
explicit incompatible recovery, current rights/resource checks and truthful adapter
capabilities. Native Task-role context restoration, parent waits, transactional Effects
and external command receipts remain dependent acceptance; no live-provider or deploy
claim from controlled process tests. README/API rewrite remains last (#2189).


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

#2177 follow-up: validate two sequential native Chief jobs against fresh per-turn facts while retaining the same resident Session; dependent Task admission runtime acceptance remains #2179.

### 2026-11-03 — Project Task contract (#2179)

New shared Tasks have Chief admission and versioned requirements. Existing Task/pool/Effects records carry independent child proposals, a released parent wait and one stable resume Handoff; child failure/cancellation never satisfies a wait. Original parent role context and workspaces are retained. Raw legacy board transitions cannot bypass the new contract, while persisted pre-contract Tasks keep their original semantics. Chief callback, rollback, exit and duplicate-resume tests are distinct from real-provider full child integration acceptance; native restore2184, storage2182 and public event/receipt2185 dependencies remain open. README simplification2189 remains last.

#2179 retains legacy Workflow delivery compatibility while requiring Chief admission for new Tasks on either path. Chief runtime quota is independent of execution slots; waiting parent lease state remains authoritative. Full real-provider child integration and native physical restoration are still dependency acceptance, not implied by deterministic runtime tests.

#2179 follow-up: Chief dependency waivers/substitutions retain exact outcome versions and explicit judgement evidence. Accepted child code enters the existing durable integration gates before parent execution; source admission is not merging or parent acceptance. Actual Git multi-parent sealing tests use deterministic child acceptance fixtures. Full real-provider parallel collaboration and native physical restoration remain pending.

#2182 implements opt-in transactional SQLite through the existing Store, exact-identity migration, process-death commit tests and recoverable offline rollback. Retain configured Chief semantic decisions while routine facts/queries remain deterministic. Public scoped event/receipt service #2185, legacy entrypoint cutover #2186 and final real deployment/README #2189 remain subsequent stages; current production state is unchanged.

#2185 unifies command recovery, bounded history/source queries and committed Project event/SSE transport over existing services. Verify persistence failure/restart, current permissions and source hashes separately from model development. Complete legacy interface/cutover compatibility #2186 and original role/native-session dependencies before the final #2189 deployment/README rewrite.

Native prior-host reconciliation now reuses verified supervisor process-group facts; native v2 registered-work/lineage and shared adapter-exit regressions guard against premature initiative transfer. In-flight current-rights abort and composed-stack acceptance remain active.

Canonical ongoing role/resource authority checks now reuse native step/SDK input and the existing scheduler + pool stop. Frozen role context remains stable; current revoked rights stop execution, with unknown exit held. Compose descendants and verify parent Task resume/API projections next.

#2186 adds the original-capability inventory and committed legacy cutover on the existing Store, group/Chief channels and Workflow controller. Validate same-version JSON/SQLite rollback separately from real-provider and UI acceptance; final real backend packaging/README #2189 follows.

#2189 supplies the persistent source init/start/login/API client and final object/API/operations documentation. Verify isolated fresh installation, retained auth/Task receipt across restart, consultation privacy, external safe/watch and SSE revoke; keep real-provider/remote/browser/production rollout evidence separate. Existing service/frontend flows are untouched.

#2292 follow-up: initial-role admission now follows approved capabilities with durable queue/start bindings; Task repository/local repository-free decision execution is implemented; bounded legacy history is implemented; Release evidence is implemented; actual real-model/parallel/restart/migration/UI and release operational acceptance remain pending under #2292.
