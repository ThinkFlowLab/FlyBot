---
subsystem: project-chief-control
owned_paths:
  - core/src/host/project-chief-assistance.js
  - core/test/project-chief-assistance.test.js
  - dev/demo/chief-assistance.mjs
  - docs/chief-assistance.md
  - core/src/host/project-chief-recovery.js
  - core/test/project-chief-recovery.test.js
  - core/src/host/project-chief-lifecycle.js
  - core/test/project-chief-lifecycle.test.js
  - core/src/host/project-chief-protocol.js
  - core/src/host/project-chief-control.js
  - core/src/host/project-chief-schedule.json
  - core/src/host/project-scheduled-tasks.js
  - core/src/host/project-process-proof.js
  - core/test/project-chief-control.test.js
  - core/test/project-scheduled-tasks.test.js
  - core/test/project-process-proof.test.js
---

#2308 lets the existing configured inspection report exhausted personal-agent
notification budgets and long inbox waits using recipient/status metadata only.
Private questions/replies never enter inspection facts. Reuse the original
schedule and Chief routing/human fallback; no new polling clock. [Inbox](agent-inbox.md).


# Chief arbitration and original scheduled tasks

Repair #39 reuses Task, Attempt, Run, resident Chief, temporary Harness execution
and resource leases. A configuring human explicitly enables arbitration with
`project-chief-configure`. The current human account and Project configure rights
are checked again for each job/effect. Chief cannot authorize itself. Policy revision,
carrier generation, Task generation, Attempt and candidate SHA fence late results.
`project-chief-state` reports policy, schedule and actual coordination Runs;
`project-chief-inspect` requests an idempotent inspection with a requestId.

Completion/uncertainty handoffs enter Chief's pool. The actual native or SDK Chief
receives the complete pinned role policy and an evidence snapshot, then proposes
bounded close/route/return/request-tests/needs-human/continue decisions. Normal
role handoffs still go directly to the next pool. Chief closure requires explicit
criteria evidence and the existing host candidate/test/review/PR-head gates.
Explicit acceptance requirements are checked at closure, not used to prevent Chief
from receiving incomplete work. Release claims without trusted proof cannot close.
A candidate recommendation is not a signed forge Reviewer PASS or merge permission.
Every decision records the initiating human, Chief executor, snapshot and applied
or rejected status. A failed Chief run remains unsuccessful coordination; it neither revokes existing evidence nor adjudicates Task acceptance.
Returns preserve Task identity and create a fresh Attempt when code must change.

## Scheduling

`project-chief-schedule.json` is the editable template: every 1800 seconds by
default, with prompt, enabled state and anomaly thresholds. Enabling the Project
configuration creates an **original DSH schedule**, not another timer engine.
The logical scheduled-task ledger maps a stable Project/Chief target to the actual
DSH record, supports edit/pause/resume and remaps that single record when its
carrier changes. Paused/resumed records may have a different native ID while
retaining their logical ID and history. A persisted creation intent reconciles an
unambiguous original record after a crash; ambiguous matches block duplication.

Only trusted schedule-source inbox envelopes with the mapped ID, current prompt
and normalized occurrence are consumed. Occurrences deduplicate durably. Mixed
batches preserve unmanaged messages; clock-only remnants cannot start a second
model turn. The existing generic work pump dispatches already-due deliveries;
it never computes a Chief-specific 30-minute cadence. Native inbox delivery and
actual Chief job completion are recorded separately. No schedule is installed
merely by loading this module or reading the template.

Inspection computes repeated handoffs without verified evidence progress, long
execution/wait and missing SDK heartbeat from persisted host facts. Message/status
churn is not artifact progress. All thresholds and inspection content/cadence are
configuration. Coordination does not consume a delivery-task quota slot, but its
actual execution still requires physical resource capacity.

## Restart and process proof

Interrupted work is never assumed successful or automatically freed on missing PID.
Local workers record the actual systemd invocation and control group only when
supervisor metadata matches the running process and KillMode=control-group.
A changed invocation under the same boot/unit/group proves the old scope exited;
unknown, unmanaged, remote or different-boot scopes retain occupancy. Confirmed
exit permits recovery of the same Task's interrupted Chief receipt. Sealed SDK
logs bind actual worker, lease generation, carrier and Run before effects.

## Evidence boundaries

Deterministic native/backend and SDK protocol-child tests cover two Attempts of
one Task: Chief returns missing test coverage, Dev repairs, Tester/Reviewer hand
off, Chief closes. They also cover stale authority/carrier/generation, rejected
closure, timer mapping, pause/resume, deduplication and conservative process proof.
These fixtures are not actual Codex, original live DSH timer delivery, browser
acceptance or shared-service restart evidence; those remain issue #41 acceptance.

