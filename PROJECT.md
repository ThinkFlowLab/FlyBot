# FlyBot — Project State

The single page that says what this project is, who decides what, and what automation must never
do. Operational rules live in [AGENTS.md](AGENTS.md) and [CONTRIBUTING.md](CONTRIBUTING.md);
architecture lives in [docs/architecture.md](docs/architecture.md) and
[docs/subsystems/](docs/subsystems/README.md). This page links them and does not repeat them.

Current stage and priorities: [ROADMAP.md](ROADMAP.md). How decisions are made:
[docs/governance.md](docs/governance.md). Dated decisions: [decisions/](decisions/README.md).

## Agent connection authorization — 2026-11-03

#2183 adds scoped agent credentials over the existing member-session HTTP channel,
reuses per-participation safe/watch grants, and persists Task-origin provenance.
Owner's closure confirmation remains personal; native/external personal agents may
suggest closure without a Task. Real TCP contract tests are separate from actual
provider adapters/login. Full operation receipts/events and transaction migration
remain #2185/#2182; runtime cancellation remains #2184. No live rollout.

## Independent personal-agent foundation — 2026-11-02

#2170 introduces user-owned identities, per-Project participation/default routing,
and migration that retains private carrier IDs, notes, conversations and Sessions.
Leaving/retiring revokes only that agent's grants and preserves private history.
External descriptors remain unverified; authentication/transport and actual provider
acceptance are #2183/#2185, compatibility #2186. This is source work, not live rollout.

## Backend convergence — 2026-11-02

Project convergence #2171 now adds explicit repository associations and non-destructive Owner double-confirmed closure on the delivery branch. It preserves unfinished Task records and memory; runtime source migration and new behavior are not deployed. Chief role proposals now require separate Maintainer/Owner approval with exact-hash/revision fencing and durable Effects proof; retirement preserves Task/Session and room history. Real-provider custom-role execution remains #2184 acceptance, and later convergence issues remain active.

Native execution convergence #2184 now adds matching physical Session bindings and observed
Agent quiescence before Bot removal/resource release. Role retirement/capability changes
cannot restart pinned execution under stale authority. Deterministic runtime acceptance
and real-provider Task loops remain separate; this work is not deployed. Custom-role artifact verification and SDK capability policy now have actual Git/host-test and subprocess contract coverage. Verified supervisor exit now supports native prior-host recovery; unmanaged/unknown exit stays held. Canonical in-flight role/resource revocation now reuses current authority checks and the existing pool stop/scheduler; unknown exit retains capacity. Composed-stack acceptance and real-provider native continuation remain active acceptance. Native activation now requires committed Effects proof and pre-step admission. The actual DSH native return loop now passes with deterministic inference, retained prior conversation and one resource.

## Fork Project State — 2026-10-31

### Backend delivery branch — 2026-11-02

`delivery/ai-centric-development-service` packages the complete S1–S6 backend at1811e3b8f,
including verified-exit, approved integration and Chief/SDK recovery fixes. Its root
README documents existing-service authentication, direct v1/legacy HTTP usage,
explicit task publication/start, isolated source demo setup and evidence limits.
This is a documentation/branch handoff, not another service listener, schema change,
main merge, runtime rollout or takeover of original frontend Task40/PR48.
No deployment credentials or operator private files are included.

### Earlier service implementation evidence

Detailed S1–S6 implementation/recovery history is [archived verbatim](docs/history/2026-11-03-service-integration.md). Existing contracts remain in their subsystem docs. New convergence work is not deployed; preserve healthy frontend Task40/PR48 and native schedules. Backend work remains in this owner-authorized session.

## Historical upstream Project State

## Mission

FlyBot is a local team of long-lived AI Bots that runs on DeepSeek Harness (DSH), in your own
browser, with your own model keys. One person talks to one Bot — the **Chief** — and the team takes
the request apart and comes back with one answer. The Bots keep their own memory, working folder,
model and schedules between turns, so work outlives a single chat.

The project's mission is to keep that team reliable and inspectable: every Bot acts on evidence,
stays inside its goal, and its result can be checked by a person afterwards. The product is the app
in this repository plus the patches that pin it to upstream `ds-bot`; it is not a hosting service.

