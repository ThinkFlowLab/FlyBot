---
subsystem: project-workbench
owned_paths:
  - core/src/host/project-scheduler.js
  - core/src/host/project-repository-policy.js
  - core/src/host/workbench-gateway.js
  - core/src/host/workbench-state.js
  - core/src/client/workbench
  - core/workbench.js
  - core/workbench.css
  - core/scripts/build-workbench.mjs
  - core/test/workbench-client.test.js
  - core/test/workbench-gateway.test.js
  - core/test/project-scheduler.test.js
  - core/test/project-repository-policy.test.js
---

# Project workbench (fork M5)

S5's metadata-only repository preflight first validates the configured execution
trust profile and includes it in readiness cache identity. The compatibility default
preserves trusted single-host execution; unsupported profiles refuse before new
Attempt/workspace allocation. This does not run tests, infer or change the UI.
See [boundary contract](project-execution-boundary.md).

## Backend dispatch recovery (R6)

Scheduler wakes coalesce the complete resource reconciliation, admission, pool,
scheduled-task and Chief pass. Only one pass executes at a time; events during
a pass request one fresh follow-up. Failure clears the lock and preserves unknown
resource occupancy. Persisted handoff/Chief requests and confirmed releases wake
the dispatcher directly; the existing one-second admission timer is a fallback,
separate from the configurable Chief inspection schedule.

`project-queue-retry {queueId}` is an explicit current Owner/Maintainer operation
for blocked queue entries after provisioning repair. It rechecks the original
requester's current authority/background grant and repository preflight, refuses
ended Tasks or active Attempts, and retains the queue/request ID and initiator.
Recovery records the manager and old reason, requeues through normal admission
and wakes execution; it does not fabricate a worker, reset evidence, replace the
requester with the manager or start a second Task. Failed preflight leaves the
entry blocked. Optional operator workspace preparation is validated as argv;
readiness never runs it. See [delivery](project-delivery.md).


The shared entry is a separate browser application, built with esbuild into committed
`core/workbench.js` and `.css`. The legacy operator UI remains available at the private
Harness entry. Members receive only the restricted gateway URL. Never share the Harness
owner login URL/cookie: doing so would expose raw Session APIs outside Project policy.

## Entry and identity

`workbench-gateway.js` listens on loopback, proxies only an explicit `/api/bot` endpoint
allowlist to one fixed loopback runtime, and holds its owner cookie server-side. There
is no arbitrary URL proxy. Host, Origin and fetch-site checks, request limits, CSP,
no-store and cookie/redirect stripping protect this boundary. Deploying it externally
requires an operator-configured reverse proxy and fixed `--public-origin`; it does not
provision TLS or alter control-plane. The gateway is a trusted server component, not a
substitute for the runtime's membership checks. Only the member session header crosses
from browser to FlyBot; owner credentials never appear in HTML, JS or local storage.

The app calls `auth-mode`, then the existing platform-login BFF or redeems a local member
invitation for isolated tests. Member credentials live in origin-scoped sessionStorage.
Platform account management links to the existing control-plane. There is no duplicate
account database or new control-plane source. Local initial invitations are operator
issued; the shared entry cannot mint unauthenticated owner sessions.

## UI and data

Project switching, deep-linked Tasks, Task board/create/run/retry, Attempt evidence,
verified test logs, PR links, commit-specific human acceptance/return, stop/cleanup,
member invitations/roles/removal, public Chief/role configuration and private Project
agent conversation/notes/proposals use actual backend endpoints. No simulated delivery
or PR actions. Permissions hide controls for convenience; the server remains authoritative.

Every refresh captures an epoch and Project id and aborts prior requests. Late responses
cannot replace another Project's content; membership failures clear the displayed scope.
A deep-linked Task must belong to the selected Project even if the human can read both.
Untrusted content is rendered using textContent; no HTML interpolation. Form drafts are
Project/view scoped; polling preserves active input focus/cursor. Logout clears drafts
and selected data. The responsive layout collapses below 900px. There are no remote assets.

## Admission and lifecycle

`project-scheduler.js` adds a durable *admission queue* around the existing delivery
service, not a second Workflow executor or Task store. At quota, a request stores
Project/Task/request hash/requester before allocating any Attempt or worktree. Duplicate
requests reuse the same queue/Attempt. A serial drain checks current membership, Task
state and Project status before starting the existing versioned delivery Workflow.
Removal cancels waiting work; admitted running work continues under Project authority.
Archived Projects block pending entries; the requester or manager can cancel them.
Startup reconciles interrupted `starting` entries against existing Attempts.

