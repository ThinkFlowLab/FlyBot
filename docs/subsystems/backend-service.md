---
subsystem: backend-service
owned_paths:
  - scripts/backend.mjs
  - scripts/backend-lib.mjs
  - scripts/backend-resolve.mjs
  - .github/scripts/backend.test.mjs
  - .github/scripts/backend-docs.test.mjs
  - .github/scripts/backend-runtime.test.mjs
  - docs/backend-operations.md
  - docs/development-service-api.md
  - docs/development-service-guide.md
  - README.md
  - README.zh.md
  - README.native.md
  - README.native.zh.md
---

# Persistent source backend entry (#2189)

The entry composes the existing DSH host/profile, all five FlyBot packages and the
original restricted HTTP/SSE gateway. It adds neither a domain service nor a Task
writer, permission policy, scheduler or executor. The upstream cookie stays in the
private process/home; ordinary member/FBA calls enter the same scoped domain API.
Original UI assets are reused without client/control-plane edits.

init installs lockfile dependencies and pinned pnpm10.34.6, links source packages
using original docker/profile.mjs logic and installs the pinned DSH bundles.
Source peer resolution uses that production profile rather than a mock Harness.
start owns only its DSH child and existing gateway, forwarding normal termination.
It uses an existing home lock; init refuses an active launcher. Public readiness
requires successful DSH authentication and actual writable Store load. Unknown
storage formats cannot become an empty healthy shared service. The45s startup
bound is a process startup deadline, not a new Chief inspection timer.

The caller chooses a private persistent home. Configuration, transport and CLI
member files use original durable file replacement with0600 permissions; raw
startup logs remain private. The CLI never prints login secrets, passwords or
upstream Owner cookies. Normal requests use the public gateway; only local Owner
bootstrap/login accesses the private operator entry. Platform identity still
requires the existing origin/Owner subject and per-request proof, without local
fallback. Restart preserves native member credentials; platform proof requires
fresh login as before. Supplied publicOrigin supports the original fixed-origin
proxy contract and local CLI Host/Origin checks.

Backend config requires shared Project mode and pool default. Existing advanced
config paths, resource grants, profiles, repository policies and migration tools
retain their own validation. Model/SDK configuration is not evidence of readiness
or successful code execution. No model or sample repository starts inside this
launcher. Role approval, Task/Handoff, confirmed exit and source/receipt semantics
are described from current code, including explicit legacy log/feature limits.

## Verification

backend.test covers actual profile composition/pin/private modes and HTTP client
behavior. backend-docs.test checks all24queries/26commands against actual source,
JSON, shell syntax and local links. dsh-pin retains its original npx pin assertions
on relocated original README guides; generated production profiles separately
prove the pinned DSH versions.

backend-runtime.test starts this actual production entry in an isolated home with
an explicitly deterministic inference server. It tests authenticated CLI bootstrap,
Project/Task persistence, completed private consultation without creating a Task,
safe FBA proposal and human approval, watch/current-token revoke, original-role
metadata, SSE membership revocation, restart and exact command replay. It refuses
init during active service and unsupported storage startup without changing the
guard. Its offline dependency fixture is separate from the manual fresh-home
init/install/start/restart acceptance. Neither is a real-provider developer loop,
production rollout, remote HTTPS deployment or browser/desktop acceptance.

#2292 adds typed Release operations to the existing service; the complete documented contract and source-matched guard now enumerate25 queries/28 commands. Source deployment and command-line entry stay unchanged.
