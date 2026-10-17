# Offline cross-runtime pilot

Implementation slice 1 of [#198](https://github.com/ThinkFlowLab/FlyBot/issues/198),
tracked in [#200](https://github.com/ThinkFlowLab/FlyBot/issues/200), following the
design in [#199](https://github.com/ThinkFlowLab/FlyBot/pull/199). This is a
development-only, deterministic contract simulator. It ships in none of the
FlyBot plugin packages and adds no runtime, task endpoint or permission grant.

## Run

Node 22.19+; no install or model key is needed for the demo and tests:

```sh
npm run demo:interop
npm run test:interop
```

The demo produces a JSON evidence record: `offline-mock`, one session, two
submitted turns, `result-ready` before explicit simulated requester acceptance,
then `accepted`. Real model requests/cost are zero because there is no model
implementation. The synthetic execution's `usage` fields remain null (unknown),
never guessed from those demo-level zeroes.

The demo scripts both agents' responses and the owner's decisions; nobody has
performed real analysis or human acceptance. Tests cover each boundary with
synthetic identities and fake time. Neither command contacts Bot Social or
OpenCode, reads the user's DSH data, uses a real credential or starts a process.

`no-network.mjs` makes accidental fetch/socket/DNS/subprocess calls throw during
the run. This is a regression tripwire for this harness, not a security sandbox
for arbitrary third-party code. Do not load external plugins or real credentials.

For lint/full verification, install the normal core tooling as described in
[AGENTS.md](../../AGENTS.md), or select an existing install with `DSH_HARNESS`:

```sh
npm run lint:interop
npm run verify
```

The required CI `package` job runs the offline suite. The core test composite
runs its lint. Root `verify` runs both after the existing suites.

## Components

| File | Responsibility |
| --- | --- |
| `codec.mjs` | Version-1 typed JSON envelopes, exact field allowlists, bounded UTF-8 input, sorted-key canonical encoding and SHA-256 vectors. This is a local contract, not JCS/A2A or a signature scheme. |
| `journal.mjs` | Single-writer snapshots with a lock, copy-on-transaction, fsynced temporary file, rename and directory fsync. |
| `harness.mjs` | Synthetic task binding, staged approvals, producer sequences, inbox/cursors, turn reservations, execution intent, cancellation observations and reconciliation. |
| `mocks.mjs` | Two-owner grant policy, fake clock, deliberately non-idempotent session/submission methods and controllable lost replies/offline/abort behavior. |
| `runtime-error.mjs` | Explicit recoverable runtime/evidence errors; unexpected assertion, storage and programming errors propagate. |
| `demo.mjs` | Scripted request → question → answer → result → simulated requester acceptance. |

The coordinator's public methods take fixture arguments such as `actor` and a
transport `context`. Those are simulated trusted inputs, **not authentication**.
An owner string in a real network request must never call these methods as if
it established authority. There is no HTTP server or real connector here.

## Boundaries exercised

- Owner A's FlyBot and owner B's OpenCode endpoint are distinct. Both directional
  grants are required. Same-owner enrollment is rejected, preserving Bot
  Social's design constraint. Display names and a common test operator cannot
  combine the two approval authorities.
- Every work message waits for the sender owner's delivery decision. Requests
  and answers also wait for the receiving owner's execution decision. Wrong-owner
  decisions, changed content under the same event/turn key, grants revoked during
  a hold and rebound owners cannot release execution.
- A host-enrolled task fixes selected input, criteria, recipients and budget in
  its digest. New tasks get separate sessions; clarification stays in the same
  session and must answer that task's outstanding question. Arbitrary chats,
  room contexts, unknown fields/versions and unrelated replies cannot start work.
- The runtime records a typed `peer-untrusted` data object. Injection text stays
  data; no prompt is assembled and there is no tool executor. Real prompt/fence
  integration and a verified no-tools OpenCode policy are future work.
- The inbox/cursor and held event are saved before returning. Before any remote
  operation, a turn and execution intent are saved. Lost submit replies are
  reconciled against scripted history. Ambiguous/unavailable history and lost
  session-creation replies stay `uncertain` without automatic resubmission.
- Cancellation persists a generation/tombstone before best-effort abort. A mock
  runtime's explicit `stopped` observation is different from `requested` or
  offline. Late messages cannot revive a cancelled task. An authenticated real
  runtime stop observation remains a connector obligation.
- Turn/message/progress limits and absolute deadlines survive close/reopen.
  There are at most two unfinished tasks and one synchronous work turn at a time
  per task. The final allowed turn can finish; no additional turn is admitted.
  Cancellation remains available after budgets or grants are exhausted.

`result-ready` tasks await a human decision and intentionally do not consume an
execution slot; they remain subject to the journal's 64-task retention bound.

Call `enforce()` when advancing the fake clock or revoking a grant to simulate
the supervisor tick. It cancels overdue/revoked work; there is deliberately no
real timer. Dispatch, release and reconciliation also recheck the applicable
scope/deadline. At most 64 tasks and 256 inbox records are retained per fixture
journal; reaching capacity fails closed rather than forgetting dedupe keys.

The mock can cancel a returned result. Current FlyBot `tasks.js` cannot; this is
an explicitly proposed host seam, not evidence that that gap is implemented.

## Persistence and remaining evidence

All demo/test data lives under a fresh `os.tmpdir()` directory and is removed
after the run. Journal methods are synchronous; one writer owns the lock. The
durability operations are verified on Linux. A lock left after a killed process
is not stolen automatically; verify the writer is dead before removing it in a
disposable test directory. Never point this harness at personal data.

Tests inject lost remote replies, then close/reopen the coordinator. They do not
claim a SIGKILL/power-loss filesystem test, a durable SSE replay test or a real
remote exactly-once guarantee. The mock's discoverable session/task association
and historical turn digest are deliberate fake capabilities. A pinned OpenCode
version must establish equivalent evidence or remain uncertain; its actual
`messageID`/abort behavior is not proven by this harness.

Still required: the reviewed host task-observation seam, structured social
correlation/approval previews, real grant/authentication enforcement, a pinned
OpenCode interface test, real tool isolation, enforceable model/cost limits and
an approved real trial. Team-mode gates, multi-human deployment and standard
A2A interoperability are unchanged.
