---
subsystem: project-state-storage
owned_paths:
  - core/src/host/project-state-sqlite.js
  - core/src/host/project-state-storage.js
  - core/src/host/project-state-migration.js
  - core/scripts/state-storage.mjs
  - core/test/project-state-sqlite.test.js
  - core/test/project-state-storage.test.js
  - core/test/project-state-runtime.test.js
---

# Transactional runtime state

The original Store and domain services remain the only runtime objects. Set the
FlyBot plugin configuration `stateStorage: sqlite` to opt into SQLite. Existing
JSON deployments remain JSON until selected. SQLite requires Node.js22.18 or newer;
this implementation is tested on Node.js22.22.3 with SQLite3.51.3. No separate server,
message queue, model call or scheduler is introduced. This PR does not migrate a
running instance. Stop the instance, back up its private home, select the option,
and restart through its existing host. General backend deployment remains #2189.

## Commit boundary

The existing save chain captures the full in-memory JSON-compatible snapshot and
Effects watermark at call time. SQLite applies changed records, removed records,
normalized histories and Effect intents in one `BEGIN IMMEDIATE` transaction.
Unique record/history/change keys and a database commit-revision compare-and-set
prevent stale snapshots from overwriting another writer. The original exclusive
home lock remains required; a broken lock does not authorize SQL writes. A read-only
host cannot acknowledge Effects. `projectEffects.saved` runs only after successful
COMMIT, with no fallible database read between COMMIT and that acknowledgement.
External execution remains after commit through existing adapters.

