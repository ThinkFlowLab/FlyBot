---
subsystem: project-sources
owned_paths:
  - core/src/host/project-sources.js
  - core/test/project-sources.test.js
---

# GitHub Source subscriptions (S4)

The existing development service connects a Project GitHub Source, repository
Thread and TaskSubscription to S3's durable Task inbox. It does not create a Task,
claim, worker, fixed role sequence or new clock for each remote comment.

## Identity and configuration

`source.subscribe` accepts taskId, threadKind (`issue`/`pull`), number and optional
mode (`active`/`context`) and includeHistory (default false). Current Project
configure and Task-write authority are required. Repository comes from the
Project; a supplied different repository is refused. Stable Project/repository/
kind/number/Task identities deduplicate subscription retries. Conflicting existing
bindings require explicit reconciliation. `source.disable` disables a binding;
ordinary feedback cannot re-enable it. Current versions remain immutable evidence.

Only one enabled actionable Task owns a Thread. Additional subscriptions must
explicitly be context-only; another actionable binding refuses and asks for Chief
reconciliation instead of broadcasting feedback across Tasks. One Task can own
multiple Threads. The query `sources` exposes scoped sources, threads, subscriptions
and paginated event/route metadata. An eventId query pages the full original event
JSON in16000-character chunks with its content hash; no credential is included.

## Observation, persistence and recovery

`source.poll {threadId}` uses only the existing Project GitHub broker and explicitly
selected Project automation credential. Comments and edits, submitted Reviews,
inline replies, checks and PR head/state/merged facts receive stable external IDs
and content-hashed revisions. Unsubmitted private Review drafts are excluded.
Issue and PR kind, canonical repository/thread and full SHA bindings are checked.
An in-flight PR head move refuses the observation before committing its cursor.

Each feed rotates independent20-entry pages, resetting the checks page on head
change. A persisted cursor resumes sweeps after restart; known event revisions
are not delivered again, older revisions stay historical, and a failed read does
not move the cursor. REST polling cannot recover intermediate edits never observed
between polls, deletions, or provide a webhook's full event history. Page sweeps
eventually revisit earlier entries for edits; they do not promise instantaneous
access to every page of a large Thread. No webhook listener is required.

Default subscription activation records earlier observations as context, based on
the source modification time (second resolution); an explicit includeHistory=true
allows backfill. Missing timestamps stay prior-context by default. New edits to
an old comment can become actionable. This avoids replaying every old discussion
as a fresh request when a subscription is installed.

All asynchronous identity/authority checks finish before staging live records.
Events, complete routing records, input bodies, input.notify Effects, source.record
receipt and cursor share the existing state-save/rename acknowledgement. There is
no asynchronous yield between those mutations. An unrelated save therefore cannot
commit a half-populated event. Before/no-op failures roll back uncommitted records;
a confirmed rename survives a subsequent journal error. Replays reconcile existing
IDs and commit proof. Unknown versions refuse execution and preserve originals.

Long observations are retained losslessly and split into inbox entries whose bodies
are at most4000 characters, with event/revision/part provenance. Model delivery
continues to use S3's bounded current-claim batches and safe turns. Observation,
durable inbox, adapter delivery, declared reading and handling remain distinct.

## Responsibility and trust

The subscription points to a Task; the Task's current handoff/claim selects the
receiver when S3 prepares its inbox. Ordinary feedback waits while a healthy Bot
is busy. The Bot retains its existing choice to work, return, transfer or ask Chief;
completion still requires Chief. A remote closed/merged state is feedback, never
a local Task-close command. Unknown business scope follows the original Chief
adjudication contract.

Old-candidate CI/Review is recorded as historical and cannot become current
candidate verification. Even current-SHA remote facts are untrusted input, never
host test evidence or a role Review verdict. External text cannot select a resource,
credential, principal, recipient or authorization. Public input.publish still
cannot forge GitHub provenance. Source authority is checked at observation and
notification/delivery; membership removal cancels its pending GitHub inputs, and
late receipts cannot revive them.

Ended/stopping Tasks and context subscriptions only record context; they create
no input, worker or new Task. Explicit stops are not reversed by polling. Repository
movement, cross-Project IDs, revoked principals and unknown protocols fail closed.

## Scheduling and verification

Automatic polling is configured through existing `schedule.configure`, with target
`{kind:"project-source",threadId}` and an operator-selected when/title/prompt. The
original logical scheduled-task service handles timing, persistent occurrences,
principal checks and delivery; its adapter invokes the same development service
port. Nothing installs a hardcoded polling interval or changes Chief's own schedule.

Unattended polls use the broker's host-only, current-principal Project automation
port rather than a departed browser cookie. Source subscription/configure authority
and current background principal proof remain mandatory; JSON cannot forge that
port or select personal credentials. Real-store tests close the browser identity
and still observe exactly the original Task input through this explicit path.

UT/ST covers real store commits, retries/restart, edits/out-of-order observations,
partial-state-save regression, scope and revocation negatives, stopped/context
Tasks, exact-SHA history, lossless chunks and the native schedule adapter. Mock
observations are separate from the actual UID998 scoped GitHub REST read. A real
GitHub feedback→current frontend Bot→handoff acceptance must be recorded separately;
a successful read or source test is not proof of that complete path.

#2185 keeps domain rollback/revocation tests on the original facade aliases so an injected source-transaction failure is not consumed by an earlier generic command-intent save. Actual v1 subscription/polling with the real Store remains covered separately. A repeated HTTP command key replays its prior response; a new observation uses a fresh key, while the Source engine still deduplicates external revisions and input IDs.
