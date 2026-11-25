# Implementation handoff

First implementation PR: Python 3.11+ standard library, SQLite v1 schema, WSGI application and unittest. Test: `python3 -m unittest discover -s tests -v`. No third-party packages or upstream code are imported.

This PR delivers authentication/session/CSRF and owner-scoped workspace records, not the complete runtime lifecycle MVP. Deployment may keep the separate dependency-free Node command planner; no Compose planner or executor is duplicated here. The management Web process never executes Docker. Next PR should implement durable desired/revision/operation jobs and the fake RuntimeBackend before wiring a separately reviewed manager adapter.

Full runtime acceptance, Compose, volume retention, upgrade/backup/purge and real browser acceptance remain unimplemented, not passed or silently skipped.

Teamily evidence and comparison status must accompany every product acceptance; see MANAGEMENT_API.md and ACCEPTANCE.md. Internal management tests validate self-hosting foundations only, not Teamily internals or product equivalence.

## Lifecycle follow-up (separate branch/PR, depends on #16)

Durable instance/jobs/revisions, lease-fenced manager routes, memory/SQLite fake receipts/state and the unchanged Deployment JS planner are now implemented; see RUNTIME_IMPLEMENTATION.md. Tests remain simulations, not real runtime/product acceptance. Operational manager/Compose execution, runtime log stream, recovery, real volumes and deployment remain owed. Do not close #2.