Slots deduplicate canonical active Runs, preparing/running Attempts and orphan Workers
by Attempt id. Failed Worker release continues to consume capacity. Owner/Maintainer
stop uses the existing single-Run Workflow reset/release path. No slot is fabricated free
while Workers remain. Cleanup and terminal Run reports wake the queue. A one-second
unref timer operates only in workbench mode and only after Workflow handlers are ready.
Project deletion refuses live queue requests. Project Tasks are not implicitly pruned
from history by legacy task retention.

Operator repository config grants filesystem/tests/automation capabilities. Its
`allowedProjectOwnerIds` defaults to `["owner-1"]`; shared members can execute Tasks
inside that owner's Project, but cannot create another Project with the same repository
name to inherit the capability. Shared callers cannot provide arbitrary workDir values.
Scoped agent/worker Project identities cannot be rebound.

## Resources and evidence

Resource cards show real concurrency, queue, Worker and Workspace records. CPU/RSS are
measurements of the *shared host process*, never per-Project guarantees. No GPU or
unreported limits are invented. The unchanged platform `/api/instance` response belongs
to the current caller's account instance and is explicitly separate from the execution
host. Missing data is unavailable.

Metrics use a rolling seven-day window and actual human-accepted Attempts: unique Tasks,
sample count, mean and median Task-created→accepted durations (queue/execution/human wait
included). No samples yields null, not zero or a simulated throughput.

Tests cover delayed cross-Project responses, revocation, deep-link ownership, XSS, member
controls, scoped Task creation, gateway escape routes/cookie isolation, quota/recovery,
repository capability ownership and real DSH queue/drain/revocation. `npm run verify`
checks generated assets. M6 owns full two-account browser acceptance; deterministic model
transport is not real-model delivery or an independent repository review PASS.

### M6 acceptance and launcher

`dev/demo/control_plane.py --workbench-check` drives two real control-plane accounts,
Chromium contexts and the shared gateway against a fresh actual DSH. `--serve-workbench`
starts a disposable interactive demo with privately entered account passwords. An
explicit `--real-model` selects existing environment configuration; missing key/base URL
fails before startup and cannot silently fall back to a fixture. Explicit GitHub fork and
credential directory flags enable Project automation drafts. Only the gateway and existing
platform URLs are printed, never the Harness owner login or account passwords.

The UI identifies deterministic demo transport, provides explicit accessible form names
(including selects), and reads actual Workflow node status alongside Attempt evidence
and workspaces. Browser tests await route-specific content before interacting with a
similarly named form in the next view. See [shared demo acceptance](../shared-demo.md)
for reproducible commands, evidence matrix and pending live-model acceptance.

The Task view shows priority, source Issue/PR, context/criteria, age, current role/Worker
workspaces, Attempt elapsed time, real diff statistics and explicit failure/return reasons.
Board cards sort by the existing urgent/high/normal/low contract. Active or terminal Tasks
cannot start a duplicate delivery from the UI, and requester input waits use the existing
question-id-bound answer endpoint; approval waits retain their separate server gate.


### Fork M7.1 — 2026-10-31

M7.1 allows project-role-memory-write through the restricted gateway. This public-memory operation still requires live Project configure authorization. Resource/Harness settings UI and terminal access are tracked separately in M7.4.


### M7.2 — 2026-10-31

M7.2 project-resources includes executionResources and sanitized resourceLeases. Connection targets, roots and worker handles remain server-side. Resource/role capacity blocks the existing queue before Attempt/worktree creation; unknown external workers keep Project slots occupied.


### M7.3 checkpoint — 2026-10-31

M7.3 resources read model includes sanitized Harness worker status/pending questions. Event-log and cwd paths remain server-side. The gateway allowlists only scoped project-execution-input, not arbitrary SDK or filesystem commands.


### M7.4 — 2026-10-31

M7.4 Owner forms preserve existing persona/Skill/memory/defaults and offer multiple resource checkboxes. Each target shows independent Harness status and probes. Explicit resource admins can open a private line-input PTY; input is never a persisted form draft. HTTP uses existing Origin/Host guards and all WebSocket upgrades are refused.


### M7.5 — 2026-10-31

