---
subsystem: project-compatibility
owned_paths:
  - core/src/host/project-compatibility.js
  - core/src/host/project-state-format.js
  - core/test/project-compatibility.test.js
---

# Original FlyBot compatibility and Project cutover

The original Store owns every Task, Bot, group, Session and Workflow record. This
adapter registers pre-existing Project work once; it adds neither a second Task
store nor an executor. Personal conversations remain independent of Project.

## Capability and data inventory

| Object / entry | Source of truth and identity | Reuse / adaptation |
| --- | --- | --- |
| Personal Chief / Bot | members.designatedChiefId, bots, original root Session and parts | Original personal-space channel, persona, attachments, questions, approvals, stop, history and own memory; no forced Project binding |
| Independent personal agent | personalAgents and participations; original private carrier | Existing native identity/join/delegation and scoped FBA transport; external descriptors are not a verified vendor adapter |
| Native group | rooms, typed participants and their history windows, original group Session | Original group controls and message history; explicit Project association adds current Project read access to the existing group ACL |
| Project room | projectRooms and its own scoped messages/participants | Original Project-room API, role catalog and document controls; no personal history import |
| Public Project Bot | committed role catalog, published role memory and scoped public carrier | Existing project-agents/roles/memory reads and original Bot presentation; private Chief/agent memory remains private |
| Task / parent / rework | tasks by original id, parentId/reworkOf, actors/results | Same records; pre-cutover legacy work may continue, canonical work uses Chief admission and durable Handoff |
| Workflow / Run / artifacts | Original Workflow plugin and projectExecutions/Attempts/workspaces | Existing graphs remain explicit compatibility execution; new Project work defaults to pools, with one controlling Attempt |
| UI dependencies | Original personal-space, Task/Project endpoints and versioned development API | Reuse current surfaces; no client or control-plane replacement in this issue |
| Active native / SDK execution | Original workers, role Sessions, leases and Effects | Existing checkpoint/exit recovery; cutover itself starts, stops or reallocates nothing |

A Project association does not invite people into a private group, publish its
history as Project knowledge, move its prior personal Tasks, change its Bots'
ownership, or turn its personal Chief into the Project Chief. A Project member
without the original group ACL cannot read the group. Revoked Project membership
also removes the associated group from the personal projection.

## One-time admission boundary

On the first writable shared-mode load, after original identity/Project migration
and Effects recovery, the adapter captures each existing Project's legacy Tasks.
It adds an identity-bound `legacyProject` marker to the **same** Task row and a
`projectCompatibility/v1` baseline with count and SHA-256 over sorted identities.
Each baseline has an original `compat.cutover` Effect; execution requires actual
Store commit acknowledgement and matching Effect Project/payload, not a save
promise, timestamp, boolean, or mere absence of `projectTask`. A read-only load
cannot create a baseline. A pending write remains held until committed.

Subsequent loads never recapture newly found untyped Project rows. Unknown work
stays readable as `held` and cannot run through task.run, the old card driver,
queue claims or generic card state transitions. It requires explicit Chief
adjudication of the same inactive Task through the existing lifecycle; active
legacy work cannot change its admission contract. No forced rerun or ID mapping.
Known legacy rework retains `reworkOf`, the original requester and Project, and an
explicit derived marker, preserving the original return workflow across restart.

New shared Project work must enter task.propose / task-create and Chief intake.
Native group dispatch/track_tasks cannot silently insert new legacy Project cards;
they explain the required Chief contract. The group's original speaker fallback
still answers messages when dispatch cannot create a card. Ordinary personal and
group questions do not publish Tasks. Unbound personal tracking stays available.
Canonical Tasks cannot inject old card leases, evidence or handoff fields, or be
rerouted by generic plugin onWrite. Public Workflow assign cannot acquire their
execution initiative. The delivery controller retains a private exact-current-
Attempt assignment port for an explicitly configured legacy Workflow; it still
uses original authorization, quota, Run and evidence checks. No fixed DAG default.

## Inspection, storage and rollback

Authenticated `project-development/v1` query `compatibility` takes projectId and
optional payload `{offset, limit}` (default50, maximum100). It returns the scoped
baseline/commit status, contract/legacy/held/active counts and ID/status/reference
rows with same-Project parent existence. It never copies descriptions, private
memory, authentication, entire histories or another Project's identities. This is
a derived diagnostic, not an authority or a second writable task board. Baseline
counts cover initial work; derived rework appears in current counts separately.

JSON homes with a cutover or canonical Task use physical version4,
`stateFormat: flybot-project-state/v1`, `logicalVersion: 2`; the existing Store
retains logical state version2. Old JSON binaries refuse the newer frame rather
than replaying new contracts. Unknown/future frames stay read-only. Cutover homes
cannot reopen with shared authorization disabled. Personal-only homes retain the
original JSON version2 format.

SQLite keeps its original version3 migration guard and logical version2 database.
Import backup, export and offline storage rollback preserve the version4 JSON
fence where applicable. They use the existing exclusive lock, exact migration
identity/hash, revision checks and recoverable rollback marker. A storage rollback
is **not** a code downgrade permit. Never delete the fence or manually reset an
Effect/lease to make old code accept new facts. Committed external actions retain
their receipts and are not rerun by export/restart/rollback. No runtime dual write.
Use a private offline snapshot and the same-version migration CLI before a live
cutover. Compare the scoped baseline, current counts, IDs/parent links and original
authorization before expanding callers; unknown exits remain held under #2184.

## Evidence and limits

project-compatibility.test.js exercises original runtime/channel and actual JSON/
SQLite migration/rollback with a real local-file Effect, including restart,
unknown frames, baseline identity changes, post-cutover rows, original Chief and
group history ACL, rework and canonical card bypasses. workbench-personal and
Project delivery regressions keep original controls and legacy Workflow evidence.
The composed DSH runtime probes use deterministic inference, including native
return and SQLite; they are not real-provider development or browser acceptance.
No production migration, service restart, external-vendor product integration or
control-plane/frontend changes are performed by this PR.
