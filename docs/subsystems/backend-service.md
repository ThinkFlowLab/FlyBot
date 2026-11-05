---
subsystem: backend-service
owned_paths:
  - scripts/backend.mjs
  - scripts/backend-lib.mjs
  - scripts/backend-resolve.mjs
  - scripts/openapi.mjs
  - scripts/api-contracts.mjs
  - scripts/api-contract-validation.mjs
  - scripts/api-examples.mjs
  - .github/scripts/openapi.test.mjs
  - .github/scripts/backend.test.mjs
  - .github/scripts/backend-docs.test.mjs
  - .github/scripts/backend-runtime.test.mjs
  - docs/backend-operations.md
  - docs/development-service-api.md
  - docs/development-service-guide.md
  - docs/third-party-bot-integration.md
  - docs/openapi/flybot.openapi.json
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
behavior. backend-docs.test checks all29queries/34commands against actual source,
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

## Public machine contract (#2300)

#2308 extends that contract to28queries/33commands and184dispatch variants, with
signed receiver-side Webhook schemas. The production-entry test now drives real
native DSH Sessions and a separate authenticated external receiver from Chief
question through common claim/result, original Task input and actual Chief
read/handled admission after restart. The inference driver remains deterministic.
See [inbox usage](../agent-inbox.md) and [architecture](agent-inbox.md).

The OpenAPI3.1 JSON describes the actual health, multiplexed POST and scoped SSE
paths, not invented REST resources. Its discriminated request schemas cover all104
gateway endpoints, all25queries/28commands and native personal/workflow variants
(176dispatches). x-flybot-operations correlates each request with exact result and
success schemas, human/FBA safe/watch predicates, server prerequisites, conditional
state effects and domain/receipt recovery. Legacy server coercions are separate
from the strict canonical client format; responses allow forward-compatible fields.
Opaque upstream/source JSON is explicitly data, never authority.

The catalog is reviewed against existing implementations. Generation refuses
missing/extra public operations and records implementation hashes; --check detects
artifact/source drift. It does not infer semantic correctness from names or hashes.
Independent OpenAPI3.1/JSONSchema2020-12 validation supplements dependency-free
vocabulary/negative-schema tests. The production-entry test now validates actual
representative success/denial JSON and SSE snapshot frames against the contract.
Deterministic inference remains labelled; this is not vendor adapter certification
or coverage of every provider/resource/PTY/external-write branch.

Human bootstrap/account management, FBA provisioning, watch authority, native
personal/group privacy and trusted role execution remain separate. No new public
credential endpoint, role-result ingress, runtime middleware, timer or deployment
is introduced. An external descriptor remains unverified metadata, not a callback
transport. Source API changes require deliberate catalog and guide review.

## GitHub App credential adaptation — #2311

#2311 extends the source-matched specification to29queries/34commands/186dispatches, including human-only selection and sanitized App identity/audit metadata. Deployment remains unchanged; see [GitHub setup](../github-automation.md).

## Workspace baseline and explicit inputs — #2325

#2325 extends the existing attempt.integration-state query with approved-source choices/materialization and attempt.integration-bind inputs with optional purpose=inspect|integrate. Counts remain29queries/34commands. Defaults retain required integration; inspect never proves a merge, test or acceptance. See [workspace contract](project-resource-workspaces.md).


#2327 documents correctionBudget and typed Chief correction/run history in OpenAPI. The actual production-entry HTTP/runtime regression injects malformed admission in two flows, verifies feedback-driven correction and retains restart/auth/private-consultation coverage. Its model is deterministic; it is not a paid SDK acceptance run.


#2328 documents CapacityState/CapacityWait and durable resume QueueEntry metadata in the existing OpenAPI. project-resources exposes the same capacity predicates used for admission; continuation cancellation remains a Chief/Task operation.


#2330 adds typed inspection lifecycle configuration and health to OpenAPI and exercises the actual production launcher: queued original occurrence, deliberately hung native inference, configured deadline, actual cancel/idleness proof, physical backend restart, then same-Run recovery/completion. Only the reminder is seeded in the stopped disposable SQLite home; execution/exit/restart are real and inference is deterministic. No live project or paid SDK acceptance is claimed.


Chief invocation history accepts the combined configured maximum: one initial invocation, up to four protocol corrections and up to four inspection recoveries (nine records). Public schema validation covers that legal configuration; correction feedback itself retains its separate five-entry bound.


#2336 types resource lease ownership/reclamation metadata in OpenAPI. The existing project-resources surface reports the actual reservation lifecycle; no general-purpose release/force-clear endpoint is introduced.


#2365 keeps the existing public transport and regenerates OpenAPI for role App
status/identity metadata and candidate-phase publication recovery. No public
credential issuance API or deployment change; see [role contract](../role-github-apps.md).


## Resource SDK authentication — #2398

#2398 extends original HealthCheck/Terminal/ExecutionMetadata schemas with profile
binding and sanitized SDK auth facts. Existing permissions and routes remain; only the
explicit terminal administrator receives target paths. OpenAPI is regenerated.

## Proven-exit retirement (#2375)

The v1 `attempt.reconcile-exit` command exposes existing pool/Effects retirement
under configure authority. It requires an exact current claim/generation and
verified physical exit; it does not cancel an Attempt or confer integration/PR
acceptance. OpenAPI and operations describe re-reading the workspace snapshot
before binding a source. Chief recovery facts retain specific blocker references.

## Explicit successor continuation (#2377)

The API inventory describes attempt.continuation-state and the optional task.run continuation object, preserving configure authority, current snapshots, explicit baseline choice and cancelled-predecessor semantics.

## Reviewer evidence API (#2378)

The GitHub read contract adds page/includeStatuses and independent completeness/source-hash metadata. Actions/log access remains under explicit role Apps/resource policy; no new login service, generic URL proxy or Review store is introduced.

## Chief feedback contract (#2393)

OpenAPI describes Chief lastResult/failureDetail, per-Task correction feedback and safe TaskView.chiefIssue. No new transport endpoint or automatic routing rule is introduced; fresh snapshots retain original receipt authorization and content gates.

## Merge-to-Chief delivery metadata — #2413

Existing Task/Attempt queries expose the OpenAPI `MergeHandoff` projection: durable notification Effect/status, linked Chief Run/outcome, waiting reference and request times. Notification delivery is distinct from provider-confirmed merge and Chief Task acceptance. The existing authorized `effect.retry` command retries notification only; no new endpoint or permission is introduced. Candidate-bound snapshots prevent an old merge request from migrating to replacement work.

#2483 adds the source-matched public GET /ready contract:200 ready/writable,503 degraded or unavailable. GET /health remains liveness only. The private state-storage verify CLI returns safe JSON diagnostics; it grants no remote repair authority.

#2483 OpenAPI defines DispatchState and ChiefInputReceiptSummary, including runtime-derived commit proof and bounded declarations on chief.state results/history. No new domain endpoint or execution permission is added.