M7.5 real browser integration exercises Owner role Harness/resource edits and private PTY, refuses Member terminal access and preserves accurate unconfigured SDK status. Runtime/terminal/input channel wiring is corrected and directly tested. Attempt UI reads only scoped sealed execution logs. Full positive paid mixed-resource acceptance remains pending profiles.

## R1 repository capability preflight

Repository configuration requires a nonempty relative path allowlist and valid argv. New admission and queue drain check the actual Git root/HEAD, test executable, declared testDependencies and writable workspace/artifact parents before allocation. The workbench uses the same metadata preflight (briefly cached for polling); every admission bypasses that cache. A blocked repository reports a safe field/reason rather than a false configured flag or silent disabled button. Readiness explicitly says tests are not run; it does not execute operator commands or model probes. Fixing provisioning does not mutate previous failed Attempts; a blocked queue request can be retried with a fresh request id.

Operators may run `node scripts/check-project-provisioning.mjs CONFIG.json OWNER/REPO OWNER_ID` against an explicit JSON object containing the same `home`, `dshHome` and `config` used by their service. It checks metadata only and never prints configuration contents or credentials. Include `allowedPaths` in the actual repository capability; use concrete repository-relative files/directories, never a filesystem-wide wildcard. If the test wrapper prepares dependencies per worktree, declare prerequisite paths only when they must already exist in the operator repository.


