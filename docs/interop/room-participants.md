# Same-room runtime participants (#198)

The first acceptance target is DSH + DSH in one FlyBot room, then DSH +
OpenCode in that same room with the same task and independent checks. A Bot
Social DM bridge alone does not satisfy it. The [earlier pilot
contract](opencode-pilot.md) and offline harness remain useful transport and
recovery foundations; their DM scope does not define the room integration.

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

An OpenCode participant also needs an operator-controlled installation binding,
normalized execution and permission events, observed cancellation state,
restart reconciliation and durable resource accounting. Peer text cannot choose
an endpoint, workspace, model, credential or tool policy. A runtime selector
must reject unsupported kinds rather than silently executing through DSH.
Closing/leaving a room, changing membership or revoking authority must prevent
new dispatch and stale callbacks. None of these external paths are enabled here.

The acceptance fixture must force a clarification, use isolated code and
independent tests, and end with human acceptance/rejection. Keep separate
evidence for deterministic room tests, mock HTTP compatibility, actual model
execution and human acceptance. The current room suites exercise DSH scheduling
with scripted events; they are not that complete fixture or a performance
comparison. Real-model trials still require explicit model and budget approval.
