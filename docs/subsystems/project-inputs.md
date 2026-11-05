---
subsystem: project-inputs
owned_paths:
  - core/src/host/project-receipt-correction.js
  - core/src/host/project-inputs.js
  - core/test/project-inputs.test.js
---

#2308 ensures a published reply to a current Chief question wakes the existing
Chief controller even before the Task has collaboration/role execution metadata.
The input remains pending until actual read/handled receipts; a persisted reply
alone is not Chief processing, Task acceptance or a new Task. [Inbox](agent-inbox.md).


# Durable Task inputs (S3)

`project-task-input/v1` extends the existing Task and per-Bot handoff pools. It is
not a chat-to-Task converter or another workflow/executor. Ordinary conversation
still goes directly to Chief. Human feedback on an existing Project-affecting Task
uses the development service `input.publish` command and `inputs` query.

## Identity, persistence and authority

An input binds Project/Task, host-owned source/event/revision, immutable UTF-8 body
hash, kind, creation time and delivery receipts. Public human input is1–4000
characters and keyed by the current member plus stable command requestId; duplicate
content returns the same input, changed content refuses. Callers cannot select
source provenance, recipient or execution claim. Future source adapters must use a
trusted host port, not interpret external text as authority. Input text is data.

S4 implements the first such host port for scoped GitHub subscriptions. Source
events and lossless bounded input parts commit with their notify Effects and
cursor. GitHub inputs carry their admission principal; current authority and
membership cancellation apply to them just as to human feedback. Public callers
still cannot set external provenance. See [Source contract](project-sources.md).

Human admission checks the current Project/Task write authority and active Project.
The input and its input.notify Effect are saved together; execution requires S2's
actual snapshot/rename acknowledgement. Failed or no-op commits cannot authorize a
new notification. Existing handoff offers save a stable handoff input with the
original pool.dispatch intent; failed offers roll back the uncommitted input too.
Old pending handoffs gain a matching input during migration without changing ids.

Input delivery follows the Task's current responsibility. Each receiving claim
accepts a bounded inbox batch (at most2 inputs/8000 body characters), binding exact
input ids/hashes to claim/Bot/generation. input.inbox saves the batch before the
adapter sends it. Repeated prepare for one claim/batch does not append its body
again. A safe subsequent turn selects only sources not already injected into that
claim. A restarted or reassigned claim retains the original input identity and may
reconcile/re-present an unconfirmed input; this is at-least-once transport with
fenced, idempotent handling, not vendor-history exactly-once.

## Receipts and truthful phases

- accepted: the host saved the input, not a model read.
- inbox-accepted: the host durably bound a batch to a current claim/snapshot.
- delivered: the existing adapter returned after writing/enqueuing the batch;
  vendor session-history persistence is not inferred.
- observed: the actual SDK produced an output item for that batch. turn.started,
  thread creation and a dispatch Effect receipt do not count as reading.
- read-confirmed: the current role explicitly declared the injected ids read.
  readProof says current-role-declaration/current-chief-declaration. This is not
  proof of comprehension or an independent verification verdict.
- handled: a validated current-role decision, successful Chief decision, or
  authoritative routing receipt acknowledges processing. It never proves Task
  completion, code correctness, tests or approval. A routing receipt can have an
  unknown read signal; the service preserves that distinction.

Role final handoff JSON may include inputReceipts:{batchId,read:[ids],handled:[ids]}
or an array of at most8 such batches. Every handled id must be in its read list
and exact injected current batch; all batches validate before any is consumed.
Foreign Task/Project, superseded claim/generation, tampered payload or cancelled
source cannot be acknowledged. Role handling is applied only after the existing
completed-role evidence checks. Normal handoffs/returns/transfers remain autonomous;
only overall completion/uncertainty goes to Chief.

## Safe execution boundaries

A healthy SDK worker is never interrupted to deliver ordinary feedback. At its
completed-turn boundary, up to4 bounded additional turns can receive newly queued
inputs in the same worker/backend thread/claim. Its intermediate handoff proposal
is not applied. No new Dev, permission answer or forced role transition is created.
An idle SDK message question may also resume through this same bound inbox; permission prompts retain their original request id and cannot be answered by ordinary feedback. Original execution deadline/evidence budgets remain; excess input follows the
next legitimate responsibility. Native dispatch uses its original inbox/step
adapter and preserves pending feedback for the next safe role step. Native history
read/persistence is not inferred from dispatch; real native/Claude receipt behavior
still needs harness-specific acceptance and remains explicitly unverified.

Blocked/arbitrating Tasks notify the existing configured Chief inspection through
an Effect. Feedback arriving during a Chief job queues its existing inspection port rather than a parallel Chief. Missing Chief configuration defers visibly; healthy execution receives
no extra Chief run. Existing operator schedules, including the configured Chief
inspection interval, remain unchanged; this module adds no timer or fixed DAG.

Chief snapshots share a total8000-character input body budget and at most2 inputs
per Task. An internal unforgeable receipt permit validates the exact live snapshot
and ids without consuming them. Failed/invalid decisions cannot consume input.
Closure rechecks new pending input and generation; its commit writes handling and
Task acceptance in the same existing state snapshot. Non-closing acknowledgements
commit only after the decision succeeds. Serialized/HTTP actor fields cannot
forge a permit. Unresolved feedback blocks human/Chief acceptance, never disappears
because the SDK stopped or a comment was received.