Native continuation invariant: an empty pre-step inbox remains admitted when no
managed reminder was consumed. A tool result may continue without new messages.

Inspection records lastMeaningfulProgressAt and evidence references from a new
candidate with passed host verification. A new commit alone or repeated tests at
the same SHA cannot reset the handoff counter. Snapshots include execution age,
worker state and heartbeat so Chief can distinguish a legitimate long task.

Judgement snapshots include the actual handoff reason, block and Task-scoped
resource lease/exit-proof facts, so failed admission is distinguishable from a
live long-running worker. No lease is released solely on a model judgement.

Snapshots expose bind-before-external-start registration proof: an Attempt with
no lease, worker, Session, Workspace or claim worker handle never allocated execution.
Any such record makes allocation recorded/unknown; missing PID is never this proof.

Chief distinguishes route/resume from explicit return/rework and receives actual
SDK stop-ack/process-exit proof. A matching historical released SDK record is
trusted host exit evidence, unlike a terminal Task or absent PID.

Snapshots name Attempt status and the actual claim Bot. A Chief request for human
clarification ends its own active claim as waiting-human, preserving the question.

Chief routing checks handoff admission before fencing current execution or preparing
a successor Run. An audited intervention begins a new bounded autonomous routing
epoch without resetting global usage or history. Preparation failures after fencing
record an explicit blocked state linked to the decision instead of remaining stopping.

Real Reviewer environmental INC must preserve the tested candidate and route for
permitted verification after host provisioning, rather than discard implementation
or manufacture a review approval. Complete fixture browser results remain separate
from actual deployed shared-service acceptance.

An already tested, fully released Chief-wait checkpoint can survive host restart
with an audit entry. Active execution or any unknown worker/lease remains interrupted;
this exception permits no automatic approval or fabricated progress.

New Chief job requests wake the existing Project dispatcher after durable save.
An existing source-key receipt returns without a redundant wake; this prevents
a self-triggering arbitration loop. Scheduled inspection cadence remains original
DSH configuration, independent of event-driven job execution.

## Development service compatibility (S1)

The original logical schedule handler enters the development service scheduled port after occurrence persistence and authority checks, then invokes the existing Chief implementation. Occurrence IDs, request deduplication, configurable timing and Chief adjudication are retained. See [service contract](project-development-service.md).


## Durable Task inbox integration (S3)

S3 snapshots durably bind bounded Task input batches. Unforgeable in-process receipt permits validate source/generation without consumption; failed decisions leave pending input. Closure rechecks later input and commits its receipt with acceptance; routing acknowledges only after success. The original configured periodic inspection remains unchanged. See [inputs](project-inputs.md).


## Approved integration recovery (#60)

Snapshots expose admitted operator input refs/SHAs. New manager admission bumps
collaboration generation so an older Chief decision cannot act on unseen inputs.
Once the host supports the pinned merge, route Developer with rework=false to
resume the current unsealed Attempt; do not ask a role to bypass shared-ref
restrictions or replace merge/index metadata. Ordinary autonomous handoffs and
configured inspection timing remain unchanged.


### Completed deferral claim lifecycle (#60 follow-up)

An arbitration `continue` decision blocks completion but marks only its own Chief
execution claim waiting-human, as needs-human/missing-decision already do. Keeping
it active after the job/SDK exited falsely blocks manager source admission. This
is not execution-exit proof: running jobs, held leases, unknown workers and other
current claims still block through their existing checks. Task/Attempt/generation,
audit and workspace remain intact; no ownership is granted by the status change.


Needs-human decisions now retain a private consultation recipient: prefer the
initiator's active default personal agent, fall back to the current human, and
retain any explicit personal-only answer restriction. Notification is staged in the
existing Effects service with the decision; native watch authority is revalidated at
execution. Safe suggestions require explicit user publication, while watch answers
use ordinary Task input admission. Chief retains Task initiative and decides whether
the answer resolves the block. See [consultation protocol](project-agents.md).


#2177 snapshots meaningful Chief decisions into separate scoped working topics on
the existing persistent public carrier. Summaries retain original Task constraints,
uncertainty and source evidence; later turns retrieve a bounded relevant subset.
A summary failure records contextIssue and preserves the previous summary without
erasing a decision already applied through the original gates. No new timer is added.

## Project Task lifecycle convergence (#2179)

Chief intake is separate from arbitration: only arbitration claims a Chief pool receipt. Snapshots include bounded current Task requirements, admission and child dependency references, and reject stale requirement revisions before mutation. Scoped admit/revise/cancel/reopen decisions use existing Effects and input notifications. Proposed work does not execute merely because a user published it.