`AGENTS.md` states the two halves the code is built from: pristine upstream `ds-bot/` (never edited),
and `core/` — `ds-bot/` plus FlyBot's ordered patches — which is what ships and what the tests run.
The shipped features are the DSH plugin in `core/` and the peer plugins `plugins/social`,
`plugins/tree`, `plugins/timeline` and `plugins/workflow`.

## Owner and maintainer roles

Today the project has one owner and a small number of human maintainers; the Bots work under the
owner's delegation. This is the state of the repository as of 2026-10-29, not the target model of
[#1550](https://github.com/ThinkFlowLab/FlyBot/issues/1550).

| Role | Who | Decides |
| --- | --- | --- |
| **Owner** | Danyang, GitHub [`Birfy`](https://github.com/Birfy) (repository admin) | Mission, governance policy, roles and membership, project Bots, compute and resources, budgets, autonomy boundaries, and every matter reserved to the owner in [docs/governance.md](docs/governance.md) |
| **Maintainer** (human) | People with repository write access — today the owner and [`hsliuustc0106`](https://github.com/hsliuustc0106) | Major decisions under [docs/governance.md](docs/governance.md): roadmap and architecture changes, changes to the governing documents, multi-subsystem contracts. Records a verdict through the review policy, never through an admin merge |
| **Chief** (AI) | The owner's Main Bot, writing as `Birfy` | Plans and routes work, splits a request into role tasks, **classifies** each decision as ordinary / major / severe with its rationale, convenes a discussion when one is needed, and escalates to the owner. Not the ultimate authority and not the owner |
| **Routine Bots** (AI) | `Triage`, `Dev`, `Dev2`–`Dev4`, `Reviewer`, `Reviewer2`, `Release`, `SelfTest`, `Docs`, `Maintainer` — the names in [`writers`](.github/agent/review-policy.json) | Only their routine's job: see [Routines](AGENTS.md#routines). A Bot records a conclusion only where its routine owns that conclusion, and the implementer never writes the verdict on its own change |
| **Contributors** (human) | Anyone who opens an issue or a pull request | Proposals, bug reports, code. No default approval right; a contribution merges only through the gates in [AGENTS.md](AGENTS.md) |

Deliberately **not** claimed here, because it is not shipped: a Maintainer console, a Member role, a
Project Assistant, per-person GitHub attribution for Bots, and the multi-human authority contract in
[docs/subsystems/team.md](docs/subsystems/team.md) (planned; team mode stays disabled until its
authorization gates pass). Every Bot still writes as the one shared `Birfy` identity, so a
`Written-by:` line is a claim the gates can check for presence and name, not a signature.

## Resources covered

- **This repository** — `https://github.com/ThinkFlowLab/FlyBot`, the source of record. `main` is
  the live branch; pull requests merge into it only through the merge queue.
- **Code** — `core/` (shipped plugin, source of truth), `patches/ds-bot/` and `core/client.js`
  (generated from `core/`), `plugins/*` (peer plugins), `scripts/` and `core/scripts/`.
- **Rules and knowledge** — `AGENTS.md` (operating contract), `CONTRIBUTING.md`, `LESSONS.md`
  (observed failures and promotion to standards), `docs/` (architecture, standards, runbooks),
  `decisions/` (dated decisions), `PROJECT.md` and `ROADMAP.md` (this page and the plan).
- **Automation** — `.github/workflows/` and `.github/scripts/` (CI, risk tier, review gate, merge
  gate, enqueue guard), `.github/agent/` (risk rules and the review policy).
- **Authoritative runtime state elsewhere** — GitHub issues, pull requests and CI runs are the
  authority for work state; task boards, approvals and per-Bot memory live in FlyBot's own storage,
  never in this repository. `docs/` pages are informative only where a source above decides
  something.
- **Not in this repository** — the upstream `ds-bot` project (pinned in `ds-bot.pin.json`, read-only
  here) and the self-hosted Bot Social server used by the social plugin. The fork
  `Birfy/FlyBot` is an archive: nothing merges into it.

## Governing boundaries

Who decides what is written in [docs/governance.md](docs/governance.md), in the operational wording
this repository uses today. In short:

- **The owner** decides the mission, the governance policy, the roles and their membership, the
  autonomy boundaries, the security surface, and any matter reserved in that page.
- **A human maintainer** concludes major decisions, records a verdict, and can challenge any
  classification.
- **Chief** classifies decisions, routes work, records outcomes, and escalates what it may not
  conclude. A classification is a routing label, never an authorization.
- **A routine Bot** concludes only ordinary work inside its routine, through the gates in
  [AGENTS.md](AGENTS.md).

### What automation may never do

These hold for every Bot and every routine, whatever the CI state, the label or a chat message says:

1. **No production deploy** of Bot Social, and no change to the owner's own local instances, without
   the owner's explicit yes.
2. **No secrets** — never write, print, log or commit an API key, token, cookie or `DSH_HOME`
   contents. A withheld key is read from `DSH_SECRETS_WITHHELD` by name only.
3. **No touching the owner's DSH data** — never point a test or a run at `~/.dsh` or at a DSH the
   owner is using; the test bench keeps its own `.dsh-test-<name>/`.
4. **Never patch DSH** and never depend on files inside a DSH install. Build on the documented
   plugin APIs or stop and say what is missing.
5. **Never bypass a gate** — no admin merge, no force-push of `main`, no bypass of a required check,
   no change to a ruleset or to branch protection, and never remove a pull request the owner put in
   the merge queue.
6. **Never lift `hold`.** Only a person sets the label and only a person removes it.
7. **No version or changelog edits outside the release routine** — `CHANGELOG.md` and
   `core/package.json` belong to the daily release, not to a feature pull request.
8. **No issue on someone else's upstream**, and no design proposal filed as an issue: a proposal
   goes to the owner, who decides whether it becomes work.
9. **Never write a verdict on a change the same Bot implemented**, and never record a second
   conclusion at one tip to win a disagreement.
10. **Never edit another writer's text to change what it said** — a correction is a new comment, a
    new decision record or a `Correction from <Bot>:` line.

Changes to this page, to `ROADMAP.md`, to `docs/governance.md` or to `AGENTS.md` are **major**
decisions, concluded as [docs/governance.md](docs/governance.md) requires and recorded in
[`decisions/`](decisions/README.md).

- M5 implements the standalone shared Project workbench, restricted gateway, durable
  quota admission and actual acceptance/resource metrics. It reuses unchanged platform
  services and the existing Workflow executor. See [M5 decision](decisions/2026-10-31-m5-project-workbench.md).
  Browser/live-model acceptance is tracked separately in M6; no deployment is implied.

- M5 ([PR #15](https://github.com/zy95-12/FlyBot/pull/15), full local verify passed) supplies
  the actual shared Project UI/gateway and quota admission. M6 adds a clean two-account
  Chromium/DSH/platform runner and foreground demo launcher, plus the Project Chief
  dispatch fix found through that fresh entry. See [shared demo](docs/shared-demo.md) and
  [M6 decision](decisions/2026-10-31-m6-shared-demo.md). True-model full delivery acceptance
  subsequently passed; see the [live acceptance record](docs/live-acceptance.md). Earlier deterministic evidence remains separately labeled.

- The owner supplied an official DeepSeek credential for live validation. Official model
  catalog, inference and full live browser/GitHub acceptance passed at `f126f8c`.
  Credentials are process-only and are never repository memory. Integration fixes include
  model-visible JSON tool results, same-request Task/proposal deduplication, bounded unique
  carrier names, and propagation of human-return feedback into retry snapshots.

- Real-provider acceptance completed with two platform accounts, real role worktrees,
  independent host tests/Review and GitHub artifact PRs #18/#19, browser return/follow-up/accept,
  failing tests/retry/queue/revocation and cleanup. [Evidence](docs/live-acceptance.md) and
  [owner decision](decisions/2026-10-31-real-provider-acceptance.md). Implementation PR #16
  contains the integration fixes and regressions; review/CI/merge remain separate.


Earlier M7.2/M7.3 implementation-status checkpoints are retained verbatim in
[the historical record](docs/history/2026-11-03-completed-m7-checkpoints.md). Current
resource/Harness contracts and authorized acceptance boundaries remain below.

### M7.4 — 2026-10-31

M7.4 adds Owner role/persona/Skills/memory/Harness/model/multiple-resource configuration, bounded connection checks and explicitly granted private target-resource PTYs. Credentials stay in private profiles; generated profiles separate Project/principal/Harness. Actual local and new Docker PTYs, hidden setup, current-session revocation and background cleanup are tested. Real authenticated three-Harness acceptance remains pending dedicated credential/profile selection.


### M7.5 — 2026-10-31

M7.5 implements local/Docker Git workspace handoffs, SHA256 manifests, one final sealed candidate without intermediate worker history, independent host-verifier tests, same-SHA review and sealed SDK event evidence. Browser integration fixes runtime/terminal/input channel routing; callback-aware stop acknowledgement prevents release deadlock. See docs/m7-acceptance.md: positive authenticated three-Harness/two-resource PR acceptance still needs dedicated profiles, so M7 is not declared fully accepted.

### M7 Codex-only acceptance authorization — 2026-11-01

The owner authorized existing zy95-12 GitHub and Codex authentication on this machine
for real Codex validation. A private selected profile outside the repository is used;
no auth values, unrelated Codex history or connector configuration are copied into the
repository. The opt-in `--codex-check` exercises the native host/Workflow with real SDK
Chief/Dev/Tester/Reviewer and draft PR evidence. Claude and mixed-resource acceptance
remain separate. No merge or production deployment is authorized by this validation.

The scoped local Codex demonstration passed at clean source `73161f3`: actual Chief,
Dev/Tester/Reviewer, immutable tests, matching-SHA draft PRs #31/#32, requested-test
return/retry/re-review and scripted owner acceptance. Workers/workspaces were released.
[Evidence](dev/demo/evidence/codex-2026-11-01.json) distinguishes this from the outstanding
Claude/mixed-resource/browser/restart criteria and independent repository review.

### Collaboration repairs — 2026-11-01

The owner authorized sequential issues [#34–#41](https://github.com/zy95-12/FlyBot/issues/33), one PR each; see [decision](decisions/2026-11-01-collaboration-repair.md). The target is native multi-Bot reuse, per-Bot pools and enforced handoff, restored role contracts, ordinary Chief conversations, safe/watch delegation and configurable Chief inspection schedules. Public hosting is deferred; control-plane stays unchanged.

R1 (#34) rejects incomplete repository capabilities before workers/workspaces/leases are allocated. Workbench readiness checks Git/runtime/dependency metadata and reports the precise block; this does not claim tests or SDK task delivery have run. Old failed Attempts remain readable. R1 full local verification passed in PR #42; actual shared-service integration remains pending.

R2 (#35) restores complete Dev/Tester/Reviewer conventions, pinned policy-source hashes and final-execution prompt assembly for native and SDK roles. FlyBot code sealing requires memory/tests/architecture evidence; candidate approval explicitly cannot mint a signed forge PASS. Focused tests cover full rules reaching SDK input, required-source failures and tampering. R2 full verification and later backend/dogfood acceptance are tracked separately.


R3 (#36) implements per-logical-Bot pools on existing Task records, atomic claims,
versioned receipts and enforced handoff admission. New shared deliveries default
to dynamic pool dispatch; the legacy DAG is explicit opt-in. Only the receiving
role allocates an execution Session/resource. Candidate returns retain the Task
and create a new Attempt; overall completion waits for Chief judgement. Unit and
SDK contract-process tests cover non-DAG return/rework with one resource. Full
verification, conversation bridging, Chief arbitration/schedules and real shared
service dogfood remain separately tracked acceptance, not implied by these tests.


R4 (#37) adds conversation-only private → Chief → original-chat handoff, isolated
from private memory and other members. Query turns cannot publish or execute a
Task; scoped GitHub reads provide actual repository facts. Impactful Task kinds
persist across proposal publication; workbench status separates publication from
queue/start/execution and Chief wait. Targeted privacy, native/SDK-query, no-Task
and credential/revocation tests pass. Full verification and real shared-service
acceptance remain separate; control-plane and public hosting are unchanged.


R5 (#38) implements safe/private publication proposals and persistent, revocable
watch grants bound to the current human and Project. Browser logout does not
revoke watch authority; account/membership/grant changes do. Scoped actions use
current human rights and retain provenance. The unchanged SQLite platform can
supply fresh account status through a FlyBot-owned read-only operator helper,
without storing browser cookies or admin credentials. Regression tests cover
logout, restart, current rights, revocation, forged status evidence and fresh WAL
reads. Shared-service provisioning and real-model acceptance are still pending.

R6 (#39) adds evidence-gated Chief arbitration, audited intervention and configurable
inspection on original DSH scheduled tasks. The JSON template defaults to 30 minutes;
content, cadence, thresholds and pause/enable are editable. Current configured human
authority and generation fences apply to each effect. Unknown process exits retain
capacity; a verified systemd invocation boundary permits local restart recovery.
Deterministic protocol tests return incomplete coverage to Dev then close the same
Task after a fresh Attempt. Real shared-service Codex/timer acceptance remains #41.

Real shared-service R6 probes passed an actual Codex Chief ordinary inquiry with
zero Tasks and an original DSH 60-second wake after browser logout, then pause/
resume and restoration to 30 minutes. R7 actual Dev requested Chief arbitration;
Chief returned the same Task to Dev with a fresh Attempt. This exposed a concurrent
resource-release reconciliation race, fixed with a red/green regression. Actual
full R7 delivery and persistent 30-minute/restart acceptance remain in progress.

### R7 (#40) collaboration candidate — 2026-11-01

Scoped internal rooms now route @mentions to independent native/SDK role conversations,
with member-bound histories/documents, public native text streaming and explicit stop.
The shared UI adds safe Markdown, real pools/Timeline and readable role/evidence cards.
[Capability inventory](docs/subsystems/project-collaboration.md) records restored paths,
operator-only surfaces and limits. Tests use deterministic execution where stated.
Loopback listening is refused in this worker sandbox, so Chromium/backend and real
shared-service acceptance are pending; no completion, review PASS or deployment is claimed.

R7 rework at prior candidate `f03f89d5b933fe315ad3fc937b3702533125bcb3` repairs
the native stream listener registration expectation and browser fixture session-token
adapter. Channel authentication checks run in verify without sockets or Chromium;
actual browser and operator shared-service acceptance remain pending.


Rework of the c9f9b5d candidate fixes the browser fixture through the real runtime save boundary and checks every rooms-page bootstrap endpoint for all three human roles before opening sockets. The current full-run log also exposed an invalid two-paragraph changelog fragment; the existing validator reproduces it and passes after consolidation. Chromium and deployed-service acceptance remain pending independent execution.
R7 dogfood also exposed sandbox Git-index and host-test boundary failures. Scoped
Codex writable roots support canonical generation; Chief route may resume a
running pre-candidate Attempt without discarding uncommitted work. Explicit
return or interrupted/candidate-backed work still creates a fresh Attempt. SDK
release records carry actual stop-ack/process-exit proof, not terminal Task inference.

The original DSH 1800-second schedule actually fired at 2026-10-31T21:54:39.260Z
after browser logout and multiple backend restarts; exactly one actual Codex
Chief Run completed. This proves the persistent 30-minute wake, not just a
shortened-clock fixture. Remaining shared delivery/browser acceptance is separate.

A real SDK sandbox/strace probe identified Unix pipe syscall denial as the remaining
Node/Git subprocess blocker. Command roles use a named filesystem profile and the
limited network proxy with no allowed destinations; Chief remains tool-free. Actual
probe children succeed while outbound requests and outside-workspace writes fail.

Chief recovery found a lifetime edge-budget refusal after several real environment
repairs. Audited Chief intervention now begins a fresh bounded autonomous routing
epoch while preserving full history and global quotas. Admission is checked before
claim fencing or Attempt preparation; later preparation failure is explicitly blocked.

Actual R7 candidate `56d14be` passed host full verification and complete deterministic
Chromium/backend clicks. Independent Review was blocked by read-only temporary
fixtures; command workers now bind a unique scratch directory and offline npm cache,
without granting review-source writes. Cleanup follows confirmed SDK exit. Actual
deployed three-account acceptance and independent approval remain separate.

A tested pool checkpoint waiting for Chief/human input survives host restart only
with a completed Chief Run and all registered SDK workers/leases confirmed released.
It retains the candidate and test receipt; active claims or unknown exits still
interrupt delivery. A checkpoint audit records the restart without inventing progress.

Published delivery rework now carries the host's existing PR binding through Chief
returns and human retries. Sealing keeps the old published candidate as an ancestor;
publication rechecks the original PR/head and fast-forwards its branch, refusing
concurrent/closed/mismatched artifacts rather than creating another PR. Actual
PR48 remains unchanged until verified backend deployment and Chief-directed rework.

Published rework now pins the actual GitHub target ref through the host broker.
A resolved merge seals with both the old candidate and trusted upstream parents;
roles receive that pinned input and publication rejects target movement or lost
ancestry. Merged content still requires real host tests and independent Review.

Role admission now replaces verified duplicate repository previews with complete-policy references, preserving full rules and all shared knowledge under the existing context cap. Preparation failures release unbound reservations and retain drafts; narrow host-proven rejected-admission checkpoints preserve the same Attempt across restart.

Unstarted bound delivery now revalidates the live PR target before Developer allocation and audits a descendant-only target refresh on the same Attempt, preserving the original PR, candidate seed and unsealed draft. Active, unknown or previously recorded execution cannot silently retarget.

Recurring M6 browser timeout reproduced at166: the native Chief correctly generated a safe-mode proposal, while the old fixture waited for an unapproved Task. Acceptance now verifies no early Task, cross-user rejection, explicit requester UI approval and idempotent publication before existing delivery checks; production authorization is unchanged.

R7 P0 maintenance now resolves the pinned `e3ff1d26` upstream into the original
`56d14be` candidate, retaining both collaboration and backend repairs. This is an
unsealed integration draft until host tests and independent Review; Owner visual
feedback remains outstanding and no overall completion is claimed.

### R7 visual rework — 2026-11-01

Issue #40/PR48 now separates the shared chat workspace from Settings, with persistent
Project/room navigation, dedicated transcript/composer and expandable Task groups.
The reference demo guides layout only; metrics, role configuration and execution
summaries continue to come from scoped Project APIs. Failed/blocked Tasks remain
visible under Needs attention. DOM regression is red on f5eb916 and green locally.
Chromium screenshots and actual shared-service acceptance for this rework are pending;
prior functional acceptance does not establish the owner's visual acceptance.

Chief inspection may explicitly select one existing Task in its authorized Project. The host validates Project configuration authority and Task ownership before using the existing scoped snapshot mechanism. Other-Project/missing Tasks are rejected; unscoped inspection is unchanged. This reduces unrelated facts without dropping policy/knowledge or raising context limits.

Owner basic-CI policy is implemented on the existing PR47 local branch: default pinned install/lint/build/canonical/core and plugin unit checks; heavy browser/runtime/package checks explicit extended dispatch. Independent Review and actual UI acceptance remain. Publish only at a safe upstream-binding checkpoint; this local change does not claim live workflow activation.

- R6/#39 existing-PR publication recovery now has a manager-scoped endpoint that
  revalidates original sealed role/test evidence and uses the guarded publisher.
  It repairs read-after-push receipt gaps without a new Attempt, fabricated Review
  or overall Task acceptance; see Project delivery architecture and regressions.
- Chief resource context retains current/uncertain lease details and digests only
  proven released history, preserving original records and the 48k admission limit.

### R7 UI continuation — slow connections and public Bot inspection

The same #40/PR48 continuation joins in-flight same-route loads, requests board/resource summaries without discarding audit history, and loads Settings/Workflow/member data only where displayed. Public Bot cards expose persona and attached same-Project/same-role public memory with revision/source. Settings retain existing permission checks. Native personal Chief/Bots/groups coexistence remains required and unfinished; Project rooms do not satisfy it. Browser throttling and current deployed three-account/visual acceptance remain separate from local unit evidence.


The returned 653ebc2 candidate failed two repository workflow-shape assertions, not dependency preparation: they still required unconditional extended jobs and the retired shell gate. The #40 continuation aligns these assertions with the authorized basic/extended CI contract while retaining executable failure/cancellation coverage. UI/native-personal compatibility and new candidate host verification remain separate outstanding evidence.

#40 continuation: Chief/private Project transcript now mounts original React
Bubbles/Markdown and identity marks from scoped history, in lazy named assets.
This is a partial native component slice, not personal-space/native-group compatibility
or Owner visual acceptance. Exact checks and remaining adapter work travel with handoff.


The current #40 continuation wires the original reply renderer to the Project/room observable source, including concurrent room streams and revocation clearing. It replaces the parallel room Markdown renderer. Personal Chief/Bots/native groups, complete Harness service adapters and current-source desktop/narrow/live acceptance remain unfinished; this is implementation progress, not Task acceptance.

R7 continuation in the preserved #40 draft adds original personal Bot/group identity
and history navigation, native sends and own-memory reads through a restricted
adapter, plus original AssistantCell rendering. Focused HTTP/component checks are
separate from pending full Harness shell/composer integration and actual deployed
visual acceptance; #40 remains unfinished and no acceptance is claimed.

Attempt8a continuation repaired native bundle/patch whitespace generation with
red/green regression evidence and 36 focused passing checks. The draft remains
unsealed; native shell/composer/tool/approval restoration and current-candidate
verification/visual acceptance remain outstanding.

- Fork basic CI checks out source in its tests-ok aggregation job and validates the current basic/extended policy in default workflow tests. The prior missing-script runner failure and stale inherited heavy-job assertions are repaired together, without bypassing failed verification.

#40 recovered native UI draft continuation preserves original personal identities,
history and native reply/list components; personal parent trees now use the original
collapse renderer. This is unaccepted implementation, not full native shell parity.
Native composer/services, complete personal controls and current browser/three-account
visual acceptance remain outstanding and must not be inferred from unit checks.

R7 pagination repair: personal Bot/archived-part history now has an earlier-page
control instead of stopping at the latest 100 messages. Loaded pages survive
polling and stay scoped to the opened identity/part; targeted regressions cover
navigation and revocation. New candidate host verification and deployed acceptance
remain separate.

R6 context recovery: managers may publish an exact-source knowledge checkpoint
through project-knowledge-write with hashed supersedes references. Original facts,
versions and authors remain readable; role snapshots contain the current summary,
newer facts and history digests under the unchanged48k cap. Invalid/stale checkpoints
never hide original records. See Project agents architecture.

Preparation-only retries retain an inherited sealed seed even when no new candidate
was produced, so restarting after context repair cannot silently discard prior UI.

#40 CSS/logout slice: original shell/conversation/sidebar rules now ship in the same-origin native stylesheet under the existing CSP. Sign out invalidates pending work immediately, including when an action is busy. Focused local tests are distinct from deployed visual acceptance; native composer/tool/approval and full legacy interaction parity remain outstanding.

Failed-test rework now receives a bounded, redacted, hash-verified diagnostic from
its own current or inherited candidate; unavailable private logs are not a model
debugging prerequisite. Complete host logs remain retained and cannot mint PASS.

#40 verification repair: the popup layering regression now follows the canonical extracted sidebar stylesheet, preserving its z-index assertions and checking the native sidebar re-export. Local red/green evidence is 11/12 → 12/12; this does not complete native composer or deployed three-account/weak-network acceptance.


Task #40 rework: the inherited candidate failed the fragment validator because
`40.fixed.md` contained multiple paragraphs. Keep one entry per fragment. The
native conversation script now uses production React configuration and full
minification, guarded by a 4.6 MB script budget (previous asset: 5.37 MB). This
is a bounded reduction, not completed weak-network acceptance: embedded math
fonts/CSS and the full native composer, tools, approval, stop/continue and
personal/group interaction integration still require work. Operator deployment,
three-account browser checks and actual screenshots remain pending.

Task40 continuation moves native math fonts from CSP-blocked inline data URLs to
individually loaded same-origin build assets. The stylesheet is 217104 bytes; local
render regressions pass. Full host verification and actual shared-browser evidence
remain pending; native composer/tool/approval integration remains unfinished.


### Task-scoped SDK context and resident Chief memory — 2026-11-01

Keep Chief durable memory and one logical Session per Task/role. SDKs retain their
supported persistence/compaction; FlyBot keeps bounded facts and exact binding/exit
proof, without a second model-history compactor. Rework resumes original context;
incompatible binding requires explicit recovery. Native continuation now has actual
DSH deterministic single-resource return/context coverage. Historical deployment and
probe details, including their original limitations, remain in
[execution history](docs/history/2026-11-03-execution-evidence.md#task-scoped-sdk-context-and-resident-chief-memory--2026-11-01).

### Task40 service integration history

Earlier S1 integration evidence is [archived verbatim](docs/history/2026-11-03-service-integration.md). Original frontend Task40/PR48 remains separate work: preserve its original UI/functions and healthy execution; backend source convergence does not authorize merge, deployment or UI takeover.

### Publish the service snapshot in the upstream repository — 2026-11-02

The owner explicitly requested pushing the delivered service to a new branch in
ThinkFlowLab/FlyBot. `delivery/ai-centric-development-service` retains db749e4eb
and its verified1811 production baseline; it does not merge or replace current
upstream main3dde8e14. README checkout targets this repository/branch. This is
a snapshot handoff, not a new main-targeting implementation PR or an upstream
compatibility PASS. Runtime/private configuration and the frontend flow are untouched.


### Task-role execution convergence — 2026-11-03 (#2184)

Task-role SDK retries retain pinned public persona/skills and the latest observed
backend context across Attempts. Dynamic input is not a definition identity. A
binding incompatibility or unknown old execution fails visibly; no silent fresh
Session or rollback to older context. Definition snapshots are shared by digest,
current rights still revoke execution, failed unused preparations release their
pins, and model input follows a durable-save/cancellation barrier. Existing
Harness/lease/Workflow services remain authoritative. Adapter capability inspection
reports exact native Task-role resume with committed activation/quiescence; actual DSH deterministic return/context coverage is recorded separately from real-provider validation. No
public service protocol, SQL transaction, deployment or frontend change is claimed.


### Collaboration contract convergence — 2026-11-03 (#2175)

Expose durable Task handoffs through one scoped contract projection, with distinct
pending/accepted/processed/revoked/invalidated states, source/target context references,
actual claim/worker binding, initiative fences and predecessor/successor history.
Idempotent trusted offer/accept ports reuse pools; unresolved old writers cannot be
bypassed by Chief rerouting to another resource. Consultation is a separate private
protocol over retained transcripts, without Task creation or initiative transfer.
Chief prefers an active personal agent for user questions: safe answers require user
publication, watch answers use existing inbox rights; only committed Effects may wake
an authorized native watch. External clients have isolated mailboxes, not fabricated
provider sessions. SDK process/HTTP tests and real-provider acceptance remain distinct.
Native restoration/context bounds, transaction events and parent waits stay on their
original dependent issues; no control-plane, deployment or frontend changes.


### Context/memory convergence — 2026-11-03 (#2177)

Unify model/Harness context budgeting and bounded source tools across persistent
Chief and temporary roles. Unknown capacity stays explicit; full rules/current
constraints remain required, retrieval yields before overflow, and native/SDK input
is checked before delivery. Working summaries use original public role-memory
records with exact source/evidence/uncertainty, separate resident Chief topics and
rollback of uncommitted staging. Facts have source/classification/version/archive;
role-authored experience cannot declare facts or overwrite human control. Private
notes retain history under bounded views. Codex tool history has an explicit cap;
SDK compaction remains runtime-managed, without claiming aggregate usage is current
window pressure. No new memory platform, executor or timer. Native Task-role physical
restore2184 and normalized SQL storage2182 remain separate acceptance; real SDK
verification must name exact runtime source hashes, not borrow deterministic tests.

Follow-up #2177: native resident Chief current facts are actual per-turn input with whole-input budget and final authority checks; do not rely on updating cached system prompt metadata. Preserve the original resident Session.
