# FlyBot Architecture

FlyBot is a team of long-lived Bots built on DeepSeek Harness (DSH). Two parts ship: the `ds-bot` plugin (patched upstream) and the desktop app.

## Fork direction and M1 boundary

The accepted [Project-first fork direction](../decisions/2026-10-31-project-first-fork.md)
makes Project the stable boundary for Tasks, Runs and Workspace references. M1
implements direct ownership, explicit migration, lifecycle rules and a Project service/
repository/policy boundary. See the [Project domain contract](subsystems/project-domain.md).
Bots/Sessions remain replaceable carriers; physical worktree isolation is M3. Reuse control-plane APIs unchanged where
possible; put new project logic/adapters in FlyBot. Task navigation and the Project
board may be rebuilt without preserving their current components or layout.

M0 adds [development tooling](subsystems/demo-baseline.md), not a runtime service or
platform patch. Its real DSH/tool execution uses a deterministic model; its separate
HTTP adapter exercises unchanged external platform source. It does not enable team
mode, bypass shared-write authorization, deploy the platform or add a scheduler.
Known identity, authorization and per-run cwd gaps remain in [Project State](../PROJECT.md).


M2 adds the [shared access boundary](subsystems/project-access.md): an explicitly
configured FlyBot BFF over unchanged control-plane authentication plus Project-owned
roles/invites, runtime context and a scoped gateway to the existing Workflow service.
It validates sessions on every request and denies legacy unscoped plugin surfaces in
workbench mode. The inherited general team-mode proposal below remains historical;
this fork's Project collaboration contract is narrower and separately tested.

M3 wraps that existing Workflow service with [commit-specific delivery](subsystems/project-delivery.md):
versioned immutable Attempt/role/model snapshots, per-role Git worktrees outside DSH data,
independent test processes, typed Review/SHA gates, explicit GitHub draft publication and
human acceptance. Restart records interruption; retry preserves evidence. Actual DSH and
GitHub fixture proof is available; true-model/browser acceptance is tracked separately.

M4 separates [public roles and private human/Project agents](subsystems/project-agents.md).
A fresh shared Chief avoids promoting old owner-private conversations. Current own-session
and human delegation gate tools; memory/transcripts/proposals are distinct from shared facts.
Project automation and exact human/Project GitHub identities have separate credential paths.
The shared browser entry must fence raw DSH owner/session APIs; that is part of M5/M6.

## Layout

| Path | What it is |
| --- | --- |
| `ds-bot/` | Pristine upstream pin (Fei2411/DeepSeek-Bot). Never edit. |
| `patches/ds-bot/` | Ordered FlyBot patches on the pin. |
| `core/` | `ds-bot/` + patches. Ships; all tests run here. |
| `plugins/social/` | `@flybot/social` — social posting plugin. |
| `plugins/tree/` | `@flybot/tree` — knowledge-tree plugin. |
| `plugins/timeline/` | `@flybot/timeline` — where time goes across the local Bot team (swimlanes, communication map, utilization). |
| `plugins/workflow/` | `@flybot/workflow` — a group-shaped chat of local Bots, with a flowchart and task assignment. |
| `app/` | Desktop app (Windows/macOS) for the DSH + plugin. |

## Subsystems

Each subsystem has a detail page under [docs/subsystems/](subsystems/README.md) with owned paths, invariants and tests:

- [ds-bot-core](subsystems/ds-bot-core.md) — pin, patch format and dev tooling of the patched core; [core-host](subsystems/core-host.md) and [core-client](subsystems/core-client.md) — its server and browser code
- [plugin-runtime](subsystems/plugin-runtime.md) — FlyBot plugin hooks
- [tree](subsystems/tree.md) — `@flybot/tree`
- [timeline](subsystems/timeline.md) — `@flybot/timeline`
- [workflow](subsystems/workflow.md) — `@flybot/workflow`
- [social](subsystems/social.md) — `@flybot/social`
- [install](subsystems/install.md) — scripts and install doctor
- [team](subsystems/team.md) — planned human/Chief/specialist authority contract (not shipped); #47–#50 are data/auth/room-membership foundations only

## Team authority (planned, not shipped)

