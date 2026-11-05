# Notify Chief about interrupted role responsibility

Date: 2026-11-05. Status: accepted for the Owner's explicit continuation of #2483
on `delivery/ai-centric-development-service`, developed directly in this session.

Existing recovery APIs passed isolated tests, but a regression at f2dd09866 shows
that persisted role restart blocks do not automatically reach Chief: the pump
only discovers arbitration. Reuse its original inspection request and durable
Run identity to deliver current interrupted responsibility and exit facts. Repeated
unchanged facts reuse the notice; physical exit or committed retirement may notify
again. A failed route's collaboration generation alone is not new evidence.
Discard queued notices after responsibility progresses. Keep the existing scheduler,
policy authority, exit fences and role context; add no workflow or polling clock.

Chief still decides whether to resume, rework, change role, wait or consult. An old
restart message alone is not a human-only decision. Neither notification nor exit
retirement selects a role, frees unknown workers, acknowledges inputs or accepts
a Task. The failure message preserves the checkpoint for judgement.

Tests write disposable state, release the first Runtime and reload it, then apply
fixture Chief decisions through real pools/delivery and Git workspaces. They cover
historical blocks, preserved draft/cwd/logical context, trusted released SDK rows,
explicit retirement followed by another judgement and unknown exit without hot
loops. This proves the mechanical chain, not actual model choice, live Docker SDK
exit recovery, private App acceptance or deployment. See
[Chief](../docs/subsystems/project-chief-control.md) and
[Delivery](../docs/subsystems/project-delivery.md).

Ops evidence6649441606 separately identifies Main's current resource wait: legacy
ready health lacks the selected profile ID. Retain the existing identity fence;
an explicit runtime check can refresh it and wake dispatch. A fixture probe test
covers this existing path without new product code or live/model-paid operations.
It is a distinct readiness gate, not evidence against the reproduced missing
interrupted-role notification. Both need independent acceptance.
