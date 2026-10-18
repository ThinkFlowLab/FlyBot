# Same-room runtime participants (#198)

The first acceptance target is DSH + DSH in one FlyBot room, then DSH +
OpenCode in that same room with the same task and independent checks. A Bot
Social DM bridge alone does not satisfy it. The [earlier pilot
contract](opencode-pilot.md) and offline harness remain useful transport and
recovery foundations; their DM scope does not define the room integration.

Phase-1 decisions (2026-10-18, recorded on #198): single-owner pilot, option
A through this participant path, the isolated fixture task with edit+test
tools and no network, and a driver-owned supervised OpenCode child process.

## Current DSH boundary (#216)

`groups.js` uses `createDshRoomParticipant(rt)` from `room-participant.js`.
This is an internal extraction, not a public plugin service or a multi-runtime
registry. All existing participants still use DSH.

| Operation | Current contract |
| --- | --- |
| `open({ room, member })` | Reuse or create the member's room Session; resolve `{ id, created }` after model/permission setup and capabilities. Keep the existing `room.sessions[botId]` and `groupOwners` links. |
| `runTurn({ room, member, sessionId, text, note, signal, started, by })` | Deliver selected room input with a fresh exchange ID; resolve raw reply text, `{ failure }`, `{ missed: true }`, `{ approval: true }`, `{ working: true }`, or `null` on stop/delivery failure. `started` retains unfinished exchanges so stopping a round can withdraw its work. |
| `snapshot(sessionId)` | Return `{ working: false }` or `{ working: true, since }` from process-local DSH events. This is not durable recovery evidence. |
| `cancel({ sessionId, exchangeId })` | With an exchange ID, withdraw that round's delivery or cancel its current turn through the existing turn tracker. Without one, cancel current member work and return whether work was present. Neither means external side effects were rolled back. |

The room layer retains membership checks, private-brief sharing decisions,
selected transcript/reference input, seen cursors, ordering, mentions, turn
limits and result presentation. The DSH driver owns Session creation, model and
permission setup (including resetting the old seen cursor on creation), waiter timers, execution-event callbacks, rollover lookup and
cancellation dispatch. Existing DSH permission decisions still use their current
host paths; there is no generic `decidePermission` operation yet.

The driver receives host-selected input, not an instruction to collect private
context itself. Its event callbacks follow `groupOwners` when a DSH context
rollover replaces a Session. Completed waits release timers and abort listeners;
background/approval work keeps its cancellation target after the round moves on.

## Remaining integration

The current one-Session-per-room/member links are preserved for compatibility;
they do **not** provide `roomId + botId + taskId` isolation. Before enabling an
external backend, add a versioned durable binding and migration that cannot
reuse a DSH session ID as an OpenCode session ID or cross task boundaries.

An OpenCode participant is a supervised child process owned by the participant
driver: the driver pins and starts it, stops it with the room, reconciles
after restarts, and validates its installation binding (version, empty
disposable workspace, no inherited configuration). The driver also normalizes
execution and permission events, observed cancellation state and durable
resource accounting. Peer text cannot choose an endpoint, workspace, model,
credential or tool policy. A runtime selector must reject unsupported kinds
rather than silently executing through DSH. Closing/leaving a room, changing
membership or revoking authority must prevent new dispatch and stale
callbacks. None of these external paths are enabled here.

The acceptance fixture must force a clarification, use isolated code and
independent tests, and end with human acceptance/rejection. Keep separate
evidence for deterministic room tests, mock HTTP compatibility, actual model
execution and human acceptance. The room suites exercise DSH scheduling with
scripted events, and `core/dev/room-smoke.mjs` runs the same acceptance shape
through a real bench with actual DSH sessions and the mock model (real room
entry, deterministic model — still not a real-model trial or a performance
comparison). Real-model trials still require explicit model and budget approval.
execution and human acceptance. The current room suites exercise DSH scheduling
with scripted events; they are not that complete fixture or a performance
comparison. Real-model trials still require explicit model and budget approval.

## Clarification contract (pinned v1 design, not yet implemented)

Cross-runtime, "the member is blocked on a question" must be a structured,
machine-checked signal. Prose that merely reads like a question creates no
wait — the acceptance fixture's forced clarification must not depend on
prompt phrasing surviving translation into another runtime.

- An external participant's turn ends in exactly one observable state:
  `reply` (text, done for now), `working` (execution evidence continues) or
  `question` (blocked on requester input). The v1 encoding for an OpenCode
  participant is a fenced `flybot-question` block carrying validated fields
  (`taskId`, `turnId`, `text`), parsed by the adapter; unknown fields, a task
  or turn that does not match the room's current state, or malformed content
  degrade the turn to a plain reply with a warning, never to a wait.
- Only the host opens `task-wait-input`; the driver cannot mint waits. A
  question raised outside a task is an ordinary room reply.
- An answer reaches the participant as room input for its next bounded turn,
  with the `task-answer-input` bookkeeping beside it. Answers are untrusted
  data and never widen permissions; approval stays a separate track.
- The DSH participant satisfies this today through its exchange and waiter
  machinery; this section is what an OpenCode adapter must provide at the
  same seam. A native "ask" tool may replace the fenced block in a later
  version once the pinned OpenCode SDK demonstrably supports one.

## Supervised child lifecycle (pinned v1 design, not yet implemented)

The participant driver owns the OpenCode process. Whoever starts a process
can stop it, so the pilot allows no operator-started server.

- **Start.** The driver spawns the pinned OpenCode version with an empty
  per-room workspace, an environment inheriting no operator configuration,
  plugins or credentials, and persists the
  `roomId + botId + taskId → (child pid, runtime session)` mapping before
  the first dispatch.
- **Supervision.** The process handle is the driver's authority for
  teardown. Health and status reads are observations; they never authorize
  work or approval.
- **Stop.** Round withdrawal, task cancellation, member removal, room close
  or leave, and plugin unload each terminate the child (TERM, bounded wait,
  KILL) and record the disposal state as `requested`, `observed` or
  `uncertain`. Disposal never claims rollback of external side effects.
- **Restart reconciliation.** On host restart, reconcile the durable mapping
  against the process table and the runtime's own session history before any
  new dispatch: live children are re-adopted or deliberately stopped,
  orphans are stopped, and sessions whose state cannot be confirmed stay
  `uncertain` with dispatch suppressed — never blind re-execution.
- **Budget.** Turn, request and cost counters live in the host journal; a
  child restart or replacement resets nothing.
