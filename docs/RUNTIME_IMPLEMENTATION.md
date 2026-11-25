> Follow-up: the new explicit executable Compose profile/CLI and recovery route are documented in [COMPOSE_MANAGER.md](COMPOSE_MANAGER.md). The original PR17 simulation/planning scope below is historical; live Docker and Teamily acceptance remain pending.

# Lifecycle slice — durable intents and simulation, not real containers

Depends on authentication/workspace PR #16 (`afedfc1`). Related #2 and #1; neither is completed or closed. PR16 stays unchanged; this work lives on its own stacked branch.

## Implemented

- Private SQLite instance registration, independent IDs, owner/workspace ownership, server-selected immutable profile/image/volume references, bounded keyset listing and membership-scoped job polling (list/inspect for any member; create/start/stop/restart for owner or admin).
- Instance creation needs `Idempotency-Key` (16–64 alphanumeric/underscore/hyphen); body `{}` only. Replays retain the same instance, including concurrent requests and process reopen. Default limits8 instances/workspace,1000 global,10000 retained jobs; quotas are operator configuration, not a user decision on container granularity.
- Each changed intent and its job commit in **one transaction**. New create starts at revision1, desired stopped. Repeated start/stop compare **desired**, including pending/failed intents, and reuse revision/operation/job. They do not silently retry failed or interrupted execution.
- Restart is independent, never a stop+start API pair. New operation_id (or omitted/server-generated) creates a revision; the same key replays the original job, even after later intents. Response includes the **current** instance plus the requested historical job when replaying an older restart. New restart conflicts409 with queued/running work; current revision/operation are returned. Started/stopped desired changes conflict while a manager is running; a queued non-create intent may be superseded before claim.
- Convergence requires equal observed/current revisions and observed==desired. A restart observation also requires a changed process identity. These are **simulation/manager protocol assertions**, not proof a real container recycled.
- Manager-only claim/heartbeat/observe; explicit ID allowlist and backend-mode grant, loopback peer only, opaque bearer credential separate from cookies; requests with Cookie or Origin are rejected. User sessions cannot enter manager routes. Manager credential hashes stay in private operator configuration; only lease hashes persist in SQLite. Public snapshots/jobs/events never contain credential/lease values or manager identities.
- Claim serializes per instance. Observations bind job, revision, manager, opaque lease and expiry; stale, duplicate and mismatched reports cannot overwrite current state. Expiry marks interrupted, latches the instance blocked and prevents automatic reexecution: an external operation could still be running. **Operator recovery/unblocking is not implemented yet; do not edit the DB to bypass it.**
- Explicit `FakeRuntimeBackend`: memory or private SQLite simulated volume state, process generations, bounded markers and atomic per-job receipts. Replaying a completed fake restart does not recycle again, including backend reopen. Failure injection reports only fixed server-owned codes/messages. No runtime output or exception text enters responses.
- Deployment's independently authored JS planner and27 original tests are integrated unchanged under `manager/compose-planner/`. `flybot-workspace.compose_planning` invokes only the fixed local pure Node bridge with shell=False, a bounded input and timeout. It returns a plan as data, **never executes the returned Docker command**. The Web application does not import that subprocess adapter.

## APIs

Existing auth/CSRF rules still apply to all user writes:

| Method | Path | Result |
|---|---|---|
| POST | `/v1/workspaces/{id}/instances` | `{}` + Idempotency-Key →201 new/200 replay, `{instance,job}` |
| GET | `/v1/workspaces/{id}/instances?limit=20&cursor=...` | Owner-scoped page, maximum100 |
| GET | `/v1/instances/{id}` | Explicit backend_mode, desired/revision/operation, observed/observed_revision, converged, blocked, fixed error |
| POST | `/v1/instances/{id}/start` or `/stop` | `{expected_revision?}` →202 new/200 reuse |
| POST | `/v1/instances/{id}/restart` | `{operation_id?,expected_revision?}` →202 new/200 replay |
| GET | `/v1/jobs/{id}` | Owner-only immutable intent/status, no lease/manager information |
| GET | `/v1/instances/{id}/logs?tail=100` | **Structured control-plane events only**, maximum100, truncation flag; `runtime_logs_supported:false` |

`expected_revision` is a positive integer; booleans are rejected. Idempotent desired-state/key replays take precedence over this precondition and never create a revision. For a changed intent a stale precondition returns409 and current intent metadata. Job states: queued/running/succeeded/failed/superseded/interrupted. Job retention is bounded by a hard count quota; archival is future work, not an automatic deletion of replay history.

Manager headers: `Authorization: Bearer <manager-id>.<43-character-opaque-token>`. No Cookie, Origin, CORS, proxy-header identity or user CSRF fallback. Authentication verifies SHA256(token) against the operator grant with constant-time comparison. Only private trusted loopback deployment is covered, not authenticated public transport or multi-host managers.

| Method | Internal path | Body/result |
|---|---|---|
| GET | `/v1/internal/instances?desired=running&limit=20&cursor=...` | Only IDs granted to this manager, same backend_mode; desired optional |
| POST | `/v1/internal/jobs/claim` | `{instance_id}` → `{claim:null}` or private `{instance,job,lease,lease_until}` |
| POST | `/v1/internal/instances/{id}/heartbeat` | `{job_id,observed_revision,lease}` renews the same unexpired lease |
| POST | `/v1/internal/instances/{id}/observe` | Same fields + `observed`, optional `process_ref,error_code` |

