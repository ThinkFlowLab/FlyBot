# Keep pre-worker waits and Chief input declarations observable

Date:2026-11-05 Asia/Shanghai. Class:ordinary reliability change.

Owner authorized staged #2483 fixes. Ops evidence6647398133 identifies retried dispatch and partial Chief input closure, not a demonstrated missing notification. Two base regressions prove swallowed admission refusal and missing declaration preflight; a third proves missing durable next-batch delivery after explicit progress.

Reuse existing pool gates, Effects and input.notify. Expose current wait/commit facts and validated declaration metadata; use existing bounded Chief correction for pending input closure. Only actual declared handling progresses a batch, with original notification/authority/cancellation checks. No new state machine, Effect kind, fixed role/escalation, forced acknowledgements or acceptance. Retain existing independent Task progress and Session/context.

Deterministic fixtures do not prove the exact onsite resource gate or model output. No live Tasks, resources, credentials, services or frontend changed.

Written-by: Codex
