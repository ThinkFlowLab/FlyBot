# Keep Attempt acceptance separate from Task completion

## Date
2026-11-05 (Asia/Shanghai).

## Decision
Implement #2526 directly in the Owner session. Chief may accept the current merged
code delivery with explicit completed/remaining scope, keep its Task open and choose
a fresh next delivery after observing current facts. Reuse existing continuation,
Effects, queues, quotas, Project authority and Task-role context. Preserve merged PR
history but do not reuse its publication binding. Baseline is the verified target
HEAD containing the accepted merge, not an assumed fixed-repository HEAD.

The host exposes ready/blocked/unknown prechecks, not a business plan or permission.
Chief recommends in its original inference turn and can inspect, defer or close the
whole Task when all conditions hold. Current scope/authority/evidence are rechecked
on execution. Personal Agent assistance is the last resort for missing information,
authority or human-only decisions, chosen by Chief. Time/count warnings do not select
roles or human escalation. No new scheduler, DAG, planner or rule platform.

## Class
Major record for the Owner-approved lifecycle and required memory/architecture update.

## Evidence
Owner accepted the revised #2526 design, clarified “通过Personal Agent向人求助是最后兜底”,
and explicitly requested “按照我们讨论下来的方案，修改issue，并开发”. The prior code
couples acceptance to Task closure and reuses closed PR bindings; base regression fails.

## Participants
The fork Owner decides scope; Codex implements and records it. No independent review
or actual-model/onsite acceptance is claimed from fixtures.

## Dissent
The original proposal's mandatory accept→Dev path, unconditional close prohibition
and never-seek-help instruction are superseded by the Owner discussion and Issue update.

## Status
Accepted for delivery/ai-centric-development-service source implementation. Tests,
actual protocol processes and live/provider/deployment acceptance remain separate.

## Links
- https://github.com/ThinkFlowLab/FlyBot/issues/2526
- [Delivery](../docs/subsystems/project-delivery.md)
- [Chief](../docs/subsystems/project-chief-control.md)

Written-by: Codex

## Follow-up Owner clarification
Public board commands are not the Chief decision allowlist. Actual Chief job facts carry legal prechecks; repeated same-fact action refusals must warn rather than loop. Reuse the current shared warning path and configured no-progress threshold, include exact current failures and retire resolved/stale warning reasons. Owner requires noncontradictory current/historical information and keeps Personal Agent escalation as a model-chosen last resort.
