---
subsystem: project-pools
owned_paths:
  - core/src/host/project-pools.js
  - core/test/project-pools.test.js
---

# Per-Bot Project task pools and handoff

After saving a new handoff receipt, the pool wakes the existing Project dispatcher
immediately. Dispatch coalesces concurrent events; it does not await a scheduler
wake from inside the pool's serialized mutation. Duplicate receipts do not emit
another wake, and confirmed-exit/authority/evidence gates remain unchanged.


New shared deliveries default to `project-handoff/v1`, with
`project-delivery/pools-v1` Attempts. `projectDispatch: workflow` explicitly selects
the historical fixed DAG; saved v1–v4 Attempts are unchanged. The existing Workflow
plugin supplies worker lifecycle operations and its pure `validateHandoff`; a
missing adapter blocks admission rather than silently substituting a DAG.

## Identity, ownership and receipts

Each durable role definition has a stable logical Bot ID. Task.collaboration stores
its destination, current claim, generation, originating human, Task kind and receipt
history. There is no second Task database. `project-task-pools` lists each Bot's
available Tasks for a current Project member. Human permissions are checked at
admission and again at claim/result; a role label grants no human authority.

A receipt includes Project, Task, Attempt, logical from/to, reason, requirements,
policy protocol/definition revision, idempotency key, generation and lifecycle.
Pending receipts become accepted on atomic claim and retain the finished execution
record after transfer. Duplicate decisions have one effect; altered retries and
old claims are refused. Tasks retain their ID across arbitrary handoffs and returns.

Only one worker can claim a Task and a logical Bot has WIP one. Busy resources leave
Tasks queued. Claim creates only the receiving role's resource lease, worktree and
temporary Session. The trusted adapter binds the current policy/context and actual
worker. Native/SDK result routing consumes retired worker replies on their original
run surface, so stale results do not fall into Chief chat. Restart blocks interrupted
claims and preserves unknown worker/resource evidence; it does not fabricate exits.

## Decisions and evidence

The actual worker receives Task content, policy, evidence and logical Bot choices.
It returns one `OUTPUT handoff:` JSON decision: handoff, return, transfer, complete or
arbitrate. Transfer routes without claiming completed role evidence. Repeated role
Sessions keep distinct immutable SDK logs and archive previous evidence. Direct handoff/return names a target and bounded reason; complete and
arbitrate enter Chief's pending pool, never close the Task. No static graph chooses
the next Bot. Ordinary next-role routing needs no Chief approval.

The existing validator enforces role/owner/evidence/idempotency/cycle/quota checks.
Destination-specific `task.poolAcceptance[role]` applies at that handoff; overall
`task.acceptance` applies to Chief admission. Model-supplied evidence is an
untrusted claim, never proof of green CI or signed PASS. Step quota also gates
claim before starting another worker. Runtime execution limits are operator config
`projectExecutionTimeoutMs` (default 120000, bounded to 1000–7200000).

The worker must confirm exit before its claim transfers and capacity becomes free.
Developer completion seals permitted code; Tester completion runs the configured
host verification; Reviewer completion checks exact candidate/test evidence and
may publish the draft candidate PR. A return to Dev after a candidate creates a
new Attempt seeded from that candidate and preserves the previous evidence.
Decision/release Task kinds may hand over outputs without requiring a code commit;
repository/resource admission still applies. Neither execution completion nor
JSON approve grants merge/release or final Task-close permission.

Chief inbox/arbitration and configurable inspection schedules are completed in R6;
conversation-only bridging is integrated in R4. R3's SDK contract-process scenario
covers Dev → Reviewer → Dev → Reviewer → Tester → Reviewer → Chief using a single execution
resource, distinct Sessions, two Attempts and one Task. This is deterministic
protocol evidence, not real Codex or persistent-service acceptance.


