# Subsystems

Detail pages for each FlyBot subsystem. Each page lists `owned_paths`, what the subsystem owns, and its invariants.

| Subsystem | Page | Owned paths (summary) |
| --- | --- | --- |
| demo-baseline | [demo-baseline.md](demo-baseline.md) | `dev/demo/`, `scripts/lint-demo.mjs` — M0 checks and unchanged-platform adapter |
| ds-bot-core | [ds-bot-core.md](ds-bot-core.md) | `core/dev/`, `core/types/`, `ds-bot/`, `ds-bot.pin.json`, `patches/ds-bot/README.md`, `scripts/ds-bot-patches.mjs` (pin, patch format, dev tooling; generated patches are not owned) |
| core-host | [core-host.md](core-host.md) | `core/index.js`, `core/src/host/`, `core/src/shared/`, `core/web-search.js`, host tests |
| core-client | [core-client.md](core-client.md) | `core/src/client/`, `core/client.js` |
| plugin-runtime | [plugin-runtime.md](plugin-runtime.md) | `core/src/host/hooks.js`, `core/src/host/flybot-feed.js`, `core/src/client/flybot-slots.js`, `core/src/client/flybot-registry.js`, `core/types/flybot.d.ts`, flybot tests |
| tree | [tree.md](tree.md) | `plugins/tree/` |
| timeline | [timeline.md](timeline.md) | `plugins/timeline/` |
| workflow | [workflow.md](workflow.md) | `plugins/workflow/` |
| social | [social.md](social.md) | `plugins/social/` |
| install | [install.md](install.md) | `core/scripts/`, arch-doc tests, `plugins/README.md`, the container image (`Dockerfile`, `compose.yaml`, `docker/`) |
| team | [team.md](team.md) | `docs/subsystems/team.md` — **planned contract only** (no code paths; multi-human is not shipped) |
| interop | [interop.md](interop.md) | `dev/interop/`, `scripts/lint-interop.mjs` — offline development harness only |
| live-e2e | [live-e2e.md](live-e2e.md) | `dev/live-e2e/`, `scripts/lint-live-e2e.mjs` — real-model browser suite (#204) |

The `team` page is a planning contract: it defines the proposed human ↔ Chief ↔ specialist authority, routing and approval rules **before** schema work. Team mode stays disabled until its authorization gates pass.

The core is three pages so that a change to the browser client, to the server, or to the pin and patch tooling edits only its own page. Longest-match wins when two subsystems claim a path. The arch-doc check (`core/scripts/check-arch-docs.mjs`) fails if an owned file changes without its subsystem doc being updated in the same PR (unless the commit message carries a `Docs-not-needed:` trailer).

- [Project domain](project-domain.md) — fork M1 ownership, migration, lifecycle and API contract.

- [Project access](project-access.md) — M2 unchanged-platform identity adapter, membership, policy and Workflow gateway.

- [Project delivery](project-delivery.md) — M3 versioned Attempts, worktrees, evidence, GitHub drafts and human acceptance.

- [Project agents](project-agents.md) — M4 public/private identity, memory, delegation, skills and credential scopes.

- [Project workbench](project-workbench.md) — M5 restricted shared entry, Project UI,
  durable quota admission and actual resource/acceptance metrics.


### M7.2 — 2026-10-31

Fork M7 resource authorization, runtime transports, leases and verification are documented in [project-resources](project-resources.md).


### M7.4 — 2026-10-31

Fork M7 Owner runtime configuration, credential probes and private PTY protocol: [project-runtime-setup](project-runtime-setup.md).


### M7.5 — 2026-10-31

Fork M7 local/Docker Git handoff, candidate and sealed SDK evidence: [project-resource-workspaces](project-resource-workspaces.md).

Project per-Bot handoff and claim lifecycle: [project-pools](project-pools.md).

Bounded Project repository reads: [project-github-read](project-github-read.md).

Safe/watch authority and account checks: [project-delegations](project-delegations.md).

Chief arbitration, inspection configuration and original schedule mapping:
[project-chief-control](project-chief-control.md).

Automatic development service and unified TaskView: [project-development-service](project-development-service.md).

Persistent Project effects and GitHub receipts: [project-effects](project-effects.md).

- [Project Task inputs](project-inputs.md) — S3 durable inbox, current-role receipts and bounded safe turns.
- [Project Sources](project-sources.md) — S4 scoped GitHub Thread subscriptions, revision replay and current-Task feedback.
- [Execution boundary](project-execution-boundary.md) — S5 trusted private profile, current authority and honest capability preflight.
- [Service acceptance](service-acceptance.md) — S6 isolated recovery matrix and separately recorded real Source/SDK handoffs.

- [Project context](project-context.md) — scoped budgets, working summaries, memory versions and bounded exact-source reads.

- [Project Task lifecycle](project-task-lifecycle.md) — Chief admission, requirement versions, child waits and original-role continuation.

- [Original FlyBot compatibility](project-compatibility.md) — original capability inventory, one-time legacy Task cutover, private group ACL and same-version storage rollback.

- [Persistent backend entry](backend-service.md) — source init/start/login/CLI, original HTTP/SSE composition and deployment/documentation verification.

[Release Tasks](project-releases.md) bind explicit publication authorization and observed external proof to the existing Attempt/Effects and Chief closure.

Project automation credential providers: [GitHub automation](project-github-automation.md).

- [Project warnings](project-warnings.md) — shared progressive disclosure, delivery and execution-action fences.