Repair R3 (#36): Admission plans only the first receiving role in pool mode. The existing admission wake also asks each logical Bot pool for executable candidates; a busy resource leaves its destination Task queued. Per-Bot visibility is exposed through membership-guarded `project-task-pools`. See [pool contract](project-pools.md).


Repair R4 (#37): Private chat provides an explicit Ask Chief
without a Task action. Proposal cards distinguish unpublished from published and
state that publication does not start execution. Server-derived Task execution
status distinguishes published, queued, starting, running, awaiting input/Chief/
acceptance and blocked/failed. An active Attempt does not imply a running worker.
Private inquiry worker metadata and sealed log paths are omitted for other users.
See [conversation routing](project-agents.md).


Repair R5 (#38): The private agent panel shows safe/watch mode
and allows its human to change or revoke it. Safe mode still requires Task
publication approval. Watch mode uses current human rights with no extra
agent-only confirmation; grant/account/role revocation remains effective.
See [delegation contract](project-delegations.md).

Repair R6 exposes Chief configuration in the scoped workbench: editable schedule
prompt/cadence, enable/pause, thresholds, inspect-now and recent actual Runs.
The resource response includes minimal Chief state without an additional gateway
call. This does not replace issue #40 native rich multi-Bot UI restoration.

Actual shared-entry repair: the explicit HTTP allowlist now includes pool, query,
GitHub read, delegation mode and Chief/schedule endpoints. Project authorization
still executes downstream; raw schedule/state/DSH APIs remain refused.

## R7 native collaboration candidate (#40)

The standalone app now exposes scoped internal rooms, mention/member routing and
registered documents, native public-text streaming, explicit conversation stop and
readable Markdown/evidence cards. Pools and Timeline derive actual Task collaboration
and Chief records. Refresh and action-return fences both protect Project switches.
Original Harness UI primitives require its private module loader and cannot be imported
into this standalone entry; the safe DOM renderer loads no remote content. The complete
[source/API/UI inventory and verification limits](project-collaboration.md) is authoritative
for this restoration. No raw owner Session/group/plugin API is added to the gateway.

## R7 reference-layout rework

The standalone shell retains Project switching and adds active-page navigation plus
scoped room shortcuts. Public Chief and private companion use a transcript/composer
layout. Role/persona/Skills/memory and Chief inspection editors move to the explicit
`settings` route; server configure checks are unchanged. The public chat retains
read-only configured Harness/model summaries, while Task details retain actual frozen
execution evidence. Neither configuration nor an idle chat implies an active worker.

The board groups Tasks into expandable Open, In progress, Needs attention and Completed
sections. Counts and execution/next-step summaries use actual Task/resource records;
reference-demo PR/Issue numbers and sample metrics are never imported. Failed Tasks
remain actionable instead of being grouped as successful completion. Fold state is local
to Project and survives polling. No raw owner APIs or new credentials are introduced.

## Slow-network and public role inspection continuation

Same-route refreshes share one in-flight promise; route changes abort and fence old responses. The board requests summary Project/resource projections, while full audit, workers and leases remain on detail/resource endpoints and in storage. Members, Workflow and pools are fetched only by consuming screens. The Project shell renders before these reads complete. Gateway responses negotiate gzip above 1 KiB while retaining no-store, CSP and credential stripping; unversioned assets remain uncached to avoid stale deployments. Public role cards show only explicitly attached same-role/Project published memory, its revision/source and persona; private notes are never rendered there. Settings keep the existing configure gate.

The native personal-space entry is still missing. Personal Chief/Bot/group compatibility must preserve existing IDs, relationships, history and owner/grant guards through bounded adapters; Project rooms are not a replacement. This continuation does not claim that acceptance criterion complete.

### Native conversation component slice (#40)

Chief/private Project chats and Project rooms mount the original `cells.js::Bubbles` and
`mark.js::BotMark/PersonMark` through React, with original conversation styles.
The fixed `/workbench-native.js` and `.css` assets load only on conversation entry;
board loading does not import the native dependency graph. The gateway serves only
these named assets, never arbitrary paths. Each render disposes its previous React
root; delayed asset callbacks verify the transcript is still connected. Roster input
contains only the current API-visible agent identity. No raw Session API, global
roster, owner credential or synthetic Harness provider is supplied.

`native-source.js` is the live Project/room-bound observable source consumed by
all three conversation surfaces. Polls reuse that source and issue one authenticated
history read per refresh, not a duplicate component-side request. Route changes,
logout, failed authorization and disposal clear it and fence delayed asset mounts.
Room transcripts and each active role's public streaming text use original Bubbles;
room controls, attachments and runtime metadata remain scoped workbench controls.
This does not implement Harness sessions/uiConversation/slots adapters, personal
Chief/Bot/group entry, native composer or tool/approval cells. Human text retains
a plain-text fallback because pinned primitives lacks the capability required by
original UserMessageCell. No substitute Harness provider is invented.

The native standalone build pins React 18.2 and published primitives 0.2.1-rc.2
plus their browser dependency graph as development dependencies in the canonical
package/lock. Provisioned symlinks alone are not a reproducible CI dependency
contract. Both generated native assets are included in the package file allowlist.

The existing createSource primitive lives in observable-source.js and remains exported
by sources.js. The workbench imports that small module directly so initial board
loading does not pull in the original character roster/assets.

### Native personal continuation — 2026-11-01

The lazy conversation bundle now mounts the original `cells.js::AssistantCell`
(with its `Bubbles`/Markdown renderer and message toolbar) and `mark.js` identities.
Its observable comes from the same `createSource` implementation as the native
client, extracted into `observable-source.js` to avoid global roster side effects.
Only published text blocks enter this projection; private reasoning is not mapped
into native turn data. UserMessageCell retains its pinned-primitives version guard.

`personal-space` is the only new gateway capability. It lists original owned,
non-Project local Bots and visible internal groups, preserving IDs and relationships.
Read pages use the original `historyEntry` interpretation and exclude hidden
exchange turns. Group reads use `roomHistory` and its membership windows rather
than raw group Session pages. Own memory reads strip team entries. Native send
re-enters the existing channel authorization, reference checks and `send` behavior.
Paging and memory reads reauthenticate before returning; the client clears its
observable on route/logout/revocation and fences late responses. The endpoint does
not expose arbitrary Session, filesystem, owner APIs, credentials or connector calls.

This remains a bounded native-component integration, not installation of the entire
Harness browser shell. Full sessions/uiConversation/slots services, native composer,
sidebar/tree and tool/approval cells are not yet mounted in this entry. Existing
Project controls remain available; original personal group creation/settings and
live tool/approval interactions still need continuation. Browser screenshots and
actual deployed three-account acceptance are required separately and are not
inferred from JSDOM/component checks.

The native bundle uses ASCII escapes and whitespace minification. Imported parser
libraries intentionally contain replacement-character literals/comments; emitting
those bytes would trip the repository corruption scanner. Escaping preserves
runtime code points and minification removes those comments while reducing the
lazy asset size. The renderer regression executes the committed served bundle.

The native bundle disables template literals during generation so whitespace inside
CSS/string literals is escaped without changing runtime string values. ASCII
encoding remains required for dependency replacement-character literals.

Recovery continuation retains the pinned PR target alongside the published seed.
The personal list now also mounts `sidebar.js::TreeNode` and the existing
`botTree` cycle/orphan handling over the authorized roster's original parent IDs.
Collapse state stays inside that mounted list; no global tree registry or foreign
Bot lookup is used. The component test reproduces the missing tree on the recovered
draft and checks selection, collapse and expansion on the served bundle.

Personal conversation pages expose an explicit “Load earlier messages” control.
The scoped source prepends the authorized page, deduplicates by stable message ID,
and retains loaded history and its oldest cursor across latest-page polling.
Opening another Bot/part clears that cache; generation fencing and failed
authorization discard late pages. Project conversation refresh semantics are unchanged.

## Native CSS and logout isolation

The workbench native stylesheet includes canonical shell, conversation and sidebar rules as a same-origin asset. Conversation mounting inserts no inline stylesheet. Sign out bypasses the action busy lock, increments the scope epoch, aborts current reads, disposes conversation roots and clears local credentials/state before awaiting remote revocation. Late action results cannot restore the former view. Local component checks do not establish deployed browser acceptance or complete native composer integration.

The popup layering regression reads `sidebar-styles.js`, the canonical extracted rules, and checks that the native sidebar re-exports them. Extraction must preserve the existing dialog/panel stacking assertions; the test is not a deployed visual acceptance claim.


Task #40 rework: the inherited candidate failed the fragment validator because
`40.fixed.md` contained multiple paragraphs. Keep one entry per fragment. The
native conversation script now uses production React configuration and full
minification, guarded by a 4.6 MB script budget (previous asset: 5.37 MB). This
is a bounded reduction, not completed weak-network acceptance: embedded math
fonts/CSS and the full native composer, tools, approval, stop/continue and
personal/group interaction integration still require work. Operator deployment,
three-account browser checks and actual screenshots remain pending.

### Same-origin native math fonts

The native build emits hashed KaTeX font files under `workbench-fonts/` using
esbuild file loaders. CSS references those same-origin assets, so only fonts
actually needed by rendered math are fetched; no font bytes inflate initial CSS.
The package includes this directory. Gateway reads accept only KaTeX filenames
with build hashes and font extensions, never arbitrary paths or query strings.
The existing self-only CSP remains unchanged. Generated binary assets are compared
as bytes in build checks and mirrored by the canonical patch generator. Local
render checks are separate from loopback host tests and deployed weak-network acceptance.

Task40 continuation shares an explicit native asset loader between sidebar and
conversation mounts. Readiness requires both same-origin JavaScript and CSS load;
stylesheet errors never mount unstyled controls. Every asynchronous mount retains
the existing conversation identity/epoch fence. The scoped composer is exported
from the original `composer.js` and reuses its dictation lifecycle; the native
conversation bundle mounts it with a captured authorized chat handle, supplied
visible mention identities and draft callbacks. Personal and Project drafts use
separate route keys; disposal retires sends and tears down microphone listeners.
This is a scoped composer adaptation, not the entire DSH shell composer: original
attachment, tool/approval and personal running-state projections remain outstanding.

The room composer uses the same native mount with existing registered-document
choices; only document IDs reach project-room-message. Private/personal sends
reject room-document options, and retired captured handles cannot send. Mention
choices for a personal group are limited to its supplied member roster. Live tool
labels reuse original `cells.js` workText and only the scoped live tool name;
arguments, private reasoning and raw SDK logs are not exposed. Tool-result cards,
blocking approvals and personal live/stop controls still need implementation.

### Task40 native interaction continuation

Personal-space now projects only the current owned Bot's question and one-shot
approval cards, with captured-scope stop/continue controls. Original PendingQuestion,
ApprovalCard and MemberWork components render the controls; original standing grants
remain available in the owner UI but are not introduced through this adapter. An
approval ID must belong to the selected Session/Bot. Historical parts cannot mutate
current execution, stale question dismissal fails, and asynchronous stop resolution
revalidates current identity before requesting cancellation. A stop request is not
proof that an external process exited.

Personal group work uses roomWorkView and the original MemberWork component; only
the viewer's own seated Bot may be stopped through this adapter. Room history retains
its existing membership-window filtering. The adapter does not stream unapproved
member replies. Current personal own-chat streaming uses documented llm/stream hooks,
excludes hidden exchange turns and drops buffers on completion. SDK permission and
message-input controls reuse the original approval card/scoped composer while still
calling project-execution-input with its actual worker ID/generation/request ID and
current Project rights. No raw DSH endpoint is exposed by the gateway.

Authorized personal tool pages expose bounded, redacted text results and tool names,
rendered through the original workText/AssistantCell components. Arguments, images,
reasoning, hidden exchanges and orphan result events are excluded. Real deployed
three-account/browser/weak-network screenshots remain operator acceptance; local
component and HTTP fixtures do not establish that acceptance.

Answerable personal group questions and owned member approvals use the same native
cards. Public question fields exclude origin/replyTo routing authority. The original
host selects the answer destination from its saved question; body IDs cannot retarget
another question or worker. Tool rows retain loaded history within the bound Session;
a call without a visible result is labelled started, not inferred to be still running.

### Current part and native attachments

The personal part picker routes the current Session to `/personal/:bot` and normalizes
an explicit current-Session deep link to that live route. Only older parts receive
personalPart, so returning from history restores composer, streaming and controls.
Human messages now use original PersonMessage/Bubbles rather than plain paragraphs.
Scoped message actions omit reactions when no reaction capability was supplied; the
original owner shell still supplies that capability unchanged.

Native personal/group file sends accept browser bytes through personal-space and
reuse public AttachmentStore admission plus identified Agent followup/steer and
Session flush APIs. No DSH code or private API is used. Source uploads are bounded
to four files, 256 KiB per file and 512 KiB total, within the shared gateway's 1 MiB
request ceiling; original native image validation remains mandatory. Current human
access is rechecked after capability resolution and attachment admission before any
message is published. Invalid batches are prevalidated before file registration.
Registration revoked before publication may retain an unreferenced immutable object,
following the native store's retention-neutral contract, but publishes no message.

History preserves attachment-only messages and exposes sanitized reference metadata,
not host paths. Image reads use the public Session attachment API; file reads use
AttachmentStore's verified stream. Each read proves a matching reference in the
selected event, or in a group line visible through native membership-window filtering,
and revalidates after awaits. Historical parts may read their own recorded attachments
but cannot send. Downloads are bounded to 512 KiB. Only verified raster images are
previewed; generic files download as octet-stream. Late reads/file-selection callbacks
cannot repopulate a retired view, and upload drafts are keyed by human and conversation.

### Native refresh lifecycle

Same-route data refreshes retain native conversation, composer, sidebar and runtime
input roots in place. Native mount handles expose update alongside unmount, allowing
fresh scoped props without resetting React state, microphone/file-selection lifetimes,
text selection or browser focus. The DOM reconciler preserves only native roots and
their event-free ancestor containers; ordinary forms are replaced with their own event
closures. No focused native ancestor is detached to build the next page.

Retention requires the same account/Project/route/part key and conversation-source
identity. Navigation, logout, access failure, changed worker generation/request and
source replacement retire the relevant roots and pending asset-load callbacks. Source
and host authorization fences still apply to every operation. Mounted-workbench tests
cover personal, public, private and room refreshes, retained sends, cursor/focus state,
Project changes and revocation. DOM identity assertions report booleans so a failure
cannot recursively print a React/DOM graph and exhaust verification memory.

## Development service compatibility (S1)

S1 adds project-development to the restricted gateway and authenticated HTTP dispatcher. Existing UI assets remain unchanged. The old taskExecution DTO and additive taskViews derive from the service TaskView; stored native Bot existence no longer counts as active execution. Read-only hosts permit only validated query operations, not arbitrary command envelopes. See [service contract](project-development-service.md).

## Durable effects and outbox (S2)

The existing coalesced admission dispatcher drains due committed effects instead of directly scanning all role pools. Batches are bounded, resource/role capacities remain authoritative, and waits defer without sleeping a model. TaskView exposes exact-candidate publication recovery and scoped failed effect references; UI assets remain unchanged. See [effect contract](project-effects.md).

The Task40/S1 integration retains existing scoped UI routes while legacy development
operations enter the shared application facade. Compact resource summaries and full
views both pass current native activity to the S1-derived status mapper. Stored Bot
existence remains insufficient evidence of running work. Frontend retained-root,
attachment, history and authorization contracts continue unchanged; S1's additive
TaskView does not expose private conversation state through the compact board.

## Project convergence integration

Project convergence #2171 admits the six repository/closure endpoints through the restricted gateway. Each reaches the same domain service with authenticated membership and operation-specific authority; exposing a route does not grant configure or Owner confirmation rights.
