---
subsystem: project-resources
owned_paths:
  - core/src/host/project-resources.js
  - core/test/project-resources.test.js
---

# Execution resources and leases (fork M7.2)

S5 validates the compatible trusted-private execution profile at resource access,
without changing grants, leases, explicit UIDs or SDK capabilities. A supported
profile is not hostile-code isolation. Safe metadata is exposed through the
[boundary query](project-execution-boundary.md); unknown profiles refuse admission.

Resources are operator-provisioned runtime capabilities, independent of model credentials.
`projectResources` maps stable IDs to local or Docker execution environments. Owner UI
may reference these IDs; request bodies cannot supply a path, Docker target or runtime UID.

```yaml
projectResources:
  development:
    type: local
    root: /srv/flybot-execution
    capacity: 3
    allowedProjectOwnerIds: [owner-1]
    harnesses: [flybot, codex, claude-agent]
  isolated:
    type: docker
    container: operator-provisioned-development
    user: '1000:1000'
    root: /workspace
    capacity: 3
    allowedProjectOwnerIds: [owner-1]
    projectIds: [project-id] # optional additional restriction
    harnesses: [codex, claude-agent]
```

Create these environments through existing operations tooling. FlyBot neither provisions
cloud capacity nor changes control-plane deployment. Optional `platformInstanceId` is an
association only: the platform's metadata/lifecycle API is not a remote execution transport.
No production instance is a test target. Native DSH currently requires a local resource
containing the registered workspace root; SDK and cross-resource file execution follow
M7.3/M7.5. Two resource IDs pointing at one local path are not isolation evidence.

## Authorization and observation

The Project's provisioned owner must appear in allowedProjectOwnerIds, and optional
projectIds must match. Current Project configure permission is required to configure role
resource IDs or run `project-resource-environment-check`. It executes only a fixed bounded
Node version/UID probe. Members see safe metadata via project-resources: no connection
strings, filesystem roots, profile secrets or process handles. Environment probe success
is explicitly **not** SDK authentication. Unprobed/unreachable resources are not eligible;
non-native candidates additionally require a ready per-Project/resource/Harness auth probe.
M7.4 implements that probe and Owner UI. CPU/memory values remain unavailable rather
than inferred from configured slot counts. Host process metrics retain their own scope.

## Admission and lifecycle

Role execution configuration has candidate `resourceIds`, Harness and optional positive
`maxConcurrent`. Choose the least occupied compatible ready environment and retain the
single-resource binding for the Session. There is no broadcast or in-flight migration.
A batch plan accounts for every temporary role before creating Workspaces. Lease
reservations serialize globally across Projects and persist before worker effects.

`projectResourceLeases` records Project/Attempt/role/Session key, resource, Harness,
principal, runtime UID and generation. Session-key replay returns the same lease;
conflicting ownership, released-key reuse and stale generations fail. Native binds to the
existing Bot; SDK workers will bind their explicit process handle. SDK/unknown/stopping
leases count toward Project admission alongside canonical Runs, preparing Attempts and
orphan native Workers, deduplicated by Attempt. Resource/role capacity exhaustion uses
the existing durable projectQueue with a visible reason; releasing capacity wakes it.

Release is idempotent. Native release requires the Bot to be absent, and external worker
release requires the matching handle's positive exit confirmation. Stop failure retains
capacity. Restart marks leases unreachable; it never repeats execution automatically.
Reconciliation can release an absent native worker; unknown external processes retain
capacity pending adapter confirmation. Resource use revocation blocks new admission;
subsequent resource commands also recheck the grant and may stop an admitted execution.
Existing leases/evidence remain until release is confirmed. No implicit eviction.

## Runtime boundary and evidence

Host-only `command` accepts argv, registered cwd and bounded timeout, never a shell string.
Local execution validates real cwd against real root, including symlinks. Docker commands
use explicit container/UID/cwd and a clean environment. It does not claim a hostile-code
sandbox or grant any browser caller a general shell API. SDK streaming and authorized
Web PTY are separate later surfaces with their own permissions.

`core/test/project-resources.test.js` covers serialized reservation, idempotence, capacity,
failed release, unknown-process restart, grants, missing readiness/auth and generation
fencing. Scheduler coverage proves resource-blocked tasks enter/drain the existing queue
and unknown SDK leases keep slots occupied. Run `node dev/demo/resources.mjs` explicitly
on a Docker-capable operator test host: it creates only a new owned container, executes
Node/file commands under UID 1000 and local Node in different filesystems/hostnames,
verifies distribution/full capacity/release, then removes all owned data/container.
It does not claim mixed-resource FlyBot Task/SDK acceptance; that belongs to M7.5.