Repair R4 (#37): Task admission preserves its published code/decision/release
kind and rejects a conflicting execution-time kind. Ordinary inquiries are
separate conversation handoffs, not pool Tasks. See [conversation routing](project-agents.md).


Repair R5 (#38): Claims, results and handoff admission validate the
initiating human account outside the browser when the operator principal checker
is configured; otherwise only a live initiating platform session suffices.
Revocation fences the claim before worker shutdown; unknown exits retain capacity.
See [delegation contract](project-delegations.md).

Repair R6: Chief admission no longer demands final completion evidence. Chief
claims its receipt, validates closure through existing gates or routes/returns
with an explicit reason. Confirmed worker exit precedes intervention; unknown
capacity remains held. Failed host verification offers the same Task to Chief.
See [Chief control](project-chief-control.md).

Failed execute/dispatch admission fences the old claim and records a rejected
receipt before entering Chief arbitration. Unknown worker exits retain occupancy;
absence of a returned worker handle does not fabricate exit confirmation. Late
results against failed receipts are stale, not idempotent successful decisions.

A successful new handoff clears stale active block/question fields and archives
them on its receipt, preserving audit without reporting repaired work as blocked.

Chief route to Dev may resume a running pre-candidate Attempt in its existing
workspace after a preparation fix. Explicit return, interrupted Attempts and
candidate-backed rework create a new Attempt, retaining prior evidence.

Route forwards explicit resume intent; delivery validates release proof before
reusing an interrupted unsealed workspace. Explicit return still requests rework.

## Audited intervention and routing budgets

Autonomous per-edge repetitions are counted since the last admitted Chief intervention.
Only the privileged Chief routing path starts a new epoch; normal role decisions
cannot request one. Historical receipts and global token/time/step usage remain.
Chief routes still satisfy evidence, current authority, quotas and worker-exit gates.
Admission is preflighted before fencing a claim or creating/resuming an Attempt.
A later preparation/authority failure records a blocked state with its decision ID.

## Durable effects and outbox (S2)

Each offered handoff saves its exact pool.dispatch intent in the same state snapshot. Failed pre-commit offers roll back; only a committed effect may enter the targeted original pool pump. Restart migrates old queued receipts without changing identity, and preserves interrupted/unknown claims. Dispatch receipts are not model-read or completed-work evidence; S3 adds that contract. See [effect contract](project-effects.md).


## Durable Task inbox integration (S3)

S3 stores a handoff input with each pool.dispatch offer, rolls it back only with an uncommitted offer and migrates old pending offers without changing ids. Current-claim injected-batch acknowledgements follow successful completed-role gates. Routing receipts resolve handoff transport without manufacturing a model read; remaining feedback follows current responsibility. Closure checks unhandled inputs. See [inputs](project-inputs.md).


## Durable handoff contract projection — #2175

`project-handoff-contract/v1` is a scoped view over Task.collaboration.history,
not another queue. `project-handoff-get {taskId,handoffId}` and
`project-handoff-list {taskId,after?,limit?}` require current Project read access;
list limits are1–100 with receipt-id cursors. Development v1 query names are
`handoff.get` and `handoff.list`. Future durable event streaming remains #2185;
the per-receipt events returned here describe existing persisted timestamps.

States distinguish pending, accepted, processed, revoked and invalidated. Processing
one handoff never means Task completion. Initiative is held by the target pool before
acceptance, then by its active claim; interrupted acceptance is fenced for recovery.
Failure phase/reason is separate from acceptance. Source/target role contexts are
server-resolved references, with immutable original references and actual receiving
context/worker recorded at binding. Private transcripts and caller-supplied Session
references are not copied. Summaries hold bounded completed/next requirements;
trusted evidence is separate from model claims. Predecessor/successor ids retain
normal handoff, return, transfer and Chief intervention chains.

Trusted `roleCommand` adds `handoff.accept` (taskId,botId,handoffId,requestId) and
`handoff.offer` (taskId,claim,requestId,payload.action/reason/to/outputs). These map to
the same original claim/decision services. They are host execution ports; public HTTP
cannot submit role tokens or invent a receiving identity. Accept response replay
returns its original claim or historical outcome and cannot revive completed work.
Old `claim`/`handoff`/`return`/`transfer`/`complete`/`arbitrate` ports remain compatible.

Confirmed source exit precedes relinquishing an execution claim. Even after Chief
observes a failed writer, a downstream non-Chief claim rechecks unresolved historical
exits; selecting another resource cannot bypass them. Chief may still observe and
arbitrate a blocked Task. Unknown occupancy remains visible and pending; a timeout
is not release evidence. Native exit/restoration and transaction-wide recovery still
follow the execution/storage acceptance work, not fabricated from these view states.


#2177 commits the source role's bounded working-summary reference with its handoff.
Failed uncommitted offers preserve the previous valid summary. Optional bounded
experience notes remain inference/unresolved/conflict and cannot overwrite human
facts; bad optional notes record memoryIssue rather than cancelling valid work.
Trusted role.memory.record uses the active claim and original Effects durability;
it neither transfers initiative nor creates a Task. See [context](project-context.md).

## Project Task lifecycle convergence (#2179)

Project Tasks may split independent children after actual source exit, preserving their own work summary and waiting continuation. The released parent has no active claim. Chief-adjudicated dependency results create one stable children-completed Handoff back to the original role/Attempt. Pool serialization, receipt replay and source-exit fencing also apply to parent resume; child cancellation/failure is not success. See [Task lifecycle](project-task-lifecycle.md).


#2179 follow-up: After adjudicated child results, continuation reuses the original logical role. An unsealed Attempt remains; a sealed candidate requires one successor Attempt seeded from that candidate. Replay reuses the recorded successor and stable children-wait Handoff. Claiming records the wait as resumed, preserving its original released claim reference.

#2185 acceptance: claim/accept persists a pool.accept marker alongside the claim and Handoff acceptance. Failed commits restore pending ownership; idempotent replay/current role operations require confirmed acceptance proof. The adapter is registered on startup for marker recovery, not only after a new claim. Legacy persisted claims without the additive proof retain their original recovery fence; the marker never dispatches an executor.

#2184 records logical role and pinned capability class on a claim. Active targets alone can receive new offers/claims; a removed queued target becomes blocked with a Chief-routing reason while its Task/initiative/history remain intact. An already acquired source may finish its retained frozen claim after retirement, then explicitly hand off to an active target. Developer-capability destinations use existing rework semantics even when named differently. Artifact responsibilities stay in the existing Attempt's roleAssignments; no new queue or scheduler is added.

Composition with #2184 rechecks the committed target role after asynchronous source-exit confirmation, before claiming. Retirement during inspection leaves the original Task blocked for Chief routing; it cannot acquire a new execution claim from the earlier catalog snapshot.

Canonical claims retain the admitted requirement revision. Decision admission rechecks that revision before and after awaited authorization, including transfer/split decisions that do not seal an artifact. Older claims can use their actual Attempt snapshot revision. A late old-plan response cannot transfer initiative or create children for revised requirements.
