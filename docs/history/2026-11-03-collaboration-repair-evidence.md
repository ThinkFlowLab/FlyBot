# Earlier collaboration implementation and validation

Preserved verbatim from PROJECT.md; active rules and current acceptance remain in active memory.

### Collaboration repairs — 2026-11-01

The owner authorized sequential issues [#34–#41](https://github.com/zy95-12/FlyBot/issues/33), one PR each; see [decision](decisions/2026-11-01-collaboration-repair.md). The target is native multi-Bot reuse, per-Bot pools and enforced handoff, restored role contracts, ordinary Chief conversations, safe/watch delegation and configurable Chief inspection schedules. Public hosting is deferred; control-plane stays unchanged.

R1 (#34) rejects incomplete repository capabilities before workers/workspaces/leases are allocated. Workbench readiness checks Git/runtime/dependency metadata and reports the precise block; this does not claim tests or SDK task delivery have run. Old failed Attempts remain readable. R1 full local verification passed in PR #42; actual shared-service integration remains pending.

R2 (#35) restores complete Dev/Tester/Reviewer conventions, pinned policy-source hashes and final-execution prompt assembly for native and SDK roles. FlyBot code sealing requires memory/tests/architecture evidence; candidate approval explicitly cannot mint a signed forge PASS. Focused tests cover full rules reaching SDK input, required-source failures and tampering. R2 full verification and later backend/dogfood acceptance are tracked separately.


R3 (#36) implements per-logical-Bot pools on existing Task records, atomic claims,
versioned receipts and enforced handoff admission. New shared deliveries default
to dynamic pool dispatch; the legacy DAG is explicit opt-in. Only the receiving
role allocates an execution Session/resource. Candidate returns retain the Task
and create a new Attempt; overall completion waits for Chief judgement. Unit and
SDK contract-process tests cover non-DAG return/rework with one resource. Full
verification, conversation bridging, Chief arbitration/schedules and real shared
service dogfood remain separately tracked acceptance, not implied by these tests.


R4 (#37) adds conversation-only private → Chief → original-chat handoff, isolated
from private memory and other members. Query turns cannot publish or execute a
Task; scoped GitHub reads provide actual repository facts. Impactful Task kinds
persist across proposal publication; workbench status separates publication from
queue/start/execution and Chief wait. Targeted privacy, native/SDK-query, no-Task
and credential/revocation tests pass. Full verification and real shared-service
acceptance remain separate; control-plane and public hosting are unchanged.


R5 (#38) implements safe/private publication proposals and persistent, revocable
watch grants bound to the current human and Project. Browser logout does not
revoke watch authority; account/membership/grant changes do. Scoped actions use
current human rights and retain provenance. The unchanged SQLite platform can
supply fresh account status through a FlyBot-owned read-only operator helper,
without storing browser cookies or admin credentials. Regression tests cover
logout, restart, current rights, revocation, forged status evidence and fresh WAL
reads. Shared-service provisioning and real-model acceptance are still pending.

R6 (#39) adds evidence-gated Chief arbitration, audited intervention and configurable
inspection on original DSH scheduled tasks. The JSON template defaults to 30 minutes;
content, cadence, thresholds and pause/enable are editable. Current configured human
authority and generation fences apply to each effect. Unknown process exits retain
capacity; a verified systemd invocation boundary permits local restart recovery.
Deterministic protocol tests return incomplete coverage to Dev then close the same
Task after a fresh Attempt. Real shared-service Codex/timer acceptance remains #41.

Real shared-service R6 probes passed an actual Codex Chief ordinary inquiry with
zero Tasks and an original DSH 60-second wake after browser logout, then pause/
resume and restoration to 30 minutes. R7 actual Dev requested Chief arbitration;
Chief returned the same Task to Dev with a fresh Attempt. This exposed a concurrent
resource-release reconciliation race, fixed with a red/green regression. Actual
full R7 delivery and persistent 30-minute/restart acceptance remain in progress.

End of preserved earlier narrative. Current governing boundaries remain in PROJECT.md.
