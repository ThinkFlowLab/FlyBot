---
subsystem: project-runtime-setup
owned_paths:
  - core/src/host/project-runtime-setup.js
  - core/src/host/project-terminal-worker.py
  - core/src/host/project-profile-auth.mjs
  - core/test/project-runtime-setup.test.js
---

# Owner runtime setup and private resource terminals (M7.4)

Owner/Maintainer role configuration edits persona, Skills, explicit published memory refs,
Harness, SDK model, multiple resource checkboxes and role concurrency. Saving snapshots
future executions, then checks each candidate once. The UI states that a small provider
probe may incur a charge. Running Sessions retain their configuration. Resource status
separates environment observation from each Project/resource/Harness auth observation,
with timestamp, actual SDK version and a bounded reason; install/login status is not
reported as successful task execution.

## Resource/profile provisioning

Keep control-plane accounts, instance metadata and operations unchanged. The deployment
operator grants the Project owner use of a resource. `adminMemberIds` separately names
humans allowed to open a configuration shell; being a Project Owner grants no host shell.
Add `profileRoot` for automatic isolated profiles, e.g. /srv/flybot-private-profiles inside
the registered resource root. Generated profiles hash Project plus principal and separate
Harnesses. Explicit profiles from M7.3 remain operator capabilities and can deliberately
share credentials only within their resource grants. Never put credential values in YAML.

Native DSH terminal setup requires an explicit `profiles[ownerId].flybot` with actual HOME
and DSH_HOME/configDir. It does not pretend a fresh SDK profile configures the running DSH.
SDK profiles use CODEX_HOME or CLAUDE_CONFIG_DIR. The configured local Node path defaults
to the running FlyBot Node; terminals and SDK subprocesses receive that PATH, not an older
system Node. Docker uses its configured runtime/UID. Python3, bash and Node 22+ must exist
on the target; runtimeDir identifies the FlyBot installation there.

A setup helper in the selected PTY can save an API key using OS echo disabled *before*
printing its prompt. It stores only flybot-credentials.json in that private profile,
0700 directory/0600 file, rejects symlink targets and never prints the value. Keys are
read only into the selected Harness environment, including from Docker profiles. They
never enter state.json, Tasks, public chat, URLs, process arguments or ordinary logs.
Codex may instead use its supported login/device flow inside the same CODEX_HOME. Claude
Agent SDK uses API/cloud credentials; no unsupported Claude.ai subscription login promise.
Operator envRefs remain supported separately. Native provider setup uses its own CLI.

## Bounded probes

`project-runtime-check` requires live Project configure authority and an operator use
grant. States: unconfigured, checking, ready, authRequired, environmentError, unreachable.
A fixed environment probe precedes auth. Native uses the existing bounded streaming
provider interface with 8 output tokens, 8-second timeout and two calls/minute. SDK checks
use a separate private no-tools worker, explicit model/profile, one turn, 10-second wait
and bounded stop. Claude budget is 0.01 USD; this is not a universal Codex billing cap.
Checks deduplicate concurrently and rate-limit immediate repeats. No background unlimited
retry. Successful SDK inference *and* controlled worker shutdown/exit are required for
ready. A runtime, quota or missing model error is not mislabeled successful login.
Probe leases count capacity and remain occupied if stop/exit cannot be confirmed.

## PTY protocol and authorization

The first version uses authenticated POST polling/input/resize/close on /api/bot. There
is no WebSocket terminal route: the gateway rejects **every** Upgrade with 403, and its
existing Origin/Host/cross-site checks cover all terminal HTTP requests. Credentials are
not query parameters and no outer DSH cookie reaches the browser.

Terminal open derives target, profile, principal, UID and cwd from the granted resource;
request fields cannot substitute shell commands/paths/credentials. The server binds a
random terminal id to that human's exact authenticated Session and fixed Project/resource/
Harness. Each operation checks live session, current Project configure and resource-admin
grant. Expiration is ten minutes; missing browser heartbeat closes within the sweep bound
(15-second heartbeat, 5-second sweep). Logout/member removal immediately closes matching
configuration terminals; periodic upstream validation also catches external revocation.
Unrelated admitted task workers are not cancelled by terminal cleanup.

The resource-side Python PTY executes a clean bash environment under the same configured
runtime UID/profile. Output buffers live only in server memory and the current authorized
browser, bounded at 64 KiB. Raw keyboard/screen streams are not persisted. Audit stores
human, target, Harness/principal, timestamps, close reason and release confirmation.
The browser clears terminal state on navigation/logout/disposal and never uses form-draft
storage for terminal input. It presents a simple line-input terminal, not a full xterm
screen emulator. Ctrl-C and terminal size are protocol operations.

Closing requests resource-side cleanup, including interactive jobs in the PTY Session,
and waits for positive release. Unknown shutdown remains explicit. Controlled SDK worker
shutdown similarly waits for settled SDK work plus a stopped frame before lease release;
merely seeing an EOF is insufficient. Closing setup automatically rechecks current config.

## Verification

Focused tests use actual Python/bash PTYs: explicit admin/session isolation, real TTY
output, resize, revoked access, nonpersistent audit, hidden key input, profile/file modes,
actual credential selection and background job cleanup. Linux /proc may return either
ENOENT or ESRCH when a process disappears during inspection; both prove it is gone,
while unrelated read errors still fail the cleanup assertion. UI tests cover persona preservation,
multiple checked resources, SDK model and per-resource probes. Gateway tests refuse wrong
origins and WebSocket upgrades. These tests include a reproduced hidden-input echo race
and old-system-Node regression; no live secret was used.

Opt-in Docker check: `node --import ./core/test/harness-resolve.mjs dev/demo/runtime-setup.mjs`.
It starts a new owned UID1000 container, binds test data/runtime, verifies the PTY executes
there in the selected profile and confirms cleanup, then removes all owned artifacts.
This is real target PTY/API transport, not browser UI or authenticated inference acceptance.
Those remaining positive SDK paths require explicit dedicated credentials and M7.5.


### M7.5 — 2026-10-31

M7.5 two real platform accounts/Chromium/actual DSH now exercise the Owner terminal and Harness/resource forms through the actual HTTP channel. Unconfigured SDKs stay unavailable after bounded checks. This validates browser/PTY/privacy/cleanup, not authenticated ready or real SDK task completion; those remain explicit Not run.
Connection probes use the same installed-version handshake as task workers and report
observed and expected SDK versions separately. A missing bridge cannot consume probe
capacity or become authenticated-ready. A PTY bridge that exits is shown as a closed
configuration terminal; input on a broken process pipe cannot crash the host.

Repair R5 (#38): runtime checks and the owning human's configuration terminal accept
validated persistent watch actors through the same current Project/resource policy.
They do not require a browser cookie when a current user grant exists. Revocation
still denies or closes the terminal; other users' resources remain unavailable.
See [delegation contract](project-delegations.md).


## Resource SDK authentication — #2398

#2398 returns the actual profile HOME/configDir only to the explicit terminal admin;
public health exposes safe profile IDs. Setup resolves the selected resource SDK CLI,
not the host/global CLI. Login/check/worker use the same selector; changed profiles
invalidate terminal input and ready caches. Close triggers a fresh original probe.
SDK auth codes reach authRequired without raw provider text or new business routing.
No auth.json copying, credential migration, automatic login or live repair is implied.
