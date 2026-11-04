---
subsystem: project-service-contracts
owned_paths:
  - core/src/host/project-command-receipts.js
  - core/src/host/project-service-events.js
  - core/src/host/project-service-views.js
  - core/src/host/project-service-sse.js
  - core/test/project-command-receipts.test.js
  - core/test/project-service-events.test.js
  - core/test/project-service-sse.test.js
---

#2308 filters consultation.notify/agent.inbox.state Effects by their private
human/independent-agent recipient, in addition to existing command-principal rules.
Shared TaskView excludes these effects entirely; inbox commands retain normal
same-principal request receipts. See [inbox contract](agent-inbox.md).


# Commands, committed views and event transport

The existing `project-development/v1` application boundary and `/api/bot` remain.
There is no second Project, Task, identity, queue or executor. Public HTTP never
accepts a role/Chief execution token; the existing trusted role ports own Handoff
and adjudication. Consultation remains a separate message contract, not a Task.

## Durable public commands

The v1 command envelope requires a stable requestId. Receipts are scoped by operation, Project,
user and independent personal-agent identity. Native watch and external connections
for the same independent agent can recover the same receipt across carrier changes;
legacy delegated carriers keep grant isolation. Origin is server-derived, never a
body actor/session field. Human, personal-agent and Project-Chief origins differ.

Canonical command intent includes operation, payload and supplied preconditions.
Omitted candidate conditions differ from explicitly requiring no candidate. Changing
intent under the same key returns `bot/idempotency-conflict`. A confirmed replay
rechecks current authority and returns its recorded response even if the original
generation has advanced. First dispatch checks current target/generation both before
and after committing its begin marker. Concurrent requests share one invocation.

Existing Effects commit intent, begin and result markers with receipt state. Result
proof binds its SHA256. Failed intent cannot dispatch. A known result awaiting its
final commit reports `completion-pending-commit`; retry finishes that commit without
repeating the handler. Results above64KiB use immutable private hashed files, bounded
to8MiB; exact reads reject symlinks, hash changes and foreign paths. `command.result`
returns at most16000 characters with a hash guard. Result metadata/history remains
outside default model context. Receipts are retained for recovery; automatic archival
or garbage collection is not introduced here.

A durable begin without a confirmed result is **unknown**, not permission to blindly
repeat. Explicit reconciliation is limited to existing idempotent `task.run` and
`task.propose`/`proposal.publish` recovery from their server-stamped original Task and
committed intake proof. Reconstructed responses are labelled. Other ambiguous
commands return `bot/outcome-unknown` with a receipt/target/Chief query suggestion.
This is not a universal exactly-once external-side-effect guarantee. Existing domain
adapters still reconcile their own external actions.

`command.receipt` and `command.result` are private to the calling principal. Private
command marker Effects are also excluded from other principals' list/retry views.
Role acceptance separately commits `pool.accept`: failed saves restore the pending
Handoff, retries cannot return an uncommitted claim, and current role operations
require its committed acceptance proof. No new role execution is launched by a
receipt marker or by receiving an event.

## Bounded queries

Task/Attempt read projections have explicit projectionVersion/preview markers.
They retain current constraints, phase, provenance and evidence metadata, not entire
requirements/wait/result/session histories. No execution-requester Session appears
in Task summaries. Existing UI-consumed fields remain; unbounded raw-record clients
must follow source references rather than depend on removed historical payloads.
Original stored records and logical/physical execution Sessions are not truncated.

- `task.history`: requirements, requirement versions, admission decisions, dependency
  results, wait history, final results, handoffs, notes and actor history.
- `attempt.context`: existing role contexts plus exact evidence, feedback,
  requirement, failure, role definitions and integration-admission sources.
- Exact sources are Project/Task scoped, max16000 characters, with SHA256 and
  expectedSha256/offset guards. Unknown sections/foreign targets are refused.
- Attempt pages remain max50. Repeated role Session previews show the latest three,
  retaining references to complete original sources. Persona, full logs and tool
  transcripts do not ride on every Task detail response.

## Committed event model

The original Store prepares safe Project/Task/Attempt/execution/resource/input
projections inside its serialized immutable-snapshot write. It persists changed
facts and cursor metadata in the same JSON rename or SQLite transaction as business
state/Effects. Only after that commit does it acknowledge the event read model.
A failed save cannot publish an event or a newer committed snapshot.

Each Project has its own epoch, sequence and revision. Private chat, unpublished
proposals, personal memory, credentials and command-receipt writes do not perturb
its public sequence. Event data includes bounded public metadata/ref IDs; no raw
operator configuration, auth Session, tool transcript or private conversation.
Permissions are checked on every query and transport batch. Events describe stored
facts, not proof of live process activity or authority to execute a command.

`project.snapshot` returns a bounded committed Project/Task projection with cursor
and revision. Further Task pages require expectedRevision; changed snapshots must
restart. `events` reads after a Project-scoped cursor, max100. Defaults retain1024
facts per Project and24hours, configurable through `projectEventRetention` with
maxPerProject and maxAgeMs. Clock rollback cannot create a hole; duplicate/gapped
persisted streams fail closed. Age/size expiry or a different epoch returns
`bot/cursor-expired` and `nextAction: project.snapshot`. SSE is not permanent history;
Task/Handoff/Attempt queries retain the original history. Delivery is at least once;
clients deduplicate by cursor and query current state when uncertain.

## HTTP/SSE

`GET /api/project-events?projectId=PROJECT_ID` on the existing restricted gateway
requires `x-flybot-member-session`, accepting the existing user or personal-agent
credential. Tokens in URLs are refused. Initial connection emits a bounded snapshot;
Last-Event-ID (or an unambiguous after query parameter) resumes committed facts.
No DSH owner cookie, Set-Cookie or raw DSH event stream is forwarded to the client.

SSE uses authenticated original application queries. Connection-bound polling is
transport only, not a Chief inspection/work timer. Factory options eventPollMs
(default1000) and eventMaxStreams(default64) bound it; the gateway CLI exposes
--event-poll-ms and --event-max-streams. Backpressure reauthenticates before another
batch, revocation closes the stream, and server shutdown/disconnect aborts polling.
Initial errors use HTTP401/403/409/429 as appropriate. An established stream sends
access-revoked or reset-required and closes; clients must act rather than reconnect
forever with an expired cursor.

Tests distinguish actual TCP/SQLite/process operations from fixture authorization
and deterministic inference. This stage does not claim an external grok/dots provider
or full real-SDK parallel development acceptance. Compatibility cutover is #2186;
simplified real backend deployment/README remains #2189. No control-plane/UI rewrite,
new autonomous worker, inspection timer, deployment or merge is performed.

Operation names scope requestId, so different operations may reuse a key. When a key matches multiple operations, command.receipt/result require commandName (also supplied in resultRef); otherwise return bot/ambiguous-command. Retrying one invocation preserves its key; a deliberate new source.poll uses a fresh key. Confirmed replay preserves the original result and marks replayed:true, rather than rewriting its domain already flag.

#2292 Attempt summaries include bounded release status/target and a release.status source reference; they exclude release notes, credential references and actor authentication metadata. Release commands reuse original command receipts and Effects.

#2292 Task projections carry bounded Chief admission failure references and expose blocked/chief-recovery rather than an indefinite apparently pending admission. Successful admission clears that active marker while preserving historical execution failure.
