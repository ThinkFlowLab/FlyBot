# Replace elapsed execution cutoffs with one evidence-bearing warning boundary

Date: 2026-11-05. Owner accepted #2518 and explicitly requested implementation.
Target delivery/ai-centric-development-service; old DAG behavior remains unchanged.

SDK duration warns each hour; Chief inspections warn after10minutes queued or15minutes
running; merge waiting warns every2hours. Elapsed time grants no failure, cancellation,
resource release, role routing or human escalation. Retain bounded I/O, operation-level
command budgets, authorization expiry and actual exit verification.

One warning service owns shared identity, disclosure, delivery and action fences.
Existing reconciliation, Effects, Inbox, events and Chief context exchange implement
it; no monitor Bot or parallel scheduler is introduced. Facts precede judgement.
Chief sees mandatory blockers, can progressively inspect scoped topics/evidence and
chooses the next lawful action. Its own operational failures notify an authorized
personal agent/human independently of the busy Chief queue. Stops preserve logical
memory and Tasks and require actual exit before recovery.

The old recovery budget is guidance only and is no longer presented as a deadline.
Query observations and elapsed time never fabricate provider status or model progress.
Tests/docs/long-term memory accompany source changes; no live deployment or paid
inference is authorized by this implementation request.
