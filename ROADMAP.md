# FlyBot — Roadmap

## Follow-up reliability — 2026-11-04

Implement #2336 reservation cleanup first; then #2337 CLI configuration, #2334
environment attribution, #2346 context migration, #2338 receipts, #2347 recovery
routing, #2331 controlled merge and #2342 operational-agent collaboration. Separate
PRs retain existing UI/control-plane, authority and exact exit/evidence contracts.
#2336/#2337 are merged. #2334 adds executor dependency receipts and classified
verification; actual Docker and paid inference remain distinct acceptance evidence.

## Recovery delivery — 2026-11-04

Implement and merge #2325 → #2327 → #2328 → #2330 sequentially into
`delivery/ai-centric-development-service`, one PR per issue. #2325 covers actual
workspace materialization and explicit source admission; Chief owns recovery
choices, the host preserves authority, evidence and execution-exit gates.
#2327 implements same-Session correction with structured feedback and a configured
budget; no implicit role routing or human escalation. #2328 adds exit-proven input waits and shared new/resume admission.
#2330 implements scheduled restart/deadline recovery and explicit inspection health.
Actual isolated native restart acceptance is distinct from paid SDK/live deployment.

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

Earlier service chronology are [preserved in the dated history](docs/history/2026-11-04-earlier-delivery-roadmap.md).
Current authorization, Task/Session/role constraints and original capability compatibility
remain in PROJECT.md and canonical subsystem contracts. Historical test evidence does
not complete outstanding real-provider, mixed-resource, release or frontend acceptance;
no new deployment, privilege expansion or automatic mission change is authorized.

Current execution order (Owner update, 2026-11-01): keep the existing frontend
#40 Task/PR48 autonomous while implementing backend #49–#55 directly in the
foreground session, in separate issue worktrees and with staged verified rollout.
Do not use FlyBot to assign backend repairs. R6 recovery covers serialized wake
bursts, immediate persisted handoff/Chief events, original-requester queue recovery
and receiving-workspace preparation before inference and host testing. Remaining
live integration, frontend restoration and R8 acceptance retain their existing
issues; no passing unit suite alone completes them.


Earlier M0–M7 and service checkpoints are [preserved in the dated history](docs/history/2026-11-04-earlier-delivery-roadmap.md).
Current authorization, Task/Session/role constraints and original capability compatibility
remain in PROJECT.md and canonical subsystem contracts. Historical test evidence does
not complete outstanding real-provider, mixed-resource, release or frontend acceptance;
no new deployment, privilege expansion or automatic mission change is authorized.

## Historical upstream roadmap

The inherited 2026-10-29 stage history is [preserved verbatim](docs/history/2026-11-04-upstream-roadmap.md).
It is historical, not new authorization. The upstream RSI stage remains gated;
no autonomous mission change, privilege expansion, new knowledge platform, second
Task store or unrelated UI/DAG rewrite is authorized by archiving this record.
Current fork work follows explicit owner approvals, PROJECT.md, AGENTS.md and
subsystem contracts. Original governance and operating gates remain unchanged.

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


Earlier convergence implementation notes are [preserved in the dated history](docs/history/2026-11-04-earlier-delivery-roadmap.md).
Current authorization, Task/Session/role constraints and original capability compatibility
remain in PROJECT.md and canonical subsystem contracts. Historical test evidence does
not complete outstanding real-provider, mixed-resource, release or frontend acceptance;
no new deployment, privilege expansion or automatic mission change is authorized.

### Completed convergence checkpoints

Dated #2179/#2182/#2185/#2186/#2189 implementation and evidence notes are
[preserved verbatim](docs/history/2026-11-04-completed-convergence-checkpoints.md).
Current Task admission/dependency, storage, receipt/cutover, native exit and role
revocation rules remain in PROJECT.md and their subsystem contracts. Preserve
current authority checks before execution and stop on revoked rights; unknown
exit retains capacity. Real-provider parallel/restart/migration/UI and Release
operational acceptance remain distinct pending evidence under #2292. Previously
deferred multi-repository automation is not reactivated by this recovery work.