Multi-human ownership is **planned, not shipped**. The proposed contract — human owner ↔ designated Chief ↔ specialists, owner-scoped management, Chief-only cross-owner traffic, approval authority and the routing matrix — lives in [docs/subsystems/team.md](subsystems/team.md). Schema (#47), member sign-in (#48), owner-scoped access (#49) and typed room membership (#50) are foundations on that page; **team mode stays disabled** until that page's authorization gates pass. Issue #16 is resolved: tree Bots may create children under themselves (Option B; see [tree](subsystems/tree.md)).

## Integrating

See [docs/integrating.md](integrating.md) for how to add a plugin or integrate with DSH.

Cross-runtime collaboration is proposed in [#198](https://github.com/ThinkFlowLab/FlyBot/issues/198).
The [room participant contract](interop/room-participants.md) scopes the same-room
DSH + DSH baseline and DSH + OpenCode target. Its current implementation extracts
the DSH execution boundary only. The earlier [OpenCode pilot
contract](interop/opencode-pilot.md) and offline harness cover a Bot Social
transport experiment with independent owner identities; they preserve its
same-owner friendship restriction and do not satisfy the room target. No
OpenCode adapter or additional team-mode gate is enabled.

## Reference

See [docs/reference.md](reference.md) for API and CLI reference material.

The fork M5 [Project workbench](subsystems/project-workbench.md) provides the shared browser
entry, keeping Harness owner credentials server-side behind an endpoint allowlist. Its
persisted admission queue wraps existing delivery/Workflow services; it adds no second
Task store or DAG executor. Platform source remains unchanged.

M6's [shared demo](shared-demo.md) starts unchanged control-plane, actual DSH and the
restricted gateway with disposable private data. Browser acceptance uses two platform
identities and independent contexts. Workflow dispatch resolves a bound Task's Project
Chief, so shared execution does not require bootstrapping the private legacy operator UI.


### Fork M7.1 — 2026-10-31

M7.1 separates durable role definitions/public role memory from per-Attempt execution Session snapshots. Existing Workflow retains lifecycle and scheduling; the host supplies hashed bounded context after graph prompt sanitization. See [role contract](subsystems/project-agents.md) and [session binding](subsystems/project-delivery.md).


### M7.2 — 2026-10-31

M7.2 adds [execution resource capabilities](subsystems/project-resources.md) under the existing Project scheduler. Control-plane instance association is metadata, not invented remote execution; local/Docker command adapters and lease records stay in FlyBot.


### M7.3 checkpoint — 2026-10-31

M7.3 adds [temporary Harness workers](subsystems/project-harness.md) through Workflow lifecycle callbacks. Explicit resource/profile credentials, SDK thread ids and redacted event references remain separate from Project role memory and acceptance evidence.


### M7.4 — 2026-10-31

M7.4 [Owner runtime setup](subsystems/project-runtime-setup.md) adds bounded profile-scoped probes and resource-admin-authorized PTYs over existing authenticated HTTP; no WebSocket shell or control-plane mutation. Positive resource-side shutdown frames, not raw EOF alone, release SDK/terminal ownership.


### M7.5 — 2026-10-31

M7.5 adds [resource workspaces](subsystems/project-resource-workspaces.md): bounded SHA-scoped Git bundles, remote role clones, imported host publication and independent host verification. SDK completion artifacts bind Session/resource/generation/context/hash; every gate/acceptance rechecks them. New Attempts are delivery/v3; old snapshots remain intact. [Current acceptance](m7-acceptance.md) explicitly separates actual resource/browser checks from missing authenticated three-Harness acceptance.

Repair R6: [Chief control](subsystems/project-chief-control.md) composes existing
Task pools, Runs, Harnesses and original DSH schedules. Logical schedule mappings
retain durable Project/Chief targets; completion decisions remain host validated.

## Fork automatic development application service

The [development service](subsystems/project-development-service.md) routes versioned
commands, trusted host events and queries to existing Project modules. Legacy HTTP,
agent and schedule adapters share the same business implementations and derived
TaskView; no second executor/store or new control-plane component is introduced.

The [effect/outbox layer](subsystems/project-effects.md) commits host action intents
with existing Project state and reconciles results through the same authorized
adapters. It does not replace role pools, SDK lifecycle or Chief adjudication.


S3 adds [durable Task inputs](subsystems/project-inputs.md) to the existing service,
store, Effect engine and per-Bot pools. Receipt evidence separates persistence,
adapter delivery, SDK observation and declared reading/validated handling. Busy SDK
feedback waits for the same worker/thread's safe turn; Chief closure commits its
input receipt with acceptance. No additional workflow, frontend, clock or platform
service is introduced.

S4 adds [GitHub Source/Thread subscriptions](subsystems/project-sources.md) at that
same boundary. The scoped GitHub broker observes immutable revisions; event routes,
S3 inputs, Effects and polling cursors commit together after all asynchronous
authority checks. Subscriptions identify Tasks, whose current responsibility
selects the receiving Bot. Existing configurable logical schedules drive polling;
remote state, CI and Review are facts and cannot grant Task closure or candidate
verification. No additional executor, listener, DAG or control-plane change.

S5 makes the [trusted private execution boundary](subsystems/project-execution-boundary.md)
explicit. Human rights, Bot contracts, Harness capability and OS isolation remain
separate. One dedicated service account is compatible; per-Bot containers/users are
optional. The read-only capability query cannot grant rights, and unsupported
profiles fail existing repository/resource preflight. Private data, current
authorization, leases/generation/exit and exact-SHA gates remain unchanged.

S6 adds an [operator acceptance harness](subsystems/service-acceptance.md), not a
production executor. Fixed isolated regressions cover fault/replay/scope boundaries;
real Source/SDK/original-Task evidence is recorded separately. A verified frontend
candidate is composed with the service baseline without replacing its Task/PR,
and original UI acceptance #41 keeps its own unresolved scope.


Issue60 extends the same service/delivery boundary with explicit approved operator
integration inputs. Current manager authority, released execution proof, exact
workspace/generation snapshot and Effect-backed admission fence which parents the
host may retain. Sealing preserves the resolved staged tree and trusted ancestry;
it does not grant SDK shared-ref access, replace a PR or substitute for verification.


The [shared context contract](subsystems/project-context.md) separates fixed role rules, retrieved memory, working summaries and original sources, with configured model/Harness envelopes and original native/SDK lifecycle management.

Project role governance (#2171) separates resident Chief proposals, Maintainer/Owner decisions, the current revisioned role catalog, and archived definitions/audit. Durable Effects proof gates visible changes; logical role keys and execution capability classes remain distinct. See [role governance](subsystems/project-agents.md#project-role-governance-2171).


Native execution (#2184) uses the original Workflow lifecycle and SessionController, with exact Task-role physical bindings and durable quiescence facts. A new ephemeral carrier can restore prior context without reviving a deleted Bot identity; new input is fenced during stopping and resources are never released from Bot absence alone. See [native adapter](subsystems/project-harness.md#native-physical-session-binding-and-quiescence-2184).
