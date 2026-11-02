---
subsystem: project-chief-control
owned_paths:
  - core/src/host/project-chief-control.js
  - core/src/host/project-chief-schedule.json
  - core/src/host/project-scheduled-tasks.js
  - core/src/host/project-process-proof.js
  - core/test/project-chief-control.test.js
  - core/test/project-scheduled-tasks.test.js
  - core/test/project-process-proof.test.js
---

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
or rejected status. A failed Chief run blocks completion rather than inventing success.
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
