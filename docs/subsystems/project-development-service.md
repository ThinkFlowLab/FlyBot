---
subsystem: project-development-service
owned_paths:
  - core/src/host/project-development-service.js
  - core/test/project-development-service.test.js
---

# Automatic development application service

The `delivery/ai-centric-development-service` branch is a consolidated source handoff from
1811e3b8f. Its [root README](../../README.md) provides the operator-facing current
service and isolated-source quickstart, authenticated API examples and command
index. It preserves this existing in-process facade; no HTTP contract or runtime
behavior changes accompany the documentation branch.

S1 (#50, parent #49) introduces one application facade in the existing FlyBot
process. It owns routing and the derived TaskView, not another Task store,
executor, permission policy or workflow engine. Existing pools, admission,
delivery, delegation and Chief modules remain the authoritative implementations.
No storage migration, external dependency or new service listener is required.

S4 adds sources query and source.subscribe/source.disable/source.poll commands,
plus a trusted scheduledSource host adapter over the same Source implementation.
Current Project configuration and Task-write authority bind subscriptions, and
ordinary feedback uses the existing inbox/pools. See [Source contract](project-sources.md).

S5 adds the read-only execution.boundary query with optional current Task scope.
It revalidates current principal/Project/Task after async metadata checks and returns
only this human's rights/delegation/credential selection, safe resources and honest
preflight/isolation limits. It grants no operation. See [boundary contract](project-execution-boundary.md).

## Transport contract

The existing authenticated `POST /api/bot` accepts endpoint `project-development`:

```json
{
  "endpoint": "project-development",
  "payload": {
    "version": "project-development/v1",
    "kind": "command",
    "name": "task.run",
    "projectId": "project-id",
    "requestId": "stable-request-id",
    "expectedGeneration": 4,
    "payload": { "taskId": "task-id" }
  }
}
```

The value is `{version, requestId?, result}` inside the existing channel response.
`kind=query` has no required requestId. Version, operation kind, payload shape and
target Project are checked before dispatch. Task/Attempt/queue targets must agree;
Proposal and worker targets are also bound to the envelope Project, even when
the actor can access both Projects. Body actor/member/role fields never replace
the authenticated actor. Project
membership and each underlying operation's existing permission checks still apply.
An optional expectedGeneration/expectedCandidateSha is an admission precondition;
the existing domain claim/candidate fences remain authoritative across async work.
Errors retain channel codes: invalid contract, forbidden scope, conflict for stale
preconditions, read-only host and existing module-specific errors. No raw event or
role-token submission is available through this HTTP endpoint.

| Kind | Names |
| --- | --- |
| Query | tasks, task, task.detail, attempt.context, attempt.log, chief.state, pools |
| Command | task.run, task.accept, task.reject, attempt.stop, attempt.cleanup, attempt.publication-retry |
| Command | queue.cancel, queue.retry, chief.inspect, chief.configure, schedule.configure, agent.mode, proposal.publish, execution.input |

`tasks` takes limit 1–200 (default 50) and optional `after=taskId`, sorted by
creation time then id within the authorized Project. Unknown/foreign cursors are
refused; queries do not create definitions, agents or mutate stored task records.
`task` returns the compact view. Legacy `project-task-detail` and v1 `task.detail`
return the Task, `view`, and the most recent Attempt summaries in their original
order (attemptLimit 1–50, default20). `attemptsPage.before` selects the previous
page via beforeAttemptId; total and all original stored history remain available.
Role context/archive/policy bodies are represented by original hashes and an
explicit contextRef, preserving execution/session/evidence fields for existing UI.
They are not retransmitted with every poll. This repairs a real Task40 response
exceeding the unchanged8MiB gateway cap after25 Attempts and40MiB stored history.

`attempt.context {attemptId,section,offset?,limit?,expectedSha256?}` reads original
roleSessions/roleSessionHistory/rolePolicies as a JSON text stream. Pages are at
most16000 characters, default8000, with source hash, totalChars and nextOffset.
Changed sources reject a stale expectedSha256; foreign Attempts and unlisted
sections are refused. Joining all pages reproduces the exact original JSON.
No state history is truncated, no gateway/model/context limit is increased. `proposal.publish` still publishes only the requester's own
proposal through the original safe/watch contract. requestId is propagated to the
existing operation; S1 does not claim uniform durable command replay for operations
that did not already implement it. For execution.input, payload.requestId retains
the worker permission-question identity; the outer requestId identifies the
transport command. Persistent Effects/receipts belong to S2/S3.

Legacy endpoints route through this same facade and retain response shapes, with
only additive task-detail/view and workbench taskViews. Scoped agent run/watch
tools already use those endpoints, so they share the same human operation path.
The service's trusted roleCommand port delegates claim and handoff/return/transfer/
complete/arbitrate to the original fenced pool, preserving independent role rules.
The Workflow plugin's authorized poolResult callback enters roleResult; stable
claim/worker identity and duplicate-result handling remain in the pool. Logical
schedule occurrence delivery enters scheduled after the original schedule module
has checked authority and persisted its occurrence id. Native schedules retain
their configured timing; there is no new Chief timer. These ports are not public
HTTP commands and do not establish a new grant.

## One derived TaskView

The read model includes Project/Task identity, phase, waitingFor/reason, logical
Bot/role, generation, Attempt/execution/worker/queue ids, candidate SHA, progress
evidence references and permission-filtered nextActions. It excludes raw prompts,
private chat/memory, worker paths, credentials and full execution logs.

Precedence is terminal → stopping → explicit Chief human question → Chief wait →
blocked → admission queue → role queue → claimed execution → acceptance wait →
failure → legacy Run state. A stored native Bot is not proof of execution: its
live activity or a correctly scoped running SDK worker is required. Resource
waiting, role waiting, worker startup and user input remain distinguishable.
Evidence includes explicit current-SHA flags; old tests/review do not approve a
new candidate. Meaningful progress reuses Chief's verified evidence projection,
never heartbeat, message count or an arbitrary new commit.

The legacy compact taskExecution DTO is derived from the same function; existing
workbench readers can continue using it. nextActions is advisory discovery based
on current permissions/state: the actual command rechecks all configuration,
resource, evidence and authority conditions. Unknown/foreign Attempt or worker
references do not contribute execution/candidate evidence.

## Rollout and verification

The owner authorized backend implementation alongside healthy autonomous frontend
work, on independent branches/workspaces, with staged deployment. Source testing
must not stop Task40/PR48 or its configured inspections. No restart while active
workers/host verification own workspaces; a verified quiescent boundary and source/
configuration backup are required for each upgrade. No automatic merge or release
is implied. Control-plane, native UI assets and running task records are preserved.

Focused tests cover contracts, legacy equivalence, stale generations/candidates,
scope/permissions, deterministic pagination, projection purity, phase precedence,
role/schedule ports and actual HTTP/gateway routing. Full verify includes real DSH
deterministic runtime probes; these are not real-model or independent Review PASS.
S2–S6 retain their own fault-injection and live acceptance obligations.

## Durable effects and outbox (S2)

S2 adds query effects {taskId?,limit?} and commands effect.retry {effectId}, comment.publish {issueNumber,text}. Retry requires current configuration authority and stable requestId and cannot revive cancelled/stopped work. Effect status responses omit payload/history/body references. TaskView shows current-candidate publication waits and retry actions; an older candidate cannot mask a current failure. See [effect contract](project-effects.md).


## Durable Task inbox integration (S3)

S3 adds command input.publish and query inputs, with current Project/Task authorization, stable requestId, bounded body/pages and host-owned provenance/routing. TaskView includes at most20 pending feedback metadata rows, no bodies. Existing acceptance refuses unhandled feedback; effect receipt never implies reading. See [input contract](project-inputs.md).


## Approved integration inputs (#60)

Queries attempt.integration-state and command attempt.integration-bind require
current Project configuration authority and the current pools Attempt. State
returns generation, pinned sources and a workspace fingerprint (id, HEAD,
MERGE_HEAD, semantic index/status hashes), without filesystem/profile/credential
paths. Bind uses1–4 exact refs under refs/remotes/operator/ plus40-hex SHAs, stable
requestId, generation and expectedWorkspace (null before allocation). Foreign or
moving refs, changed snapshots, active/unknown workers, sealed/stopped Attempts and
unresolved paths refuse admission. A request replay returns its original audit;
a changed payload cannot reuse its key. Admission bumps the handoff generation,
invalidating old snapshots, and persists its integration.admit Effect with the
source list. It never starts a worker, changes Git or grants candidate approval.
The ordinary authenticated service/gateway remains the only HTTP entry; model text
and raw worker callbacks cannot authorize integration parents.


The delivery branch also supplies the [public API reference](../development-service-api.md)
and [workflow/private-agent/state guide](../development-service-guide.md). Their
operation index follows this module's 12 queries and21 commands; native creation
and personal-agent endpoints are labeled separately. Documentation adds no role
result/claim HTTP route, new state writer or additional authority.