`observed` is running/stopped/failed; running requires a32-hex process identity, stopped requires no process_ref; failed requires the sole code `runtime_failure`. Arbitrary error strings, tokens, logs, paths, environment, image/command/mount selectors and extra fields are rejected. Errors never carry runtime exception text. Pending jobs and current revision are the fencing authority, not merely the manager's claimed state.

## Running and configuration

Python3.11+; **Node18+ is additionally needed for planner integration/tests** (local verification used Node24.22.1). No pip/npm dependency install required. The manager-side adapter defaults to the system executable search path only. For an operator-installed/CI tool-cache Node outside that path, explicitly set `FLYBOT_WORKSPACE_PLANNER_NODE` to its absolute executable path (or inject the constructor argument); relative paths, non-Node filenames and group/world-writable executables are refused. This is operator process configuration, never an HTTP/JSON selector. CI stages its preinstalled runner Node into a private0700 job directory with an0500 executable, then exports that absolute path before Python tests. The application permission check is not relaxed for writable hosted-tool-cache binaries. The Web/API remains Python stdlib only.

```sh
python3 -m unittest discover -s tests -v
node --test manager/compose-planner/compose-command-planner.test.js
python3 -m compileall -q flybot-workspace tests
python3 -m flybot_workspace.server --help
```

The optional operator-run development server flag `--simulation` enables the labelled lifecycle APIs; without it the PR16 auth-only behavior remains. `--manager-grants /private/operator/managers.json` loads only explicit grants at startup and requires --simulation. Server remains loopback-only development WSGI, never starts a manager or executes Docker. No service was started for this PR's verification.

The grant file and its immediate directory must be owned/private (0600/0700); symbolic paths, special files, oversized input, unknown fields and plaintext `token` fields are refused. Format is a bounded list of `{id,credential_hash,instance_ids,backend_mode}`. A credential_hash is64 lowercase hex characters from the manager's high-entropy opaque token; do not use a human password, place raw bearer tokens in that file or commit either real credentials or operator files. IDs must be actual operator-approved instance IDs; grants cannot be created/expanded by any API. Updates require an operator restart. Tests use synthetic temporary state only.

The manager worker in `fake_runtime.py` is a synchronous **in-process simulation test helper**, not a deployed manager daemon/HTTP polling client. The independent HTTP claim/heartbeat/observe routes are exercised by tests but an operational manager client/supervisor is still owed.

Schema: base authentication schema remains v1; lifecycle adds its own version1 tables atomically in the same private DB. Unknown/empty malformed runtime version metadata fails closed. No destructive migration, automatic backup/restore or operator recovery tooling is included. Existing SQLite WAL backup/private-permissions rules continue to apply.

## Honest acceptance status and remaining work

| Area | FlyBot evidence/status | Teamily comparison/status | Gate |
|---|---|---|---|
| Instances/jobs/owner/manager scopes and revision fencing | Self-authored executable HTTP/service tests | Teamily internal server architecture unknown; no same-implementation claim | Self-hosting foundation only |
| Memory/SQLite fake start/stop/restart and data marker | Tested simulation, explicitly backend_mode=simulation | Not a real FlyBot/Teamily operation comparison | Simulation pass only |
| Compose planning | Pure planner27 tests + Python adapter tests | Teamily internal orchestration unknown | Not execution/volume retention proof |
| Real FlyBot create/health/start/stop/restart/volume retention | Not executed; compose-planning mode cannot acquire executable jobs (501) | pending-verification | Not accepted |
| Runtime logs | Unsupported; only fixed control-plane events exposed | pending-verification | Not accepted |
| Product UI and13 domains | No browser/frontend acceptance | Same real page/role/input/result evidence still required; guides/gray rollouts pending-verification | Not accepted |

Still owed for #2: operational manager daemon/client, reviewed registry/realpath boundary, real Compose executor/inspection/readiness, bounded **raw runtime** log filtering, interrupted-operation recovery, real container restart/retention/failure acceptance and deploy/TLS/resource policy. Planning alone never returns running. backup/restore/upgrade/reclaim/purge remain explicit501. Full Teamily functionality, UI parity and independent reviewer29-case release acceptance are not completed by these unit tests. Preserve both sides' evidence/status fields from ACCEPTANCE.md, and never turn N/A/not-executed into pass.

## Quality follow-up evidence

PR16's fixed `afedfc1` passed both Python3.11/3.13 matrices (push and PR checks). PR17's initial `8c95089` failed its two Python planner integration tests on the hosted runners: Node was installed in the hosted tool cache, not `os.defpath`. The fix keeps the restricted default search and explicitly configures the trusted absolute runner executable; it does not fall back to untrusted request/current-directory PATH or skip tests.

The expanded local suite passes62 Python tests plus27 unchanged planner tests. New coverage includes parallel additive runtime initialization preserving auth/session/workspace rows, **four separate Python processes** racing the same SQLite instance key, competing desired-state transactions, cross-manager grant and cross-owner denial, rejection of an older completed job's observe/heartbeat while a newer revision is leased, and strict public control-event log fields excluding synthetic private runtime content. These are real process/SQLite/protocol tests with synthetic temporary data, not a real container or Teamily parity pass. The initial CI evidence is linked by runs [PR16](https://github.com/openTeamily/openTeamily/actions/runs/43826354933) and [PR17 failure before fix](https://github.com/openTeamily/openTeamily/actions/runs/43827235697); follow-up CI status must be read from the fixed commit's checks.