#2179 follow-up: Dependency snapshots expose exact scoped versions. Protected resolve-dependency callbacks record qualitative waivers or accepted replacement outcomes with evidence, never fabricated passing tests or child acceptance. Cancellation may end its own scoped Chief Task claim without inventing worker-exit proof.

Validated Chief completion accepts up to four role proposals alongside Task decisions. The host supplies stable run-scoped proposal keys and current Chief-job authority; proposals cannot apply role changes. A malformed proposal list fails the job rather than granting configuration rights.


Custom-role targets use their approved capability class for Developer rework semantics. The active catalog still controls new targets; an existing claim's frozen source identity may be retained after retirement for completion/Chief intervention. Chief must explicitly choose an active destination for blocked retired-role work.


Native prior-host recovery reuses the existing supervisor proof helper and exact lease/generation data. A matching known exit permits safe cleanup/resumption; unresolved platform jobs, old unmanaged scopes or lost context remain explicit held conditions for Chief/operator reconciliation. No new inspection timer or parallel execution coordinator is introduced.

#2292 actual Codex admission exposed a requirements.criteria array/string ambiguity. The Chief prompt now distinguishes typed requirement strings from outer criteria evidence arrays, retaining strict domain validation. Failed pre-admission callbacks persist bounded admission.failure with the failed run reference; snapshots and Task views show blocked/chief-recovery. Existing chief.inspect provides explicit retry, and valid admission clears only the active failure marker while retaining failed run/decision history. No new retry timer or model-output coercion is introduced.

## Workspace baseline and explicit inputs — #2325

#2325 supplies bounded repositoryRecovery facts with operator ref/SHA choices, workspace snapshot/materialization and the latest preparation failure. A validated Chief may attach repositoryInputs to route/return; the trusted delivery port rechecks current authority, exact snapshot/ref/SHA and confirmed workspace exit, excluding only the current authenticated Chief job that never owns the Dev workspace. Arbitrary source selection and other active/unknown workers remain refused. Protocol correction and proactive prompting follow in #2327.

## Bounded protocol correction — #2327

Autonomous progress within current authorization is Chief's first priority. The host
supplies exact active logical Bot IDs, fresh Task/resource/repository facts and typed
protocol feedback. It never infers Developer or creates a consultation from a malformed
route/return. Root JSON is validated first; each Task is then protocol/scope/receipt-checked before its own effects. Valid independent Task decisions may commit while rejected Task items receive correction.
Missing/invalid destinations, malformed JSON and requirement strings are correctable;
permission, stale evidence and actual execution failures retain their original gates.

`inspection.correctionBudget` defaults to 2 and accepts integers 0–4. A run pins its
budget. A committed `chief.correction` intent permits a fresh invocation of the same
resident Chief Session and control run only after prior execution exit/release. Each
invocation rechecks policy, current role catalog and scoped snapshots. Feedback is
bounded to five entries; private execution proof paths never enter correction prompts.
Stale/duplicate callbacks cannot apply another decision. History retains hashes,
invocations and exact applied-decision receipts; a failed durable save cannot authorize
retry. No extra timer is introduced.

Pending correction appears as `correction-pending` / Task `awaiting-chief`; exhaustion
is an `incomplete` judgement with Task `blocked/chief-recovery`, not an automatic human
escalation. Chief can later independently choose consultation, repair or another lawful
route through the original inspection interface. A valid decision clears only its Task's
current issue marker, retaining failed invocation/audit history. Separate per-Task
execution failure isolation and scheduled restart recovery remain #2330.


#2328 captures an explicit Chief input-wait checkpoint after needs-human. The host releases project execution capacity only with current exit evidence; input receipt does not resume work until Chief routes and the original scheduler re-admits it.

## Scheduled inspection lifecycle — #2330

Logical deliveries persist their Chief runId and reconcile source occurrence/Run
state on each existing scheduler wake. They no longer wait for a process-local
Chief result Promise. An interrupted/failed/cancelled/partial Run settles its delivery
explicitly; a recovered Run can resume the same occurrence, and a done Run is not
replayed. One occurrence remains one Run even across schedule revisions. Redundant
queued reminders coalesce to the latest scoped inspection; historical records remain.

`inspection.lifecycle` configures queueTimeoutMs (600000), runTimeoutMs (900000),
recoveryDelayMs (5000), maxRecoveries (2, range 0–4) and overdueMs (3600000).
Durations accept integers 1–86400000. Dispatch preparation/model transport runs
outside the pump lock, so it cannot prevent its own deadline checks. The original
configured schedule and dispatcher supply all wakes; no new business timer exists.