## Stop, revocation, recovery and queries

Cancelled/closed/stopping Tasks refuse new input and old claim acknowledgements;
query results expose inactive unhandled input as cancelled. Project membership
removal cancels that source's pending inputs permanently; regrant/retry cannot
revive them. The accepted Task/history remains intact. Every delivery still uses
current Task execution authority; a source message grants no new privilege.

Queries page1–200 authorized Task inputs and include hashes/provenance/receipt kind;
TaskView exposes bounded pending metadata without message bodies. All original
records remain in the existing store. Corrupt payloads refuse delivery/receipt;
unknown protocol records remain queryable as unavailable and block execution/
closure rather than being silently dropped. No public endpoint accepts raw model
receipts, worker tokens or manufactured external source events.

## Verification and rollout

Unit and store/host integration cover durable admission, repeated delivery, failed/
no-op saves, bounded batches, safe SDK turns, late/foreign receipts, stop/revocation,
regrant, corruption/future protocol, Chief failure/forged permit and new-input races.
The baseline S2 source refuses the missing input.publish operation. A separate real
Codex fixture uses a registered Git working directory and records two-input/same-
worker/thread safe turns, explicit declarations and real stop-ack/process-exit.
It is not production frontend closure, independent repository Review or native/
Claude acceptance. All source/hash-bound reports stay in operator evidence.

S3 depends on S2 and the verified supervisor-exit compatibility repair (#57).
Verification precedes a released-checkpoint deployment; preserve the autonomous
frontend Task/PR, existing UI adapters, account/credential configuration and all
state/history. After inbox/effect state is written, rollback requires matching
schema-aware reconciliation, not blind restoration of older code or state.

## Project Task lifecycle convergence (#2179)

Chief-confirmed requirement revisions become requirements-change inputs with Chief-decision provenance in the same existing inbox. Notification uses the original postcommit input.notify effect. Uncommitted input staging is discarded on confirmed rollback; a changed requirement version invalidates old delivery acceptance.


## Invalid receipt correction (#2338)

Role receipts are preflighted before worker release, host completion/tests/review
or downstream routing. Schema/unknown-batch/uninjected-ID/handled-not-read errors
carry `input-receipt-feedback/v1`: exact current Task/claim/generation, field,
correctability and at most8 injected manifests (IDs/hashes only, never bodies).
Foreign/historical batch, foreign Task, stale claim/snapshot, revoked source and
changed content remain denials, without foreign manifests or automatic remapping.
A valid multi-batch declaration validates every batch before any acknowledgement.
Acknowledgement and its `input.receipt` Effect commit together; uncommitted failure
rolls back only its own unchanged fields. An acknowledged rename remains committed.

Correctable role output freezes the original business proposal in a private,
hash-checked archive (maximum64KiB). The original claim stores only the reference,
up to5 feedback records and a bounded correction counter. Existing Effects deliver
`input.correction` to the original worker/Session; no new Task or role is admitted.
The role returns `OUTPUT handoff: {"correctionOf":"<proposal SHA256>",
"inputReceipts":{...}}` (or up to8 receipt batches). Only receipts are replaced;
the original business action/outputs/evidence stay frozen. Tools are disabled for
this narrow turn. All live authority, input and claim gates run again. New inputs
remain pending and cannot be declared handled merely by correcting another batch.

`projectHandoff.inputCorrectionBudget` defaults to2, range0–4. Original execution
timeout and evidence budgets still apply. Duplicate original completions do not
spend another round; SDK correction frames bind a turn ID and backend Session.
A committed dispatch marker prevents blind resend after ambiguous transport.
Exhaustion/transport failure is an explicit incomplete state for Chief judgement,
never an automatic human consultation or fixed next role. Restart preserves the
proposal and feedback but fences the old claim; recovery must confirm exit and
reconcile context, never replay the business proposal from an expired receipt.

Chief uses the same bounded feedback constructor and its existing resident-Session
correction mechanism. Each Chief Task receipt is checked before that Task effects; invalid Task items defer global role proposals while independent valid decisions may commit. Frozen role-worker receipt-only correction remains unchanged.
A corrected response declares the current snapshot explicitly; no old batch is
silently translated. Candidate-stage evidence already produced by an SDK stays
immutable and is not re-recorded as a second execution during receipt correction.

#2393 reports pre-dispatch input integrity failures as typed source-changed facts; corrupted text is never injected or acknowledged. A correction transport failure remains incomplete on its original Run rather than a phantom pending invocation.

## Chief batches and existing notification continuation (#2483)

`taskInbox.remaining` counts authorized pending inputs outside the injected batch, not rows with a divergent status. `accepted` means ingested, never read/handled. Closure requires explicit declarations and all pending inputs addressed; missing declarations and pending later batches enter the existing Chief correction before business acceptance. Chief can choose `continue` with a deliberate read/handled declaration for the current batch.

Only newly handled progress stages a follow-up `input.notify` intent, atomically with the acknowledgement. Read-only declarations or replays stage none. The original notifier reuses a current-policy queued scoped judgement, defers active/correcting/interrupted Chief turns, and uses a unique continuation request identity. It follows current responsibility through the existing safe-turn/Chief delivery path, retaining source authority and cancellation checks. No new Effect kind, store, timer or fixed workflow is introduced; unread inputs are never automatically handled.