WAL, synchronous FULL and foreign keys are configured and read back. Database and
payload files are private; external credentials are not introduced. Actual process
kill tests cover before-COMMIT rollback and after-COMMIT Task/Effect survival. They
do not simulate physical power loss or guarantee a filesystem/device honors fsync.
Use a local filesystem compatible with SQLite WAL, not a network-mounted database.
See the [Node.js22.22.3 SQLite API](https://raw.githubusercontent.com/nodejs/node/v22.22.3/doc/api/sqlite.md),
[SQLite synchronous settings](https://www.sqlite.org/pragma.html#pragma_synchronous)
and [WAL constraints](https://www.sqlite.org/wal.html).

## Layout and growth

- `state.sqlite`: metadata, per-entity records, history rows and ordered change IDs.
- `state_records`: namespace/ID primary key; immutable content hash and complete
  record fingerprint. Root descriptors preserve empty maps and scalar values.
- `state_history`: individual ordered entries for history, requirementsHistory,
  waitHistory, results, roleSessionHistory, resumptions and versions arrays. A new
  history item does not rewrite previous history items.
- `state_changes`: monotonic sequence, commit revision, namespace/ID and operation;
  no private record bodies. Its bounded internal query is not a public event feed.
  Authenticated Project-scoped HTTP/events remain #2185.
- `state-payloads/<sha256>.json`: immutable, hash-verified payloads above64KiB;
  individual payloads are limited to16MiB. Files are fsynced before their transaction
  can reference them. Failed commits may leave harmless unreferenced files; this
  implementation does not automatically delete history or collect those files.
- Existing logs, artifacts, SDK histories and workspaces stay in their existing
  filesystem locations. Database records retain their references and hashes.

Compatibility still hydrates the full runtime state. Each save scans/normalizes its
snapshot and compares fingerprints; this is not constant-time or lazy SQL execution.
It reduces changed disk records and separates append histories. History retention,
in-memory residency and model context budgets are different concerns. Bounded
role context, source retrieval and summary versions stay in #2177; changing the
storage engine does not load all history into a model or solve context overflow.

## Migration and one writable authority

1. Validate the original JSON schema and ownership through the original Store,
   applying its existing migrations and retaining identities. Invalid JSON or
   ownership refuses migration; it cannot create an empty SQL replacement.
2. Save a private immutable normalized import with SHA256. Atomically publish a
   version3 `state.json` guard identifying the import and migration ID, phase
   `prepared`. JSON-only older binaries refuse that newer version.
3. Initialize state, schema and migration metadata in one SQL transaction. Verify
   the DB/guard identity and activate the guard. Thereafter `state.json` is a guard,
   not a second writable snapshot; omitting the option on restart still selects SQL.
4. A prepared migration can recover from its verified import. A missing **active**
   database refuses to import an old backup automatically. Foreign/future schema,
   changed backup, wrong guard ID, invalid ownership or unknown authority fails closed.

The current implementation migrates the complete original team state into one SQL
transaction domain, including legacy users/Bots/rooms, Project records and pending
Effects; it does not run JSON and SQL as independently writable partial stores.
Working Task, Handoff, Attempt, SDK binding, logical Session and Effect IDs survive.
An old read-only host taking over must refresh current SQL state; a stale raw save
is rejected by revision instead of overwriting newer facts.

## Private offline operator commands

All hosts using this home must be stopped for export/rollback. The tool enforces the
exclusive home lock; do not manually copy a live main DB and omit its WAL.

```sh
node core/scripts/state-storage.mjs inspect --home /private/flybot-home
node core/scripts/state-storage.mjs export --home /private/flybot-home --migration MIGRATION_ID --output /private/export.json
node core/scripts/state-storage.mjs rollback --home /private/flybot-home --migration MIGRATION_ID
```

Inspect returns metadata only. Use its exact migration ID as a stale-source guard.
Export preserves the current committed version2 state in a private file, not the
old import. Rollback keeps that export and archives DB/WAL/SHM together, atomically
publishes the latest JSON state and completes a rollback marker. Remove the explicit
`stateStorage: sqlite` option before restarting on JSON; otherwise it intentionally
opts into a fresh SQL migration again. No authorization, evidence or history is reset.

A prepared rollback blocks runtime writes and startup adoption. After interruption:

```sh
node core/scripts/state-storage.mjs rollback --home /private/flybot-home --migration MIGRATION_ID --resume
```

The tool checks the export hash, exact migration, archived paths and unchanged commit
revision, completes partial moves and publishes JSON once. It will not overwrite a
conflicting archive or silently revert newer SQL data. Current SQL writers also check
the storage guard, so an old connection cannot keep writing after authority changes.
The tool is not exposed to Bot roles or HTTP callers.

## State semantics and release scope

Existing authorized structured commands update formal facts deterministically.
Queries derive views from those records; they do not call a model, rewrite Project
goal/scope, or append to PROJECT.md/ROADMAP.md. Chief admission, dependency judgement
and final completion remain the existing semantic decision points. Inspections keep
their configurable scheduled-task policy. Summaries and human documents cannot
replace permissions, execution ownership or matching candidate evidence.

Comparison checked against upstream main986399246ff8c26bd418978785ce1199dbd239ca
and delivery741bf1ef4aa199f0c7656095b32db3ab8e529a6a: main has the original core
Store but not this delivery branch's Project development service or Effects module.
The delivery base already had locked JSON snapshots and post-save Effects; it did
not have SQLite. This issue's PR stacks on #2179/4826723cc and adds SQL storage and
migration only. It does not merge upstream main, deploy, change control-plane/UI or
claim real-provider parallel Task development validation. Public event/receipt and
history service boundaries remain #2185; legacy entrypoint cutover remains #2186.

## Composed native lifecycle verification

The actual DSH native pool return probe also runs with `stateStorage: sqlite`. Its read side loads committed snapshots through a separate read-only SQLite connection, proving canonical Chief admission, native activation intent, retained Task-role context/parts, physical exit proofs and nonoverlapping resource release persist across role handoffs. It uses deterministic model transport and actual code/host tests, not provider inference or production migration. JSON remains the default. The dev probe's `--sqlite` flag is verification tooling; deployment documentation remains #2189.

State maps have no semantic insertion order. The probe resolves the previous Attempt through the successor's `feedback.previousAttemptId`; SQLite map iteration exposed an invalid earlier assertion that assumed the first UUID record was oldest. Immutable history arrays preserve explicit positions. No domain fact or history was lost by that diagnostic failure.
