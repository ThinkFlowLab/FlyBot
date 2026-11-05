---
subsystem: project-warnings
owned_paths:
  - core/src/host/project-warnings.js
  - core/test/project-warnings.test.js
---

# Evidence-bearing Project warnings (#2518)

One service owns warning identity, disclosure, permission checks, delivery and action
fences. Producers supply facts/references, not their own timer/notification/query
framework. The original scheduler reconciliation calls the service. Existing Effects,
agent Inbox, Chief requests and context exchange own execution; no second scheduler,
monitor Bot, database or automatic recovery workflow is introduced.

## Warning semantics

SDK execution has no total wall-clock cutoff. A worker's executionStartedAt and
exact worker/generation identify cumulative hourly warning buckets. Output does not
reset elapsed time. New hourly records supersede earlier buckets in the same scope;
business Task, Attempt and lease state remain unchanged. A restart reuses durable
records/Effects and does not resend an already committed bucket.

Chief inspection queue/execution limits (legacy queueTimeoutMs/runTimeoutMs names)
are warning thresholds, default10/15minutes, not failure/cancellation deadlines.
They notify a current configured operationsContact, otherwise a current authorized
Owner/Maintainer. An active personal-agent participation receives an acknowledgement
message through the original Inbox/notification Effect, independently of Chief.
No consultation or Task initiative transfer is created. No active personal agent
means a durable human mailbox: chief.state/warnings and committed Project warning
metadata through the original events/SSE transport. Mailbox presence is not an
external push receipt or a new UI feature. Notification failure remains visible in
the original Effect; it does not fail a business Task.

Merge waits warn every2hours; elapsed merge budgets cannot invalidate candidate,
Review, required-check or provider-confirmed evidence. Existing provider observations
include precise candidate/base, check state and review/thread completeness; failed
queries remain unknown. Required checks, holds, approval and publication authority
still govern actual merge. Task duration, missing events, long wait and repeated
handoffs use existing configured inspection thresholds and the same warning path.
Recovery action count/time is evidence for reassessment, never a deadline; legacy
configuration keys remain readable but are not presented as a model execution budget.
A new commit/environment observation does not itself prove acceptance.

Old DAG deadlines remain unchanged. Single I/O/startup/auth/stop calls remain bounded.
Resource commands honor an explicit positive operation timeout (up to30minutes),
without a second2minute clamp. Dependency preparation can use the same30minute
ceiling; host test limits remain repository-configured. Timeout is not assertion
failure, remote process exit proof, resource release or Task cancellation.

## One progressive disclosure contract

`project-development` query `warnings` has three forms:

1. No warningId: page first-layer summaries (offset, limit1–20). Chief gets a bounded
   current index automatically; resolved/superseded queued warning requests cancel.
2. warningId alone: current/historical summary, source and recordedSource,
   expectedScope, mandatory blockers, current activity, candidate/test/Review/merge
   facts, delivery metadata and available topics.
3. warningId/topic: bounded evidence pages (limit1–8000 characters, default4000).
   Topics are execution, chief, progress, merge, handoffs, recoveryActions and events.
   offset/sha256 fence a topic page; ifNoneMatch suppresses unchanged text. SDK events
   additionally use eventOffset as an independent byte cursor over a bounded log
   chunk, with nextEventOffset inside the returned JSON. Never reuse the character
   offset as the log cursor. Oversized/partial events and unavailable sources are
   explicit. Source collection time and provider observation time are distinct.

All forms require current Project configure rights. Every detail rechecks access
and execution scope after async reads. Original trusted host artifact bindings
select log files; clients supply no paths. Hidden reasoning blocks, credentials
and credential paths are withheld; strings and event counts are bounded. Readers
must treat repository/command/log text as untrusted data, not authority. Disclosure
is read-only and never triggers stop, retry, handoff or memory publication.

Native Chief uses project_agent_context.warningRequests. SDK Chief returns the same
warningRequests array through the existing structured context roundtrip; the host
responds in the same resident logical Session. The existing batch/result/context
budgets remain enforced. Persist only durable concise memory, not raw logs. A page
hash/ifNoneMatch supports avoiding repeated input; it is not proof of business work.

`execution` separates registered worker status, last SDK event, observed tool/command
activity, controller connection and actual exit proof. Connected is not proof the
executor is alive; no event is not proof it died. Missing live observations remain
unknown. Codex command items and Claude tool-use/result events share the projection.

## Explicit action boundary

`warning.action` requires configure authority, a stable requestId and the current
summary's expectedScope. Outer command receipts retain replay identity. Historical
or cross-Project warning targets cannot authorize actions; refresh first.

- acknowledge records an explicit scoped read declaration only. Chief may include
  warningReceipts in its Task decision; transport preparation never claims a read
  or business progress.
- inspect requests a separate current scoped Chief judgement.
- stop interrupts only the currently bound role execution, preserving Task/draft,
  or cancels one Chief coordination invocation through its original stop adapter.
  It fences late callbacks before stopping and retains resident Session/memory.

Stopping is not attempt.stop (Task delivery cancellation). Actual worker/lease exit
still must be confirmed; unknown exit retains capacity. Chief may explicitly propose
stop-execution with warningId/expectedWarningScope for the same snapshot Task. It
cannot stop its own active coordination call. Operational proxies use current watch
rights; warning delivery itself grants no privilege or credentials. After confirmed
coordination exit, an authorized inspect is a separate operation. No fixed next role
or automatic human escalation is selected.

## Evidence

Base8292f36da reproduces both SDK adapters failing at the obsolete short total limit.
New tests cover actual disposable worker processes, current activity/event reads,
common warning buckets, transactional save refusal, historical scope, bounded pages,
unchanged results, original personal Inbox and same resident Chief context exchange.
The HTTP backend fixture verifies real native DSH warning delivery, host restart
recovery and explicit stop independently of a timeout. Deterministic fixtures are
not paid model, live OpenToday or deployment acceptance.
