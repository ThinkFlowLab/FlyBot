# Historical backend execution evidence

Archived verbatim from PROJECT.md on 2026-11-03 to keep the active role-policy context bounded. These dated implementation/probe records retain their original claims and limitations; current owner decisions and PROJECT.md govern current behavior and permissions. No active operating rule or test budget is removed.

### Direct backend recovery — 2026-11-01

The owner requires backend repairs in the foreground Codex session; do not
dispatch backend development through FlyBot. Existing frontend work is preserved and now continues autonomously while new
backend service work is developed independently (owner update, 2026-11-01). See the
[execution decision](decisions/2026-11-01-direct-backend-recovery.md).
R6 adds coalesced event-driven dispatch, manager-controlled retry of blocked queue
entries under the original requester, and operator-selected workspace preparation
before each pool receiver and after independent test cleanup. Failed allocation,
checkout or context preparation releases only proven unbound reservations and
retains its failure audit. These changes do not imply live UI or R8 acceptance.


This is `zy95-12/FlyBot`. Current scope is the [shared-project roadmap](https://github.com/zy95-12/FlyBot/issues/1)
and [fork decision](decisions/2026-10-31-project-first-fork.md). The inherited mission,
people and stage descriptions below are historical upstream context; upstream accounts
are not this fork's decision-makers merely because inherited docs name them.

- Project is the target stable boundary for Task/Run/Workspace ownership. Bots and
  Sessions are replaceable execution/interaction carriers. M1 implements direct ownership and explicit legacy resolution; see [Project domain](docs/subsystems/project-domain.md).
- Reuse control-plane identity, auth, invitation, instance and operations APIs unchanged
  where possible. Put project business logic/adapters in FlyBot; justify a missing API
  separately. The platform PR was withdrawn, not merged.
- Rebuild task navigation and the Project board; current UI/components are not constraints.
- M0 is implemented on [PR #9](https://github.com/zy95-12/FlyBot/pull/9), merged (2026-10-31):
  real DSH/tool execution with a deterministic model, plus a FlyBot-owned HTTP adapter
  exercising unchanged external platform source. This is not real-model PR delivery.
- The baseline identity, scoped Workflow-write and per-run cwd seams are implemented
  through M1–M3; later milestone integration and live acceptance are recorded below.
- Durable repository memory is this page, ROADMAP, LESSONS and dated decisions. Update
  them and matching architecture docs alongside code, with regression coverage in
  verify/CI and tested-SHA evidence. Never edit live DSH/Bot memory for repository decisions.

See [baseline ownership and tests](docs/subsystems/demo-baseline.md).

- M1 implementation ([PR #10](https://github.com/zy95-12/FlyBot/pull/10), complete local verification, awaiting review) adds Project service/policy/repository boundaries, immutable work
  ownership, explicit migration, archive/delete/member-removal rules and an owner-only
  detail API. Workspace records are directory references; M3 supplies worktree isolation.
- The owner authorized continuing M2–M6, one PR per milestone, with memory, architecture
  and tests updated in each. [M1 decision](decisions/2026-10-31-m1-project-ownership.md).

- M2 ([PR #11](https://github.com/zy95-12/FlyBot/pull/11), complete local verification, awaiting review) implements the [shared access contract](docs/subsystems/project-access.md): unchanged
  platform auth API adapter, stable subject mapping, human membership policy/invites,
  immediate revocation and scoped Workflow gateway. It is explicitly configured; worktrees,
  agent delegation/credentials and browser delivery are supplied by M3–M6 below.

- M3 ([PR #13](https://github.com/zy95-12/FlyBot/pull/13), full local verify) implements the [commit-specific delivery contract](docs/subsystems/project-delivery.md)
  on the existing Workflow service: versioned Attempts, real role worktrees/cwd, host test
  evidence, Review/SHA gates and human acceptance. Actual DSH and draft artifact PR #12
  were first exercised with a deterministic model. Integrated real-model/GitHub/browser
  acceptance subsequently passed in M6; [evidence](docs/live-acceptance.md).

- M4 implements [scoped Project agents](docs/subsystems/project-agents.md): fresh public
  Chief, private human/Project identities, separate memory/history/proposals, live delegated
  tool checks, role/skill snapshots and exact GitHub credential scopes. Actual DSH fixture
  validation covers creation/publication/revocation; real-model/browser acceptance
  subsequently passed in M6. Runtime code-worker OS isolation is not claimed by this demo.

- M7 is owner-authorized in [#20](https://github.com/zy95-12/FlyBot/issues/20),
  implemented sequentially as #21–#25, one PR per issue. It explicitly authorizes native,
  Codex SDK and Claude Agent SDK Harness choices; the inherited upstream removal of
  Codex does not govern this fork. Control-plane remains unchanged. M7.1 introduces
  explicit public role memory and bounded hashed execution contexts, durable Chief
  identity/history and per-Attempt temporary Session bindings. M7.2–M7.5 code is on PRs #27–#30: resource leases, SDK Harnesses, Owner setup and
  verified Git handoffs. Authenticated mixed-resource acceptance remains outstanding;
  the later owner-authorized local Codex-only run passed, as recorded below.

### Task-scoped SDK context and resident Chief memory — 2026-11-01
Owner requires a resident Chief with durable Project memory and one logical Session per Task/role. Codex/Claude own their supported conversation persistence and automatic compaction; FlyBot does not inject a second model-history compactor. SDK role rework reuses a confirmed released Task-role cwd/thread under the same principal/resource/profile/model/persona binding, while preserving separate immutable Attempt/claim/log/test/Review evidence. Changed bindings rotate backend threads with recorded lineage. Chief memory uses the original own-Bot MEMORY.md/topics/journal, never global team or private-user memory. Context admission keeps current bounded facts and hash-bound full source archives for scoped retrieval. Backend changes are foreground work; frontend Task40/PR48 resumes through FlyBot after validation.

Task40 continuation integrates trusted backend `91792c1b` into preserved candidate
`25607404` without committing or publishing. Room-scoped messages/streaming and role
identity are retained alongside Chief retrieval/memory and binding-checked SDK resume.
The inherited changelog failure reproduces (6/7) and the single-entry repair passes
(7/7). Generated patches match canonical core. Direct integration testing requires
DSH's registered loader: plain node cannot resolve `@deepseek-ai/dsh-llm` from the
new scheduled-task module. This is not a passing integration result. Native composer,
tool/approval/stop/stream, personal/group interactions, CSS-load synchronization and
actual deployed three-account/weak-network acceptance remain open.

Follow-up local check used the required harness loader:
`cd core && node --import ./test/harness-resolve.mjs --test test/project-agents.test.js test/project-harness.test.js`
passed 40/40 on the staged merge draft. The earlier plain-node failure was a loader
invocation error, not a missing prepared dependency. Full verify, smoke, independent
Review and deployed acceptance are Not run for this draft.

Task40 adds a CSS/JS readiness barrier (defect tests 0/2 → 2/2) and mounts the scoped
composer from original composer.js for Project agents and personal conversations.
The original dictation hook is reused with disposal; captured chat handles retain
scope revocation. A base-bundle composer test fails because the capability is absent;
current native render/client/asset checks pass 27/27. These are local draft checks,
not host full verification, independent Review or deployed three-account acceptance.

The room composer now shares that native mount and existing registered-document
IDs, while personal groups restrict mention choices to their visible members.
Actual native workText labels render scoped live tool names. Final focused UI
checks pass 33/33. Full verify was attempted during editing and is not valid final
verification; a later process-control/result request was refused by sandbox
loopback policy. Request actual configured host verification through Tester, then
return this partial implementation to Developer for remaining tool-result,
approval, personal live/stop and full interaction work. Do not close Task40.

Task40 continuation at base cbcad4c4 adds actual native question/approval/stop/continue
controls, original group MemberWork controls, bounded redacted tool results and current
own-chat streaming. Existing original components are reused; standing grants and raw
owner APIs are not exposed. SDK permission/message inputs now use the same original
approval/composer components with existing host worker-generation/current-rights gates.
The new personal HTTP capability test failed at base (1/2) before implementation and
passed afterward; additional boundary tests cover foreign approvals/workers, retired
handles, hidden turns, historical parts and stale questions. Host full verification,
independent Review and deployed three-account/weak-network screenshots remain required.

The continuation also restores answerable group question/approval cards through
original handlers, exposing only public question fields rather than replyTo/origin.
Group member-stop tests use actual native membership and reject another owner's Bot.
Final local interaction checks, build/patch/lint results and outstanding host/browser
validation are reported at handoff; no candidate recommendation closes this Task.

Task40 host verification at `33e482d6` reported four failures in install, secrets
and usage suites. All four reproduced locally (28/32). The personal stream observer
was also installed in legacy mode, shifting the established listener order used by
those protocol tests. Register it only for explicit shared-workbench mode; keep its
purpose/Session guards. The new mode-boundary regression fails without that fix;
affected suites plus personal-workbench coverage now pass 38/38. Final host full
verification and independent Review remain required; no deployed acceptance is claimed.

Review return at `846378bf` reproduced current-part navigation leaving the live
conversation read-only; picker and explicit current-part links now normalize to the
live route (defect regression red→green). Human Markdown/mentions reuse original
PersonMessage. Attachment-only messages, scoped image preview/file download and
native file/image sends use public DSH attachment/Agent APIs with current-user checks.
The new human/attachment render test fails against the base bundle and passes on the
working build. Boundary tests cover foreign IDs, batch validation, historical reads,
revocation during admission and late download callbacks. Final host verification,
independent Review and real-service screenshots/weak-network acceptance remain open.

Review return at `bde2cf7c` reproduced native composer remount/focus loss on same-route
refresh. The mounted regression now uses bounded boolean DOM-identity diagnostics
(the former object diff exhausted memory before reporting failure) and reproduces
red at that source. Native roots now update in place within the same scoped route and
source, retaining input, cursor and focus; navigation/revocation still dispose them.
Mounted personal/public/private/room regressions cover retained sends and scope teardown.
No resource limit was raised. Exact-candidate host verification, independent Review
and deployed three-account/weak-network/screenshot acceptance remain separate gates.
