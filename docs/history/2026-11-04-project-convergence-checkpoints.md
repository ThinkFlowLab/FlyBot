# Project convergence implementation history

Preserved verbatim from PROJECT.md. Current contracts remain in subsystem documentation.

### 2026-11-03 — Project Task contract (#2179)

New shared Tasks have Chief admission and versioned requirements. Existing Task/pool/Effects records carry independent child proposals, a released parent wait and one stable resume Handoff; child failure/cancellation never satisfies a wait. Original parent role context and workspaces are retained. Raw legacy board transitions cannot bypass the new contract, while persisted pre-contract Tasks keep their original semantics. Chief callback, rollback, exit and duplicate-resume tests are distinct from real-provider full child integration acceptance; native restore2184, storage2182 and public event/receipt2185 dependencies remain open. README simplification2189 remains last.

#2179 runtime follow-up: native Chief facts refresh is fixed in original #2177 PR2225 (410127580). The Workflow gateway now enforces Chief admission and excludes Chief control jobs from execution quota. Real DSH queue verification uses actual Chief decisions and an isolated host-verification latch to test queue/revocation without timing assumptions.

#2179 follow-up: Chief dependency waivers/substitutions retain exact outcome versions and explicit judgement evidence. Accepted child code enters the existing durable integration gates before parent execution; source admission is not merging or parent acceptance. Actual Git multi-parent sealing tests use deterministic child acceptance fixtures. Full real-provider parallel collaboration and native physical restoration remain pending.

### 2026-11-03 — Transactional state (#2182)

Opt-in SQL retains the original Store/services and saves domain facts plus Effects atomically. JSON becomes a newer-version migration guard, with verified import/recovery and offline export/rollback; no dual writable snapshots. Histories are normalized and large immutable payloads hash-referenced. Routine state updates/views make no additional model calls or Project-position changes. Full-state hydration/scanning remains; storage growth is distinct from #2177 context budgets. No live migration or provider-loop claim.

### 2026-11-03 — Service contracts (#2185)

The original application service adds private principal-scoped command receipts, bounded Task/Attempt sources, committed snapshots/events and authenticated resumable SSE. Unknown command outcomes are reconciled explicitly, never blindly rerun. Independent personal-agent identity survives carrier/transport rotation. Role acceptance commits before ownership can be replayed. Event receipt grants no role authority; private chat/auth/receipt writes do not affect public Project streams. Existing UI remains; #2186 compatibility and #2189 real deployment/README follow.

Composition checkpoint: current role governance/native exit, bounded context and canonical Task waits now share one execution chain. Native input fences logical role/physical worker separately; Task requirement revision changes stop the old Attempt through existing pool release. Actual composed/native acceptance and remaining API/storage compatibility are still under verification, not deployment.

SQLite composition now has an actual DSH native return probe: canonical Chief intake, persisted activation/exit, original role context and single-resource handoff are read from committed SQL snapshots. Inference remains deterministic; no production migration or full-provider workflow acceptance is claimed.

Service composition adds scoped native execution/exit and current-vs-pinned role metadata, role governance aliases, and bounded per-entity committed snapshots. New projections and final six-case DSH/SQLite validation are under current review; none of this branch is deployed.

### 2026-11-03 — Preserve original capabilities (#2186)

Keep personal Chief/Bots, groups, private memories and original Task/Workflow IDs. Shared Project legacy execution requires an identity-bound committed cutover; new dispatch/tracking cannot bypass Chief admission. Associated original groups retain their own history ACL plus current Project access. JSON version4 fences new contracts across SQLite rollback; code downgrades must not erase receipts. No deployment or UI replacement. See docs/subsystems/project-compatibility.md.

### 2026-11-03 — Persistent deployment and final API docs (#2189)

Use scripts/backend.mjs to initialize/start the original DSH/FlyBot host plus existing restricted HTTP/SSE gateway in a private persistent home. Login and CLI calls reuse native/platform identity; no mock model, sample repository, parallel executor or frontend replacement is packaged. Original guides move to README.native variants. Auth-mode confirms Store writability before readiness. External safe proposal impact/scope must survive publication into canonical requirements (actual production-entry regression). Deployment/restart, deterministic HTTP/DSH tests and real-provider acceptance remain separate evidence.
