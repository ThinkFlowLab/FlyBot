---
subsystem: project-task-lifecycle
owned_paths:
  - core/src/host/project-task-lifecycle.js
  - core/test/project-task-lifecycle.test.js
---

# Project Task lifecycle

The original Task remains the business identity. Its additive `projectTask/v1`
contract separates admission, versioned requirements, dependencies, the parent
continuation and final-result history from legacy board status. Consultation never
creates one. Original Attempt, Handoff, Session, lease and Effects records keep their
existing identities and persistence; this module adds no scheduler or datastore.

## Admission and requirements

New shared Project Tasks are proposed first. Title, acceptance criteria and project
impact must be explicit before Chief admits them; scope may be supplied as well.
Creation commits `task.intake` alongside the Task. Its existing Effects adapter asks
the resident Chief for an intake turn; missing configured authority defers visibly.
A run request before acceptance returns `waitingFor: chief`, allocating no Attempt.
The actual Chief callback validates the current actor, Project, snapshot generation
and requirements revision before applying `admit` and committing `task.start`.
The start effect rechecks the original requester's live membership and permissions.
No model-provided member identity or public role token grants Chief authority.

Chief `revise` retains the original requirements and increments their revision;
it also stages an ordinary durable Task input with Chief-decision provenance. The
current execution receives that increment through the existing inbox notification
path. Old requirement-bound delivery evidence cannot close the changed Task. Notes
and supplemental inputs are distinct from lowering acceptance requirements.

`task.change.request` accepts a member's cancellation/reopen/revision request and
asks Chief to judge it. It does not apply the change itself. Chief cancellation
refuses an unrelated active execution claim; its own scoped Chief claim can record cancellation without claiming that its worker has exited; any unconfirmed historical lease remains held
and must reconcile before new execution. It never treats unknown exit as release. Reopening records the previous result and adjudication, retains the
original requirements and logical role Sessions, and schedules another Attempt.
New goals require another Task. An unresolved active cancellation needs the existing
stop/reconciliation path before adjudication; no invented forced-exit proof.

## Parallel children and continuation

The current role may return a `split` decision with one to sixteen independent
`children:[{title,criteria,impact,scope?}]`, a reason and a bounded `resumePoint`.
Children use the same trusted Task constructor as public creation. After source
stop/exit confirmation, one Effects commit persists child proposals, the parent wait,
its own role summary, and child-intake intents. Failed/unconfirmed commits cannot
execute the children. Existing parent workspaces and Task-role context are retained;
children obtain distinct Task workspaces and need their own Chief admission.

The parent holds no active execution claim while waiting. Its released Attempt does
not consume execution quota, while any remaining lease or native worker still does.
Each dependency requires an accepted child with explicit Chief completion provenance;
cancelled/failed children remain unsatisfied. Parent/child scope and graph validation
reject foreign Projects, duplicate children and cycles. Child results carry original
Task/Attempt, criteria revision, candidate and decision references; `integrated:false`
means the result has not yet been integrated into the parent's candidate.

The existing outbox stages a stable `task.resume` only after all waits are satisfied.
Pool serialization and the stable `children-<wait>` Handoff request prevent duplicate
parent admission, including repeated callbacks and restart replay. The receiving
role uses the same parent Task and logical Session, retaining an unsealed Attempt/workspace or creating a successor from a sealed candidate. It reads its own
summary and child result references, and continues integration. All children ending
never closes the parent. Current dependency state is checked again before execution
and Chief completion. Required code integration still uses the existing pinned-source
admission/evidence gates; child completion is not a merge or publication permit.

## Compatibility and evidence

Persisted Tasks without this contract retain their old delivery/board semantics.
Legacy personal/group Tasks and fixed Workflow execution remain available; their
older group aggregation is not reused for Project child waits. New Project Tasks
cannot use generic board transitions, legacy task-drive dispatch, or human delivery
acceptance to bypass Chief. Legacy adoption is an explicit scoped Chief admission,
refused during active legacy delivery.

Tests distinguish pre-contract delivery fixtures from new admission fixtures. They
cover the real Chief callback and committed-start seam using deterministic execution,
concurrent resume, original role/Attempt continuity, failed exit, failed commit,
requirements snapshots, scope/cycles and cancelled children. This is not a claimed
new real-provider full Chief/child-integration acceptance. Native physical Session
restoration remains #2184, storage normalization #2182, and complete public command
receipts/events #2185. Those dependencies must finish before closing #2179.

## Admission and compatibility checks

Execution start retains the authenticated initiating principal/session, never the body session field, so a platform background check cannot borrow another session. Removing a source Bot records a carrier notice without cancelling the independent Task commitment. Cancellation also uses a durable transition marker so a post-commit save error cannot roll back an already committed decision in memory.

Attempts pin the complete Project requirements revision, including impact/scope. A scope-only change invalidates old completion evidence even if title and criteria are unchanged. Rework after a revision creates a successor with the new requirements snapshot, retaining the prior version and logical Task-role Session.

A failed Attempt leaves a new Project Task blocked with its source Attempt/reason; it does not close the commitment or erase Chief admission. A later active Attempt clears that execution block. Pre-contract legacy Task failure semantics remain unchanged.


## Exceptional dependency judgement

Chief snapshots carry each linked dependency's exact current version. Protected
`resolve-dependency` decisions require that version, a reason and bounded evidence
references. Chief may waive a condition explicitly, or substitute a same-Project,
Chief-accepted result with its own exact outcome version. The decision records
`chief-judgement-not-host-tests` and never accepts the failed/cancelled original
child or closes the parent. A changed/reopened replacement invalidates the waiver
and blocks integration again. Formal cancellation or reopening of a linked child
stages one dependency-review request to the resident Chief; ordinary operations do
not call a model to reconsider Project positioning.

Wait IDs cannot be reused. A later split preserves the previous wait and dependency
records in history. Resume remains idempotent across retries. A sealed pre-split
candidate continues in one successor Attempt without editing the original evidence;
Task-role context remains stable. The accepted-child source admission protocol is
specified in project-delivery.md. A plan changed after a parent has resumed requires
execution stopping/reconciliation; current guards refuse stale integration rather
than pretending the changed wait has completed.