### M7.3 checkpoint — 2026-10-31

M7.3 adds startProcess for host-selected Node workers in explicit local/Docker targets. Current SDK dispatch refuses remote Workspaces until M7.5 implements transfer; runtime environment and authentication observations remain distinct.


### M7.4 — 2026-10-31

M7.4 separates adminMemberIds from Project-owner use grants; safe list canManage is derived per current human. Probe-only leases may check authentication without assuming it first; capacity still applies. Profile roots/runtime paths remain operator settings, never browser-selected paths.


### M7.5 — 2026-10-31

M7.5 captures resource physical binding hashes per lease and adds host-only bounded upload/download through local/Docker transports. Candidate bundle hash/commit/scope checks happen before import; credentials and raw chats are never file-transfer inputs. Native workers remain local, SDK workers may execute on prepared Docker targets.

Version probes, command adapters, worker startup and private setup profiles now select the
same explicit nodePath (or the running host Node for local resources). Runtime paths are
absolute operator settings; tests cover executable paths containing spaces without a shell.
Native Harness compatibility also requires a local transport, even if an operator mistakenly
advertises native capability on Docker. Local and remote Git gates both validate their
captured resource binding before acting; a physical target change cannot retarget evidence.
An SDK role without any selected authorized resource pool remains queued before allocation;
it cannot consume an Attempt/workspace merely because the default Project quota is free.

Repair R6 captures verified local supervisor scope before external execution.
Only confirmed exit or a proven prior systemd control-group invocation exit
releases capacity; missing PID and unknown supervisor evidence do not. Actual
Chief jobs count against resource capacity while avoiding delivery quota deadlock.

Live dogfood regression: supervisor inspection yields to release callbacks.
Reconciliation rechecks terminal status afterward and cannot resurrect a confirmed
released lease. Current owned controllers avoid unnecessary supervisor I/O.

Confirmed releases record their evidence kind. SDK releases carry bound worker
and generation proof from stop acknowledgement plus process exit; unknown releases
still retain capacity. Historical matching SDK released records remain host facts.


Native resource release now requires a matching projectNativeWorkers native-agent-quiescent record, generation/Session/lease scope and absent old Bot. Missing Bot records or undefined handles with exited=true cannot free capacity. The existing native-turn delegation path still requires its actual nonempty matching handle. Actual stopping uses the original SessionController-resolved Agent and awaits whenIdle; unknown prior-host execution remains held for explicit reconciliation.


#2184 separates physical release from context recovery. Native normal release needs v2 registered-work quiescence; supervisor release additionally verifies the exact process-group/invocation through the existing manager proof service. A legacy missing carrier can free capacity after actual manager verification without manufacturing native context. Reconciliation preserves a nested confirmed release and uses native host-epoch ownership rather than PID equality to recognize current controllers. No missing PID or timeout is a release proof.


Removing a current role resource grant or changing its registered Resource binding revokes ongoing canonical execution at the existing scheduler check. The same SDK/native stop and physical-exit proof govern release; current permissions never justify a silent new Session or an assumed exit.


## Reservation ownership and startup rollback — #2336

Pool reservations retain Task/claim/generation/Session ownership. The existing
reconciler reclaims retired/superseded or invalid-claim reservations only after
checking no worker, process scope, bound Session or ephemeral Bot exists. Startup
registration and reclamation serialize with binding; late binding/spawn refuses a
released or stale owner. Active preparation and unknown external execution remain
occupied regardless of age or an empty controller list.

SDK registration uses a durable starting fence before external spawn. A registered
worker that never crossed that fence may receive exact sdk-worker-not-started proof;
starting/spawned workers require the original physical exit protocol. Reclamation
uses committed Effects, preserves original owner/reason and rolls back uncommitted
state on save failure. The dispatcher is woken only after release. No workspace,
draft, candidate, logical Session or prior binding is deleted, and no new timer exists.


Preparation itself has a fenced active/settled lifetime. In-flight commands keep
capacity after claim retirement until their actual callback settles. A restarted
active preparation remains unknown; only the existing exact local supervisor proof
can reconcile it automatically (remote preparation is not inferred exited). Initial
reservation/batch save failures cannot leak a startup capability before return.