A deadline fences the old capability and records interrupted/failed, not worker exit.
SDK recovery requires matching invocation, generation, released lease and trusted
stop/process proof. Native recovery cancels the exact exchange and waits for actual
agent idleness before persisting its bound exit receipt. Restart can also use existing
systemd control-group proof; unmanaged/unknown prior execution stays isolated. A
never-dispatched preparation can record registration-before-input absence only when
its fenced preparation actually returns. Stop waits run outside the pump; an unknown
exit is visible and never frees a Session by timeout alone. Current policy, schedule
revision, authority, resident Session and committed recovery intent are rechecked.
The same run gets a fresh invocation/snapshot; stale callbacks cannot mutate it.

Inspection decisions isolate each domain/exit refusal into bounded decisionFailures
and per-Task chiefActionIssue; independent Task decisions still execute. Partial rounds
are not successful inspections. Applied intent receipts prevent duplicate mutation
on recovery; protocol errors still use #2327 root JSON and per-Task validation/correction.

`chief.state.health` separates enabled, pending, healthy, degraded and overdue. It
reports reminder acceptance/start/completion/success, last applied non-deferral decision,
active age/deadline and recovery reason. None of these claims verified project progress;
empty inspections can succeed without changing a Task. Persisted state remains the
source of truth, not a misleading enabled flag or an in-memory waiter.

#2334 supplies structured test outcome, testsStarted, actual executor and preparation receipt references plus bounded SDK dependency observations. Chief chooses recovery; an environment blockage is neither an assertion failure nor automatic escalation.

Missing-runner facts additionally include stage=runner-startup. testsStarted is
configured command invocation; Chief must not interpret it as assertion execution.

#2346 adds bounded contextRecovery facts from claim/worker history, including resumed versus reconstructed identity and source hashes. Chief chooses recovery; no automatic human escalation follows a context mismatch.

#2347 adds typed recovery facts, namespace/birth-checked unmanaged native-Chief
exit, bounded durable stop attempts and safe sealed-candidate verification recovery.
Unknown SDK/container execution stays isolated, including after policy revocation.
See [recovery API and operator guide](../chief-recovery.md).

#2331 supplies current merge waiting/blocking/actual-commit facts to Chief and
wakes the original inspection after observed merge. Chief completion stays separate.

#2342 adds human-selected current operations contacts, bounded public assistance
requests and advisory autonomy budgets. Chief alone selects consultation or a
same-message retry-notification judgement. Original inbox/Effect claims and original
logical schedules remain authoritative; no host privileges or alternate controller.
Inspection projects recipient/delivery/claim/reply and recovery-budget metadata;
other Chief schedules expose actual native nextDueAt. Generation, requirements,
Attempt/candidate and contact/role changes supersede old assistance. See
[operator and API guide](../chief-assistance.md).

## Shared exit verification (#2375)

The existing inspection exit verifier is also used by explicit claim retirement for native/SDK Chief runs. Only exact invocation evidence can discharge responsibility; the generic unmanaged-process predicate is unchanged. Recovery facts are not business routing instructions.

## Run failure and current facts (#2393)

Run.lastResult distinguishes executor responses from host dispatch diagnostics using
hashes and source/invocation metadata. failureDetail records stage/code/recovery kind
and precise missing criteria fields. Neither raw failed text nor V8 parser errors
become Task blocks. Existing business blocks and candidate/tests/Review/merge facts
survive execution failure; only the exact current owned Chief claim may be fenced.
Old generations cannot overwrite new claims or attach current Task failure markers.

Per-Task correction states allowedTaskIds, rejected fields, snapshot changes and
appliedTaskIds. Out-of-scope decisions are explicitly rejected, never silently
dropped; valid scoped siblings remain applied and cannot be replayed/replaced.
Stale generation/requirements/candidate/input batch gets fresh facts in the same
Chief Session; old receipts are never rebased or marked handled. Revoked/foreign
and changed-content inputs remain distinct refusals. Global role proposals wait
when any Task protocol item is invalid. Existing correction/inspection budgets
limit resources and select no business route or human escalation.

Chief may explicitly choose reconcile-exit, invoking #2375 on the snapshot's exact
claim through current authority and durable retirement gates. Its own live run is
not exit proof. Other legal decisions remain available; evidence-supported
Tester/Reviewer recovery uses existing resumeVerification. Historical rejection
text is audit data, not a current routing constraint. No JSON boolean repair,
fixed DAG, generic recovery scheduler or new state store is added.

A failed correction dispatch is transport-incomplete, not a pending model turn. Machine-readable recovery kinds distinguish changed sources, input protocol and missing acceptance evidence; candidate references remain full40-character Git SHAs.
