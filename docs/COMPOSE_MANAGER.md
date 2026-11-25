# Compose manager for per-account DS-Bot runtimes

The manager runs the isolated DS-Bot containers and reports verified state back to the platform. The web service handles account sessions and provisioning. A separate, operator-managed process executes the Docker work over an authenticated loopback connection. Execution and automatic account provisioning are opt-in.

The v0.3.10 build passed real Docker/Compose lifecycle, volume retention, gateway
routing and two-account Bot Social tests. Chromium verified private-chat history
on two separate account volumes before upgrade, after upgrade and after restart.
[Runtime image checks](https://github.com/openTeamily/openTeamily/actions/runs/45196194354)
and [upgrade acceptance](ACCEPTANCE.md#verified-ds-bot-v0310-upgrade) record the evidence.

## Scope and prerequisites

- Linux/POSIX, Python 3.11+, operator-installed Docker Engine and Compose v2.
- Web process **does not import the manager or receive a Docker socket**. Use a
  separate unprivileged Web identity/container with no Docker group/socket access;
  the operator manager is privileged. Same-UID development is not a security
  boundary against a compromised Web process.
- Manager HTTP connection is numeric loopback HTTP only (`127.0.0.1` / `::1`,
  explicit port), direct/no proxies, redirects, cookies, Origin, credential URLs or
  DNS. The operator's `server_host` supplies the server's exact configured origin
  netloc as Host, **without changing the numeric-loopback connection target**. Public ingress must deny `/v1/internal/` entirely: a local reverse proxy's
  loopback peer is not proof that its original caller was local.
- A **locally preloaded, operator-supplied digest-pinned image**; the server still
  does not pull or build images itself and does not claim license-completeness.
  Image contract: UID/GID1000, `/data` writable by that UID (image directory
  ownership is copied to a new named volume), read-only rootfs except `/data`
  and tmpfs `/tmp`, TCP8080 if optionally published, and a functioning Docker
  HEALTHCHECK. Operators can build that image from `runtime/flybot-image/` and
  pass the resulting `name@sha256:…` to `--compose-image`. See the
  [runtime image workflow](../.github/workflows/flybot-runtime-image.yml) for the
  build inputs and [licensing notes](LICENSING.md) for redistribution status.
  A passing Docker healthcheck is required before the manager publishes the container route. Supply
  a checked CMD healthcheck only if the image lacks one.
- Each auto-provisioned account gets one Compose project, one container and one
  persistent data volume. Its personal workspace anchors the allocation.
  Shared workspaces use the member's own runtime and share state through Bot Social.
- One active operator executor/state directory per instance/engine. `flock` prevents
  concurrent local invocations; this is not a distributed/HA runtime coordinator.

## Execution profile versus planning

The `compose` mode is claimable with matching grants and is selected on the
server with `--compose-image <image@sha256:...>`. `compose-planning` remains
a planning profile and returns HTTP `501` on claim. Simulation stays available
for development. Private Compose claims carry the previous process reference for
fencing.

Use the loopback WSGI runner for development. An Internet-facing deployment needs
its own WSGI service and HTTPS gateway configuration.

## Build the operator manager image

Build each release from the same verified dependency base. The base provides
Python, Node, Docker, and Compose with the manager's runtime configuration.
Keep its image ID in the release configuration and verify the local tag
against that ID before building.

Run [the manager release builder](../deploy/isolated/build_manager_release.py)
with the matching web image and a release context containing
`release/flybot_workspace/`, `release/manager/`, `wsgi.py`, and `manager-poll.py`.
The builder checks the image ancestry, runtime configuration, and every
application and planner file against the staged release. The fixed dependency
base keeps the layer count independent of earlier releases. Update the base
when the dependency or runtime configuration changes.

## Account provisioning and deployment

1. Preload the exact runtime image by digest on the Docker host and configure the
   same digest in the platform's Compose policy and the manager's
   `auto_instances.image`. The manager's `auto_instances.healthcheck` can be
   `null` to use the image's healthcheck.
2. Give the manager an `auto_provisioned: true` grant in the platform's private
   `--manager-grants` file. Set `enabled`, `manager_id` and `max_instances`
   in the private `--auto-provision` file. The selected manager can claim only
   its assigned accounts and any explicitly granted instance IDs.
3. Run `python3 -m flybot_workspace.manager --config "$CONFIG" --execute poll-once`
   from the operator supervisor. With `dsbot_gateway.web_container` configured,
   it publishes the route for each healthy managed runtime. The public HTTPS
   gateway uses the signed-in account to choose that runtime. Set up shared
   service connectivity using the [Bot Social deployment guide](../deploy/isolated/BOT_SOCIAL_DEPLOY.md).
   The [isolated deployment supervisor](../deploy/isolated/manager-poll.py)
   checks for new work one second after each successful pass. Idle passes
   stay out of the logs. Failed passes retry after 10 seconds and back off
   up to 60 seconds until the next successful pass.
4. Configure the [platform default model API](MODEL_API.md) before verifying
   first-time chat. Sign in with two test accounts, confirm each has a distinct
   runtime and data volume, and send a message in each account. Verify the
   persisted history after restart.

With automatic Compose provisioning enabled, workspace instance requests use
the same account limit and manager assignment as signup. An existing account
runtime is returned across workspaces where the caller can operate instances.

### Release and restore a stopped reservation

An operator can release the automatic provisioning reservation for a stopped
account runtime. Its container, volume, owner, and manager assignment are
preserved. The owner sees a paused status until the reservation is restored.
The global runtime instance limit still includes paused runtimes.

Run these commands as the management service user with the same data directory
and private auto-provision policy as the running management service. Use the
instance ID and current revision from the manager's instance status. Verify the
container is stopped on the Docker host before releasing a reservation.

```sh
python3 -m flybot_workspace.runtime_slots --data-dir "$DATA_DIR" --auto-provision "$AUTO_PROVISION" status
python3 -m flybot_workspace.runtime_slots --data-dir "$DATA_DIR" --auto-provision "$AUTO_PROVISION" park "$INSTANCE_ID" --revision "$REVISION"
python3 -m flybot_workspace.runtime_slots --data-dir "$DATA_DIR" --auto-provision "$AUTO_PROVISION" restore "$INSTANCE_ID" --revision "$REVISION"
```

The runtime must be stopped with a confirmed lifecycle revision and no active
job. Restoring requires a free reservation. Once restored, the owner can start
the same runtime from the startup page.

### Reserve address space for account bridges

Reserve a private IPv4 CIDR on the Docker host for new FlyBot account
bridges. Check the host's routes, VPN routes, and existing Docker subnets before
choosing the range. Keep the range exclusive to the manager and record it in
the host's network plan. Add `runtime_ipv4_pool` at the top level of the private
manager configuration. An example reserved range is `10.240.240.0/20`.

The manager assigns a separate `/28` bridge to each new account from the pool.
A `/20` supplies 256 such bridges. Existing account bridges retain their current
subnets, including bridges for stopped accounts. Account reservations and
available bridge addresses are separate capacity limits. Size both for the
number of accounts the host should support.

Install a manager build that supports the setting, apply the private
configuration, and restart the FlyBot manager after current lifecycle jobs
finish. Verify that a fresh test account gets its own bridge, starts its runtime,
and can send a first message with the configured platform model.

### Upgrade existing runtimes

Changing the image for **existing** account volumes is a separate operator
rollout. Record the current image digest, take consistent volume snapshots,
and verify health, routing and private-chat continuity on staged upgrades.
Coordinate the platform's image reference, the manager registry and the
container replacement as one change. The manifest repair command below updates
allowlisted mounts and memory limits. A change of image digest is rejected by
that command. Keep the previous image and pre-upgrade volume snapshot together
for rollback.

## Manual enrollment for one explicit instance

1. With an already-preloaded compatible image, start the management development API
   with `--compose-image "$IMAGE"` and normal private storage/origin options from
   [MANAGEMENT_API.md](MANAGEMENT_API.md). Create an account, workspace and instance
   through the authenticated/CSRF owner API; retain its 32-hex `INSTANCE_ID`. No
   request may choose paths, commands, image, environment or mounts.
2. In a new operator-owned private parent directory, create disabled configuration:

   ```sh
   # IMAGE is an operator-provided locally preloaded repository@sha256 digest.
   python3 -m flybot_workspace.manager init \
     --state-dir "$HOME/ot-private/manager-fixture" \
     --instance-id "$INSTANCE_ID" --image "$IMAGE" \
     --base-url http://127.0.0.1:8080 --server-host 127.0.0.1:8080 \
     --docker /usr/bin/docker --socket /run/docker.sock
   ```

   The parent directory must already exist, be owned by the operator/root and not
   group/world-writable; state is new0700, files0600, no overwrite. stdout contains
   paths only, never the generated bearer secret. `manager.json` contains the
   manager token; **do not paste it into chat, logs, URLs, process arguments or git**.
   `grants.json` contains only its SHA256 digest and exact instance/mode grants.
3. Install **only the digest grants file** into the Web identity's private directory
   with the correct owner/mode, then restart/reload the development server with
   `--manager-grants /absolute/server-private/grants.json` and the same Compose image
   and persistent DB. The development loader requires an explicit operator restart.
   Keep the bearer-bearing file with the manager. For explicit enrollment, each
   additional instance needs a corresponding registry entry and grant.
4. Inspect `manager.json` privately, explicitly set `execution_enabled` to true and
   retain mode0600/dir0700. `--execute` is required on **every** operational command:

   ```sh
   # plan is file-only, never HTTP or Docker; generated Compose JSON must not be edited.
   python3 -m flybot_workspace.manager --config "$CONFIG" plan --instance-id "$INSTANCE_ID"
   python3 -m flybot_workspace.manager --config "$CONFIG" --execute run-once --instance-id "$INSTANCE_ID"
   python3 -m flybot_workspace.manager --config "$CONFIG" --execute inspect --instance-id "$INSTANCE_ID"
   python3 -m flybot_workspace.manager --config "$CONFIG" --execute logs --instance-id "$INSTANCE_ID" --tail 30
   ```

   Issue owner start/stop/restart intents through the existing owner API, then invoke
   run-once. The command performs one worker pass for this instance. Repeated
   calls do not reexecute an already claimed/completed job. Optional `publish_port`
   maps only `127.0.0.1:<operator-port>` to8080; never all interfaces. The runtime's
   own authentication remains necessary. Default is no published port.

## Whitelist, bounds and readiness

`manager.json` exact fields: version1, execution_enabled(boolean), base_url,
server_host, manager_id, token, docker (absolute executable), socket (absolute local
Unix socket), instances, and optional `auto_instances`, `dsbot_gateway`,
`bot_social_socket`, and `runtime_ipv4_pool`. Each of at most 100 explicit instance entries has image,
healthcheck (CMD argv or null), and publish_port (integer 1024–65535 or null). Repeated
host ports, unknown keys, mutable images and caller-selected Compose files fail.

The manager generates canonical JSON Compose in its private state directory and
checks its exact content again before use. There is no include/build, custom
service command/entrypoint/env_file, host/PID namespace, privileged mode,
Docker socket mount or arbitrary argv. The only data mount is named volume
`ot-<instance-id>` at `/data`, retained on stop. The manager chooses fixed,
read-only binds for the account's model API configuration, Bot Social configuration
and personal-agent bootstrap. The optional Bot Social socket uses a fixed mount
when enabled. See the [Bot Social deployment guide](../deploy/isolated/BOT_SOCIAL_DEPLOY.md)
for the shared-service wiring.
The files are written or refreshed before create, start or restart; when no
key or server is configured the corresponding file is empty. The model API
key and any Bot Social connector token are never placed in Compose
environment, the image, or user or manager claim/observe JSON. The manager upgrades
frozen `compose-*.json` files with missing allowlisted secret binds or the former 1 GiB
memory limit. On the next create, start, or restart it recreates the container with
`--force-recreate` to apply the updated manifest. The 1.5 GiB limit gives the local
meeting recognizer room to run alongside DS-Bot. The named volume
`ot-<instance-id>` and existing secret files are never deleted; `down`,
`volume rm`, and `-v` stay off the allowlist. Operators can preview or apply
this with `python3 -m flybot_workspace.manager --config … migrate-manifest --instance-id …`
(add `--apply` to write). Any other compose drift still fails closed as
`manifest_changed` and still does not touch the volume. It enforces nonroot UID, no new
privileges, dropped capabilities, read-only rootfs, resource caps and bounded local
logging. Existing container project/service/image, mount, privilege, user, namespace,
network and published-port metadata are checked; existing volume Compose ownership
labels must match, with local driver and no custom driver options (no disguised host bind). No pull/down/rm/exec/kill/purge or `-v` command is emitted.

Trusted file/executable paths must be absolute, owned by the operator/root, not
symlinks or group/world-writable, including ancestors (root-owned sticky `/tmp`
allowed above a private fixture directory). Manager config/Compose/lock files and
state directory must be private and operator-owned. No private configuration path
is accepted through HTTP. Same-UID/root/Docker administrators remain trusted; this
is not a defense against an administrator racing the filesystem or daemon.

Subprocesses use shell=False, exact arrays, stdin closed, a private Docker home and
Unix host, a minimal env (no inherited DOCKER_*/COMPOSE_*/proxy/LD_PRELOAD), and a
new process group. Combined stdout/stderr is capped at64KiB; overflow discards output
and fails closed. Engine reads/logs max10s, lifecycle command max60s, health polling
max30s including subprocess time. HTTP response128KiB/request16KiB, total HTTP
header/body deadline2s; no application-level retry. Public exceptions are generic.

Create uses `compose create`, not up: it must leave an existing stopped container.
Start uses `up --no-build --no-recreate --pull never`; stop preserves volumes;
restart is a **single Compose restart** (also valid for a stopped existing container).
The manager requires the registered container's health=healthy, not merely exit0 or
running. Process identity is SHA256(container ID + exact StartedAt)[:32], so the
same container ID after restart still requires a changed process start. Both the
actual pre-restart identity and the server's previous identity are fenced.

A lease guard renews **while subprocesses and readiness checks run**, not afterwards.
Renewal/command/ready uncertainty kills only the manager's own subprocess group,
posts no invented observation, stops renewing and leaves the server to interrupt
and block the job on expiry. Killing a Docker CLI cannot cancel an already submitted
daemon operation: **do not automatically retry or recover it**.

## Explicit recovery: new fenced STOP, never replay an uncertain restart

After job expiry, inspect first. Wait for/terminate old executors appropriately and
independently ensure **all previously submitted daemon work is quiescent**. The CLI
cannot cryptographically prove daemon quiescence; the operator must attest it. Do
not use the flag as a blind retry button. A running but quiescent container can be
safely stopped by the **new leased** recovery job; no unleased stop is performed.

```sh
# default dry-run; no recover POST or DB modification
python3 -m flybot_workspace.manager --config "$CONFIG" --execute recover --instance-id "$INSTANCE_ID"
# explicit scoped/revision-fenced operator attestation; use one stable key on retry
python3 -m flybot_workspace.manager --config "$CONFIG" --execute recover \
  --instance-id "$INSTANCE_ID" --apply --confirm-no-active-executors \
  --expected-revision "$BLOCKED_REVISION" --operation-id operator-recovery-0001
python3 -m flybot_workspace.manager --config "$CONFIG" --execute run-once --instance-id "$INSTANCE_ID"
```

The new authenticated route is POST `/v1/internal/instances/{id}/recover`, fields
`expected_revision` positive int, `operation_id`16..64 safe chars, and exact
`confirmation:"quiesced-executors"`. Same loopback bearer, no browser/Origin/Cookie,
exact instance and `compose` mode grants. Only blocked/interrupted or runtime-failed
instances with no queued/running job may recover. Atomic CAS increments revision,
clears the latch into **unknown, not successful**, sets desired=stopped and queues
operation_type=recover. A normal claim/lease/heartbeat/STOP/inspect/observe must
confirm it; start/restart cannot supersede pending recovery. An old lease stays
invalid. Same operation key replays its job without a new revision; inspect current
intent if a historical key is replayed. No direct DB edits, auto-requeue, automatic
resume, data deletion or purge. Owner may explicitly start only after STOP converges.

## Logs and concrete remaining tasks

- **Implemented:** local authenticated/grant-checked operator `logs`, tail1..100,
  bounded capture, known secret/quoted-key/bearer/private-key/long-token redaction
  before output. No raw command error/body logging. Regex redaction is not a full
  DLP guarantee; operator runtime text can still contain unknown sensitive material.
  Do not share it automatically or treat it as safe browser output.
- **Not implemented:** tenant/browser runtime log API. Existing owner `/logs`
  remains structured control-plane events with runtime_logs_supported=false.
  Next task: bounded authenticated manager-to-server log spool, scoped owner read,
  privacy/schema filtering, retention/rotation/drop indicators, then cross-owner
  and secret-leak tests plus real container verification. No invented raw log route.
- Use isolated canaries to verify production-specific supervisor, public gateway,
  model and Bot Social configuration after changes. Keep backup, restore, digest
  rollout and volume purging as explicit operator procedures.
- Follow the [acceptance record](ACCEPTANCE.md) for browser and release evidence
  and the [licensing notes](LICENSING.md) for image redistribution.

## Repeatable acceptance

```sh
# Safe temporary SQLite + local HTTP + actual subprocess STUB only:
scripts/accept-compose-manager-stub.sh
# Full original + new suite (Node planner requires trusted Node per runtime docs):
FLYBOT_WORKSPACE_PLANNER_NODE="$(command -v node)" python3 -m unittest discover -s tests -v
node --test manager/compose-planner/compose-command-planner.test.js
```

On a **separately approved isolated real fixture**, after owner create/start/stop/
restart intents, `scripts/accept-compose-manager-stage.py --config "$CONFIG"
--instance-id "$INSTANCE_ID" --expected stopped|running|restart
--confirm-isolated-fixture` drains and verifies that stage. Restart additionally
requires `--previous-process-ref <previous inspect ref>`. It never pulls/builds or
cleans up volumes. It does not prove application-level behavior or persisted file
contents: retain separate private real `/data` sentinel evidence and perform manual
cleanup only after operator approval. Record the real-stage results for the environment where the script runs.

Official command references verified during implementation:
[create](https://docs.docker.com/reference/cli/docker/compose/create/),
[up](https://docs.docker.com/reference/cli/docker/compose/up/),
[ps](https://docs.docker.com/reference/cli/docker/compose/ps/),
[restart](https://docs.docker.com/reference/cli/docker/compose/restart/).

### Exact volume preflight (F-PR19-01)

The manager now runs `docker volume inspect ot-<instance_id>` directly. It does
not use `volume ls` name filters or infer absence from a successful empty list.
An existing volume must have exactly the expected name, local driver/scope, no
driver options, and the expected Compose project/data labels.

Only exit status 1, JSON stdout `[]`, and a single exact, target-bound English
missing-volume diagnostic are classified as absence. Supported diagnostic forms
are `Error response from daemon: get <name>: no such volume` and
`Error: No such volume: <name>`. Other errors, extra diagnostics, wrong names,
unexpected exit status, invalid metadata, or warnings fail closed. The child
locale remains `C.UTF-8`. An unrecognized Docker/CLI variant needs operator
investigation; it is not silently treated as an absent volume. Child output is
bounded and retained only for internal classification; public exceptions remain
codes, never raw engine diagnostics.

The subprocess stub exercises literal-substring filters, exact inspect errors
and unexpected driver or ownership metadata. The runtime image workflow checks
volume retention with a real Docker engine.
