# Keep merge observation and Chief closure handoff durable

Date: 2026-11-05 (Asia/Shanghai). Class: ordinary reliability change.

Owner authorized #2413 implementation and delivery-branch PR/merge in the current session. Reuse Attempt merge evidence, Effects, Chief request/snapshot/correction and the existing scheduler. Save notification intent with the provider-confirmed observation; retry/recover notification independently from completed external merge work. Backfill only trusted exact-candidate evidence, with bounded discovery and unchanged authority.

Chief retains all acceptance, role and consultation decisions. Do not introduce another workflow/store/timer, auto-close merged Tasks, auto-clear genuine waits or revive cancelled/replaced Attempts. Current Chief snapshots detect newly arriving merge evidence and refresh through existing correction. A persisted request is not Task completion.

Evidence: at5e71a07e, notification failure after merge save followed by wait-budget expiry left the Effect failed and merge projection blocked; the new regression failed before this fix. Deterministic fault injection is distinct from actual private GitHub/App or OpenToday onsite validation. No live credentials, Tasks, resources, UI or deployments changed.

References: [#2413](https://github.com/ThinkFlowLab/FlyBot/issues/2413), [delivery](../docs/subsystems/project-delivery.md), [Chief](../docs/subsystems/project-chief-control.md).

Written-by: Codex
