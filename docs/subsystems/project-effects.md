---
subsystem: project-effects
owned_paths:
  - core/src/host/project-effects.js
  - core/test/project-effects.test.js
  - core/test/project-effects-runtime.test.js
  - core/test/project-outbox.test.js
---

# Durable Project effects and external receipts

S4's real-store regression also proves GitHub event/input/notification/cursor state
shares the existing rename acknowledgement. The source.record receipt carries
thread/event identifiers; input.notify remains the only feedback wake path. All
async source preflight precedes staging, preventing unrelated saves from committing
partial events. See [Source contract](project-sources.md).

The same real-store suite covers native scheduled Source polling after browser
identity closure through the explicit background-principal broker, with one input
on the original Task and no ambient/personal credential fallback.

S2 (#51, parent #49) adds `project-effect/v1` records to the existing locked
state.json snapshot. There is no second database, message broker, executor or
Chief timer. The admission dispatcher drains due effects, at most two per batch;
original Project/resource quotas and role WIP checks still govern execution.

## Commit boundary

An effect carries Project/Task ownership, a stable `(projectId, kind, key)` id,
immutable intent hash, generation/revision, status, execution/failure counts,
due time, history and receipt. Payloads contain controlled host identifiers, never
credentials or caller-selected commands. A changed payload with the same key is
refused unless a trusted adapter explicitly requests generation replacement.

Pool handoff stages its dispatch intent synchronously with its business changes,
then saves both in one JSON snapshot. The engine holds unconfirmed intents. Store
save captures effect generation/revision alongside the exact JSON and acknowledges
them only after atomic rename, before optional journal recording. Awaiting save
alone is insufficient: a read-only/no-op save cannot authorize I/O; a journal
failure after proven rename does not erase the committed intent. This is process
restart recovery using the existing store, not a new power-loss/fsync guarantee.

The running checkpoint is saved before adapter validation/I/O. Completion saves
business results and the receipt together. A failed running/receipt save retains
the last committed generation and retries its dirty checkpoint; it cannot dispatch
a new unsaved intent on behalf of its caller. Late old-generation completion is
recorded in history and cannot acknowledge/delete a replacement. An uncommitted
replacement cannot become committed merely because an old operation replied.
Failed handoff commits roll back their offer without losing the previous claim or
history. Physical commit with a lost response remains a reconciliation case.

## Dispatch and recovery

`pool.dispatch` binds the exact handoff id and original human. Each attempt checks
current membership/principal, pending handoff and stopped/superseded state. Busy
resources or Chief slots defer without failure. Pool claim/launch still use the
existing serial authority, registered worker/lease and confirmed-exit rules. The
effect receipt means dispatch observed, not model input read, tests passed or Task
finished; S3 owns input/read receipts. Unknown exits never grant another writer.

Old queued handoffs gain a matching intent on migration, preserving Task and
receipt ids. Restarted running effects become pending for adapter reconciliation;
interrupted claims remain blocked by original pool recovery. Ended/stopped/stale
work cancels; resource/authority-proof waits defer; ordinary failures back off
exponentially up to60 seconds and exhaust after6 failures. No sleeping model turn
or busy retry loop is added. Unknown protocol records are retained without execution.
Adapter replacement is refused while its effect is executing. Shutdown waits for
in-flight adapters and leaves pending intents for the next host.

## PR outbox

`github.publish` is staged with the sealed candidate, original initiator and
publicationEffectId before push/PR calls. It rechecks current Task/requirements,
principal, matching passing tests, execution logs, independent role verdict and
candidate integrity. Background recovery additionally requires confirmed worker/
lease release and revalidates under the Attempt lock. It cannot close the Task.

The original GitHub publisher preserves the bound PR and upstream ancestry. A
first publication queries all PR states on its unique branch before push: response
loss reuses the existing artifact; a closed/ambiguous/moved PR is refused rather
than replaced. New artifacts carry a stable publication marker. Rework cannot
silently create another PR while the previous publication outcome is unresolved.
Network semantics remain at-least-once plus broker idempotence/reconciliation,
never cross-system exactly-once. Chief/human acceptance still rechecks the actual SHA.

## Personal comment outbox

`github.comment` uses the exact human×Project credential and verified GitHub login.
Its immutable approved body is a0600 artifact in the private outbox directory,
published via an atomic exclusive link. State contains its hash/reference and
minimal actor/grant provenance, not body text, token, cookie or browser session.
The current inline actor is transient; restart uses the configured current
principal checker, with live watch-grant validation when delegated. Missing proof
waits; revoked scope/grant or changed body/identity cancels. No automation fallback.

Before POST, the adapter searches only the configured repository/thread for its
own account's stable `flybot-outbox` marker and exact body. It follows pagination
up to10 pages; an incomplete scan defers without posting. Remote success with a
lost response or failed local receipt is reconciled to one stable audit id. Existing
receipt content changes are not overwritten. Legacy callers without requestId get
a fresh intent; callers needing retry deduplication use a stable requestId, including
the v1 comment.publish command. Unreferenced bodies from pre-commit failures are
private artifacts, not completed publications or evidence of a Task.

## Inspection and authorization

The v1 `effects` query returns bounded scoped status/receipt metadata without raw
payload/history/body paths. `effect.retry` requires current Project configuration
authority, an exhausted effect and stable requestId; repeats preserve one audit.
It cannot revive cancelled/stopped work. Every adapter rechecks current authority
and source validity after enqueue. TaskView shows exact-candidate publication waits
and pending/failed effect references, without borrowing an old candidate's success.

## Verification and rollout

Fault tests cover unsaved/no-op/failed commits, real-store rename-before-dispatch,
duplicate wakes, generation replacement/late receipts, ordinary backoff versus
resource deferral, local receipt failures, restart, marker reconciliation, personal
grant revocation, body tampering and incomplete pagination. Real Git tests exercise
same-PR continuation, first-publication lost response and closed/changed PR refusal.
Mocks are not real SDK/GitHub acceptance; S6 retains those integration obligations.

Source verification precedes deployment. Preserve autonomous frontend work and
original UI adapters; activate only at a verified released checkpoint, with a source/
state backup and compatibility checks. After S2 writes pending effects, rolling back
to code unaware of effects requires reconciliation or its matching pre-upgrade
data/operation boundary; do not blindly restore state over newer accepted work.
No control-plane, credential, merge/release or per-Bot sandbox changes are included.


## Durable Task inbox integration (S3)

S3 input.notify persists with admitted Task feedback and input.inbox proves its exact claim/snapshot batch reached the store before adapter dispatch. Notification waits for configured Chief recovery only when already blocked/arbitrating; it never interrupts a healthy worker or implies a model read. See [inputs](project-inputs.md).

S3 notification can resume a safe SDK message-wait or queue inspection behind a current Chief. It never answers a permission prompt. Effect staging failure rolls back a newly introduced input even before a token exists.


## Durable integration admission (#60)

integration.admit records a manager's exact source approval atomically with its
Attempt pins and generation. intentCommitted(token) acknowledges a known persisted
generation, independently of a newer unsaved receipt revision. It cannot authorize
an uncommitted replacement, unknown protocol or absent token. Delivery requires
this proof before using pins; a successful/no-op save alone is not enough. This
metadata-only adapter does not launch code or imply a merge/verification result.

#2185 adds pure pool.accept and service.command commit markers. They acknowledge ownership/command phases without invoking another executor. service.command results bind their exact SHA256; marker list/retry visibility follows the receipt's original independent principal, including native/external personal-agent identity across carrier rotation. Other Project members do not gain access to private command receipts or their markers.
